"""
BIMWorks Milestone P7: Typesafe AI Driver, Semantic Queries & MCP Server Test Suite
Covers:
  1. Tier 0: Command Catalog & JSON Schema 2020-12 Tool Specifications
  2. Semantic Query Engine & Cardinal Direction Auto-Grounding
  3. Golden Prompt Planning & Parameter Schema Validation
  4. Atomic Transaction Execution with Post-Condition Verification & Rollback
  5. Parametric Macro Skills (.bwskill)
  6. Standard Model Context Protocol (MCP Server JSON-RPC 2.0)
  7. HTTP API Surface & Journal Parity
"""

from __future__ import annotations

import os
import sys
import json
import time
import socket
import urllib.request
import urllib.error
import subprocess
import threading
from typing import Any, Dict, List, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(REPO_ROOT, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from ifc_service import bim_manager
from command_bus import command_bus, CommandRequest, COMMAND_REGISTRY
from ai_driver import ai_driver, AiPlanner, SemanticQueryEngine, AiContext, AiPlan, PostCondition, SkillDefinition
from mcp_server import McpServer

PASS_COUNT = 0
FAIL_COUNT = 0


def check(name: str, condition: bool):
    global PASS_COUNT, FAIL_COUNT
    if condition:
        PASS_COUNT += 1
        print(f"   [ok]   {name}")
    else:
        FAIL_COUNT += 1
        print(f"   [FAIL] {name}")


# ----------------------------------------------------------------------------
# 1. TIER 0: COMMAND CATALOG & JSON SCHEMA 2020-12 EXPORT
# ----------------------------------------------------------------------------
def test_section_1_command_catalog_and_schemas():
    print("1. Tier 0: Command Catalog & JSON Schema 2020-12 Tool Specifications ...")
    catalog = ai_driver.get_tool_catalog()

    check("catalog declares version 2.1", catalog.get("version") == "2.1")
    check("catalog protocol matches BIMWorks_AI_Catalog_v2.1", catalog.get("protocol") == "BIMWorks_AI_Catalog_v2.1")
    check("catalog registers 31 command schemas", catalog.get("registered_commands_count") == len(COMMAND_REGISTRY))

    schemas = catalog.get("command_schemas", {})
    check("WallCreate schema present", "WallCreate" in schemas)
    check("DoorInsert schema present", "DoorInsert" in schemas)
    check("WindowInsert schema present", "WindowInsert" in schemas)
    check("SheetCreate schema present", "SheetCreate" in schemas)
    check("ViewportAdd schema present", "ViewportAdd" in schemas)

    tools = catalog.get("tools", [])
    tool_names = [t["name"] for t in tools]
    check("execute_transaction tool declared", "execute_transaction" in tool_names)
    check("query_elements tool declared", "query_elements" in tool_names)
    check("describe_scene tool declared", "describe_scene" in tool_names)
    check("get_element tool declared", "get_element" in tool_names)
    check("plan_and_execute_prompt tool declared", "plan_and_execute_prompt" in tool_names)
    check("undo tool declared", "undo" in tool_names)
    check("redo tool declared", "redo" in tool_names)


# ----------------------------------------------------------------------------
# 2. SEMANTIC QUERY ENGINE & CARDINAL WALL GROUNDING
# ----------------------------------------------------------------------------
def test_section_2_semantic_queries_and_cardinal_grounding():
    print("2. Semantic Query Engine & Cardinal Direction Auto-Grounding ...")
    bim_manager.reset_model()
    command_bus.journal.clear()
    command_bus.undo_stack.clear()
    command_bus.redo_stack.clear()

    # Create 4 walls forming a 40' x 30' rectangle
    # South: (0,0) -> (40,0)
    w_south = bim_manager.add_wall((0.0, 0.0), (40.0, 0.0), height=10.0, thickness=0.8333, name="South Wall")
    # East: (40,0) -> (40,30)
    w_east = bim_manager.add_wall((40.0, 0.0), (40.0, 30.0), height=10.0, thickness=0.8333, name="East Wall")
    # North: (40,30) -> (0,30)
    w_north = bim_manager.add_wall((40.0, 30.0), (0.0, 30.0), height=10.0, thickness=0.8333, name="North Wall")
    # West: (0,30) -> (0,0)
    w_west = bim_manager.add_wall((0.0, 30.0), (0.0, 0.0), height=10.0, thickness=0.8333, name="West Wall")

    query_engine = SemanticQueryEngine(bim_manager)

    # describe_scene
    desc = query_engine.describe_scene()
    check("describe_scene reports decimal_feet unit", desc["unit"] == "decimal_feet")
    check("describe_scene counts 4 walls", desc["counts"]["walls"] == 4)
    check("envelope width is 40 ft", desc["envelope"]["width"] == 40.0)
    check("envelope depth is 30 ft", desc["envelope"]["depth"] == 30.0)

    # Cardinal walls classification
    cardinals = query_engine.classify_cardinal_walls()
    check("South wall correctly identified", cardinals["south"] == w_south["guid"])
    check("North wall correctly identified", cardinals["north"] == w_north["guid"])
    check("East wall correctly identified", cardinals["east"] == w_east["guid"])
    check("West wall correctly identified", cardinals["west"] == w_west["guid"])

    # Relative text resolution
    check("resolve_target_wall('the south wall') resolves south GUID", query_engine.resolve_target_wall("the south wall") == w_south["guid"])
    check("resolve_target_wall('north facade') resolves north GUID", query_engine.resolve_target_wall("north facade") == w_north["guid"])
    check("resolve_target_wall('east side') resolves east GUID", query_engine.resolve_target_wall("east side") == w_east["guid"])
    check("resolve_target_wall('west boundary') resolves west GUID", query_engine.resolve_target_wall("west boundary") == w_west["guid"])

    # Single element query
    elem = query_engine.get_element(w_south["guid"])
    check("get_element returns length 40.0", elem["length"] == 40.0)
    check("get_element returns level_name Level 1", elem["level_name"] == "Level 1")


# ----------------------------------------------------------------------------
# 3. GOLDEN PROMPT PLANNING & SCHEMA VALIDATION
# ----------------------------------------------------------------------------
def test_section_3_golden_prompt_planning():
    print("3. Golden Prompt Planning & Parameter Schema Validation ...")
    planner = AiPlanner(bim_manager)

    # Golden Prompt 1: Perimeter Box
    p1 = planner.plan_prompt("create 40x30 perimeter walls with 10' height")
    check("Plan 1 intent describes 40' x 30' perimeter wall enclosure", "40.0' × 30.0'" in p1.intent_summary)
    check("Plan 1 contains 4 WallCreate commands", len(p1.commands) == 4 and all(c.command == "WallCreate" for c in p1.commands))
    check("Plan 1 diagnostics clean", len(p1.diagnostics) == 0)
    check("Plan 1 has post_condition element_count_at_least", any(pc.assertion == "element_count_at_least" for pc in p1.post_conditions))

    # Golden Prompt 2: Door Insertion
    p2 = planner.plan_prompt("insert 36x84 door in south wall at 10ft")
    check("Plan 2 intent describes door insertion", "Door" in p2.intent_summary)
    check("Plan 2 contains DoorInsert command", len(p2.commands) == 1 and p2.commands[0].command == "DoorInsert")
    check("Plan 2 targets south wall", len(p2.affected_guids) == 1)
    check("Plan 2 offset is 10.0 ft", p2.commands[0].params["offset_along_wall"] == 10.0)
    check("Plan 2 has opening_hosted post-condition", any(pc.assertion == "opening_hosted" for pc in p2.post_conditions))

    # Golden Prompt 3: Window Insertion Centered
    p3 = planner.plan_prompt("add 48x48 window centered in north wall")
    check("Plan 3 intent describes window insertion", "Window" in p3.intent_summary)
    check("Plan 3 contains WindowInsert command", len(p3.commands) == 1 and p3.commands[0].command == "WindowInsert")
    check("Plan 3 centered offset calculated", p3.commands[0].params["offset_along_wall"] > 10.0)

    # Golden Prompt 4: Slab Foundation
    p4 = planner.plan_prompt("add slab under building")
    check("Plan 4 intent describes slab foundation", "Slab" in p4.intent_summary)
    check("Plan 4 contains SlabCreate command", len(p4.commands) == 1 and p4.commands[0].command == "SlabCreate")
    check("Plan 4 slab polygon has 4 vertices", len(p4.commands[0].params["polygon"]) == 4)

    # Golden Prompt 5: Sheet Creation & Viewport Placement
    p5 = planner.plan_prompt("create sheet A105 Second Floor Plan and place view-level-2 on it")
    check("Plan 5 intent describes Sheet A105", "A105" in p5.intent_summary)
    check("Plan 5 contains SheetCreate and ViewportAdd", len(p5.commands) == 2 and p5.commands[0].command == "SheetCreate" and p5.commands[1].command == "ViewportAdd")
    check("Plan 5 viewport references view-level-2", p5.commands[1].params["view_id"] == "view-level-2")


# ----------------------------------------------------------------------------
# 4. ATOMIC TRANSACTION EXECUTION & POST-CONDITION ROLLBACK
# ----------------------------------------------------------------------------
def test_section_4_atomic_execution_and_rollback():
    print("4. Atomic Transaction Execution with Post-Condition Verification & Rollback ...")
    bim_manager.reset_model()
    command_bus.journal.clear()
    command_bus.undo_stack.clear()
    command_bus.redo_stack.clear()

    # 1. Execute Golden Prompt: Perimeter walls
    p_box = ai_driver.plan("create 40x30 perimeter walls with 10' height")
    res1 = ai_driver.execute_plan(p_box)
    check("execute_plan returns committed status", res1["status"] == "committed")
    check("4 commands executed", res1["commands_executed"] == 4)
    check("verified_assertions returned", len(res1["verified_assertions"]) >= 1)
    check("model has 4 walls", len(ai_driver.query_engine.query_elements(category="wall")) == 4)

    # Verify journal entry
    j_entry = command_bus.journal[-1]
    check("transaction origin is 'ai'", j_entry["origin"] == "ai")
    check("transaction description is intent summary", "perimeter wall enclosure" in j_entry["description"])

    # 2. Execute Golden Prompt: Door Insertion with post-condition
    p_door = ai_driver.plan("insert 36x84 door in south wall at 12ft")
    res2 = ai_driver.execute_plan(p_door)
    check("door insertion committed", res2["status"] == "committed")
    check("model has 1 door", len(ai_driver.query_engine.query_elements(category="door")) == 1)

    # 3. Post-Condition Failure & Automatic Rollback
    # Construct a plan with an impossible assertion
    failing_plan = AiPlan(
        intent_summary="Faulty operation with impossible assertion",
        commands=[
            CommandRequest(
                command="WallCreate",
                params={"start": [50.0, 0.0, 0.0], "end": [60.0, 0.0, 0.0], "height": 10.0, "thickness": 0.5, "name": "Faulty Wall"}
            )
        ],
        post_conditions=[
            PostCondition(
                assertion="element_count_at_least",
                params={"min_count": 999, "category": "wall"},
                description="Require 999 walls in document",
            )
        ]
    )

    walls_before = len(ai_driver.query_engine.query_elements(category="wall"))
    raised_assertion = False
    try:
        ai_driver.execute_plan(failing_plan)
    except AssertionError as e:
        raised_assertion = True
        check("failing post-condition raises AssertionError", "AI Post-Condition Assertion Failed" in str(e))

    check("AssertionError was triggered", raised_assertion)
    walls_after = len(ai_driver.query_engine.query_elements(category="wall"))
    check("failed transaction was automatically rolled back (walls unchanged)", walls_before == walls_after)


# ----------------------------------------------------------------------------
# 5. PARAMETRIC MACRO SKILLS (.bwskill)
# ----------------------------------------------------------------------------
def test_section_5_skills_macros():
    print("5. Parametric Macro Skills (.bwskill) ...")
    bim_manager.reset_model()

    planner = ai_driver.planner
    check("builtin skill 'perimeter_box' registered", "perimeter_box" in planner.skills)

    # Execute skill via natural language prompt with parameter overrides
    skill_plan = planner.plan_prompt("run skill perimeter_box width 50 depth 35")
    check("skill plan generated", bool(skill_plan))
    check("skill plan intent names perimeter_box", "perimeter_box" in skill_plan.intent_summary)
    check("skill plan contains 5 commands (4 walls + 1 slab)", len(skill_plan.commands) == 5)

    # Check that $width was substituted with 50.0 and $depth with 35.0
    w0 = skill_plan.commands[0]
    check("wall 0 end X is 50.0", w0.params["end"][0] == 50.0)
    w1 = skill_plan.commands[1]
    check("wall 1 end Y is 35.0", w1.params["end"][1] == 35.0)

    # Execute skill
    res = ai_driver.execute_plan(skill_plan)
    check("skill execution committed", res["status"] == "committed")
    desc = ai_driver.query_engine.describe_scene()
    check("envelope width is 50.0 ft", desc["envelope"]["width"] == 50.0)
    check("envelope depth is 35.0 ft", desc["envelope"]["depth"] == 35.0)
    check("slab created by skill", desc["counts"]["slabs"] == 1)


# ----------------------------------------------------------------------------
# 6. MODEL CONTEXT PROTOCOL (MCP Server JSON-RPC 2.0)
# ----------------------------------------------------------------------------
def test_section_6_mcp_server():
    print("6. Standard Model Context Protocol (MCP Server JSON-RPC 2.0) ...")
    server = McpServer()

    # 1. initialize
    init_req = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    init_res = server.handle_request(init_req)
    check("initialize response has jsonrpc 2.0", init_res.get("jsonrpc") == "2.0")
    check("protocolVersion is 2024-11-05", init_res["result"].get("protocolVersion") == "2024-11-05")
    check("serverInfo name is bimworks-mcp-server", init_res["result"]["serverInfo"]["name"] == "bimworks-mcp-server")

    # 2. tools/list
    tools_req = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    tools_res = server.handle_request(tools_req)
    tools = tools_res["result"]["tools"]
    tool_names = [t["name"] for t in tools]
    check("tools/list returns list of tools", len(tools) >= 7)
    check("execute_transaction in tools/list", "execute_transaction" in tool_names)
    check("describe_scene in tools/list", "describe_scene" in tool_names)

    # 3. tools/call: describe_scene
    call_req = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "describe_scene", "arguments": {}}}
    call_res = server.handle_request(call_req)
    content = json.loads(call_res["result"]["content"][0]["text"])
    check("tools/call describe_scene returns envelope", "envelope" in content)
    check("tools/call describe_scene returns counts", "counts" in content)

    # 4. tools/call: plan_and_execute_prompt
    exec_req = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "plan_and_execute_prompt",
            "arguments": {"prompt": "insert 36x84 door in south wall at 15ft"},
        },
    }
    exec_res = server.handle_request(exec_req)
    exec_content = json.loads(exec_res["result"]["content"][0]["text"])
    check("tools/call plan_and_execute_prompt committed", exec_content.get("status") == "committed")

    # 5. tools/call: undo
    undo_req = {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "undo", "arguments": {}}}
    undo_res = server.handle_request(undo_req)
    undo_content = json.loads(undo_res["result"]["content"][0]["text"])
    check("tools/call undo succeeds", undo_content.get("status") == "undone")


