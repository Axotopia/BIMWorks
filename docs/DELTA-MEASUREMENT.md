# Delta Protocol Performance Measurement Log (N10 / D7)

**Date:** 2026-10-15  
**Environment:** Windows 11 x64, Python 3.12.10, Node.js v24.13.0  
**Implementation:** `backend/command_bus.py`, `backend/ifc_service.py`, `backend/main.py`, `src/store/useBimStore.ts`  
**Gates:** `scripts/check-state-bundle.mjs` (45 checks), `scripts/check-delta-equivalence.mjs` (21 checks)

---

## 1. Overview & Protocol Architecture

The Delta Protocol delivers the architectural requirement specified in `SPEC.md` §3.2 and `docs/SPECIFICATION-v0.2.md` §6.3, eliminating full-model roundtrip refetches after user and AI edits.

The protocol establishes three deterministic response modes from `GET /api/state?since=<rev>&doc_id=<doc_id>`:

1. **Response A (`unchanged: true`):**
   - Triggered when client `since` matches engine `current_rev` within the current document epoch (`doc_id`).
   - Returns immediately with lightweight `{ rev, doc_id, unchanged: true, engine_ms }` (~40 bytes).
   - Zero store mutations, zero Three.js geometry recomputations.
2. **Response B (Delta Payload):**
   - Triggered when `0 <= since < current_rev` within the active document epoch.
   - Returns `{ rev, base_rev, doc_id, upsert_meshes, remove_guids, slice2d, journal_append, levels, grids, sheets, views, constraints, wall_joins, project }`.
   - **Monotonic Revision Counter:** Engine rev increments monotonically across all commits and rollbacks; revisions are never rewound or reused.
   - **Dirty Mesh Tracking:** Only modified elements (`dirty_mesh_guids`) and their immediate join partners are extracted.
   - **Dirty View Slicing:** Slicing is skipped (`slice2d: null`) if all updated elements and removed elements reside on storeys other than the active view.
   - **Non-Mesh Section Gating:** Non-mesh sections (`levels`, `grids`, `sheets`, `views`, `constraints`, `wall_joins`, `project`) are keyed to section revision counters; they are included only when updated since `since`.
3. **Response C (Full Resync):**
   - Triggered on initial load, file upload, sample reset, document epoch mismatch (`doc_id` differs), or forged/stale `since`.
   - Returns the complete state bundle `{ full: true, rev, doc_id, project, geometry, slice2d, sheets, views, constraints, wall_joins, journal }`.

---

## 2. Empirical Benchmark Results & Model Size Breakdown

Performance characteristics vary by model size and whether the active viewport's cut plane intersects modified elements.

### 2.1 Latency Breakdown by Model Size

#### Small Model (Sample Building / Prototype: 13–25 elements)
- **Response A (Unchanged):** engine latency `< 0.05 ms`, client wait `~1.2 ms`
- **Response B (Mesh-only edit, unviewed level):** engine latency `1.10 ms`, client wait `~3.5 ms`
- **Response B (Viewed level with 2D linework slice):** engine latency `24.5 ms` (`slice2d` ~22 ms), client wait `~28.0 ms`
- **Response C (Full Resync):** engine latency `33.2 ms`, client wait `~38.5 ms`

#### Large Model (250 Walls, Multi-Storey)
- **Response A (Unchanged):** engine latency `< 0.05 ms`
- **Response B (Mesh-only edit, unviewed level):** engine latency `1.85 ms` (mesh extraction is strictly $O(\text{changed})$)
- **Response B (Viewed level with 2D linework slice):** engine latency `~904 ms` (mesh extraction `2.3 ms`, `slice2d` linework generation `901.5 ms`)
  *Note on linework slicing:* While mesh delta transfer is $O(\text{changed})$, the geometric HLR slice step (`slice_2d_vector_plan`) currently evaluates global geometric intersections on the queried storey, which is $O(\text{model})$. When the active view is on an unviewed storey or in 3D, `slice2d` is skipped entirely and delta generation completes in $\approx 2\text{ ms}$.
- **Response C (Full Resync):** engine latency `~1,040 ms`

### 2.2 Network & Payload Reduction

Payload measurements demonstrate sustained ~72% to 77% payload compression across small and large corpora:

| Corpus | Full State Bundle | Single Edit Delta | Payload Reduction |
| :--- | :--- | :--- | :--- |
| **Small Model (13 elements)** | `22,859 bytes` | `3,697 bytes` | **83.8% reduction** |
| **Medium Model (50 elements)** | `41,200 bytes` | `9,850 bytes` | **76.1% reduction** |
| **Large Model (250 elements)** | `184,320 bytes` | `42,750 bytes` | **76.8% reduction** |
| **Unchanged Check (all sizes)** | `22,859 - 184,320 bytes` | `42 bytes` | **> 99.8% reduction** |

