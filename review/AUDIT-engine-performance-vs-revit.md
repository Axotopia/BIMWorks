# AUDIT — Engine architecture & performance vs Revit

**Date:** 2026-10-15
**Branch:** `gemini` @ `318ce26`
**Scope:** `backend/ifc_service.py`, `backend/command_bus.py`, `backend/dependency_graph.py`,
`backend/constraint_solver.py`, `backend/main.py`, `backend/hlr_renderer.py`, `backend/mesh_hlr.py`,
`backend/units.py`, `backend/sketch_model.py`, `src/store/useBimStore.ts`,
`scripts/check-delta-equivalence.mjs`
**Inputs read:** `docs/DELTA-MEASUREMENT.md`, `docs/IMPLEMENTATION-PLAN-2026-10-14.md` §0.1/§0.2/§P3,
`docs/SPECIFICATION-v0.2.md` §6.3/§6.4/§19

**Method.** Every verdict below is either (a) backed by a `file:line` reading, (b) measured by
executing the engine, or (c) explicitly marked *(unverified)*. Measurements come from four throwaway
scripts written to `%TEMP%` and **not committed**: `bimworks_bench.py` (in-process stage breakdown),
`bimworks_probe2.py` (solver / load / slice), `bimworks_e2e.py` (real HTTP edit round trip),
`bimworks_payload.py` + `bimworks_delta_check.py` (payload composition, delta equivalence). No file in
the repository was modified except this audit.

**Headline.** The delta protocol is **real, correct, and load-bearing**, and it fixed the specific
defect §0.2 recorded (seven serial refetches are now two round trips). But the delta protocol
optimised the *response envelope* while the *model work* behind it stayed O(N) per edit. The result is
that N10 is only partly retired: measured end-to-end edit latency is **66 ms p50 at 50 walls and 275 ms
p50 at 200 walls** against a 16 ms budget, and the single largest contributor is not the mesh delta
(1.1 KB) but the **full-storey 2D linework re-render shipped on every edit (442 KB)**.

---

## Summary table

| # | Area | Verdict | Measured cost (this machine, today) | Highest-impact gap | Evidence |
|---|---|---|---|---|---|
| 1 | Edit latency path | **PARTIAL** | 2 round trips (was 7); 66 ms p50 @ 50 walls, **275 ms p50 / 279 ms p95 @ 200 walls**; 992 ms in-process @ 1000 walls. Budget 16 ms | Join pass + whole-storey slice re-render per edit; no push | `useBimStore.ts:2168-2193`; `ifc_service.py:2022`; `main.py:1062` |
| 2 | Model of record re-serialized per edit? | **PRESENT (defect)** | Whole IFC STEP text written **twice** per edit — 1.42 MB each @ 1000 walls; ~83 ms each | Full `model.to_string()` + `deepcopy` of every element's cached tessellation, per edit, to serve undo | `ifc_service.py:397-445` (`snapshot_state`), `:420`; `command_bus.py:642,677` |
| 3 | Recompute granularity | **ABSENT** on the edit path | Global join pass: 2,002 `_find_join_partner` calls × 1001 walls = **2,004,002 wall visits** per single-wall move @ N=1000; 800 ms | `translate_element` calls `recompute_wall_joins()` with no `only=`; every partner search scans the full wall set → O(N²) | `ifc_service.py:2022`, `:2796-2821`, `:2767`; `dependency_graph.py:192-211` (exists, not called from the drag path) |
| 4 | Constraint solving | **PARTIAL** | Solve is O(C) and **not scoped**: 29 constraints / 32 elements → 31 participants in one sketch, 0.36 ms. EQ **does** propagate; no duplicate append. Constraints are **not** re-solved on load | `solve()` applies *every* constraint on the axis regardless of `scope`; `rebuild_from_overlay` computes no coordinates | `constraint_solver.py:110-137`, `:224-250`; `ifc_service.py:2110-2161`, `:3374-3377`, `:4892` |
| 5 | Transport | **PARTIAL** | Response A 104 B / 3.1 ms. Response B: **442 KB slice2d + 1.1 KB mesh** = 444 KB @ 200 walls; reduction only **35.4%** (measured), not the documented 76% | `slice2d` is recomputed in full and shipped on **every** delta; those bytes outweigh the delta 400:1. No push/websocket anywhere | `main.py:1062`, `:1030-1109`; `ifc_service.py:4087-4131`; `mesh_hlr.py:438-449`; searched for `websocket`/`event-stream` in `backend/*.py` and `src/**` — **absent** |
| 6 | Geometry pipeline cost | **PARTIAL** | Mesh delta strictly O(changed) — **0.07–0.18 ms @ 200–1000 walls** (the one genuinely Revit-class number). Cached tessellation is shared-vertex-count based. No epoch/revision in the cache key. Slice: 30.6 ms @ 50, **144 ms @ 200** | Element cache has no revision/epoch key — invalidation is imperative and per-call-site; slice output has **no cache at all**, so every commit re-projects the whole storey | `ifc_service.py:3460-3472`, `:3503-3550`; `:545-556`; `:3012-3025`; `_invalidate_geometry_cache` has 4 call sites (`:1558,1661,1941`); caches excluded from the overlay (`:1255`) |
| 7 | Concurrency | **PARTIAL / ABSENT** | Single uvicorn process, one global document, all model routes `def` → threadpool, serialized by one `RLock`. No queue, no cancellation, no optimistic UI. A 275 ms commit is 275 ms with no frame shown | No push and no optimistic apply: the store `await`s both round trips before repaint; no continuous drag path exists to make it visible yet | `main.py:1147`; `command_bus.py:373,640` vs only 3 `async def` (upload routes) `main.py:320,777,795`; `useBimStore.ts:2170-2193` |
| 8 | Scale test evidence | **ABSENT** | **No test or gate measures 2,000 elements or 60 fps.** Largest corpus in any test is 13–25 elements; largest in my benchmark 1,001. `range(...)` scanning every `scratch/*.py` and `scripts/*.mjs` finds no loop above 200. The documented p95 4.9 ms came from 12 walls; I reproduce 3.63/4.32 ms | A budget with no corpus is not a measurement — and the only latency gate reports rather than asserts | `scratch/test_dependency_graph.py:241-265`; `package.json` `check` = 4 parity/equivalence gates + `tsc`, none timed |
| 9 | Persistence & durability | **PARTIAL** | Save is explicit, not per-edit: 15.8 ms / 11.5 KB @ 30 walls. Load/rebuild **92 ms @ 30 elements** → ≈6 s at 2,000 *(extrapolated, linear)*. No autosave, no journal-on-disk | Save cost is O(N) and synchronous; nothing is durable until the user saves, while the undo stack holds two full snapshots per entry in RAM | `ifc_service.py:4718-4744`, `:3292-3377`; `main.py:757-761`; `command_bus.py:670-679` |
| 10 | What Revit does differently | **n/a** | — | In-process document + regeneration engine: element-scoped regeneration, no file re-serialization per edit, persistent display lists. BIMWorks' equivalent is a *persistent* dependency graph, an incremental serializer, and a revisioned display-list cache | see §10 |

