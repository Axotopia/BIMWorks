"""
BIMWorks - element dependency graph (P3).

Spec §3.2 asks for a dependency graph with dirty-flag topological recompute
rather than ad-hoc recursion. Before P3 the only dependency handling was
`translate_element`'s recursive delta-copy plus a *global* join pass, so:

  * the cost of any edit was O(all walls) regardless of what actually changed, and
  * a storey had no relationship to its elements at all — moving a level moved
    nothing (the README M2 gate explicitly requires "move Level 2 → constrained
    walls follow").

This module makes the dependency structure explicit. Nodes are elements (and
levels); edges are the relationships that make one node's geometry depend on
another:

    level    element -> level it sits on (moving the level moves the element)
    host     opening -> wall that hosts it
    join     wall <-> wall that share an endpoint (their footprints interact)
    constraint  element <-> element tied by a solved constraint

What it is *not*: a general parametric feature graph. Sketch membership and type
parameters belong to P4/P2's overlay schema; this covers the edges that exist
today, so the graph stays truthful rather than aspirational.
"""

from collections import defaultdict, deque
from typing import Dict, Iterable, List, Optional, Sequence, Set


class DependencyGraph:
    """Tracks element dependencies and which nodes need recomputing."""

    #: Edge kinds, in the order recompute should process them.
    EDGE_KINDS = ("level", "host", "join", "constraint")

    def __init__(self, manager):
        self.manager = manager
        # node -> {kind: set(nodes it depends on)}
        self._deps: Dict[str, Dict[str, Set[str]]] = defaultdict(lambda: defaultdict(set))
        # node -> {kind: set(nodes that depend on it)}
        self._dependents: Dict[str, Dict[str, Set[str]]] = defaultdict(lambda: defaultdict(set))
        self._dirty: Set[str] = set()
        #: Per-recompute counters, for the p95 measurement and for proving the
        #: recompute is actually incremental.
        self.last_stats: Dict[str, int] = {}

    # -- construction -------------------------------------------------------
    @classmethod
    def build(cls, manager) -> "DependencyGraph":
        """Rebuilds the whole graph from current model state."""
        g = cls(manager)
        g.rebuild()
        return g

    def rebuild(self) -> None:
        self._deps.clear()
        self._dependents.clear()
        self._dirty.clear()
        meta = self.manager.element_meta

        for guid, m in meta.items():
            # level edge
            level_id = m.get("level_id")
            if level_id:
                self._link(guid, level_id, "level")
            # host edge
            host = m.get("host_wall_guid")
            if host and host in meta:
                self._link(guid, host, "host")
            # constraint edges
            for c in self.manager.constraints.values():
                if not c.get("is_locked", True):
                    continue
                ctype = c.get("type")
                if ctype == "align":
                    self._link_pair(c.get("ref_guid"), c.get("target_guid"), "constraint")
                elif ctype == "dimension_lock":
                    self._link_pair(c.get("guid_a"), c.get("guid_b"), "constraint")
                elif ctype == "equalize":
                    members = [c.get("span_start_guid"), c.get("span_end_guid"),
                               *(c.get("interior_guids") or [])]
                    members = [x for x in members if x]
                    for a in members:
                        for b in members:
                            if a != b:
                                self._link_pair(a, b, "constraint")

        # join edges: walls that share an endpoint coordinate
        walls = [g for g, m in meta.items()
                 if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase") and m.get("start")]
        tol = 1e-6
        endpoints: Dict[tuple, List[str]] = defaultdict(list)
        for g in walls:
            m = meta[g]
            for p in (m.get("start"), m.get("end")):
                if p:
                    endpoints[(round(float(p[0]), 6), round(float(p[1]), 6))].append(g)
        for shared in endpoints.values():
            for a in shared:
                for b in shared:
                    if a != b:
                        self._link_pair(a, b, "join")

    def _link(self, node: str, dependency: str, kind: str) -> None:
        self._deps[node][kind].add(dependency)
        self._dependents[dependency][kind].add(node)

    def _link_pair(self, a: Optional[str], b: Optional[str], kind: str) -> None:
        if not a or not b or a == b:
            return
        self._link(a, b, kind)
        self._link(b, a, kind)

    # -- queries ------------------------------------------------------------
    def dependencies(self, node: str) -> Set[str]:
        out: Set[str] = set()
        for s in self._deps.get(node, {}).values():
            out |= s
        return out

    def dependents(self, node: str) -> Set[str]:
        out: Set[str] = set()
        for s in self._dependents.get(node, {}).values():
            out |= s
        return out

    def neighborhood(self, guid: str) -> Set[str]:
        """
        `guid` plus everything directly or transitively affected by it.

        This is the set an edit must recompute — the point of the graph, and what
        replaces "recompute every wall in the model".
        """
        seen: Set[str] = set()
        queue: deque = deque([guid])
        while queue:
            node = queue.popleft()
            if node in seen:
                continue
            seen.add(node)
            for dep in self.dependents(node):
                if dep not in seen:
                    queue.append(dep)
        return seen

    # -- dirty tracking -----------------------------------------------------
    def mark_dirty(self, *guids: str) -> None:
        for g in guids:
            self._dirty.add(g)

    @property
    def dirty(self) -> Set[str]:
        return set(self._dirty)

    def clear_dirty(self) -> None:
        self._dirty.clear()

    # -- recompute ----------------------------------------------------------
    def recompute(self, changed: Sequence[str], kinds: Iterable[str] = EDGE_KINDS) -> Dict[str, int]:
        """
        Recomputes only what `changed` can affect, in dependency order.

        Returns counters describing the work done, which is what makes the
        incremental claim checkable (`walls_recomputed` should be far below the
        model size for a local edit).
        """
        kinds = tuple(kinds)
        # Walk only along the edge kinds the caller asked about, transitively.
        # `join` is deliberately excluded from the transitive walk (see below): its
        # effect is local, so treating it as transitive would recompute an entire
        # connected chain for a single edit.
        walk_kinds = tuple(k for k in kinds if k != "join")
        affected: Set[str] = set()
        for g in changed:
            affected.add(g)
            queue = deque([g])
            while queue:
                node = queue.popleft()
                for kind in walk_kinds:
                    for dep in self._dependents.get(node, {}).get(kind, set()):
                        if dep not in affected:
                            affected.add(dep)
                            queue.append(dep)
        affected = {a for a in affected if a in self.manager.element_meta}
        stats = {"affected": len(affected), "walls_recomputed": 0, "walls_total": 0}

        walls = [g for g, m in self.manager.element_meta.items()
                 if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")]
        stats["walls_total"] = len(walls)

        if "join" in kinds:
            # Seeded from `changed` (not from the transitively-walked `affected`),
            # then widened by one hop of join partners. One hop is the correct
            # radius: a wall's own geometry determines its joins, so moving C0
            # requires recomputing C0 and its partners, but C2's join with C1 is
            # untouched because C1's baseline never changed.
            walls_to_fix: Set[str] = set()
            for g in changed:
                if g not in self.manager.element_meta:
                    continue
                walls_to_fix.add(g)
                walls_to_fix |= self._dependents.get(g, {}).get("join", set())
            walls_to_fix = sorted(
                g for g in walls_to_fix
                if self.manager.element_meta[g].get("ifc_class")
                in ("IfcWall", "IfcWallStandardCase")
            )
            stats["walls_recomputed"] = len(walls_to_fix)
            if walls_to_fix:
                self.manager.recompute_wall_joins(only=walls_to_fix)

        if "constraint" in kinds or not kinds:
            # Re-resolve dimensions for affected nodes with constraint dependencies (Phase 3.4)
            for node in affected:
                if hasattr(self.manager, "_re_resolve_dimensions_after_move"):
                    self.manager._re_resolve_dimensions_after_move(node)

        self.mark_dirty(*changed)
        stats["dirty"] = len(self._dirty)
        self.last_stats = stats
        return stats
