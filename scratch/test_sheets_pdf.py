"""
P6 Sheets, Viewports, and Vector PDF Test Suite
Complies with docs/SPECIFICATION-v0.2.md Section 13 and IMPLEMENTATION-PLAN-2026-10-14.md (Milestone P6).

Sections:
  1. Sheet data model & invariants (Section 13.1 & 13.2)
  2. Viewport placement, constraints & separation from views (Section 13.1 & 13.2)
  3. CommandBus transaction engine (SheetCreate, SheetDelete, ViewportAdd/Remove/Move) & undo/redo
  4. Hybrid container round-trip (.bimworks zip with parametric.json overlay)
  5. Single-sheet and multi-sheet batch vector PDF compilation via PyMuPDF
  6. HTTP endpoint verification (REST routes, state bundle, batch export)

Run:  python scratch/test_sheets_pdf.py
"""

import copy
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import pymupdf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND = os.path.join(ROOT, "backend")
sys.path.insert(0, BACKEND)

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


total_passed = 0
total_failed = 0


def check(label: str, condition: bool, detail: str = ""):
    global total_passed, total_failed
    if condition:
        total_passed += 1
        print(f"   [ok]   {label}")
    else:
        total_failed += 1
        print(f"   [FAIL] {label}")
        if detail:
            print(f"          {detail}")


