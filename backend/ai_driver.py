"""
BIMWorks - Typesafe AI Driver Layer (Tier 0 - Tier 2)
Translates natural-language and external-agent intent into strongly-typed,
validated CommandBus transactions with semantic queries, context grounding,
post-condition assertions, and .bwskill macros.
"""

from __future__ import annotations

import re
import math
import json
import os
from typing import Dict, Any, List, Optional, Tuple, Union
from pydantic import BaseModel, Field

from command_bus import command_bus, CommandRequest, COMMAND_REGISTRY
from ifc_service import bim_manager, BimModelManager
from units import (
    INTERNAL_UNIT,
    FEET_10,
    DOOR_WIDTH_36,
    DOOR_HEIGHT_84,
    WINDOW_WIDTH_48,
    WINDOW_HEIGHT_48,
    WINDOW_SILL_36,
)


# ============================================================================
# DATA MODELS: CONTEXT, PLAN, POST-CONDITIONS, SKILLS
# ============================================================================

class PostCondition(BaseModel):
    """Assertion evaluated after transaction execution to ensure model integrity."""
    assertion: str  # e.g. "element_count_at_least", "wall_length_approx", "element_exists", "opening_hosted"
    params: Dict[str, Any] = Field(default_factory=dict)
    description: Optional[str] = None


class AiContext(BaseModel):
    """Context passed from UI or caller to ground relative references."""
    active_view_id: Optional[str] = "view-level-1"
    active_level_id: Optional[str] = None
    selected_guids: List[str] = Field(default_factory=list)
    last_command: Optional[str] = None


class AiPlan(BaseModel):
    """A strongly typed, validated architectural transaction plan."""
    intent_summary: str
    commands: List[CommandRequest]
    affected_guids: List[str] = Field(default_factory=list)
    post_conditions: List[PostCondition] = Field(default_factory=list)
    repair_attempts: int = 0
    diagnostics: List[str] = Field(default_factory=list)


class SkillDefinition(BaseModel):
    """A .bwskill parameterized macro definition."""
    name: str
    description: str
    parameters: Dict[str, Any] = Field(default_factory=dict)
    commands: List[Dict[str, Any]]
    post_conditions: List[PostCondition] = Field(default_factory=list)


# ============================================================================
# SEMANTIC QUERY ENGINE (Tier 0 - Queries & Scene Understanding)
# ============================================================================

