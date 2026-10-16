"""
BIMWorks - planar constraint solver (P3).

Wraps FreeCAD's PlaneGCS (the same solver FreeCAD's Sketcher uses) behind the
constraint vocabulary this application speaks: Align & Lock, locked dimensions
and Equalize (EQ). GPL-3.0-compatible, matching this project's licence.

Why a real solver replaced the old recursion
---------------------------------------------
`translate_element` used to propagate constraints by recursively copying the
delta to "locked" partners and, for EQ, did nothing at all -- so an EQ span held
at creation time and then silently stopped holding the moment anything moved
(review finding N6). It also appended a *new* `equalize` constraint on every
call, so wiring propagation into it would have accumulated duplicates.

Modelling the constraints as equations removes both problems: EQ is a persistent
relation between the span's endpoints and its interior elements, and moving
anything re-solves it.

The model
---------
Each constrained element contributes one movable node on the constraint axis
(its coordinate along that axis, from `manager.get_element_coord`). Span
endpoints may be pinned to a value when something else has already decided where
they go -- the solver then moves only what is free.

Constraints map to PlaneGCS primitives:

    Align & Lock   (ref, target, axis)     -> a fixed target coordinate equal to ref
    Locked dim     (a, b, axis, distance)  -> point-to-point distance
    Equalize       (start, end, interiors) -> equal spacing along the span

Conflicts
---------
`ConstraintSolve.solve()` reports `conflicting` when the solver returns
`SolveStatus.Conflict` (an over-constrained or inconsistent system) and leaves the
model untouched, so a bad constraint set is visible rather than silently applied.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple, Set, Any

try:
    from planegcs import Sketch, SolveStatus
except ImportError:  # pragma: no cover - surfaced by the caller as a clear error
    Sketch = None
    SolveStatus = None


class SolverUnavailable(RuntimeError):
    """Raised when planegcs is missing; the caller decides how loud to be."""


@dataclass
class ConstraintSolve:
    """Result of one solve: where each element ends up, and what went wrong."""

    axis: str
    status: str                      # "success" | "conflict" | "failed"
    coordinates: Dict[str, float] = field(default_factory=dict)
    pinned: Dict[str, float] = field(default_factory=dict)
    conflicting: List[str] = field(default_factory=list)
    moved: List[str] = field(default_factory=list)
    applied: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "success"

    def deltas(self, current: Dict[str, float]) -> Dict[str, float]:
        """Coordinate change per element, relative to `current`."""
        out: Dict[str, float] = {}
        for guid, value in self.coordinates.items():
            base = current.get(guid)
            if base is None:
                continue
            delta = value - base
            if abs(delta) > 1e-12:
                out[guid] = delta
        return out


class ConstraintSolver:
    """
    Builds and solves the constraint system for one axis at a time.

    Axis independence is not an approximation here: every constraint the
    application supports is axis-aligned (Align/Lock/EQ all carry a single
    `axis`), so the two axes are genuinely decoupled and solving them separately
    halves the problem size.
    """

    def __init__(self, manager):
        self.manager = manager

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _require_solver() -> None:
        if Sketch is None:
            raise SolverUnavailable(
                "planegcs is not installed; constraint solving is unavailable. "
                "Install it with `pip install planegcs` (GPL-3.0)."
            )

    def _position(self, guid: str, axis: str) -> Optional[float]:
        if guid not in self.manager.element_meta:
            return None
        return self.manager.get_element_coord(guid, axis)

    # -- scope --------------------------------------------------------------
    def affected_guids(self, guids: Sequence[str]) -> List[str]:
        """
        Expands a set of moved elements to everything whose position a constraint
        ties to them, transitively (across every axis).
        """
        scope = {g for g in guids if g in self.manager.element_meta}
        changed = True
        while changed:
            changed = False
            for c in self.manager.constraints.values():
                if not c.get("is_locked", True):
                    continue
                ctype = c.get("type")
                if ctype == "align":
                    pair = {c.get("ref_guid"), c.get("target_guid")}
                elif ctype == "dimension_lock":
                    pair = {c.get("guid_a"), c.get("guid_b")}
                elif ctype == "equalize":
                    pair = set(c.get("interior_guids") or []) | {
                        c.get("span_start_guid"), c.get("span_end_guid")
                    }
                else:
                    continue
                pair.discard(None)
                if pair & scope and not pair <= scope:
                    scope |= pair
                    changed = True
        return sorted(scope)

    # -- core ---------------------------------------------------------------
    def solve(
        self,
        axis: str,
        pins: Optional[Dict[str, float]] = None,
        scope: Optional[Sequence[str]] = None,
        extras: Optional[List[Tuple[str, tuple]]] = None,
        pin_span_endpoints: bool = True,
    ) -> ConstraintSolve:
        """
        Solves for new coordinates along `axis`.

        `pins` fixes elements at a coordinate (used for the element the user just
        moved, and for anything rigidly following it). `scope` limits which
        elements may move; anything outside it keeps its current position. `extras`
        adds constraints that are not (yet) persisted, e.g. the delta of an
        in-progress drag.
        """
        pins = dict(pins or {})
        extras = list(extras or [])

        # Which elements participate: everything in scope plus every constraint
        # partner, so a constraint is never solved against a missing node.
        participants = set(scope or [])
        participants |= set(pins)
        participants = {
            g for g in self.affected_guids(sorted(participants)) if g in self.manager.element_meta
        }
        if not participants:
            return ConstraintSolve(axis=axis, status="success")

        coords: Dict[str, float] = {}
        for g in sorted(participants):
            pos = self._position(g, axis)
            if pos is None:
                continue
            coords[g] = pos

        # An EQ span defines the spacing between its two endpoints, so both are
        # held at their current coordinates while the interior elements are
        # redistributed. Left free, the far endpoint drifts a hair (observed:
        # 40.018 instead of 40) because the equal-length chain can be satisfied by
        # nudging everything slightly rather than by moving only the interiors.
        for c in (self.manager.constraints.values() if pin_span_endpoints else []):
            if c.get("type") != "equalize" or c.get("axis", "x") != axis:
                continue
            if not c.get("is_locked", True):
                continue
            span = {c.get("span_start_guid"), c.get("span_end_guid")}
            if not span & participants:
                continue
            for g in span:
                if g in coords:
                    pins.setdefault(g, coords[g])
        for g in list(pins):
            if g in coords:
                coords[g] = pins[g]

        if Sketch is None:
            return self._solve_pure_python(axis, coords, pins, extras, participants)

        self._require_solver()

        sketch = Sketch()
        ids: Dict[str, int] = {}
        fixed: set = set()
        for g in sorted(coords):
            if g in pins:
                ids[g] = sketch.add_fixed_point(float(pins[g]), 0.0)
                fixed.add(g)
            else:
                ids[g] = sketch.add_point(float(coords[g]), 0.0)

        applied: List[str] = []
        conflicting: List[str] = []

        def add_p2p(a: str, b: str, distance: float) -> bool:
            if a not in ids or b not in ids:
                return False
            sketch.set_p2p_distance(ids[a], ids[b], float(distance))
            return True

        coincident_pairs: Set[Tuple[str, str]] = set()

        for kind, payload in extras:
            if kind == "equalize":
                start, end, interiors = payload
                self._apply_equalize(sketch, ids, start, end, interiors, conflicting, add_p2p)
                applied.append("extra:equalize")
            elif kind == "align":
                ref_g, tgt_g = payload
                pair = tuple(sorted((ref_g, tgt_g)))
                if ref_g in ids and tgt_g in ids and pair not in coincident_pairs:
                    sketch.coincident(ids[ref_g], ids[tgt_g])
                    coincident_pairs.add(pair)
                    applied.append("extra:align")
            elif kind == "dimension_lock":
                a, b, dist = payload
                if add_p2p(a, b, float(dist)):
                    applied.append("extra:dimension_lock")

        for cid, c in sorted(self.manager.constraints.items()):
            if not c.get("is_locked", True):
                continue
            if c.get("axis", "x") != axis:
                continue
            ctype = c.get("type")
            if ctype == "align":
                ref, target = c.get("ref_guid"), c.get("target_guid")
                pair = tuple(sorted((ref, target)))
                if ref in ids and target in ids and pair not in coincident_pairs:
                    # Rigid: the target sits exactly on the reference's coordinate.
                    sketch.coincident(ids[ref], ids[target])
                    coincident_pairs.add(pair)
                    applied.append(cid)
            elif ctype == "dimension_lock":
                a, b = c.get("guid_a"), c.get("guid_b")
                dist = c.get("locked_distance")
                if dist is None:
                    ref = self._position(a, axis)
                    cur = self._position(b, axis)
                    if ref is not None and cur is not None:
                        dist = abs(cur - ref)
                if dist is not None and add_p2p(a, b, float(dist)):
                    applied.append(cid)
            elif ctype == "equalize":
                start, end = c.get("span_start_guid"), c.get("span_end_guid")
                interiors = c.get("interior_guids") or []
                self._apply_equalize(sketch, ids, start, end, interiors, conflicting, add_p2p)
                applied.append(cid)

        try:
            status = sketch.solve()
        except Exception as e:  # solver blew up: report rather than mutate
            return ConstraintSolve(
                axis=axis, status="failed", conflicting=[f"{type(e).__name__}: {e}"],
                coordinates=dict(coords), pinned=pins,
            )

        name = getattr(status, "name", str(status))
        if name not in ("Success", "Converged"):
            # Over-constrained or inconsistent: report the constrained elements so
            # the caller can surface a conflicting set instead of guessing.
            return ConstraintSolve(
                axis=axis, status="conflict",
                conflicting=sorted(set(applied)) or sorted(participants),
                coordinates=dict(coords), pinned=pins,
            )

        out: Dict[str, float] = {}
        for g, pid in ids.items():
            try:
                x, _y = sketch.get_point(pid)
            except Exception:
                x = coords[g]
            out[g] = float(x)

        moved = [g for g, v in out.items() if abs(v - coords.get(g, v)) > 1e-9]
        return ConstraintSolve(
            axis=axis, status="success", coordinates=out, pinned=pins,
            conflicting=conflicting, moved=sorted(moved), applied=sorted(set(applied)),
        )

    def _solve_pure_python(
        self,
        axis: str,
        coords: Dict[str, float],
        pins: Dict[str, float],
        extras: List[Any],
        participants: Set[str],
    ) -> ConstraintSolve:
        out = dict(coords)
        for g, p in pins.items():
            if g in out:
                out[g] = float(p)

        fixed = set(pins.keys())
        applied = []
        conflicting = []

        active_constraints = []
        for kind, payload in extras:
            if kind == "equalize":
                start, end, interiors = payload
                active_constraints.append({
                    "id": "extra:equalize",
                    "type": "equalize",
                    "span_start_guid": start,
                    "span_end_guid": end,
                    "interior_guids": interiors,
                })
            elif kind == "align":
                ref_g, tgt_g = payload
                active_constraints.append({
                    "id": "extra:align",
                    "type": "align",
                    "ref_guid": ref_g,
                    "target_guid": tgt_g,
                })
            elif kind == "dimension_lock":
                a, b, dist = payload
                active_constraints.append({
                    "id": "extra:dimension_lock",
                    "type": "dimension_lock",
                    "guid_a": a,
                    "guid_b": b,
                    "locked_distance": float(dist),
                })

        for cid, c in sorted(self.manager.constraints.items()):
            if not c.get("is_locked", True):
                continue
            if c.get("axis", "x") != axis:
                continue
            active_constraints.append(dict(c))

        for _ in range(len(out) + 5):
            changed = False
            for c in active_constraints:
                cid = c.get("id")
                ctype = c.get("type")
                if ctype == "align":
                    ref = c.get("ref_guid")
                    tgt = c.get("target_guid")
                    if ref in out and tgt in out:
                        if ref in fixed and tgt not in fixed:
                            out[tgt] = out[ref]
                            fixed.add(tgt)
                            changed = True
                            applied.append(cid)
                        elif tgt in fixed and ref not in fixed:
                            out[ref] = out[tgt]
                            fixed.add(ref)
                            changed = True
                            applied.append(cid)
                        elif ref in fixed and tgt in fixed:
                            if abs(out[ref] - out[tgt]) > 1e-4:
                                conflicting.append(cid)
                            else:
                                applied.append(cid)
                        elif ref in out and tgt in out:
                            out[tgt] = out[ref]
                            applied.append(cid)

                elif ctype == "dimension_lock":
                    a = c.get("guid_a")
                    b = c.get("guid_b")
                    dist = c.get("locked_distance")
                    if a in out and b in out:
                        orig_a = self._position(a, axis) or 0.0
                        orig_b = self._position(b, axis) or 0.0
                        sign = 1.0 if orig_b >= orig_a else -1.0
                        if dist is None:
                            dist = abs(orig_b - orig_a)
                        target_dist = float(dist)

                        if a in fixed and b not in fixed:
                            out[b] = out[a] + sign * target_dist
                            fixed.add(b)
                            changed = True
                            applied.append(cid)
                        elif b in fixed and a not in fixed:
                            out[a] = out[b] - sign * target_dist
                            fixed.add(a)
                            changed = True
                            applied.append(cid)
                        elif a in fixed and b in fixed:
                            if abs(abs(out[b] - out[a]) - target_dist) > 1e-4:
                                conflicting.append(cid)
                            else:
                                applied.append(cid)

                elif ctype == "equalize":
                    start = c.get("span_start_guid")
                    end = c.get("span_end_guid")
                    interiors = c.get("interior_guids") or []
                    if start in out and end in out and interiors:
                        span_len = out[end] - out[start]
                        step = span_len / (len(interiors) + 1)
                        for i, ig in enumerate(interiors):
                            if ig in out:
                                target_pos = out[start] + (i + 1) * step
                                if abs(out[ig] - target_pos) > 1e-9:
                                    out[ig] = target_pos
                                    changed = True
                        applied.append(cid)

            if not changed:
                break

        if conflicting:
            return ConstraintSolve(
                axis=axis,
                status="conflict",
                conflicting=sorted(set(conflicting)),
                coordinates=dict(coords),
                pinned=pins,
            )

        moved = [g for g, v in out.items() if abs(v - coords.get(g, v)) > 1e-9]
        return ConstraintSolve(
            axis=axis,
            status="success",
            coordinates=out,
            pinned=pins,
            conflicting=[],
            moved=sorted(moved),
            applied=sorted(set(applied)),
        )

    def _apply_equalize(self, sketch, ids, start, end, interiors, conflicting, add_p2p) -> None:
        """
        EQ as one relation over the ordered span: start, interiors..., end with
        equal gaps between consecutive items.

        Implemented with `equal_length` on the segments between consecutive nodes,
        which is exactly "equal spacing" and -- unlike a chain of absolute
        distances -- stays consistent when a *span endpoint* moves, which is the
        case the old code silently failed.
        """
        chain = [g for g in [start, *interiors, end] if g in ids]
        if len(chain) < 3:
            if interiors:
                conflicting.append("equalize: span needs a start, an end and at least one interior")
            return
        segments = []
        for a, b in zip(chain, chain[1:]):
            try:
                segments.append(sketch.add_line(ids[a], ids[b]))
            except Exception:
                return
        for first, second in zip(segments, segments[1:]):
            try:
                sketch.equal_length(first, second)
            except Exception:
                return

    # -- public operations --------------------------------------------------
    def redistribute(self, guid: str, axis: str, new_coord: float) -> ConstraintSolve:
        """
        Re-solves with `guid` pinned at `new_coord` on `axis`.

        This is the propagation primitive: the caller has decided where one
        element goes, and everything constrained to it is re-derived. EQ
        redistributes its interior elements instead of being ignored, which is the
        behaviour the old recursive delta-copy could not express.
        """
        return self.solve(axis=axis, pins={guid: float(new_coord)})

    def apply_solve(self, result: ConstraintSolve) -> List[str]:
        """
        Writes a successful solve back into the model via `translate_element`.

        Returns the GUIDs that actually moved. A non-successful solve changes
        nothing, so a conflict can never leave the model half-updated.
        """
        if not result.ok:
            return []
        current = {g: self._position(g, result.axis) for g in result.coordinates}
        moved: List[str] = []
        for guid, delta in result.deltas({k: v for k, v in current.items() if v is not None}).items():
            dx = delta if result.axis == "x" else 0.0
            dy = delta if result.axis == "y" else 0.0
            if self.manager.translate_element(guid, dx, dy, 0.0, _propagate=False):
                moved.append(guid)
        return moved

    def equalize(
        self,
        span_start_guid: str,
        span_end_guid: str,
        interior_guids: Sequence[str],
        axis: str = "x",
    ) -> ConstraintSolve:
        """
        Solves an EQ span: endpoints stay put, interior elements become equally
        spaced between them.
        """
        pins: Dict[str, float] = {}
        for g in (span_start_guid, span_end_guid):
            pos = self._position(g, axis)
            if pos is not None:
                pins[g] = pos
        scope = [g for g in interior_guids if g in self.manager.element_meta]
        # No `extras` here: the equalize relation is already a persisted constraint,
        # and `solve()` applies it. Passing it as an extra as well built the same
        # equal-length chain twice on one sketch, which the solver reported as a
        # conflict (it cannot tell a duplicated constraint from an inconsistent one).
        return self.solve(
            axis=axis,
            pins=pins,
            scope=scope,
            pin_span_endpoints=False,   # already pinned explicitly above
        )