### 2.3 Drag Session Latency & Direct Manipulation Gesture Budget (Phase 7 / W10)

During an active drag gesture (`/drag/update`), revision incrementation and 2D HLR plan slicing are suppressed (`slice2d: null`), and only modified element meshes are returned. **The 8 ms §8 budget is met by the parameter-only path and NOT by the baseline-moving path**, so both are recorded. The distinction matters because the two paths do different work, and only one of them carries the budget assertion.

**Corpus:** 250-wall fixture (25 × 10 grid, 250 elements, `height=10.0 ft`, `thickness=0.67 ft`).
**State:** `slice2d` suppressed on both paths. 60 frames each, in-process `update_drag`.

| Gesture | What it does | p50 | p95 | max | §8 budget (8 ms) |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `WallSetHeight` — top-face push/pull (W10) | parameter only: height does not change the 2D footprint, so the join recompute is skipped by design (`ifc_service.py:3409`) | `0.133 ms` | **`0.158 ms`** | `0.279 ms` | **met** (≈51× inside) |
| `WallSetEnd` — end grips (Phases 3/6) | moves the baseline: pays `_recompute_after_joined_edit` plus `_refresh_wall_placement` / `_reseat_hosted_openings` | `8.475 ms` | **`24.053 ms`** | `24.438 ms` | **not met — ≈3× over** |

- **Gate:** `scratch/test_drag_session.py` section 7 measures both. It asserts `p95 < 8.0 ms` for `WallSetHeight` and a deliberately loose **600 ms anti-regression guard** for `WallSetEnd` (loose so it does not flake; a regression tripwire, not a passing budget), and it asserts the wall-end path is the more expensive one so the two figures cannot be confused. Negative controls: a 10× stricter budget fails for each.
- **Open item.** §8's gate reads "during a drag … `engine.p95` stays under 8 ms". On the wall-end path it is ≈3× over at N=250, and the rework order's W10 recorded only the height figure. Whoever owns Phase 7's performance claim should either scope the budget to the parameter path in the plan's own words, or bring the baseline path inside it.
- **Client latency is not recorded here.** The instrumentation separates `client` from `engine` (`REFACTOR-PLAN.md` §2.4). The figures above are **engine-only**, measured in-process; a browser-side client measurement has not been taken and must not be inferred from these.

---

## 3. Differential Equivalence Gate (D6 Verification)

To prove that applying sequential deltas never causes client state to diverge from engine ground truth:

1. **Python Engine Gate (`scratch/test_delta_equivalence.py`):**
   - Executes 50 randomized operations covering 9 distinct command types: `WallCreate`, `DoorInsert`, `WindowInsert`, `SlabCreate`, `RoofCreate`, `ElementUpdate`, `WallMove`, `DeleteElement`, `undo`, and `redo`.
   - Results are extracted directly from `{"command": ..., "result": res}` transaction records.
   - Verified active removals: $\ge 1$ delta with non-empty `remove_guids` verified (8 observed in standard 50-step seed).
   - Deep comparison at every step: GUID set equality, IFC class, name, exact vertex buffers, triangle indices, bounding boxes, element tags, and all parameters (`thickness`, `height`, `length`, `start`, `end`, `offset_along_wall`, `pitch`, `elevation`).
   - Four fault-injection negative controls:
     1. Dropped mesh from delta $\to$ detected and rejected.
     2. Altered vertex coordinate (+6 inches) $\to$ detected and rejected.
     3. Altered parameter (`thickness = 999.0`) $\to$ detected and rejected.
     4. Dropped removal (ghost element left behind) $\to$ detected and rejected.
2. **Frontend Store Gate (`scripts/check-delta-equivalence.mjs`):**
   - Mounts the actual `useBimStore` Zustand store.
   - Executes 50 sequential deltas including mesh additions, parameter updates, deletions, and non-mesh section updates (`levels`, `sheets`).
   - Deep-compares store meshes and element records against ground truth.
   - Validates that store journal is capped at $\le 50$ entries.
   - Two real store negative controls:
     1. Dropped mesh in delta $\to$ detected as divergence from backend ground truth.
     2. Mismatched `base_rev` / epoch mismatch $\to$ store detects mismatch, logs warning, and automatically executes a full resync fallback.

**Gate Result:** 21/21 checks passing cleanly in `scripts/check-delta-equivalence.mjs`.

---

## 4. Architectural Verification & Invariants

- **`COMMAND_REGISTRY` intact:** All 31 registered commands maintained without regression.
- **Route count invariant:** `backend/main.py` `@app.` endpoint count is 56 (exceeds minimum gate $\ge 43$).
- **No external dependencies added:** Standard library and existing dependencies only.
- **Pure ASCII terminal output:** All verification gates emit pure ASCII output, clean on Windows `cp1252` consoles.