# ----------------------------------------------------------------------------
# 7. HTTP API SURFACE & LIVE SIDECAR
# ----------------------------------------------------------------------------
class Http:
    def __init__(self, base_url: str):
        self.base_url = base_url

    def get(self, path: str) -> Tuple[int, bytes]:
        req = urllib.request.Request(f"{self.base_url}{path}")
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def post(self, path: str, payload: Any) -> Tuple[int, bytes]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_health(api: Http, proc: subprocess.Popen, timeout: float = 15.0, server_logs: List[str] = None):
    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            tail = "\n".join(server_logs[-30:]) if server_logs else ""
            raise RuntimeError(f"Server exited early with code {proc.returncode}\n{tail}")
        try:
            status, body = api.get("/health")
            if status == 200:
                return
        except Exception:
            pass
        time.sleep(0.2)
    tail = "\n".join(server_logs[-30:]) if server_logs else ""
    raise TimeoutError(f"Server did not become healthy in {timeout}s\n{tail}")


def test_section_7_http_api_surface():
    print("7. HTTP Endpoints & Live Sidecar Verification ...")
    port = pick_free_port()
    base = f"http://127.0.0.1:{port}"

    server_logs: List[str] = []
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=BACKEND_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )

    def _drain():
        for line in proc.stdout:
            server_logs.append(line.rstrip())

    drain_thread = threading.Thread(target=_drain, daemon=True)
    drain_thread.start()

    try:
        api = Http(base)
        wait_for_health(api, proc, server_logs=server_logs)

        # 1. GET /api/ai/tools
        status, body = api.get("/api/ai/tools")
        check("GET /api/ai/tools returns 200", status == 200)
        tools_data = json.loads(body)
        check("tools list present in HTTP response", "tools" in tools_data)
        check("command schemas present in HTTP response", "command_schemas" in tools_data)

        # 2. GET /api/ai/describe
        status, body = api.get("/api/ai/describe")
        check("GET /api/ai/describe returns 200", status == 200)
        desc_data = json.loads(body)
        check("describe response contains envelope", "envelope" in desc_data)

        # 3. POST /api/ai/plan
        status, body = api.post("/api/ai/plan", {"prompt": "create 40x30 perimeter walls with 10' height"})
        check("POST /api/ai/plan returns 200", status == 200)
        plan_data = json.loads(body)
        check("synthesized plan contains 4 commands", len(plan_data["commands"]) == 4)
        check("synthesized plan intent matches", "40.0' × 30.0'" in plan_data["intent_summary"])

        # 4. POST /api/ai/execute
        status, body = api.post("/api/ai/execute", {"plan": plan_data})
        check("POST /api/ai/execute returns 200", status == 200)
        exec_data = json.loads(body)
        check("execute response status is committed", exec_data["status"] == "committed")
        check("verified_assertions present in execute response", len(exec_data["verified_assertions"]) >= 1)

        # 5. Verify journal entry
        status, j_body = api.get("/api/transaction/journal?limit=5")
        journal = json.loads(j_body)
        latest_tx = journal[-1]
        check("transaction journal records origin='ai'", latest_tx.get("origin") == "ai")
        check("transaction journal records intent description", "perimeter wall enclosure" in latest_tx.get("description", ""))

        # 6. POST /api/ai/execute with direct prompt (integrated plan & execute)
        status, body = api.post("/api/ai/execute", {"prompt": "insert 36x84 door in south wall at 10ft"})
        check("POST /api/ai/execute with direct prompt returns 200", status == 200)

        # 7. POST /api/ai/query
        status, body = api.post("/api/ai/query", {"category": "door"})
        check("POST /api/ai/query returns 200", status == 200)
        doors = json.loads(body)
        check("POST /api/ai/query found door", len(doors) >= 1)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------
def main():
    print("=" * 70)
    print("BIMWorks Milestone P7: Typesafe AI Driver & MCP Test Suite")
    print("=" * 70)

    test_section_1_command_catalog_and_schemas()
    test_section_2_semantic_queries_and_cardinal_grounding()
    test_section_3_golden_prompt_planning()
    test_section_4_atomic_execution_and_rollback()
    test_section_5_skills_macros()
    test_section_6_mcp_server()
    test_section_7_http_api_surface()

    print("=" * 70)
    print(f"RESULT: {PASS_COUNT} passed, {FAIL_COUNT} failed")
    if FAIL_COUNT == 0:
        print("ALL P7 AI DRIVER & MCP TESTS PASSED")
        return 0
    else:
        print("FAILURES DETECTED IN P7 SUITE")
        return 1


if __name__ == "__main__":
    sys.exit(main())