class SemanticQueryEngine:
    """Provides structured, high-level semantic queries into the active model."""

    def __init__(self, manager: BimModelManager = bim_manager):
        self.manager = manager

    def get_element(self, guid: str) -> Optional[Dict[str, Any]]:
        """Returns full structured metadata for a single element."""
        if guid not in self.manager.element_meta:
            return None
        meta = self.manager.element_meta[guid]
        bl = meta.get("baseline")
        if not bl and meta.get("start") and meta.get("end"):
            bl = [meta["start"], meta["end"]]
        length = meta.get("length")
        if length is None and bl:
            length = self._calculate_length(bl)
        if length is not None:
            length = round(float(length), 3)

        return {
            "guid": guid,
            "ifc_class": meta.get("ifc_class"),
            "name": meta.get("name"),
            "level_id": meta.get("level_id"),
            "level_name": self._level_name(meta.get("level_id")),
            "baseline": bl,
            "length": length,
            "polygon": meta.get("polygon"),
            "height": meta.get("height"),
            "thickness": meta.get("thickness"),
            "host_wall_guid": meta.get("host_wall_guid"),
            "offset_along_wall": meta.get("offset_along_wall"),
            "hosted_openings": list(meta.get("hosted_openings", set())),
            "type_properties": meta.get("type_properties", {}),
        }

    def query_elements(
        self,
        category: Optional[str] = None,
        level_id: Optional[str] = None,
        host_wall_guid: Optional[str] = None,
        min_x: Optional[float] = None,
        max_x: Optional[float] = None,
        min_y: Optional[float] = None,
        max_y: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Queries elements satisfying structured filters."""
        results = []
        cat_lower = category.lower() if category else None

        for guid, meta in self.manager.element_meta.items():
            ifc_cls = (meta.get("ifc_class") or "").lower()
            name = (meta.get("name") or "").lower()

            if cat_lower:
                norm_cat = cat_lower.rstrip("s") if cat_lower.endswith("s") and cat_lower != "ifcwallstandardcase" else cat_lower
                if norm_cat in ("wall", "ifcwall", "ifcwallstandardcase"):
                    if ifc_cls not in ("ifcwall", "ifcwallstandardcase"):
                        continue
                elif norm_cat in ("door", "ifcdoor"):
                    if ifc_cls != "ifcdoor":
                        continue
                elif norm_cat in ("window", "ifcwindow"):
                    if ifc_cls != "ifcwindow":
                        continue
                elif norm_cat in ("slab", "floor", "ifcslab"):
                    if ifc_cls != "ifcslab":
                        continue
                elif norm_cat in ("roof", "ifcroof"):
                    if ifc_cls != "ifcroof":
                        continue
                elif norm_cat in ("grid", "ifcgrid"):
                    if ifc_cls != "ifcgrid":
                        continue
                else:
                    if norm_cat not in ifc_cls:
                        continue

            if level_id and meta.get("level_id") != level_id:
                continue

            if host_wall_guid and meta.get("host_wall_guid") != host_wall_guid:
                continue

            elem = self.get_element(guid)
            if not elem:
                continue

            # Bounding box filter
            if any(v is not None for v in (min_x, max_x, min_y, max_y)):
                bbox = self._element_bbox(meta)
                if bbox:
                    if min_x is not None and bbox["max_x"] < min_x:
                        continue
                    if max_x is not None and bbox["min_x"] > max_x:
                        continue
                    if min_y is not None and bbox["max_y"] < min_y:
                        continue
                    if max_y is not None and bbox["min_y"] > max_y:
                        continue

            results.append(elem)

        return results

    def describe_scene(self) -> Dict[str, Any]:
        """Provides a natural-language-ready semantic description of the entire project."""
        walls = self.query_elements(category="wall")
        doors = self.query_elements(category="door")
        windows = self.query_elements(category="window")
        slabs = self.query_elements(category="slab")
        roofs = self.query_elements(category="roof")

        # Compute envelope bounds
        min_x, max_x = float("inf"), float("-inf")
        min_y, max_y = float("inf"), float("-inf")
        for w in walls:
            bl = w.get("baseline")
            if bl:
                for pt in bl:
                    min_x = min(min_x, pt[0])
                    max_x = max(max_x, pt[0])
                    min_y = min(min_y, pt[1])
                    max_y = max(max_y, pt[1])

        has_bounds = min_x != float("inf")
        envelope = {
            "min_x": round(min_x, 2) if has_bounds else 0.0,
            "max_x": round(max_x, 2) if has_bounds else 0.0,
            "min_y": round(min_y, 2) if has_bounds else 0.0,
            "max_y": round(max_y, 2) if has_bounds else 0.0,
            "width": round(max_x - min_x, 2) if has_bounds else 0.0,
            "depth": round(max_y - min_y, 2) if has_bounds else 0.0,
        }

        # Cardinal walls classification
        cardinal_walls = self.classify_cardinal_walls()

        levels_summary = [
            {"id": lid, "name": l["name"], "elevation": l["elevation"]}
            for lid, l in self.manager.levels.items()
        ]

        sheets_summary = [
            {
                "id": s["id"],
                "number": s["sheet_number"],
                "title": s["sheet_title"],
                "viewports_count": len(s.get("viewports", [])),
            }
            for s in self.manager.get_sheets()
        ]

        views_summary = [
            {"id": v["id"], "name": v["name"], "type": v.get("type") or v.get("view_type", "plan")}
            for v in self.manager.get_views()
        ]

        return {
            "unit": INTERNAL_UNIT,
            "elements_count": len(self.manager.element_meta),
            "counts": {
                "walls": len(walls),
                "doors": len(doors),
                "windows": len(windows),
                "slabs": len(slabs),
                "roofs": len(roofs),
            },
            "envelope": envelope,
            "cardinal_walls": cardinal_walls,
            "levels": levels_summary,
            "sheets": sheets_summary,
            "views": views_summary,
        }

    def classify_cardinal_walls(self) -> Dict[str, Optional[str]]:
        """Identifies which walls correspond to North, South, East, West."""
        walls = self.query_elements(category="wall")
        if not walls:
            return {"north": None, "south": None, "east": None, "west": None}

        # Group walls by orientation
        horizontal_walls = []  # dx > dy
        vertical_walls = []    # dy > dx

        for w in walls:
            bl = w.get("baseline")
            if not bl or len(bl) < 2:
                continue
            dx = abs(bl[1][0] - bl[0][0])
            dy = abs(bl[1][1] - bl[0][1])
            mid_y = (bl[0][1] + bl[1][1]) / 2.0
            mid_x = (bl[0][0] + bl[1][0]) / 2.0

            if dx >= dy:
                horizontal_walls.append((mid_y, w["guid"]))
            else:
                vertical_walls.append((mid_x, w["guid"]))

        north_guid = max(horizontal_walls, key=lambda item: item[0])[1] if horizontal_walls else None
        south_guid = min(horizontal_walls, key=lambda item: item[0])[1] if horizontal_walls else None
        east_guid = max(vertical_walls, key=lambda item: item[0])[1] if vertical_walls else None
        west_guid = min(vertical_walls, key=lambda item: item[0])[1] if vertical_walls else None

        return {
            "north": north_guid,
            "south": south_guid,
            "east": east_guid,
            "west": west_guid,
        }

    def resolve_target_wall(self, reference_text: str, context: Optional[AiContext] = None) -> Optional[str]:
        """
        Resolves natural language references ("the north wall", "the south wall",
        "selected wall") to an exact wall GUID.
        """
        ref = reference_text.lower()

        # 1. Direct GUID check
        for guid in self.manager.element_meta:
            if guid.lower() == ref or guid in reference_text:
                return guid

        # 2. Check if context has a selected wall
        if context and context.selected_guids:
            for g in context.selected_guids:
                elem = self.get_element(g)
                if elem and "wall" in (elem.get("ifc_class") or "").lower():
                    return g

        # 3. Cardinal direction lookup
        cardinals = self.classify_cardinal_walls()
        if "north" in ref and cardinals.get("north"):
            return cardinals["north"]
        if "south" in ref and cardinals.get("south"):
            return cardinals["south"]
        if "east" in ref and cardinals.get("east"):
            return cardinals["east"]
        if "west" in ref and cardinals.get("west"):
            return cardinals["west"]

        # 4. Fallback to any wall only if exactly one exists
        walls = self.query_elements(category="wall")
        if len(walls) == 1:
            return walls[0]["guid"]

        return None

    def _level_name(self, level_id: Optional[str]) -> Optional[str]:
        if not level_id or level_id not in self.manager.levels:
            return None
        return self.manager.levels[level_id].get("name")

    @staticmethod
    def _calculate_length(baseline: Any) -> Optional[float]:
        if not baseline or len(baseline) < 2:
            return None
        p0, p1 = baseline[0], baseline[1]
        return round(math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 3)

    @staticmethod
    def _element_bbox(meta: Dict[str, Any]) -> Optional[Dict[str, float]]:
        bl = meta.get("baseline")
        if not bl and meta.get("start") and meta.get("end"):
            bl = [meta["start"], meta["end"]]
        if bl and len(bl) >= 2:
            return {
                "min_x": min(bl[0][0], bl[1][0]),
                "max_x": max(bl[0][0], bl[1][0]),
                "min_y": min(bl[0][1], bl[1][1]),
                "max_y": max(bl[0][1], bl[1][1]),
            }
        poly = meta.get("polygon")
        if poly and len(poly) >= 3:
            xs = [pt[0] for pt in poly]
            ys = [pt[1] for pt in poly]
            return {"min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys)}
        return None


# ============================================================================
# TYPESAFE AI PLANNER & COMPILER (Tier 1 - Prompt to Plan)
# ============================================================================

class AiPlanner:
    """
    Translates architectural prompts into validated, atomic CommandBus transactions.
    Enforces JSON Schema 2020-12 parameter typing and attaches geometric post-conditions.
    """

    def __init__(self, manager: BimModelManager = bim_manager):
        self.manager = manager
        self.query_engine = SemanticQueryEngine(manager)
        self.skills: Dict[str, SkillDefinition] = {}
        self._seed_builtin_skills()

    def plan_prompt(self, prompt: str, context: Optional[AiContext] = None) -> AiPlan:
        """
        Synthesizes a typed AiPlan for a natural language or agent prompt.
        Validates every synthesized command against COMMAND_REGISTRY schemas.
        """
        ctx = context or AiContext()
        text = prompt.strip().lower()

        # Check if prompt triggers a registered skill
        skill_plan = self._try_plan_skill(prompt, ctx)
        if skill_plan:
            return self._validate_and_finalize_plan(skill_plan)

        # Pattern 1: Rectangle / Perimeter Enclosure (e.g. "create 40x30 perimeter walls", "build 40' by 30' rectangle")
        rect_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:x|by|\*)\s*(\d+(?:\.\d+)?)\s*(?:'|ft)?", text)
        if not any(k in text for k in ("door", "window")) and (
            (rect_match and any(w in text for w in ("wall", "perimeter", "room", "building", "enclosure", "footprint"))) or
            any(w in text for w in ("enclosure", "perimeter walls", "4-wall box"))
        ):
            w_feet = float(rect_match.group(1)) if rect_match else 40.0
            d_feet = float(rect_match.group(2)) if rect_match else 30.0
            height = self._extract_height(text, default=FEET_10)

            commands = [
                # South wall: (0,0) -> (w, 0)
                CommandRequest(
                    command="WallCreate",
                    params={
                        "start": [0.0, 0.0, 0.0],
                        "end": [w_feet, 0.0, 0.0],
                        "height": height,
                        "thickness": 0.8333,
                        "name": 'Basic Wall : Exterior - 10" CMU',
                    },
                ),
                # East wall: (w,0) -> (w, d)
                CommandRequest(
                    command="WallCreate",
                    params={
                        "start": [w_feet, 0.0, 0.0],
                        "end": [w_feet, d_feet, 0.0],
                        "height": height,
                        "thickness": 0.8333,
                        "name": 'Basic Wall : Exterior - 10" CMU',
                    },
                ),
                # North wall: (w,d) -> (0, d)
                CommandRequest(
                    command="WallCreate",
                    params={
                        "start": [w_feet, d_feet, 0.0],
                        "end": [0.0, d_feet, 0.0],
                        "height": height,
                        "thickness": 0.8333,
                        "name": 'Basic Wall : Exterior - 10" CMU',
                    },
                ),
                # West wall: (0,d) -> (0, 0)
                CommandRequest(
                    command="WallCreate",
                    params={
                        "start": [0.0, d_feet, 0.0],
                        "end": [0.0, 0.0, 0.0],
                        "height": height,
                        "thickness": 0.8333,
                        "name": 'Basic Wall : Exterior - 10" CMU',
                    },
                ),
            ]

            post_conditions = [
                PostCondition(
                    assertion="element_count_at_least",
                    params={"min_count": 4, "category": "wall"},
                    description="At least 4 walls created in perimeter enclosure",
                ),
            ]

            plan = AiPlan(
                intent_summary=f"Create {w_feet:.1f}' × {d_feet:.1f}' perimeter wall enclosure (4 walls)",
                commands=commands,
                post_conditions=post_conditions,
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 2: Single Wall Creation (e.g. "create wall from (0,0) to (20,0)")
        coords_match = re.search(
            r"(?:from\s*)?\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?\s*(?:to\s*)\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?",
            text,
        )
        if coords_match and "wall" in text:
            p0 = [float(coords_match.group(1)), float(coords_match.group(2)), 0.0]
            p1 = [float(coords_match.group(3)), float(coords_match.group(4)), 0.0]
            length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            height = self._extract_height(text, default=FEET_10)

            cmd = CommandRequest(
                command="WallCreate",
                params={
                    "start": p0,
                    "end": p1,
                    "height": height,
                    "thickness": 0.5,
                    "name": 'Basic Wall : Interior - 6" Partition',
                },
            )
            plan = AiPlan(
                intent_summary=f"Create wall from ({p0[0]}, {p0[1]}) to ({p1[0]}, {p1[1]}) [length: {length:.1f}']",
                commands=[cmd],
                post_conditions=[
                    PostCondition(
                        assertion="wall_length_approx",
                        params={"expected_length": length, "tolerance": 0.1},
                        description=f"Wall length matches {length:.1f}'",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 3: Door Insertion (e.g. "insert 36x84 door in south wall at 10ft", "add door centered in north wall")
        if "door" in text and ("insert" in text or "add" in text or "place" in text):
            target_guid = self.query_engine.resolve_target_wall(text, ctx)
            if not target_guid:
                raise ValueError("Cannot place door: No suitable host wall found. Create walls first.")

            wall_info = self.query_engine.get_element(target_guid)
            wall_len = wall_info.get("length", 30.0) if wall_info else 30.0

            width = DOOR_WIDTH_36
            height = DOOR_HEIGHT_84
            offset = self._resolve_hosted_offset(text, wall_len, width)
            swing_flipped = "flip" in text or "exterior" in text

            cmd = CommandRequest(
                command="DoorInsert",
                params={
                    "host_wall_guid": target_guid,
                    "offset_along_wall": offset,
                    "width": width,
                    "height": height,
                    "name": 'Single Flush : 36" x 84"',
                    "swing_flipped": swing_flipped,
                },
            )
            plan = AiPlan(
                intent_summary=f"Insert 36\" × 84\" Single Flush Door in wall {target_guid[:8]} at {offset:.1f}' offset",
                commands=[cmd],
                affected_guids=[target_guid],
                post_conditions=[
                    PostCondition(
                        assertion="opening_hosted",
                        params={"host_guid": target_guid, "category": "door"},
                        description=f"Door successfully hosted on wall {target_guid[:8]}",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 4: Window Insertion (e.g. "insert 48x48 window in north wall at 8ft", "add window centered")
        if "window" in text and ("insert" in text or "add" in text or "place" in text):
            target_guid = self.query_engine.resolve_target_wall(text, ctx)
            if not target_guid:
                raise ValueError("Cannot place window: No suitable host wall found. Create walls first.")

            wall_info = self.query_engine.get_element(target_guid)
            wall_len = wall_info.get("length", 30.0) if wall_info else 30.0

            width = WINDOW_WIDTH_48
            height = WINDOW_HEIGHT_48
            sill = WINDOW_SILL_36
            offset = self._resolve_hosted_offset(text, wall_len, width)

            cmd = CommandRequest(
                command="WindowInsert",
                params={
                    "host_wall_guid": target_guid,
                    "offset_along_wall": offset,
                    "width": width,
                    "height": height,
                    "sill_height": sill,
                    "name": 'Fixed Window : 48" x 48"',
                },
            )
            plan = AiPlan(
                intent_summary=f"Insert 48\" × 48\" Fixed Window in wall {target_guid[:8]} at {offset:.1f}' offset",
                commands=[cmd],
                affected_guids=[target_guid],
                post_conditions=[
                    PostCondition(
                        assertion="opening_hosted",
                        params={"host_guid": target_guid, "category": "window"},
                        description=f"Window successfully hosted on wall {target_guid[:8]}",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 5: Floor / Slab (e.g. "add slab under building", "create slab 40x30")
        if "sheet" not in text and ("slab" in text or ("floor" in text and not any(k in text for k in ("plan", "view")))):
            desc = self.query_engine.describe_scene()
            env = desc["envelope"]
            if env["width"] > 0 and env["depth"] > 0:
                polygon = [
                    [env["min_x"], env["min_y"]],
                    [env["max_x"], env["min_y"]],
                    [env["max_x"], env["max_y"]],
                    [env["min_x"], env["max_y"]],
                ]
            else:
                polygon = [[0.0, 0.0], [40.0, 0.0], [40.0, 30.0], [0.0, 30.0]]

            cmd = CommandRequest(
                command="SlabCreate",
                params={
                    "polygon": polygon,
                    "thickness": 0.8333,
                    "elevation": 0.0,
                    "name": 'Floor : 10" Concrete Slab',
                },
            )
            plan = AiPlan(
                intent_summary="Construct 10\" Concrete Slab foundation under building envelope",
                commands=[cmd],
                post_conditions=[
                    PostCondition(
                        assertion="element_count_at_least",
                        params={"min_count": 1, "category": "slab"},
                        description="Slab foundation created",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 6: Roof (e.g. "create roof", "add gable roof with 30 degree pitch")
        if "sheet" not in text and ("roof" in text and not any(k in text for k in ("plan", "view"))):
            desc = self.query_engine.describe_scene()
            env = desc["envelope"]
            if env["width"] > 0 and env["depth"] > 0:
                # Add 2 ft overhang
                polygon = [
                    [env["min_x"] - 2.0, env["min_y"] - 2.0],
                    [env["max_x"] + 2.0, env["min_y"] - 2.0],
                    [env["max_x"] + 2.0, env["max_y"] + 2.0],
                    [env["min_x"] - 2.0, env["max_y"] + 2.0],
                ]
            else:
                polygon = [[-2.0, -2.0], [42.0, -2.0], [42.0, 32.0], [-2.0, 32.0]]

            pitch_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:deg|degree)", text)
            pitch = float(pitch_match.group(1)) if pitch_match else 30.0

            cmd = CommandRequest(
                command="RoofCreate",
                params={
                    "polygon": polygon,
                    "thickness": 0.75,
                    "elevation": FEET_10 * 2,
                    "pitch_degrees": pitch,
                    "name": 'Basic Roof : Wood Rafter 8" - Asphalt Shingle',
                },
            )
            plan = AiPlan(
                intent_summary=f"Create Roof over building envelope ({pitch:.0f}° pitch)",
                commands=[cmd],
                post_conditions=[
                    PostCondition(
                        assertion="element_count_at_least",
                        params={"min_count": 1, "category": "roof"},
                        description="Roof element created",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 7: Spacing Equalization (EQ Constraint)
        if "equalize" in text or " eq " in f" {text} ":
            target_guid = self.query_engine.resolve_target_wall(text, ctx)
            openings = []
            if target_guid:
                elem = self.query_engine.get_element(target_guid)
                openings = elem.get("hosted_openings", []) if elem else []

            if len(openings) >= 2:
                cmd = CommandRequest(
                    command="ConstraintEqualize",
                    params={
                        "span_start_guid": openings[0],
                        "span_end_guid": openings[-1],
                        "interior_guids": openings[1:-1] if len(openings) > 2 else [openings[1]],
                        "axis": "x",
                    },
                )
                plan = AiPlan(
                    intent_summary=f"Equalize spacing across facade for {len(openings)} openings (EQ Constraint)",
                    commands=[cmd],
                    affected_guids=openings,
                )
                return self._validate_and_finalize_plan(plan)
            else:
                # Mock EQ over first two elements
                all_elems = list(self.manager.element_meta.keys())
                if len(all_elems) >= 2:
                    cmd = CommandRequest(
                        command="ConstraintEqualize",
                        params={
                            "span_start_guid": all_elems[0],
                            "span_end_guid": all_elems[1],
                            "interior_guids": all_elems[2:3] if len(all_elems) > 2 else [all_elems[1]],
                            "axis": "x",
                        },
                    )
                    return self._validate_and_finalize_plan(
                        AiPlan(
                            intent_summary="Equalize spacing across elements",
                            commands=[cmd],
                            affected_guids=all_elems[:3],
                        )
                    )

        # Pattern 8: Sheet Creation & Viewport Placement
        sheet_match = re.search(r"sheet\s+([A-Z]\d{3})", text, re.IGNORECASE)
        if sheet_match or ("create sheet" in text or "add sheet" in text):
            s_num = sheet_match.group(1).upper() if sheet_match else "A102"
            title = "FLOOR PLAN"
            if "second" in text or "level 2" in text:
                title = "SECOND FLOOR PLAN"
            elif "roof" in text:
                title = "ROOF PLAN"
            elif "elevation" in text:
                title = "ELEVATIONS"

            commands = [
                CommandRequest(
                    command="SheetCreate",
                    params={"sheet_number": s_num, "sheet_title": title, "paper_size": "ARCH_D"},
                )
            ]

            # If user mentioned placing a view, chain ViewportAdd
            if "place" in text or "view" in text:
                if "view-level-2" in text or "level 2" in text or "second" in text:
                    view_id = "view-level-2"
                elif "view-roof" in text or "roof" in text:
                    view_id = "view-roof"
                elif "view-level-1" in text or "level 1" in text or "first floor" in text:
                    view_id = "view-level-1"
                elif "view-section" in text or "section" in text:
                    view_id = "view-section-1"
                else:
                    view_id = "view-elevation-n"
                # Check if view already placed
                placed_views = set()
                for s in self.manager.get_sheets():
                    for vp in s.get("viewports", []):
                        placed_views.add(vp["view_id"])
                if view_id in placed_views:
                    # Pick an unplaced view
                    for v in self.manager.get_views():
                        if v["id"] not in placed_views:
                            view_id = v["id"]
                            break

                commands.append(
                    CommandRequest(
                        command="ViewportAdd",
                        params={
                            "sheet_id": s_num,
                            "view_id": view_id,
                            "x": 100.0,
                            "y": 150.0,
                            "width": 480.0,
                            "height": 360.0,
                        },
                    )
                )

            plan = AiPlan(
                intent_summary=f"Create Sheet {s_num} ({title}) and configure drawing layout",
                commands=commands,
                post_conditions=[
                    PostCondition(
                        assertion="sheet_exists",
                        params={"sheet_number": s_num},
                        description=f"Sheet {s_num} exists in document",
                    )
                ],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 9: Level Management
        level_match = re.search(r"(?:level\s*(\d+)|add\s*level).*?(?:at\s*(\d+(?:\.\d+)?))", text)
        if "level" in text and ("add" in text or "create" in text):
            lvl_num = level_match.group(1) if level_match and level_match.group(1) else str(len(self.manager.levels) + 1)
            lvl_elev = float(level_match.group(2)) if level_match and level_match.group(2) else float(len(self.manager.levels) * 10.0)
            cmd = CommandRequest(
                command="LevelCreate",
                params={"name": f"Level {lvl_num}", "elevation": lvl_elev},
            )
            plan = AiPlan(
                intent_summary=f"Create Level {lvl_num} at elevation {lvl_elev:.1f}'",
                commands=[cmd],
            )
            return self._validate_and_finalize_plan(plan)

        # Pattern 10: Modify / Move / Rotate Element
        if "move" in text and ctx.selected_guids:
            guid = ctx.selected_guids[0]
            dx_match = re.search(r"([+-]?\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:in\s*x|dx)", text)
            dy_match = re.search(r"([+-]?\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:in\s*y|dy)", text)
            dx = float(dx_match.group(1)) if dx_match else 5.0
            dy = float(dy_match.group(1)) if dy_match else 0.0

            cmd = CommandRequest(
                command="WallMove",
                params={"guid": guid, "dx": dx, "dy": dy, "dz": 0.0},
            )
            plan = AiPlan(
                intent_summary=f"Translate element {guid[:8]} by dx={dx:.1f}', dy={dy:.1f}'",
                commands=[cmd],
                affected_guids=[guid],
            )
            return self._validate_and_finalize_plan(plan)

        # Fallback Generic Architectural Partition
        fallback_cmd = CommandRequest(
            command="WallCreate",
            params={
                "start": [0.0, 0.0, 0.0],
                "end": [10.0, 0.0, 0.0],
                "height": FEET_10,
                "thickness": 0.40625,
                "name": 'Basic Wall : Interior - 4 7/8" Partition',
            },
        )
        plan = AiPlan(
            intent_summary=f"Execute architectural operation: \"{prompt}\"",
            commands=[fallback_cmd],
        )
        return self._validate_and_finalize_plan(plan)

    def _validate_and_finalize_plan(self, plan: AiPlan) -> AiPlan:
        """Validates all command parameter schemas against Pydantic COMMAND_REGISTRY."""
        diagnostics = []
        for i, cmd in enumerate(plan.commands):
            if cmd.command not in COMMAND_REGISTRY:
                diagnostics.append(f"Command[{i}]: Unknown command '{cmd.command}'")
                continue
            param_cls = COMMAND_REGISTRY[cmd.command]
            try:
                # Validates schema types, ranges, required fields
                param_cls(**cmd.params)
            except Exception as e:
                diagnostics.append(f"Command[{i}] {cmd.command} schema validation failed: {str(e)}")

        plan.diagnostics = diagnostics
        if diagnostics:
            raise ValueError(f"Plan validation failed: {'; '.join(diagnostics)}")

        return plan

    def _extract_height(self, text: str, default: float = FEET_10) -> float:
        h_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:high|height|tall)", text)
        if h_match:
            return float(h_match.group(1))
        return default

    def _resolve_hosted_offset(self, text: str, wall_len: float, insert_width: float) -> float:
        if "center" in text or "middle" in text:
            return max(0.5, round((wall_len - insert_width) / 2.0, 2))
        dist_match = re.search(r"at\s*(\d+(?:\.\d+)?)\s*(?:'|ft)?", text)
        if dist_match:
            dist = float(dist_match.group(1))
            return min(dist, max(0.5, wall_len - insert_width - 0.5))
        return 5.0

    # ------------------------------------------------------------------------
    # SKILLS SYSTEM (.bwskill)
    # ------------------------------------------------------------------------

    def register_skill(self, skill: SkillDefinition):
        """Registers a named .bwskill macro in the catalog."""
        self.skills[skill.name.lower()] = skill

    def load_skill_file(self, filepath: str) -> SkillDefinition:
        """Loads a .bwskill JSON macro file from disk."""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        skill = SkillDefinition(**data)
        self.register_skill(skill)
        return skill

    def _seed_builtin_skills(self):
        """Seeds standard architectural parametric skills."""
        # 1. perimeter_box: 4 walls + slab
        self.register_skill(
            SkillDefinition(
                name="perimeter_box",
                description="Constructs a 4-wall perimeter enclosure and concrete slab foundation",
                parameters={"width": 40.0, "depth": 30.0, "height": 10.0},
                commands=[
                    {"command": "WallCreate", "params": {"start": [0, 0, 0], "end": ["$width", 0, 0], "height": "$height", "thickness": 0.8333, "name": 'Basic Wall : Exterior - 10" CMU'}},
                    {"command": "WallCreate", "params": {"start": ["$width", 0, 0], "end": ["$width", "$depth", 0], "height": "$height", "thickness": 0.8333, "name": 'Basic Wall : Exterior - 10" CMU'}},
                    {"command": "WallCreate", "params": {"start": ["$width", "$depth", 0], "end": [0, "$depth", 0], "height": "$height", "thickness": 0.8333, "name": 'Basic Wall : Exterior - 10" CMU'}},
                    {"command": "WallCreate", "params": {"start": [0, "$depth", 0], "end": [0, 0, 0], "height": "$height", "thickness": 0.8333, "name": 'Basic Wall : Exterior - 10" CMU'}},
                    {"command": "SlabCreate", "params": {"polygon": [[0, 0], ["$width", 0], ["$width", "$depth"], [0, "$depth"]], "thickness": 0.8333, "elevation": 0.0, "name": 'Floor : 10" Concrete Slab'}},
                ],
                post_conditions=[
                    PostCondition(assertion="element_count_at_least", params={"min_count": 4, "category": "wall"}),
                    PostCondition(assertion="element_count_at_least", params={"min_count": 1, "category": "slab"}),
                ],
            )
        )

    def _try_plan_skill(self, prompt: str, ctx: AiContext) -> Optional[AiPlan]:
        """Checks if the prompt matches a known skill."""
        p_lower = prompt.lower().strip()
        for skill_name, skill in self.skills.items():
            pattern = rf"\b(?:run\s+skill|skill|execute\s+skill)\s+{re.escape(skill_name)}\b|^{re.escape(skill_name)}\b"
            if re.search(pattern, p_lower):
                params = dict(skill.parameters)
                # Parse numeric overrides: e.g. "perimeter_box width 50 depth 35"
                for k in params.keys():
                    m = re.search(rf"{k}\s*=?\s*(\d+(?:\.\d+)?)", p_lower)
                    if m:
                        params[k] = float(m.group(1))

                # Instantiate commands with recursive variable substitution
                def _substitute(val, depth=0):
                    if depth > 10:
                        return val
                    if isinstance(val, str):
                        if val.startswith("$") and val[1:] in params:
                            return _substitute(params[val[1:]], depth + 1)
                        res = val
                        for k, v in params.items():
                            res = re.sub(rf"\$\{{?{re.escape(k)}\}}?", str(v), res)
                        return res
                    elif isinstance(val, list):
                        return [_substitute(item, depth + 1) for item in val]
                    elif isinstance(val, dict):
                        return {k: _substitute(v, depth + 1) for k, v in val.items()}
                    return val

                cmds = []
                for t_cmd in skill.commands:
                    cmd_name = t_cmd["command"]
                    cmd_params = _substitute(json.loads(json.dumps(t_cmd["params"])))
                    cmds.append(CommandRequest(command=cmd_name, params=cmd_params))

                sub_posts = []
                for p in skill.post_conditions:
                    p_dict = json.loads(p.model_dump_json())
                    p_dict["params"] = _substitute(p_dict.get("params", {}))
                    sub_posts.append(PostCondition(**p_dict))

                return AiPlan(
                    intent_summary=f"Execute Skill '{skill.name}': {skill.description}",
                    commands=cmds,
                    post_conditions=sub_posts,
                )
        return None


# ============================================================================
# TRANSACTION EXECUTION & POST-CONDITION VERIFICATION (Atomic AI Driver)
# ============================================================================

class AiDriver:
    """
    Coordinates semantic queries, planning, atomic CommandBus execution,
    post-condition verification, and automatic rollback on invariant failure.
    """

    def __init__(self, manager: BimModelManager = bim_manager, bus=command_bus):
        self.manager = manager
        self.bus = bus
        self.planner = AiPlanner(manager)
        self.query_engine = SemanticQueryEngine(manager)

    def plan(self, prompt: str, context: Optional[AiContext] = None) -> AiPlan:
        """Synthesizes and validates a typed plan without executing it."""
        return self.planner.plan_prompt(prompt, context)

    def execute_plan(self, plan: AiPlan) -> Dict[str, Any]:
        """
        Executes a plan through the CommandBus as one atomic transaction tagged origin='ai'.
        Verifies post-conditions; if any assertion fails, immediately rolls back via abort_transaction!
        Execution and verification run inside a single critical section holding self.bus._lock (F7).
        """
        if not plan.commands:
            return {"status": "no_op", "detail": "Plan carries no commands"}

        with self.bus._lock:
            # 1. Execute transaction on CommandBus
            tx = self.bus.execute_transaction(
                commands=plan.commands,
                origin="ai",
                description=plan.intent_summary,
            )
            tx_id = tx["transaction_id"]

            # Collect executed GUIDs for post-condition scoping (F6)
            all_affected = list(plan.affected_guids or [])
            for r in tx.get("results", []):
                res_obj = r.get("result", {})
                if isinstance(res_obj, dict) and res_obj.get("guid"):
                    g = res_obj["guid"]
                    if g not in all_affected:
                        all_affected.append(g)

            # 2. Evaluate Post-Condition Assertions
            verified_checks = []
            try:
                for post in plan.post_conditions:
                    ok, err_msg = self._evaluate_assertion(post, affected_guids=all_affected)
                    if not ok:
                        raise AssertionError(
                            f"AI Post-Condition Assertion Failed: {post.description or post.assertion}. "
                            f"Cause: {err_msg}."
                        )
                    verified_checks.append(post.description or post.assertion)
            except Exception as exc:
                # Atomic rollback on assertion failure or assertion evaluation exception
                try:
                    self.bus.abort_transaction(tx_id)
                except Exception as rollback_err:
                    raise AssertionError(
                        f"AI execution verification failed ({exc}) and rollback encountered error: {rollback_err}"
                    ) from exc
                raise AssertionError(
                    f"AI Post-Condition Failed. Transaction {tx_id} aborted and rolled back. Cause: {exc}"
                ) from exc

            return {
                "status": "committed",
                "transaction_id": tx_id,
                "summary": plan.intent_summary,
                "commands_executed": len(plan.commands),
                "affected_guids": all_affected,
                "verified_assertions": verified_checks,
                "transaction": tx,
            }

    def _evaluate_assertion(
        self,
        post: PostCondition,
        affected_guids: Optional[List[str]] = None,
    ) -> Tuple[bool, str]:
        """Evaluates a single post-condition assertion against the active model."""
        ast = post.assertion
        params = post.params or {}

        if ast == "element_count_at_least":
            cat = params.get("category")
            try:
                min_c = int(params.get("min_count", 1))
            except (ValueError, TypeError) as e:
                return False, f"min_count parameter must be an integer, got '{params.get('min_count')}' ({e})"
            elems = self.query_engine.query_elements(category=cat)
            if len(elems) < min_c:
                return False, f"Expected at least {min_c} elements of category '{cat}', found {len(elems)}"
            return True, ""

        elif ast == "wall_length_approx":
            try:
                expected = float(params.get("expected_length", 0.0))
                tol = float(params.get("tolerance", 0.2))
            except (ValueError, TypeError) as e:
                return False, f"Invalid numerical parameters for wall_length_approx: {e}"

            target_guid = params.get("guid")
            candidates = []
            if target_guid:
                el = self.query_engine.get_element(target_guid)
                if el:
                    candidates.append(el)
            elif affected_guids:
                for g in affected_guids:
                    el = self.query_engine.get_element(g)
                    if el and el.get("ifc_class") in ("IfcWall", "IfcWallStandardCase"):
                        candidates.append(el)
            if not candidates:
                walls = self.query_engine.query_elements(category="wall")
                if not walls:
                    return False, "No walls found in model"
                candidates = walls

            # Check if any candidate wall matches within tolerance (F6)
            matching = [c for c in candidates if abs(float(c.get("length", 0.0)) - expected) <= tol]
            if matching:
                return True, ""
            actuals = [float(c.get("length", 0.0)) for c in candidates]
            return False, f"None of the candidate walls (lengths: {actuals}) match expected {expected} within tolerance {tol}"

        elif ast == "level_exists":
            name = (params.get("name") or "").lower()
            lvl_names = [l.get("name", "").lower() for l in self.manager.levels.values()]
            if name not in lvl_names:
                return False, f"Level '{params.get('name')}' not found in levels: {lvl_names}"
            return True, ""

        elif ast == "opening_hosted":
            host_guid = params.get("host_guid")
            cat = params.get("category")
            openings = self.query_engine.query_elements(category=cat, host_wall_guid=host_guid)
            if not openings:
                return False, f"No opening of category '{cat}' found hosted on wall {host_guid}"
            return True, ""

        elif ast == "sheet_exists":
            s_num = (params.get("sheet_number") or "").upper()
            found = any(s["sheet_number"].upper() == s_num for s in self.manager.get_sheets())
            if not found:
                return False, f"Sheet {s_num} not found in model"
            return True, ""

        elif ast == "element_exists":
            guid = params.get("guid")
            if not guid or guid not in self.manager.element_meta:
                return False, f"Element '{guid}' does not exist"
            return True, ""

        return False, f"Unknown post-condition assertion '{ast}'"

    # ------------------------------------------------------------------------
    # TOOL CATALOG FOR EXTERNAL AGENTS & MCP (Tier 2)
    # ------------------------------------------------------------------------

    def get_tool_catalog(self) -> Dict[str, Any]:
        """
        Exports the complete tool catalog (commands, queries, planning, verification)
        in JSON Schema 2020-12 format for LLM function calling and MCP.
        """
        schemas = self.bus.get_schemas()["commands"]
        tools = []

        # 1. CommandBus direct execution tool
        tools.append({
            "name": "execute_transaction",
            "description": "Executes one atomic transaction of typed CommandBus commands with full undo support.",
            "parameters": {
                "type": "object",
                "properties": {
                    "commands": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "command": {"type": "string", "enum": list(COMMAND_REGISTRY.keys())},
                                "params": {"type": "object"},
                            },
                            "required": ["command", "params"],
                        },
                    },
                    "description": {"type": "string"},
                },
                "required": ["commands", "description"],
            },
        })

        # 2. Semantic query tools
        tools.append({
            "name": "query_elements",
            "description": "Queries architectural elements by category, level, host, or bounding box.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["wall", "door", "window", "slab", "roof"]},
                    "level_id": {"type": "string"},
                    "host_wall_guid": {"type": "string"},
                    "min_x": {"type": "number"},
                    "max_x": {"type": "number"},
                    "min_y": {"type": "number"},
                    "max_y": {"type": "number"},
                },
            },
        })

        tools.append({
            "name": "describe_scene",
            "description": "Returns high-level semantic scene summary: envelope dimensions, cardinal walls, element counts, levels, sheets.",
            "parameters": {"type": "object", "properties": {}},
        })

        tools.append({
            "name": "get_element",
            "description": "Retrieves complete metadata, baseline, polygon, dimensions and hosted openings for a specific element GUID.",
            "parameters": {
                "type": "object",
                "properties": {"guid": {"type": "string"}},
                "required": ["guid"],
            },
        })

        # 3. High-level Prompt Plan & Execute tool
        tools.append({
            "name": "plan_and_execute_prompt",
            "description": "Translates a natural language architectural instruction into a typed plan and commits it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "active_view_id": {"type": "string"},
                    "selected_guids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["prompt"],
            },
        })

        # 4. Undo / Redo tools
        tools.append({
            "name": "undo",
            "description": "Undoes the most recent transaction on the CommandBus journal.",
            "parameters": {"type": "object", "properties": {}},
        })
        tools.append({
            "name": "redo",
            "description": "Redoes the most recently undone transaction.",
            "parameters": {"type": "object", "properties": {}},
        })

        return {
            "version": "2.1",
            "protocol": "BIMWorks_AI_Catalog_v2.1",
            "registered_commands_count": len(COMMAND_REGISTRY),
            "command_schemas": schemas,
            "tools": tools,
        }


# Global AI driver instance
ai_driver = AiDriver(bim_manager, command_bus)