class Http:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _open(self, req):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def get(self, path: str):
        return self._open(urllib.request.Request(self.base_url + path, method="GET"))

    def post(self, path: str, payload=None):
        body = json.dumps(payload if payload is not None else {}).encode()
        req = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._open(req)

    def delete(self, path: str):
        return self._open(urllib.request.Request(self.base_url + path, method="DELETE"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_health(api, proc, server_logs=None, timeout_s=45.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            out = b"".join(server_logs).decode("utf-8", "replace") if server_logs else ""
            raise RuntimeError(f"server exited early ({proc.returncode}):\n{out}")
        try:
            if api.get("/health")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("server never became healthy")


def test_section_1_sheet_data_model():
    print("1. Sheet Data Model & Invariants (Section 13.1 & 13.2) ...")
    mgr = BimModelManager()
    mgr.reset_model()

    # Initial default sheets
    sheets = mgr.get_sheets()
    check("initial model seeds default sheets", len(sheets) >= 2)
    s_numbers = [s["sheet_number"] for s in sheets]
    check("default sheet A101 present", "A101" in s_numbers)
    check("default sheet A201 present", "A201" in s_numbers)

    # Standard views present
    views = mgr.get_views()
    check("initial model seeds default views", len(views) >= 8)
    v_ids = [v["id"] for v in views]
    check("view-level-1 present", "view-level-1" in v_ids)
    check("view-level-2 present", "view-level-2" in v_ids)

    # Create sheet
    s_a102 = mgr.add_sheet(
        sheet_number="A102",
        sheet_title="SECOND FLOOR PLAN",
        paper_size="ARCH_D",
    )
    check("add_sheet returns created sheet", s_a102["sheet_number"] == "A102")
    check("new sheet has empty viewports", len(s_a102["viewports"]) == 0)
    check("new sheet is registered in self.sheets", "A102" in [s["sheet_number"] for s in mgr.get_sheets()])

    # Constraint: Sheet number empty rejected
    empty_rejected = False
    try:
        mgr.add_sheet(sheet_number="", sheet_title="Empty Number Test")
    except ValueError as e:
        empty_rejected = "Sheet Number is empty" in str(e)
    check("empty sheet number rejected with Section 13.2 message", empty_rejected)

    # Constraint: Sheet number unique per scope
    dup_rejected = False
    try:
        mgr.add_sheet(sheet_number="a102", sheet_title="Duplicate Number Test")
    except ValueError as e:
        dup_rejected = "already in use" in str(e).lower()
    check("duplicate sheet number rejected (case-insensitive)", dup_rejected)

    # Placeholder sheet support (Section 13.3)
    s_ph = mgr.add_sheet(sheet_number="A900", sheet_title="FUTURE DETAILS", is_placeholder=True)
    check("placeholder sheet created with is_placeholder=True", s_ph.get("is_placeholder") is True)

    # Constraint: Explicit duplicate sheet_id rejected (preventing silent viewport wipe)
    dup_id_rejected = False
    try:
        mgr.add_sheet(sheet_number="A999", sheet_title="HIJACK", sheet_id=s_a102["id"])
    except ValueError as e:
        dup_id_rejected = "already exists" in str(e).lower()
    check("re-adding with existing sheet_id rejected (no viewport erasure)", dup_id_rejected)


def test_section_2_viewports_and_invariants():
    print("2. Viewport Placement, Constraints & View Separation (Section 13.1 & 13.2) ...")
    mgr = BimModelManager()
    mgr.reset_model()

    # Invariant Section 13.1: View exists unplaced
    unplaced_view = mgr.views["view-roof"]
    check("view-roof exists unplaced in document", unplaced_view["id"] == "view-roof")

    # Add sheet and place viewport
    sheet = mgr.add_sheet("A103", "ROOF PLAN")
    vp = mgr.add_viewport_to_sheet(sheet["id"], "view-roof", x=100.0, y=150.0, width=500.0, height=350.0)
    check("viewport placed on sheet with coordinates", vp["x"] == 100.0 and vp["y"] == 150.0)
    check("viewport references view-roof", vp["view_id"] == "view-roof")

    # Constraint Section 13.2: A view appears at most once per sheet
    dup_sheet_rejected = False
    try:
        mgr.add_viewport_to_sheet(sheet["id"], "view-roof", x=200.0, y=200.0)
    except ValueError as e:
        dup_sheet_rejected = "cannot contain more than one instance" in str(e)
    check("duplicate view on same sheet rejected", dup_sheet_rejected)

    # Constraint Section 13.2: A view appears at most once across all sheets in the model
    dup_model_rejected = False
    try:
        mgr.add_viewport_to_sheet("sheet-a201", "view-roof", x=50.0, y=50.0)
    except ValueError as e:
        dup_model_rejected = "in this model cannot contain more than one instance" in str(e)
    check("duplicate view across different sheets rejected", dup_model_rejected)

    # Viewport translation / move
    moved_vp = mgr.move_viewport(vp["id"], x=120.0, y=180.0)
    check("move_viewport updates sheet placement coordinates", moved_vp["x"] == 120.0 and moved_vp["y"] == 180.0)

    # Invariant Section 13.1: Deleting viewport leaves view intact
    mgr.remove_viewport_from_sheet(vp["id"], sheet["id"])
    sheet_vps = mgr.sheets[sheet["id"]]["viewports"]
    check("viewport removed from sheet", len(sheet_vps) == 0)
    check("underlying view-roof remains completely intact in document", "view-roof" in mgr.views)

    # Invariant Section 13.1: Deleting sheet leaves views intact
    mgr.add_viewport_to_sheet(sheet["id"], "view-roof", x=100.0, y=150.0)
    mgr.delete_sheet(sheet["id"])
    check("sheet deleted from document", sheet["id"] not in mgr.sheets)
    check("referenced view-roof STILL exists in document after sheet deletion", "view-roof" in mgr.views)


def test_section_3_command_bus_transactions():
    print("3. CommandBus Transactions & Undo/Redo for Sheets ...")
    mgr = BimModelManager()
    mgr.reset_model()
    bus = CommandBusEngine(manager=mgr)

    # 1. SheetCreate transaction
    initial_sheet_count = len(mgr.sheets)
    res = bus.execute_transaction(
        [
            CommandRequest(
                command="SheetCreate",
                params={"sheet_number": "A301", "sheet_title": "SITE PLAN", "paper_size": "ARCH_D"},
            )
        ],
        origin="ui",
        description="Create Sheet A301",
    )
    check("SheetCreate transaction committed", res["status"] == "committed")
    check("sheet count grew by 1", len(mgr.sheets) == initial_sheet_count + 1)
    new_sid = res["results"][0]["result"]["sheet_id"]

    # 2. ViewportAdd transaction
    res_vp = bus.execute_transaction(
        [
            CommandRequest(
                command="ViewportAdd",
                params={"sheet_id": new_sid, "view_id": "view-level-2", "x": 100.0, "y": 100.0},
            )
        ],
        origin="ui",
        description="Add Viewport",
    )
    check("ViewportAdd transaction committed", res_vp["status"] == "committed")
    vp_id = res_vp["results"][0]["result"]["viewport_id"]
    check("viewport added to sheet", len(mgr.sheets[new_sid]["viewports"]) == 1)

    # 3. ViewportMove transaction
    res_move = bus.execute_transaction(
        [
            CommandRequest(
                command="ViewportMove",
                params={"viewport_id": vp_id, "x": 250.0, "y": 300.0, "sheet_id": new_sid},
            )
        ],
        origin="ui",
        description="Move Viewport",
    )
    check("ViewportMove transaction committed", res_move["status"] == "committed")
    check("viewport coordinates updated", mgr.sheets[new_sid]["viewports"][0]["x"] == 250.0)

    # 4. Undo ViewportMove
    bus.undo()
    check("undo ViewportMove restores previous position", mgr.sheets[new_sid]["viewports"][0]["x"] == 100.0)

    # 5. Undo ViewportAdd
    bus.undo()
    check("undo ViewportAdd removes viewport from sheet", len(mgr.sheets[new_sid]["viewports"]) == 0)

    # 6. Undo SheetCreate
    bus.undo()
    check("undo SheetCreate removes sheet", len(mgr.sheets) == initial_sheet_count)
    check("sheet ID no longer in model", new_sid not in mgr.sheets)

    # 7. Redo SheetCreate
    bus.redo()
    check("redo SheetCreate restores sheet", len(mgr.sheets) == initial_sheet_count + 1)
    check("sheet ID restored", new_sid in mgr.sheets)

    # 8. Transaction atomicity on failure
    before_fail_count = len(mgr.sheets)
    fail_rolled_back = False
    try:
        bus.execute_transaction(
            [
                CommandRequest(
                    command="SheetCreate",
                    params={"sheet_number": "A302", "sheet_title": "VALID SHEET"},
                ),
                CommandRequest(
                    command="SheetCreate",
                    params={"sheet_number": "", "sheet_title": "INVALID EMPTY SHEET"},
                ),
            ],
            origin="ui",
            description="Atomic Multi-command Fail",
        )
    except RuntimeError as e:
        fail_rolled_back = True
    check("multi-command transaction rolls back on failure", fail_rolled_back)
    check("failed transaction leaves sheet count unchanged", len(mgr.sheets) == before_fail_count)
    check("A302 was rolled back and not persisted", "A302" not in [s["sheet_number"] for s in mgr.get_sheets()])


def test_section_4_container_roundtrip():
    print("4. Hybrid Container Roundtrip (.bimworks zip) ...")
    mgr = BimModelManager()
    mgr.reset_model()

    # Author custom sheet and viewports
    s_custom = mgr.add_sheet(
        sheet_number="A501",
        sheet_title="BUILDING DETAILS & ENLARGEMENTS",
        paper_size="ISO_A1",
        is_placeholder=False,
    )
    mgr.add_viewport_to_sheet(
        sheet_id=s_custom["id"],
        view_id="view-level-2",
        x=75.5,
        y=125.5,
        width=400.0,
        height=300.0,
        scale_factor=2.0,
    )

    # Save to .bimworks container
    container_path = mgr.save_orlt_project()
    check("container saved successfully", os.path.exists(container_path))

    # Inspect zip contents
    with zipfile.ZipFile(container_path, "r") as z:
        names = z.namelist()
        check("container has model.ifc", "model.ifc" in names)
        check("container has parametric.json", "parametric.json" in names)
        check("container has views/default.json", "views/default.json" in names)

        overlay = json.loads(z.read("parametric.json").decode("utf-8"))
        check("parametric.json carries sheets array", "sheets" in overlay)
        check("parametric.json carries views array", "views" in overlay)

        saved_sheet_nums = [s["sheet_number"] for s in overlay["sheets"]]
        check("custom sheet A501 in overlay", "A501" in saved_sheet_nums)

    # Re-load container in a fresh BimModelManager
    mgr_loaded = BimModelManager()
    load_res = mgr_loaded.load_orlt_project(container_path)
    check("container loads successfully", load_res["status"] == "loaded")

    loaded_sheets = mgr_loaded.get_sheets()
    loaded_sheet_dict = {s["sheet_number"]: s for s in loaded_sheets}
    check("custom sheet A501 restored", "A501" in loaded_sheet_dict)
    s501 = loaded_sheet_dict["A501"]
    check("sheet title preserved", s501["sheet_title"] == "BUILDING DETAILS & ENLARGEMENTS")
    check("paper size preserved", s501["paper_size"] == "ISO_A1")
    check("viewport preserved on sheet", len(s501["viewports"]) == 1)
    vp501 = s501["viewports"][0]
    check("viewport view_id preserved", vp501["view_id"] == "view-level-2")
    check("viewport position preserved", abs(vp501["x"] - 75.5) < 1e-6 and abs(vp501["y"] - 125.5) < 1e-6)
    check("viewport scale preserved", abs(vp501["scale_factor"] - 2.0) < 1e-6)

    # Overlay normalization stability
    p2 = mgr_loaded.save_orlt_project()
    with zipfile.ZipFile(container_path, "r") as z1, zipfile.ZipFile(p2, "r") as z2:
        ov1 = json.loads(z1.read("parametric.json").decode("utf-8"))
        ov2 = json.loads(z2.read("parametric.json").decode("utf-8"))
        check("sheets byte-identical across save/load/save cycle", json.dumps(ov1["sheets"], sort_keys=True) == json.dumps(ov2["sheets"], sort_keys=True))

    try:
        os.remove(container_path)
        os.remove(p2)
    except Exception:
        pass


def test_section_5_vector_pdf_compilation():
    print("5. Vector PDF & Batch Multi-Sheet Export (PyMuPDF) ...")
    mgr = BimModelManager()
    mgr.reset_model()

    # Sample SVG 1 (representing Sheet A101)
    svg_a101 = """<svg viewBox="0 0 1056 704" width="1056" height="704" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="1016" height="664" fill="white" stroke="#0f172a" stroke-width="2"/>
      <text x="100" y="100" font-family="Helvetica" font-size="24" fill="#0f172a">A101 - FLOOR PLAN</text>
      <line x1="50" y1="200" x2="600" y2="200" stroke="#000000" stroke-width="3"/>
    </svg>"""

    # Sample SVG 2 (representing Sheet A201)
    svg_a201 = """<svg viewBox="0 0 1056 704" width="1056" height="704" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="1016" height="664" fill="white" stroke="#0f172a" stroke-width="2"/>
      <text x="100" y="100" font-family="Helvetica" font-size="24" fill="#0f172a">A201 - ELEVATIONS</text>
      <circle cx="300" cy="300" r="80" stroke="#0284c7" stroke-width="2" fill="none"/>
    </svg>"""

    # Sample SVG 3 (representing Sheet A301)
    svg_a301 = """<svg viewBox="0 0 1056 704" width="1056" height="704" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="1016" height="664" fill="white" stroke="#0f172a" stroke-width="2"/>
      <text x="100" y="100" font-family="Helvetica" font-size="24" fill="#0f172a">A301 - SECTIONS</text>
    </svg>"""

    # 1. Single sheet vector PDF export
    pdf_single = mgr.compile_sheet_to_vector_pdf(svg_a101)
    check("compile_sheet_to_vector_pdf returns bytes", isinstance(pdf_single, (bytes, bytearray)))
    check("PDF output starts with %PDF- header", pdf_single.startswith(b"%PDF-"))

    doc_single = pymupdf.open("pdf", pdf_single)
    check("single-sheet PDF has exactly 1 page", len(doc_single) == 1)
    page_text = doc_single[0].get_text()
    check("PDF preserves searchable text", "A101 - FLOOR PLAN" in page_text)

    # 2. Multi-sheet batch vector PDF export
    batch_svgs = [svg_a101, svg_a201, svg_a301]
    pdf_batch = mgr.compile_batch_to_vector_pdf(batch_svgs)
    check("compile_batch_to_vector_pdf returns bytes", isinstance(pdf_batch, (bytes, bytearray)))
    check("batch PDF starts with %PDF- header", pdf_batch.startswith(b"%PDF-"))

    doc_batch = pymupdf.open("pdf", pdf_batch)
    check("batch PDF has exactly 3 pages", len(doc_batch) == 3)
    check("page 1 contains Sheet A101 text", "A101" in doc_batch[0].get_text())
    check("page 2 contains Sheet A201 text", "A201" in doc_batch[1].get_text())
    check("page 3 contains Sheet A301 text", "A301" in doc_batch[2].get_text())

    # Pure vector linework verification (zero rasterization)
    check("single-sheet PDF has 0 raster images", len(doc_single[0].get_images()) == 0)
    check("single-sheet PDF contains vector drawings", len(doc_single[0].get_drawings()) > 0)
    check("batch PDF page 1 has 0 raster images", len(doc_batch[0].get_images()) == 0)
    check("batch PDF page 2 has 0 raster images", len(doc_batch[1].get_images()) == 0)
    check("batch PDF page 3 has 0 raster images", len(doc_batch[2].get_images()) == 0)

    # Negative control: verify that a rasterized PDF fails this check!
    test_raster_doc = pymupdf.open()
    r_page = test_raster_doc.new_page(width=100, height=100)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 10, 10), False)
    r_page.insert_image(pymupdf.Rect(0, 0, 50, 50), pixmap=pix)
    check("negative control: raster image detection succeeds on rasterized page", len(r_page.get_images()) > 0)


def test_section_6_http_endpoints_and_state_bundle():
    print("6. HTTP Endpoints & State Bundle Live Verification ...")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ, PYTHONPATH=BACKEND, PYTHONUNBUFFERED="1")

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    server_logs = []

    def _drain():
        try:
            for line in iter(proc.stdout.readline, b""):
                server_logs.append(line)
        except Exception:
            pass

    drain_thread = threading.Thread(target=_drain, daemon=True)
    drain_thread.start()

    try:
        api = Http(base)
        wait_for_health(api, proc, server_logs=server_logs)

        # GET /api/sheets
        status, body = api.get("/api/sheets")
        check("GET /api/sheets returns 200", status == 200)
        sheets_data = json.loads(body)
        check("GET /api/sheets returns list", isinstance(sheets_data, list))
        check("GET /api/sheets has camelCase keys for UI", "sheetNumber" in sheets_data[0])

        # GET /api/views
        status, body = api.get("/api/views")
        check("GET /api/views returns 200", status == 200)
        views_data = json.loads(body)
        check("GET /api/views returns views list", len(views_data) >= 8)

        # POST /api/sheet
        status, body = api.post(
            "/api/sheet",
            {"sheet_number": "A105", "sheet_title": "CODE COMPLIANCE", "paper_size": "ARCH_D"},
        )
        check("POST /api/sheet returns 200", status == 200)
        created_res = json.loads(body)
        sheet_id = created_res["sheet_id"]
        check("sheet_id returned", bool(sheet_id))

        # Check journal entry
        status, j_body = api.get("/api/transaction/journal?limit=5")
        journal = json.loads(j_body)
        latest_tx = journal[-1]
        check("POST /api/sheet journaled as SheetCreate transaction", latest_tx["commands"][0]["command"] == "SheetCreate")

        # Verify duplicate view placement rejection over HTTP
        dup_status, dup_body = api.post(
            f"/api/sheet/{sheet_id}/viewport",
            {"view_id": "view-level-1", "x": 100.0, "y": 150.0, "width": 480.0, "height": 360.0},
        )
        check("POST /api/sheet/{sheet_id}/viewport with already placed view returns 400", dup_status == 400)
        check("rejection mentions Section 13.2 message", b"cannot contain more than one instance" in dup_body)

        # POST /api/sheet/{sheet_id}/viewport with unplaced view (view-roof)
        status, body = api.post(
            f"/api/sheet/{sheet_id}/viewport",
            {"view_id": "view-roof", "x": 100.0, "y": 150.0, "width": 480.0, "height": 360.0},
        )
        check("POST /api/sheet/{sheet_id}/viewport returns 200", status == 200)
        vp_res = json.loads(body)
        vp_id = vp_res["viewport_id"]

        # POST /api/sheet/viewport/{viewport_id}/move
        status, body = api.post(f"/api/sheet/viewport/{vp_id}/move", {"x": 200.0, "y": 250.0, "sheet_id": sheet_id})
        check("POST /api/sheet/viewport/{id}/move returns 200", status == 200)
        move_res = json.loads(body)
        check("viewport moved to x=200", move_res["x"] == 200.0)

        # DELETE /api/sheet/viewport/{viewport_id}
        status, body = api.delete(f"/api/sheet/viewport/{vp_id}")
        check("DELETE /api/sheet/viewport/{id} returns 200", status == 200)

        # Invariant check: view-roof is still intact
        status, body = api.get("/api/views")
        views_now = [v["id"] for v in json.loads(body)]
        check("view-roof remains untouched after viewport deletion", "view-roof" in views_now)

        # DELETE /api/sheet/{sheet_id}
        status, body = api.delete(f"/api/sheet/{sheet_id}")
        check("DELETE /api/sheet/{id} returns 200", status == 200)

        # POST /api/export/sheet-pdf
        svg_content = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="blue"/></svg>'
        status, pdf_data = api.post("/api/export/sheet-pdf", {"svg_content": svg_content, "sheet_name": "TestSheet"})
        check("POST /api/export/sheet-pdf returns 200", status == 200)
        check("PDF header present in HTTP response", pdf_data.startswith(b"%PDF-"))

        # POST /api/export/batch-pdf
        batch_payload = {
            "sheets": [
                {"svg_content": svg_content, "sheet_name": "Page_1"},
                {"svg_content": svg_content, "sheet_name": "Page_2"},
            ],
            "filename": "Project_Set",
        }
        status, batch_pdf_data = api.post("/api/export/batch-pdf", batch_payload)
        check("POST /api/export/batch-pdf returns 200", status == 200)
        check("batch PDF response starts with %PDF-", batch_pdf_data.startswith(b"%PDF-"))
        doc = pymupdf.open("pdf", batch_pdf_data)
        check("batch PDF HTTP response contains exactly 2 pages", len(doc) == 2)

        # GET /api/state bundle contains sheets
        status, state_body = api.get("/api/state")
        check("GET /api/state returns 200", status == 200)
        state_data = json.loads(state_body)
        check("state bundle includes 'sheets'", "sheets" in state_data and isinstance(state_data["sheets"], list))
        check("state bundle includes 'views'", "views" in state_data and isinstance(state_data["views"], list))
        check("state bundle timings contains 'sheets'", "sheets" in state_data.get("timings", {}))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    print("=" * 70)
    print("BIMWorks Milestone P6: Sheets, Viewports & Vector PDF Test Suite")
    print("=" * 70)

    test_section_1_sheet_data_model()
    test_section_2_viewports_and_invariants()
    test_section_3_command_bus_transactions()
    test_section_4_container_roundtrip()
    test_section_5_vector_pdf_compilation()
    test_section_6_http_endpoints_and_state_bundle()

    print("=" * 70)
    print(f"RESULT: {total_passed} passed, {total_failed} failed")
    if total_failed == 0:
        print("ALL P6 SHEETS & PDF TESTS PASSED")
        return 0
    else:
        print("SOME TESTS FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