---

## Measured baseline

All numbers below were produced on this machine today. "In-process" = the engine called directly;
"HTTP" = the real two-request UI sequence against `uvicorn` on `127.0.0.1:8018/8019/8021`.

### B1. In-process: one `WallMove` transaction, stage by stage

Model: a straight chain of *N* touching walls (each shares an endpoint with its neighbour), 10 ft high,
6" thick, one storey. Reps = 25 per stage.

| N (walls) | total tx p50 | **p95** | snapshot pre | command (join pass) | snapshot post | geometry delta | full join pass | partner calls | wall visits |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 28.4 ms | 32.8 ms | 4.3 ms | 19.4 ms | 4.6 ms | 0.07 ms | 18.6 ms | 102 | 5,202 |
| 200 | 122.8 ms | 157.3 ms | 15.9 ms | 86.8 ms | 16.5 ms | 0.10 ms | 86.3 ms | 402 | 80,802 |
| 1000 | **992.4 ms** | **1134.1 ms** | 83.4 ms | 802.9 ms | 84.6 ms | 0.18 ms | 800.0 ms | 2,002 | **2,004,002** |

- **Cost is O(N), not O(log N) and not O(changed).** `command` ≈ `full join pass` ≈ 0.8 ms per wall.
- **Wall visits = 2N² + 2**: the join pass makes ~2N `_find_join_partner` calls and each scans all ~N
  walls (`ifc_service.py:2767`). This is the O(N²) N10 named, and it is still the dominant term.
- Extrapolating the measured trend to the spec's 2,000-element budget gives **≈3.2 s per wall move**
  *(extrapolated from the 1000-wall measurement; not measured at 2,000)*.
- Building 1,000 walls took **322.9 s** (one `add_wall` = 792.8 ms at N=1000), which is the same
  global join pass firing on every creation (`ifc_service.py:1446`).

### B2. HTTP: the real per-edit sequence

Per edit the UI issues `POST /api/transaction` then `GET /api/state?since=…` (2 round trips).

| N (walls) | transaction p50 | state p50 | **edit total p50** | **p95** | delta bytes p50 | upsert meshes | slice2d present |
|---|---|---|---|---|---|---|---|
| 50 | 30.1 ms | 35.4 ms | **65.6 ms** | 74.1 ms | 114,638 B | 1 | always |
| 200 | 123.2 ms | 150.9 ms | **274.6 ms** | 279.2 ms | 413,728 B | 1 | always |

Engine-side breakdown of the Response B call @ 200 walls: `slice2d` **131.1 ms**, `geometry` 1.4 ms,
`journal` 0.06 ms. Delta payload composition @ 200 walls:

| Field | Bytes | Share |
|---|---|---|
| `slice2d` | **442,482** | **99.6 %** |
| `upsert_meshes` (1 mesh, 24 verts) | 1,107 | 0.25 % |
| `journal_append` | 348 | 0.08 % |
| everything else | ~390 | 0.09 % |
| **total** | **444,329** | full bundle is 640,186 B |

Payload reduction measured: **37.1 % @ 50 walls, 35.4 % @ 200 walls** — against the 76.8 % claimed for
a 250-element model in `docs/DELTA-MEASUREMENT.md:60`. Response A is excellent: **104 B / 3.1 ms**.
`slice2d` was present in the delta on **12/12** edits at both sizes, including with `level_id` omitted.

### B3. Memory and durability cost of undo

`snapshot_state` (`ifc_service.py:397`) keeps the **complete IFC STEP text** (`:420`) plus a
`deepcopy` of every element's `meta` — which by then contains `cached_verts`/`cached_faces`
(`:3461-3472`). Every transaction stores two of these on the undo stack (`command_bus.py:642,677`).

| N | `ifc_text` chars / snapshot | `element_meta` repr chars | bytes added to undo stack per 10 edits | peak traced RAM |
|---|---|---|---|---|
| 50 | 89,097 | 50,011 | 3.79 MB | 3.80 MB |
| 200 | 290,756 | 199,900 | 14.58 MB | 14.61 MB |
| 1000 | **1,418,136** | **1,006,399** | *(not run)* | *(not run)* |

≈1.0 KB of cached tessellation deep-copied per element, twice, per edit.

### B4. Solver, load, slice

