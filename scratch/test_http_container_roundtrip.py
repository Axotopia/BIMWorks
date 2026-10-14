"""
HTTP-level project-container round-trip regression test (P0-2).

Why this exists
---------------
The 2026-10-14 review found that `python-multipart` was neither declared in
`requirements.txt` nor installed, while `POST /api/project/load-orlt` declares
`file: UploadFile = File(...)`. FastAPI raises at request time when the multipart
parser is missing, so the endpoint 500s in the real app — yet every test passed,
because the existing suites call `bim_manager.load_orlt_project(...)` in-process
and never touch HTTP. "Tests pass, app broken."

This test therefore exercises the container endpoints **over real HTTP**:
it boots `backend/main.py` under uvicorn on a loopback port and drives the
actual multipart upload/download paths with the Python standard library only
(no extra test dependencies).

Coverage:
  1. GET  /health                                  — server is really up
  2. POST /api/sample                              — build a known 13-element model
  3. GET  /api/project/export-bimworks             — download a real container
                                                     (asserts .bimworks filename,
                                                     zip members, no 500)
  4. POST /api/project/load-bimworks               — reset + reload over HTTP
  5. POST /api/project/load-orlt                   — legacy path + .orlt filename alias
  6. POST /api/project/load-orlt with a mislabelled `.orlt` payload — the legacy
     extension must keep working even though the container body is `.bimworks`

Run:  ./.venv/bin/python scratch/test_http_container_roundtrip.py
"""

import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND = os.path.join(ROOT, "backend")


# ---------------------------------------------------------------------------
# Minimal stdlib HTTP client (urllib) — no requests/httpx dependency
# ---------------------------------------------------------------------------
class Http:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    @staticmethod
    def _header(headers, name: str) -> str:
        """Case-insensitive header lookup (header capitalization varies by stack)."""
        for k, v in headers.items():
            if k.lower() == name.lower():
                return v
        return ""

    def get(self, path: str):
        req = urllib.request.Request(self.base_url + path, method="GET")
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers, r.read()

    def post_json(self, path: str, payload=None):
        body = json.dumps(payload if payload is not None else {}).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.headers, r.read()

    def post_multipart(self, path: str, filename: str, content: bytes, field: str = "file"):
        boundary = "----BIMWorksTestBoundary" + uuid.uuid4().hex
        buf = io.BytesIO()
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode()
        )
        buf.write(b"Content-Type: application/zip\r\n\r\n")
        buf.write(content)
        buf.write(f"\r\n--{boundary}--\r\n".encode())
        body = buf.getvalue()
        req = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_health(api: Http, proc: subprocess.Popen, timeout_s: float = 45.0):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read().decode("utf-8", "replace") if proc.stdout else ""
            raise RuntimeError(f"Server exited early (code {proc.returncode}):\n{out}")
        try:
            status, _, _ = api.get("/health")
            if status == 200:
                return
        except Exception as e:  # connection refused until uvicorn binds
            last_err = e
        time.sleep(0.25)
    raise RuntimeError(f"Server did not become healthy in {timeout_s}s: {last_err}")


