# Delta Protocol Performance Measurement Log (N10 / D7)

**Date:** 2026-10-14  
**Environment:** Windows 11 x64, Python 3.12.10, Node.js v22  
**Implementation:** `backend/command_bus.py`, `backend/ifc_service.py`, `backend/main.py`, `src/store/useBimStore.ts`  
**Gates:** `scripts/check-state-bundle.mjs`, `scripts/check-delta-equivalence.mjs`

---

## 1. Overview & Protocol Design

The Delta Protocol delivers the architectural requirement specified in `SPEC.md` §3.2 and `docs/SPECIFICATION-v0.2.md` §6.3, retiring the interim full-model resync after every user edit.

The protocol provides three deterministic response modes from `GET /api/state?since=<rev>`:

1. **Response A (`unchanged: true`):**
   - Triggered when client `since` matches engine `current_rev`.
   - Returns immediately with lightweight `{ rev, unchanged: true, engine_ms }` (~30 bytes).
   - Zero store mutations, zero Three.js geometry recomputations.
2. **Response B (Delta Payload):**
   - Triggered when `0 <= since < current_rev`.
   - Returns `{ rev, base_rev, upsert_meshes, remove_guids, slice2d, journal_append, ... }`.
   - Only dirty meshes and join partners are tessellated and transferred.
   - Slicing is view-filtered (skips 2D slicing if all affected elements reside on unviewed storeys).
3. **Response C (Full Resync):**
   - Triggered on initial load, file upload, sample reset, or forged/stale `since`.
   - Returns the complete state bundle `{ full: true, rev, project, geometry, slice2d, ... }`.

---

## 2. Empirical Benchmark Results (100-Operation Sweep)

A benchmark sweep of 100 sequential operations (wall creations, wall moves, element deletions, undos, and redos) was performed on a multi-element architectural model.

### 2.1 Latency Distribution

| Refresh Mode | p50 Latency (ms) | p95 Latency (ms) | Mean Latency (ms) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Response A (Unchanged)** | `< 0.001 ms` | `0.001 ms` | `0.001 ms` | Sub-microsecond check on rev equality |
| **Response B (Delta)** | `1.10 ms` | `26.82 ms` | `5.66 ms` | Recomputes only dirty walls + join partners |
| **Response C (Full Resync)** | `30.52 ms` | `48.20 ms` | `33.15 ms` | Full model tessellation & slice rebuild |

*Note: For cached geometry buffers, engine read latency is dominated by JSON serialization; delta generation reduces serialization by 72%.*

### 2.2 Network & Payload Reduction

| Metric | Full State Bundle | Delta Payload | Reduction |
| :--- | :--- | :--- | :--- |
| **Mean Payload Size** | `27,627 bytes` | `7,806 bytes` | **71.7% reduction** |
| **Single Edit Delta Size** | `22,859 bytes` | `3,697 bytes` | **83.8% reduction** |
| **Unchanged Check Size** | `22,859 bytes` | `30 bytes` | **99.87% reduction** |

---

## 3. Differential Equivalence Verification (D6)

To guarantee that applying sequential deltas never causes the client read-model to drift from the engine core:

1. **Randomized Stress Test ($\ge 50$ operations):**
   - `scripts/check-delta-equivalence.mjs` and `scratch/test_delta_equivalence.py` execute 50 randomized operations (`WallCreate`, `WallMove`, `DoorInsert`, `WindowInsert`, `DeleteElement`, `Undo`, `Redo`).
   - At every step, Client A (delta-applied) is compared against Client B (fresh full bundle).
   - **Result:** 50/50 steps verified strictly identical geometry (vertices, face indices, bounding boxes, element parameters, element tags).
2. **Negative Control Fault Injection:**
   - Deliberately dropping a mesh: **Detected & flagged failure.**
   - Deliberately altering a single vertex coordinate (+6 inches): **Detected & flagged failure.**
   - Deliberately altering an element parameter (`thickness = 999.0`): **Detected & flagged failure.**

---

## 4. Architectural Verification & Invariants

- **`COMMAND_REGISTRY` intact:** 31 commands maintained without breakage.
- **Route count invariant:** `backend/main.py` `@app.` count is 56 (exceeds minimum gate $\ge 43$).
- **No external dependencies added:** Pure Python standard library and existing `ifcopenshell` primitives.
- **Pure ASCII terminal output:** All verification gates adhere strictly to ASCII characters for cross-platform Windows console compatibility.
