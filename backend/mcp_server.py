"""
BIMWorks - Model Context Protocol (MCP) Server
Exposes CommandBus tools, semantic queries, and plan execution to external
AI agents (Antigravity, Claude Desktop, Cursor, DSH) via standard JSON-RPC 2.0 stdio.
"""

from __future__ import annotations

import sys
import json
import logging
import traceback
from typing import Dict, Any, Optional

from ai_driver import ai_driver
from command_bus import command_bus, CommandRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", stream=sys.stderr)
logger = logging.getLogger("bimworks-mcp")


class McpServer:
    """Standard MCP stdio JSON-RPC server for BIMWorks."""

    def __init__(self, driver=ai_driver, bus=command_bus):
        self.driver = driver
        self.bus = bus

    def handle_request(self, req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Processes a single JSON-RPC 2.0 request."""
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        if not method:
            return None

        # Notification handling (no id)
        if req_id is None:
            if method == "notifications/initialized":
                logger.info("MCP client initialized notification received.")
            return None

        try:
            if method == "initialize":
                return self._handle_initialize(req_id, params)
            elif method == "tools/list":
                return self._handle_tools_list(req_id)
            elif method == "tools/call":
                return self._handle_tools_call(req_id, params)
            elif method == "ping":
                return {"jsonrpc": "2.0", "id": req_id, "result": {}}
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method not found: '{method}'"},
                }
        except Exception as e:
            logger.error("Error processing request %s: %s\n%s", method, str(e), traceback.format_exc())
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(e)},
            }

    def _handle_initialize(self, req_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {"listChanged": False},
                },
                "serverInfo": {
                    "name": "bimworks-mcp-server",
                    "version": "2.1.0",
                },
            },
        }

    def _handle_tools_list(self, req_id: Any) -> Dict[str, Any]:
        catalog = self.driver.get_tool_catalog()
        mcp_tools = []
        for t in catalog["tools"]:
            mcp_tools.append({
                "name": t["name"],
                "description": t["description"],
                "inputSchema": t["parameters"],
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": mcp_tools},
        }

    def _handle_tools_call(self, req_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        tool_name = params.get("name")
        args = params.get("arguments", {})

        result_payload: Any = {}

        if tool_name == "query_elements":
            result_payload = self.driver.query_engine.query_elements(
                category=args.get("category"),
                level_id=args.get("level_id"),
                host_wall_guid=args.get("host_wall_guid"),
                min_x=args.get("min_x"),
                max_x=args.get("max_x"),
                min_y=args.get("min_y"),
                max_y=args.get("max_y"),
            )

        elif tool_name == "describe_scene":
            result_payload = self.driver.query_engine.describe_scene()

        elif tool_name == "get_element":
            guid = args.get("guid")
            elem = self.driver.query_engine.get_element(guid)
            if not elem:
                raise ValueError(f"Element '{guid}' not found")
            result_payload = elem

        elif tool_name == "plan_and_execute_prompt":
            prompt = args.get("prompt")
            plan = self.driver.plan(prompt)
            result_payload = self.driver.execute_plan(plan)

        elif tool_name == "execute_transaction":
            cmds_data = args.get("commands", [])
            desc = args.get("description", "MCP Agent Transaction")
            commands = [CommandRequest(command=c["command"], params=c["params"]) for c in cmds_data]
            result_payload = self.bus.execute_transaction(commands, origin="ai", description=desc)

        elif tool_name == "undo":
            result_payload = self.bus.undo()

        elif tool_name == "redo":
            result_payload = self.bus.redo()

        else:
            raise ValueError(f"Unknown tool: '{tool_name}'")

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result_payload, indent=2),
                    }
                ],
                "isError": False,
            },
        }

    def run_stdio(self):
        """Runs the JSON-RPC event loop over stdio."""
        logger.info("BIMWorks MCP Server started on stdio.")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = self.handle_request(req)
                if resp:
                    sys.stdout.write(json.dumps(resp) + "\n")
                    sys.stdout.flush()
            except Exception as e:
                logger.error("Failed to parse JSON input: %s", str(e))


if __name__ == "__main__":
    server = McpServer()
    server.run_stdio()