def main() -> int:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ, PYTHONPATH=BACKEND, PYTHONUNBUFFERED="1")

    print(f"1. Booting uvicorn on {base} ...")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    try:
        api = Http(base)
        wait_for_health(api, proc)
        print("   -> /health OK")

        # --- 2. Build a known model over HTTP ---------------------------------
        print("2. POST /api/sample ...")
        status, _, body = api.post_json("/api/sample")
        assert status == 200, f"/api/sample returned {status}"
        sample = json.loads(body)
        assert sample.get("status") == "sample_loaded", sample
        print(f"   -> sample built: {sample.get('elements_count')} elements "
              f"(expected 13 walls/doors/windows/slab/roof/grids)")
        assert sample.get("elements_count", 0) >= 10, sample

        # --- 3. Export the container over HTTP --------------------------------
        print("3. GET /api/project/export-bimworks ...")
        status, headers, container = api.get("/api/project/export-bimworks")
        assert status == 200, f"export returned {status}: {container[:200]!r}"
        disposition = Http._header(headers, "Content-Disposition")
        assert ".bimworks" in disposition, f"expected .bimworks filename, got {disposition!r}"
        assert len(container) > 1000, f"container suspiciously small ({len(container)} bytes)"
        with zipfile.ZipFile(io.BytesIO(container)) as z:
            names = set(z.namelist())
            required = {"model.ifc", "parametric.json", "meta.json"}
            missing = required - names
            assert not missing, f"container missing members: {missing} (has {sorted(names)})"
            meta = json.loads(z.read("meta.json"))
            parametric = json.loads(z.read("parametric.json"))
            assert meta.get("container_format") == "bimworks_hybrid_v3", meta
            assert meta.get("element_count", 0) >= 10, meta
            assert len(parametric.get("elements", {})) >= 10, parametric.keys()
        print(f"   -> {len(container)} byte container, "
              f"members={sorted(names)}, filename={disposition}")

        # --- wipe the live model so a stale load cannot pass ------------------
        status, _, body = api.post_json("/api/reset")
        assert status == 200, f"/api/reset returned {status}"
        status, _, body = api.get("/api/project")
        assert status == 200
        assert json.loads(body)["elements_count"] == 0, "reset did not clear the model"
        print("   -> server model reset to 0 elements (proves the load below is real)")

        # --- 4. Reload the container over HTTP (canonical route) --------------
        print("4. POST /api/project/load-bimworks (real multipart upload) ...")
        status, _, body = api.post_multipart(
            "/api/project/load-bimworks", "Prototype.bimworks", container
        )
        assert status == 200, (
            f"load-bimworks returned HTTP {status}: {body[:400]!r}\n"
            "If this is a 500 about 'python-multipart', the declared dependency "
            "regressed — see requirements.txt."
        )
        loaded = json.loads(body)
        assert loaded["status"] == "loaded", loaded
        assert loaded["elements_count"] >= 10, loaded
        assert loaded["container_format"] == "bimworks_hybrid_v3", loaded
        print(f"   -> loaded {loaded['elements_count']} elements via canonical route")

        # --- 5. Legacy route + legacy filename must still work ----------------
        print("5. POST /api/project/load-orlt (legacy route + .orlt alias) ...")
        api.post_json("/api/reset")
        status, _, body = api.post_multipart("/api/project/load-orlt", "OldProject.orlt", container)
        assert status == 200, f"legacy load-orlt returned HTTP {status}: {body[:400]!r}"
        legacy = json.loads(body)
        assert legacy["status"] == "loaded" and legacy["elements_count"] >= 10, legacy
        print(f"   -> legacy route still loads {legacy['elements_count']} elements")

        # --- 6. Legacy endpoint tolerates a mislabelled container -------------
        print("6. POST /api/project/load-orlt with a mislabelled .orlt payload ...")
        api.post_json("/api/reset")
        status, _, body = api.post_multipart(
            "/api/project/load-orlt", "not-really-legacy.orlt", container
        )
        assert status == 200, f"mislabelled load returned HTTP {status}: {body[:400]!r}"
        mislabelled = json.loads(body)
        assert mislabelled["elements_count"] >= 10, mislabelled
        print(f"   -> mislabelled payload loaded {mislabelled['elements_count']} elements")

        # --- 7. A truncated/garbage payload fails cleanly, not with a 500 -----
        print("7. POST /api/project/load-bimworks with garbage payload ...")
        status, _, body = api.post_multipart(
            "/api/project/load-bimworks", "broken.bimworks", b"this is not a zip container"
        )
        assert status == 400, f"expected clean 400 for garbage input, got {status}: {body[:200]!r}"
        print(f"   -> clean HTTP 400 with a useful detail: {json.loads(body).get('detail', '')[:60]}...")

        # --- 8. /api/geometry carries the parametric record (P0-4) -----------
        # The frontend's element record is built from `mesh.params`; without it
        # the record stays empty and AI-planned hosted inserts see no walls.
        print("8. GET /api/geometry carries per-element params ...")
        status, _, body = api.get("/api/geometry")
        assert status == 200, f"/api/geometry returned {status}"
        geometry = json.loads(body)
        meshes = geometry.get("meshes", [])
        assert meshes, "geometry returned no meshes"
        missing_params = [m["guid"] for m in meshes if not m.get("params")]
        assert not missing_params, f"{len(missing_params)} meshes have no params payload"
        by_guid = {m["guid"]: m["params"] for m in meshes}
        walls = [p for p in by_guid.values() if p.get("ifc_class") == "IfcWallStandardCase"]
        doors = [p for p in by_guid.values() if p.get("ifc_class") == "IfcDoor"]
        assert walls and doors, f"expected walls and doors, got {len(walls)} walls / {len(doors)} doors"
        assert all(p.get("start") and p.get("end") and p.get("length") for p in walls), \
            "wall params must include baseline start/end/length (the AI planner uses them)"
        for door in doors:
            assert door.get("host_wall_guid") in by_guid, \
                f"door {door['guid']} references host {door.get('host_wall_guid')} not in the payload"
            assert isinstance(door.get("offset_along_wall"), (int, float)), door
        print(f"   -> {len(meshes)} meshes, all with params; "
              f"{len(walls)} walls carry baselines, {len(doors)} doors carry hosts")

        print("\nALL HTTP CONTAINER ROUND-TRIP TESTS PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