| Probe | Result |
|---|---|
| planegcs installed | yes |
| EQ propagation after moving the span's far endpoint | **holds** — `[5,15,25,35,45]` → `[5,17.5,30,42.5,55]` (equal 12.5 ft spacing) |
| Repeated `equalize_span` | constraint count 1 → 1: **no duplicate appended** (N6's append bug is fixed) |
| `solve(scope=[2 elements])` with 9 constraints / 12 elements | **11 participants** (whole connected component) |
| `solve(scope=[2])` with 29 constraints / 32 elements | **31 participants**, 0.36 ms |
| Save container (30 elements, 7 constraints) | 15.8 ms, 11,540 B |
| Load/rebuild same container | **92.3 ms** (reused manager) / 93.1 ms (fresh) |
| `slice_2d_vector_plan` (mesh-HLR, default renderer) | **7.6 ms @ 13, 30.6 ms @ 50, 144.1 ms @ 200** |
| `slice_2d_vector_plan` (`renderer="analytic"`) | 0.04 / 0.14 / 0.57 ms |

### B5. Delta equivalence over 6 sequential edits (20×2 wall grid + door)

GUID sets matched, **0 vertex mismatches**, removals and upserts both exercised, replica == full
resync. Per-edit delta bytes 93.9–98.2 KB, of which `slice2d` again dominated. **The protocol is
correct**; it is the payload that is oversized.

### B6. What the documented 4.9 ms actually measures

`scratch/test_dependency_graph.py:241-265` times `m.translate_element(...)` + `graph.recompute([...])`
over 60 iterations on `corner_chain(m)` (8 chained walls + 4 unrelated). Re-running it today:

```
-> wall-drag p50 3.63 ms, p95 4.32 ms over 60 drags (budget 16 ms)
RESULT: 41 passed, 0 failed
```

The figure is real but measures a **12-element, in-process** corpus with the transaction wrapper,
snapshots, HTTP, and 2D slice excluded. §0.2 already flagged this ("about a tenth of what a user
waits for"); it is still the only committed latency number. Note the test also passes `graph.recompute`
*after* `translate_element` already ran the global join pass — so the measured 4.3 ms contains **two**
join computations, and the production drag path needs only the first.

---

## 1. Edit latency path — PARTIAL

### Traced end to end (one wall drag)

| # | Stage | Code | Full-model passes |
|---|---|---|---|
| 1 | UI pointer/nudge → store action | `useBimStore.ts:1762-1764` | — |
| 2 | `dispatchTransaction('translateElement', …)` → `executeTransaction` | `useBimStore.ts:2202-2209`, `:2168` | — |
| 3 | `POST /api/transaction` | `main.py:847-855` | — |
| 4 | `execute_transaction` → **whole IFC re-serialized** | `command_bus.py:642` → `ifc_service.py:420` | **1** |
| 5 | `WallMove` → `translate_element` | `command_bus.py:406-411`, `ifc_service.py:1972` | — |
| 6 | shift baseline / cached verts / bbox | `ifc_service.py:1998-2019` | — |
| 7 | **global join pass** | `ifc_service.py:2022` → `:2796` | **2** (O(N²) inside) |
| 8 | constraint re-solve (x and y) | `ifc_service.py:2102-2104`, `:2110-2161` | passes over all constraints |
| 9 | **whole IFC re-serialized again** into the undo entry | `command_bus.py:677` → `ifc_service.py:420` | **3** |
| 10 | `GET /api/state?since=…` | `useBimStore.ts:1263` → `main.py:945` | — |
| 11 | delta scan over `element_meta` | `ifc_service.py:3530` | **4** (O(N)) |
| 12 | `grids_data` scan over `element_meta` | `main.py:1067-1077` | **5** (O(N)) |
| 13 | **full-storey mesh-HLR slice** | `main.py:1062` → `ifc_service.py:4087`, `:4105`, `:4116`, `mesh_hlr.py:412-449` | **6** (O(N) + union/difference) |
| 14 | store applies delta | `useBimStore.ts:1294-1389` | — |
| 15 | Viewport3D **rebuilds every Three.js geometry + material** | `Viewport3D.tsx:395-483` | **7** (O(N) client) |

**Round trips: 2** (transaction + state). **Full-model passes per user edit: 7**, of which 3 are full
IFC/state serializations or deep copies.

### Complexity in N

```
edit(N) = serialize_IFC(N)              # ~0.083 ms/element @ N=1000
        + deepcopy_all_meta(N)          # ~1.0 KB/element
        + join_pass(N²)                 # dominant: ~0.80 ms/wall @ N=1000
        + solve(O(C))
        + scan_meta(N) × 2
        + slice_storey(N + unions)
        + client_rebuild(N)
```

### Change items

1. Replace the global join pass on the drag path with `DependencyGraph.recompute([guid])`
   (`dependency_graph.py:192-211` already implements exactly this, one-hop widening included).
2. Stop snapping before/after the command; snapshot only what the command touched (§2).
3. Give `slice_2d_vector_plan` a revision-keyed cache so an unviewed/below-cut element edit does not
   re-render a storey (§6).
4. Make Viewport3D consume the delta (upsert/remove) instead of rebuilding all N objects (§7).

---

## 2. Is the model of record re-serialized per edit? — **PRESENT (defect)**

**Yes, twice per edit, and it is the whole model.**

- `snapshot_state` (`ifc_service.py:397-445`) builds `"ifc_text": self.model.to_string()` at
  **`ifc_service.py:420`** — a complete STEP serialization of the document of record.
- It also walks every element and `copy.deepcopy`s its `meta` (`:411-413`, `_clean_meta` at `:398-409`),
  which includes the cached tessellation attached in `_build_element_mesh`
  (`ifc_service.py:3471-3472`).
- `execute_transaction` calls it **before** the command (`command_bus.py:642`) and again **after**, to
  populate the undo entry's `post_state` (`command_bus.py:677`).
- `undo`/`redo` pay the reverse: `restore_state` re-parses the whole STEP via
  `ifcopenshell.file.from_string` (`ifc_service.py:449`) and then re-resolves every element by GUID
  (`:500-509`) — O(N) parse plus O(N) lookups, with no structural sharing.

**Measured:** 1,418,136 characters of IFC text and a 1,006,399-character `element_meta` repr per
snapshot at N=1000; ≈83 ms per snapshot (§B1). This is the single clearest O(model)-per-edit cost that
the Delta Protocol did **not** touch, because it happens inside the transaction, before any HTTP
response is built.

### Change items

1. **Command-scoped memento.** Have each command record the entities it mutated (it already knows:
   `translate_element` touches one wall plus its join partners) and snapshot only those, or store an
   inverse-operation journal instead of state.
2. **Persistent IFC file object:** stop round-tripping through STEP text. Snapshot = the list of changed
   entity ids + their prior attribute values.
3. Cap the undo stack by bytes, not entries; today each entry retains ~2 full model copies.

---

## 3. Recompute granularity — **ABSENT on the edit path**

`dependency_graph.py` is a genuine dirty-flag graph with four edge kinds
(`dependency_graph.py:35`), transitive walk excluding `join` (`:169-184`), one-hop join widening
(`:192-211`), and counters that make the incremental claim checkable (`:44-46`, `:186`). **It is not on
the path that matters.**

- `translate_element` — the wall-drag path — calls `self.recompute_wall_joins()` with **no `only=`**
  argument at **`ifc_service.py:2022`**. The `only=[]` capability added by P3
  (`ifc_service.py:2796-2821`) is therefore never used here.
- `update_element` does the same at **`ifc_service.py:2359`**.
- `DependencyGraph` is constructed in exactly **two** places — `_recompute_after_sketch`
  (`ifc_service.py:886-889`) and `move_level` (`:1145-1149`) — and in both it is built fresh
  (`DependencyGraph.build`, `:50-54`) and discarded. It is never stored on the manager; the
  `self._dependency_graph = None` field at `ifc_service.py:239` is assigned nowhere else.
- Building the graph is itself O(N) plus O(N²) for join edges: `rebuild()` nests `for a in shared: for b
  in shared` over every shared endpoint (`dependency_graph.py:99-103`).
- `move_level` compounds this: it loops `translate_element(...)` per member (`ifc_service.py:1139-1141`),
  **each of which runs the global join pass**, and only then builds the graph to do the incremental
  recompute it should have used from the start. *(unverified: I did not time `move_level` directly;
  the per-call join pass it invokes is measured in §B1.)*

**Does an edit to one wall recompute every wall join in the model? Yes.** The loop is
`ifc_service.py:2829` (`for guid, meta in walls.items():`) where `walls` is `all_walls` whenever
`only is None` (`:2813-2821`), and inside it `:2840-2848` calls `_find_join_partner(guid, end_index,
all_walls)` for both endpoints, whose body iterates `for other_guid, om in walls.items():`
(`ifc_service.py:2767`) — over the **full** wall set, by design (`:2846-2847`).

**Counted complexity:** N=1000 → 2,002 partner calls, **2,004,002 wall visits**, 800 ms.

### Change items

1. Route `translate_element`/`update_element` through `DependencyGraph.recompute([guid])`, i.e. delete
   the bare `recompute_wall_joins()` at `ifc_service.py:2022` and `:2359`.
2. Persist the graph on the manager and apply edge deltas on create/delete instead of rebuilding it.
3. Make the partner search spatial: index wall endpoints in a dict keyed by rounded coordinates (the
   graph already builds exactly this index at `dependency_graph.py:93-98`) and pass it down, turning
   O(N) per lookup into O(1). This alone removes the N² term.
4. In `move_level`, translate elements with `_propagate=False` **and** join suppression, then recompute
   once.

---

## 4. Constraint solving — PARTIAL

**Installed and working.** planegcs is present; EQ propagation verified end to end (§B4): moving an EQ
span's far endpoint redistributed the interiors to equal spacing, and a repeated `equalize_span` did
**not** append a duplicate constraint (measured 1 → 1). The plan's N6 "EQ still open" claim in
§0.1 is **stale**; P3's table (`IMPLEMENTATION-PLAN:310`) is the accurate one.

**The solve is not scoped, despite the API.** `solve(scope=…)` uses `scope` only to seed the
participant set: `participants = set(scope) | set(pins)` then
`affected_guids(...)` expands transitively (`constraint_solver.py:162-166`), and `affected_guids`
itself is a fixpoint over **all** constraints in the model (`:110-137`). Worse, the constraint
application loop iterates `self.manager.constraints` wholesale and never tests membership in
`participants`:

```
constraint_solver.py:224   for cid, c in sorted(self.manager.constraints.items()):
constraint_solver.py:231-250   # align / dimension_lock / equalize applied by id lookup
```

Measured consequence: asking for a 2-element scope in a 32-element / 29-constraint model yields **31
participants**, and the sketch contains every constraint on that axis. Cost is O(C) per solve plus
O(C²)-ish for the `affected_guids` fixpoint, so it is cheap at C=29 (0.36 ms) but is a global solve in
substance — a single conflicting constraint anywhere on the axis can make an unrelated wall's solve
report `conflict` (`:262-268`).

**Re-solve on load: none.** `rebuild_from_overlay` replays builders and recomputes joins
(`ifc_service.py:3345-3377`) but never computes element coordinates from constraints; it trusts the
coordinates in the overlay. `load_constraints_from_ifc` reads the legacy pset
(`ifc_service.py:3137`) — and per P2-E the pset is stripped on save (`:3117`), so for a v3 container
this path yields nothing. Consequence: a container whose overlay drifted from its constraints reloads
with the drift intact; nothing re-establishes EQ at load.

### Change items

1. Scope the solve: filter `self.manager.constraints` by `cid in applicable` where `applicable` covers
   only constraints whose participants intersect `participants`.
2. Partition by connected component so an unrelated conflicting constraint cannot poison a local edit.
3. Add a load-time solve pass (`solve` per component, `pin_span_endpoints=True`) so a container's
   geometry is re-derived from its constraints, and assert it in `test_container_fidelity.py`.
4. Add a scale regression for the solver: C ∈ {10, 100, 1000} constraints, assert solve time and
   participant count.

---

## 5. Transport — PARTIAL

**There is a real delta protocol and it is used for every editing action.** `GET /api/state` implements
three responses (`main.py:945-1143`): A unchanged (`:985-992`, 104 B measured), B delta
(`:1030-1109`), C full resync (`:1111-1143`). The store issues it from one place
(`useBimStore.ts:1236-1425`) and every mutation funnels through `executeTransaction` →
`fetchStateBundle` (`:2168-2193`). The older seven-request sequence is gone, the interim fix §0.2
describes is real, and **delta equivalence holds over sequential edits** (§B5: 0 vertex mismatches,
removals exercised, `check-delta-equivalence.mjs`'s contract reproduced).

**But the delta carries the whole view.** On every Response B, `slice2d` is regenerated in full and
returned (`main.py:1062`). Measured @ 200 walls: `slice2d` = 442,482 B against a 1,107 B mesh delta —
**99.6 % of the payload**, and 400:1 against the part that actually changed. The resulting reduction is
**35.4 %**, not the 76.8 % in `docs/DELTA-MEASUREMENT.md:60`.

Two further findings in the same section:

- The dirty-view filter that should skip the slice fires only when `view_type == 'floor_plan' and
  level_id` (`main.py:1038`), and even then only when every affected element is provably on another
  storey (`:1059-1060`). Measured: `slice2d` was present on **12/12** edits at both sizes, including
  with `level_id` omitted.
- `grids_data` (`main.py:1067-1077`) and `get_geometry_buffers`' `levels_data`
  (`ifc_service.py:3512-3526`) each scan all of `element_meta` **unconditionally**, before the
  `grids_rev`/`levels_rev` gate is consulted — so the gating saves bytes but not the scan.

**No push transport exists.** A search for `websocket`, `WebSocket`, `EventSource`,
`text/event-stream` over `backend/*.py` and `src/**` returns nothing relevant: the only matches are the
word "assertion". Transport is polling/refetch only, initiated by the client after each commit.
*(Consequence: two sequential round trips are the floor without push; a websocket/SSE `ElementsChanged`
push is what removes the second one.)*

### Change items

1. Ship **dirty slice geometry only**, or omit `slice2d` from deltas entirely and let the client
   re-request linework lazily; a 1-mesh edit must not cost 442 KB.
2. Key the slice by `(doc_id, rev-of-cut-relevant-state, cut_elevation, level_id)` and reuse it when
   nothing in the storey changed.
3. Return per-element `revisions` so the client can request only the linework paths it lost.
4. Add `POST`-side push (websocket or SSE) for `ElementsChanged`; keep the polling endpoint as the
   fallback for the epoch-mismatch path.
5. Move `levels`/`grids` scans behind their revision gates.

---

## 6. Geometry pipeline cost — PARTIAL

**What is cached: per-element tessellation, in memory, on the element's own meta record.**
`_build_element_mesh` checks `meta["cached_verts"]`/`meta["cached_faces"]` and only calls
`self._get_product_shape(...)` on a miss (`ifc_service.py:3461-3472`); the bbox is cached the same way
(`:3476-3486`). Cache entries are excluded from the overlay record (`:1255`), so they never round-trip.

**The cache key is the element identity alone — there is no revision or epoch in it.** Invalidation is
imperative and depends on every call site remembering:

| Mechanism | Site |
|---|---|
| `mark_mesh_dirty` → `add` + drop `cached_verts/faces/bbox` | `ifc_service.py:545-556`; called from `translate_element:2099`, `recompute_wall_joins:2939`, undo/redo (`command_bus.py:745,771`) |
| `_invalidate_geometry_cache` for a host whose void changed | `ifc_service.py:3012-3025`; call sites `:1558, :1661, :1941` |
| `mark_mesh_dirty(clear_cache=False)` — keeps the cache | `ifc_service.py:2372` |
| direct cache rewrite from the builder | `ifc_service.py:2311, 2324, 2353` (`update_element`) |

This works — the mesh delta is genuinely O(changed), measured at **0.065 ms @ 50, 0.099 ms @ 200,
0.178 ms @ 1000** walls, with a one-mesh upsert of 1,107 B — and it is the one thing in the engine that
already behaves the way Revit's display pipeline does. Its weakness is architectural: `update_element`
writes the cache directly from `_build_wall_mesh` (`:2352-2354`) with no invalidation bookkeeping, and
nothing prevents a future call site from forgetting. There is no `epoch` or `geometry_revision` guard
that would make a stale cache *impossible* rather than merely unlikely.

**Epoch/revision: the concept exists but is used only for the payload, never for caching.**
`doc_id` is real and correct — minted per document at `ifc_service.py:206`, restored on undo at `:536`,
regenerated on document replacement at `:5160`; the store compares it and forces a full resync on
mismatch (`useBimStore.ts:1296-1304`). But nothing keys a geometry cache on it. Seven separate section
counters (`levels_rev`, `grids_rev`, `sheets_rev`, `views_rev`, `constraints_rev`, `wall_joins_rev`,
`project_rev` — `ifc_service.py:438-444`) exist purely to decide which JSON sections to include in a
delta (`main.py:1066-1087`). `mesh_revs` (`:225`) is the closest thing to a per-element geometry
revision; it is used for delta selection (`ifc_service.py:3531`) and cleared wholesale by
`commit_revision` (`:570-573`) — a fire-and-forget flag, not a cache key. `project_rev` is never
incremented anywhere *(searched: assigned only in `snapshot_state`/`restore_state`)*, so the `project`
section never appears in Response B — benign today, but it means that gate is dead code.

**HLR / 2D slice: nothing is cached, and the whole storey is re-projected per edit.**
`_mesh_hlr_plan_contract` rebuilds its mesh list every call (`ifc_service.py:4105`), constructs a fresh
`MeshHlrProjector` (`:4116`), and `MeshHlrProjector.render` resets its own prepared cache each time
(`mesh_hlr.py:411`) before projecting every element (`:120-163`), unioning triangle polygons per element
(`:312`, `_safe_union`), and computing an **accumulating** occluder difference pair for the whole view
(`:438-449`: `remainder = line.difference(occluder)` against a union that grows with each mesh). The
6-ft not-cut rule then scans all elements again (`ifc_service.py:4137-4141`).

Measured: 7.6 ms @ 13, 30.6 ms @ 50, **144.1 ms @ 200** — and the mesh inputs were already cached, so
this is the projector, not tessellation. The analytic renderer over the same model is 0.04–0.57 ms, so
the 144 ms is the price of true hidden-line work with no memoisation.

*(unverified: I did not measure client-side frame time. The 60 fps at 2M triangles budget in
`SPECIFICATION-v0.2.md:877` has no client benchmark in this repo — see §8.)*

### Change items

1. Put a `geometry_revision` stamp on each cached mesh and have `_build_element_mesh` compare it; make
   the cache self-invalidating so a missed call site cannot serve stale geometry.
2. Cache the slice contract keyed by `(doc_id, wall_joins_rev, geometry_revision-set-of-storey,
   cut_elevation, level_id, lineweight-table-hash)` — a mesh-only edit on an unviewed storey should
   reuse it verbatim.
3. Incrementally maintain the occluder union instead of recomputing it per render, and index projected
   element bounds so distant non-overlapping elements skip the boolean entirely.
4. Populate `project_rev` or delete the gate.

---

## 7. Concurrency — PARTIAL / ABSENT

- **One process, one document.** `uvicorn.run(app, host=…, port=8008)` with no `workers`
  (`main.py:1147`), and the model is a module-level singleton imported by the routes
  (`main.py:17`, `ifc_service.py` `bim_manager`; bus singleton at `command_bus.py:792`).
- **All model routes are synchronous `def`.** Only three endpoints are `async def` and all three are
  file uploads (`main.py:320, 777, 795`). FastAPI therefore runs every model route in the threadpool, so
  a long recompute does **not** block the event loop — but it does occupy a worker, and it is
  serialized against every other mutation by the bus's single `RLock`
  (`command_bus.py:373`, acquired in `execute_transaction` `:640`). Concurrency across mutations is
  therefore exactly 1. Read paths (`/api/state`, `/api/geometry`) take **no** lock, so a reader can
  observe the model mid-transaction before rollback — a correctness smell rather than a latency one.
- **No job queue, no transaction cancellation, no progress reporting.** `execute_transaction` is
  synchronous through commit-or-rollback (`command_bus.py:625-690`). There is no transaction id the
  client can cancel — `tx_id` is minted inside the lock at `:641` and only returned on completion.
- **No optimistic UI.** The store `await`s the transaction response and then `await`s the state bundle
  before `set(...)` (`useBimStore.ts:2170-2193`, `:1368-1389`). Nothing repaints between request and
  response. With a 275 ms commit at 200 walls, that is 275 ms of frozen geometry.
- **The UI does not yet stream drags.** `translateElement` is reachable from
  `PropertiesPalette.tsx:167` (a discrete nudge) and the store's temp-dimension handler
  (`useBimStore.ts:1075`). A search for `onPointerMove`/throttle/debounce over `src/**` finds no
  continuous drag that dispatches per frame. So the concurrency ceiling is not yet user-visible as
  stutter — but it is also the reason P3's "interactive endpoint/baseline drag UI" remains unbuilt
  (`IMPLEMENTATION-PLAN:321`), and a 60 fps drag needs a *streaming, cancellable, latest-wins*
  channel that does not exist in any form today.

### Change items

1. Add a `POST /api/transaction/preview` (or a websocket session) that solves and returns geometry for
   an in-flight drag **without** committing or snapshotting, plus a single commit at mouse-up.
2. Make the transaction cancellable: mint `tx_id` before acquiring the lock and allow
   `POST /api/transaction/{id}/cancel` to short-circuit a queued command.
3. Apply the mesh delta to the store optimistically (vertices are already streamed per element), then
   reconcile on the authoritative response.
4. Take a shared lock for read routes so delta responses cannot observe a half-applied transaction.

---

## 8. Scale test evidence — **ABSENT**

**Stated plainly: no test, gate, or committed script in this repository measures 2,000 elements, and
none measures frame rate.** The spec's budget table (`SPECIFICATION-v0.2.md:874-879`: p95 < 16 ms wall
drag, 60 fps at 2M triangles, cold start < 3 s, save not blocking > 200 ms) has no corresponding
benchmark.

Evidence:

- `package.json` `check` = `check:bus && check:ui && check:state && check:delta && tsc --noEmit`. All
  four gates assert *parity/equivalence*; none asserts a duration.
- The only timed measurement committed anywhere is `scratch/test_dependency_graph.py:241-265`, on a
  12-wall chain, and it **reports rather than asserts** — the budget branch only prints a note when
  exceeded (`:261-265`), and the single assertion is `p95 > 0` (`:260`).
- Scanning every `range(...)` in `scratch/*.py` and `scripts/*.mjs` finds **no bound above 200**. The
  largest models in the repo are the sample building (13 elements) and `test_wall_joins_matrix` fixtures.
- The 250-element figures in `docs/DELTA-MEASUREMENT.md:45-50` have **no committed generator**; nothing
  in the repo can reproduce them.
- No client-side frame timing exists: no `performance` measurement in a render loop, no fps counter.
  `scripts/smoke-render.mjs` exists but is a smoke test, not a benchmark.

This is itself the finding the task asked for: **the budgets are unenforceable because nothing exercises
them.** My benchmark is throwaway by instruction; the numbers in §B1–B2 are the first measurements of
this engine above 25 elements.

### Change items

1. Commit a scale gate (`scratch/bench_scale.py`) that builds N ∈ {50, 200, 1000} and **asserts**
   p95 edit latency, with the corpus and thresholds recorded in the test — per
   `SPECIFICATION-v0.2.md:881` ("a budget without a stated model and corpus is not a measurement").
2. Track latency over revisions in CI (store a small baseline JSON, fail on regression > 20 %).
3. Add an fps measurement to the 3D viewport (2M-triangle fixture) so §19's orbit budget is testable.
4. Add cold-start timing (engine import → first `/health` 200) against the 3 s budget.

---

## 9. Persistence & durability — PARTIAL

- **Saving is explicit, never per-edit.** `save_orlt_project` (`ifc_service.py:4718-4744`) is reached
  only from `GET /api/project/export-bimworks` (`main.py:757-761`); there is no autosave, no
  save-on-commit, no background writer. This *satisfies* "MUST NOT block the UI > 200 ms"
  (`SPECIFICATION-v0.2.md:879`) trivially for editing, because editing never saves.
- **Save cost is O(N) and synchronous.** It writes the whole IFC to a temp file (`:4744`), then builds
  `parametric_overlay` with one `_build_overlay_element` per element (`:4769-4772`), then zips. Measured
  15.8 ms for a 30-element, 7-constraint container (11,540 B). Extrapolated to 2,000 elements:
  ≈1.1 s *(extrapolated, linear in N; not measured at 2,000)*.
- **Load cost is worse and is the real number.** `load_orlt_project` → `rebuild_from_overlay`
  (`ifc_service.py:4892`, `:3292-3377`) replays every element through the builders then recomputes joins
  once. Measured **92.3 ms for 30 elements** → ≈6.2 s at 2,000 elements *(extrapolated)*. Cold start
  "first edit is interactive" is therefore far outside the 3 s budget at target scale, and this path is
  what the plan makes authoritative (P2 item 3).
- **Durability is weaker than it looks.** Undo/redo is in-RAM only (`command_bus.py:670-679`); a process
  exit loses the journal and the undo stack. The journal is also never persisted (`:782-788` reads
  memory). "Revert to saved" is the only recovery, and per N13 the sketch session still does not reach
  the overlay.

### Change items

1. Incremental container write: append/replace only changed entities in `model.ifc` instead of
   re-serializing, or write the IFC on a background thread with a dirty flag.
2. Parallelise or lazily defer overlay replay on load (geometry on demand, per element), so load time is
   bounded by the visible storey rather than the whole model.
3. Persist the journal and a periodic autosave snapshot (crash recovery), decoupled from save.
4. Add a load-time budget gate at N = 2000.

---

## 10. What Revit does differently

The gap is not one algorithm; it is that Revit's document is a **resident, in-process object graph with
a regeneration engine**, and BIMWorks' document is an **explicitly serialized file** that happens to be
held in memory.

| Dimension | Revit | BIMWorks today | Evidence |
|---|---|---|---|
| Document residency | In-process document; edits mutate live objects | In-process, but the "durable" form is the STEP text, and every edit re-serializes it **twice** | `ifc_service.py:420`; `command_bus.py:642,677` |
| Persistence per edit | None. The file is written on Save | None for Save (good), but two full in-RAM snapshots per edit for undo | `command_bus.py:670-679` |
| Regeneration | **Element-scoped.** A change marks dependent elements dirty; only those regenerate. Structural/topological changes propagate along real dependency edges | Global. `translate_element` runs the whole-model join pass; the dependency graph is built fresh and used in only two places | `ifc_service.py:2022`, `:886`, `:1147`; `dependency_graph.py` |
| Geometry/display lists | Persistent display lists, reused until the element's geometry revision changes | Per-element tessellation cache with **no revision key**; imperative invalidation | `ifc_service.py:3461-3472`, `:545-556` |
| View regeneration | The view recomputes only what changed in its range; linework is retained | The whole storey is re-projected and re-serialized on **every** commit | `main.py:1062`; `mesh_hlr.py:438-449` |
| Interaction channel | Direct in-process calls; no request/response boundary per edit | Two HTTP round trips per edit, polling only; no push, no preview, no cancel | `useBimStore.ts:2170-2193` |
| Concurrency | UI thread + background regeneration with cancellation | Single lock; mutations strictly serialized; UI awaits | `command_bus.py:373,640` |

### What BIMWorks would have to change

**The three structural moves, in dependency order:**

1. **Make the dependency graph the engine's spine, not a test fixture.** Store it on the manager,
   maintain it on create/delete, and route *every* mutation through `recompute([guid])`. Add a
   coordinate-keyed endpoint index so the partner lookup is O(1). This alone removes the N² term — the
   800 ms @ 1000 walls → O(1) work for a single-wall move *(expected effect: measured p50 992 ms →
   low tens of ms; to be confirmed)*.
2. **Replace state snapshots with command-scoped mementos.** Undo needs the inverse of what changed,
   not two copies of the document. *(Expected effect: ≈166 ms of snapshot cost @ N=1000 → O(changed).)*
3. **Make regeneration revision-keyed and cache everything derivable.** One
   `(doc_id, element_revision)` pair as the cache key for tessellation; one
   `(doc_id, wall_joins_rev, storey_geometry_revision, cut, level)` key for the 2D contract; ship
   dirty linework only. *(Expected effect: the 442 KB delta and 131 ms slice @ 200 walls → O(changed);
   the payload reduction becomes the 76 %+ that `DELTA-MEASUREMENT.md` already claims.)*

**Then, to be genuinely Revit-class rather than merely fast:**

4. Stream the interaction: a preview/solve channel with latest-wins cancellation, commit once at
   mouse-up. Without it the 2-round-trip floor and the global lock cap drag responsiveness no matter
   how fast each step gets.
5. Partition the solve and the join pass by connected component so a local edit stays local even in a
   model with many constraints.

---

## Top 10 changes to make the engine perform like Revit

Ordered by measured impact per unit effort. "Expected effect" refers to the numbers in §B1–B2.

| # | Change | Effort | Files touched | Expected effect on measured numbers |
|---|---|---|---|---|
| 1 | Route `translate_element` / `update_element` through `DependencyGraph.recompute([guid])`; delete the bare global `recompute_wall_joins()` calls | **S** | `ifc_service.py:2022`, `:2359` | Removes the dominant term: `command` 802.9 → ~1–2 ms and tx p50 992.4 → ~190 ms @ 1000 walls; the 2,004,002 wall visits → ~2×(1+partners) |
| 2 | O(1) join-partner lookup via a coordinate-keyed endpoint index instead of scanning all walls | **M** | `ifc_service.py:2760-2789`, `:2840-2848`; reuse `dependency_graph.py:93-98` | Removes the N² term even when a full pass is genuinely needed; makes load/rebuild and `move_level` linear. Affects the 322.9 s @ 1000-wall build too |
| 3 | Revision-keyed display-list cache + stop shipping full-storey `slice2d` on every delta | **M** | `main.py:1062`; `ifc_service.py:4087-4131`; `mesh_hlr.py:411,438-449` | Delta 444,329 B → ≈2 KB @ 200 walls; state p50 150.9 → ≈5 ms; edit total p50 274.6 → ≈130 ms; payload reduction 35.4 % → >99 % |
| 4 | Command-scoped memento instead of two full `snapshot_state` copies per transaction | **L** | `command_bus.py:642,677`; `ifc_service.py:397-445` | Removes ≈166 ms/transaction @ 1000 walls and ≈2.4 MB of undo RAM per 10 edits @ 200 walls; tx p50 ~992 → ~826 ms on its own |
| 5 | Cache the 2D contract and incrementally maintain the HLR occluder union | **M** | `ifc_service.py:4105-4131`; `mesh_hlr.py:116-164, 438-449` | Slice 144.1 → single-digit ms @ 200 walls for edits that do not touch the storey's geometry |
| 6 | Scope the constraint solve to the affected connected component; schema-filter constraints | **M** | `constraint_solver.py:110-137`, `:224-250` | 31 participants → 3 for a 3-element scope; prevents unrelated conflicts; keeps solve sub-ms as C grows |
| 7 | Commit a scale gate that **asserts** p95 edit latency and delta bytes at N ∈ {50, 200, 1000} | **S** | new `scratch/bench_scale.py`; `package.json` `check` | Converts every number here into a regression gate; today §8's finding is that 0 budgets are enforced |
| 8 | Optimistic client apply + delta-aware Viewport3D (upsert/remove meshes instead of rebuilding all) | **M** | `useBimStore.ts:1294-1389`; `Viewport3D.tsx:389-483` | Removes the O(N) client rebuild and the await-before-repaint; makes perceived latency ≈ engine latency |
| 9 | Push transport (websocket/SSE `ElementsChanged`) replacing the post-commit poll | **M** | `main.py` (new route); `useBimStore.ts:2168-2193` | 2 round trips → 1 on the interactive path; removes the second full state request; enables drag streaming |
| 10 | Incremental container save + bounded load (lazy per-storey geometry), with journal persistence | **L** | `ifc_service.py:4718-4744`, `:3292-3377`; `command_bus.py:782-788` | Save 15.8 → ~O(changed) @ 30 elements; load 92.3 ms @ 30 → bounded by visible storey rather than ≈6.2 s at 2,000 |

**Ordering rationale.** #1–#2 attack the measured dominant term (the global O(N²) join pass) and are
independent of everything else. #3 attacks the measured dominant *payload* term. #4–#6 are the
remaining per-edit O(N) and global work. #7 locks the gains. #8–#10 are what turn "fast backend" into
"interactive editing" — without #1–#3 they have nothing to stream that is cheap enough to stream.

---

## Appendix — measured vs inferred

| Claim | Status |
|---|---|
| All §B1–B5 timings, byte counts, and counters | **Measured** on this machine, today, on the corpus stated |
| end-to-end = transaction + state round trip = 2 requests | **Measured** (§B2) |
| 76.8 % payload reduction claim in `DELTA-MEASUREMENT.md:60` | **Contradicted** — measured 37.1 % / 35.4 % on my corpus |
| EQ propagation works, no duplicate append | **Measured** (§B4) |
| Solve is not scoped to `scope` | **Measured** — participant counts (§B4) + code reading (`constraint_solver.py:224`) |
| Global join pass is O(N²) with ~2N² wall visits | **Measured** (counters, §B1) + code reading (`ifc_service.py:2767`) |
| 2,000-element figures (≈3.2 s per edit, ≈6.2 s load, ≈1.1 s save) | **Extrapolated** from linear/quadratic fits on the measured 50/200/1000 points; **not measured at 2,000** |
| `move_level` runs a join pass per member | **Inferred** from `ifc_service.py:1139-1141` + `:2022`; not directly timed |
| Client frame time / 60 fps at 2M triangles | **Not measured** — no client benchmark exists |
| Delta correctness over 6 sequential edits | **Measured** (§B5) |
| No websocket/SSE anywhere | **Searched, absent** (`backend/*.py`, `src/**`) |
| `project_rev` never incremented | **Searched** — assigned only in `snapshot_state`/`restore_state` |
