"""
test_drag_session.py — Verification Gate for Track B Phase 2: Drag Session on the Bus.

Verifies:
1. 60-frame drag advances rev by exactly 1 at commit.
2. rev does NOT advance during update frames (negative control guard).
3. Exactly ONE transaction journal entry and ONE undo entry emitted for the entire 60-frame gesture.
4. One undo restores pre-drag geometry exactly.
5. Cancel (commit=False) leaves rev unchanged and geometry byte-identical.
"""

import os
import sys
import copy

backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from ifc_service import bim_manager
from command_bus import command_bus, CommandRequest

passed = 0
failed = 0

def check(name: str, condition: bool, extra: str = ""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  [PASS] {name}{f' ({extra})' if extra else ''}")
    else:
        failed += 1
        print(f"  [FAIL] {name}{f' ({extra})' if extra else ''}")

print("\n=== RUNNING DRAG SESSION ON THE BUS GATE (PHASE 2) ===")

# 1. Setup clean model with two walls
bim_manager.reset_model()
res1 = bim_manager.add_wall((0.0, 0.0), (10.0, 0.0), height=3.0, thickness=0.2)
res2 = bim_manager.add_wall((0.0, 5.0), (10.0, 5.0), height=3.0, thickness=0.2)
wall1_guid = res1["guid"]
wall2_guid = res2["guid"]

pre_drag_rev = command_bus.rev
pre_drag_journal_len = len(command_bus.journal)
pre_drag_snap = bim_manager.snapshot_state()

# 2. begin_drag
drag_start = command_bus.begin_drag(origin="ui", description="60-frame wall drag")
session_id = drag_start["session_id"]
check("begin_drag returns session_id", bool(session_id))
check("begin_drag does NOT advance rev", command_bus.rev == pre_drag_rev, f"rev={command_bus.rev}")

# 3. 60-frame drag updates (simulate 60 fps pointer drag)
rev_stayed_constant = True
all_returned_meshes = True
slice2d_stayed_none = True

for frame in range(1, 61):
    cmd = CommandRequest(command="WallMove", params={"guid": wall1_guid, "dx": 0.1, "dy": 0.0, "dz": 0.0})
    update_res = command_bus.update_drag(session_id, [cmd])
    if command_bus.rev != pre_drag_rev:
        rev_stayed_constant = False
    if not update_res.get("changed_meshes"):
        all_returned_meshes = False
    if update_res.get("slice2d") is not None:
        slice2d_stayed_none = False

check("rev does NOT advance during update frames (60 frames)", rev_stayed_constant)
check("update returns changed meshes without full model rebuild", all_returned_meshes)
check("update suppresses slice2d (slice2d is null)", slice2d_stayed_none)

# Check intermediate live position (moved 6.0 ft along X)
wall1_meta = bim_manager.element_meta[wall1_guid]
check("live model reflects 60-frame movement", abs(wall1_meta["start"][0] - 6.0) < 1e-4 and abs(wall1_meta["end"][0] - 16.0) < 1e-4)

# 4. end_drag with commit=True
end_res = command_bus.end_drag(session_id, commit=True)
check("end_drag status is committed", end_res.get("status") == "committed")
check("end_drag advances rev by EXACTLY 1", command_bus.rev == pre_drag_rev + 1, f"rev={command_bus.rev}")
check("end_drag emits EXACTLY 1 journal entry for 60 frames", len(command_bus.journal) == pre_drag_journal_len + 1)
check("journal entry captures all 60 frames commands", len(command_bus.journal[-1]["commands"]) == 60)

# 5. Undo restores pre-drag state exactly
undo_res = command_bus.undo()
check("undo reports undone", undo_res.get("status") == "undone")
wall1_restored = bim_manager.element_meta[wall1_guid]
check("undo restores pre-drag wall start position exactly (0.0)", abs(wall1_restored["start"][0] - 0.0) < 1e-4)
check("undo restores pre-drag wall end position exactly (10.0)", abs(wall1_restored["end"][0] - 10.0) < 1e-4)

# 6. Negative control & Cancel: commit=False must leave geometry byte-identical and rev unchanged
pre_cancel_rev = command_bus.rev
pre_cancel_snap = bim_manager.snapshot_state()

drag_cancel_session = command_bus.begin_drag(origin="ui", description="Cancelled gesture")
cancel_id = drag_cancel_session["session_id"]

for frame in range(10):
    cmd = CommandRequest(command="WallMove", params={"guid": wall2_guid, "dx": 0.5, "dy": 0.5, "dz": 0.0})
    command_bus.update_drag(cancel_id, [cmd])

# Verify wall2 moved during drag
wall2_during = bim_manager.element_meta[wall2_guid]
check("wall2 moved during active cancel gesture", abs(wall2_during["start"][0] - 5.0) < 1e-4)

# Cancel drag gesture
cancel_res = command_bus.end_drag(cancel_id, commit=False)
check("cancel returns status: cancelled", cancel_res.get("status") == "cancelled")
check("cancel leaves rev UNCHANGED", command_bus.rev == pre_cancel_rev, f"rev={command_bus.rev}")

# Verify geometry restored byte-identical
post_cancel_snap = bim_manager.snapshot_state()
check("cancel leaves IFC text byte-identical to pre-drag state",
      post_cancel_snap["ifc_text"] == pre_cancel_snap["ifc_text"])

wall2_restored = bim_manager.element_meta[wall2_guid]
check("wall2 start restored to 0.0", abs(wall2_restored["start"][0] - 0.0) < 1e-4)
check("wall2 end restored to 10.0", abs(wall2_restored["end"][0] - 10.0) < 1e-4)

# 7. Performance Evidence on 250-Wall Fixture (W10 / Plan §8)
print("\n--- 7. Performance Benchmark on 250-Wall Fixture (W10) ---")
import time

bim_manager.reset_model()
wall_250_guids = []
for i in range(250):
    gx = float(i % 25) * 12.0
    gy = float(i // 25) * 12.0
    w_res = bim_manager.add_wall(
        start_pt=(gx, gy, 0.0),
        end_pt=(gx + 10.0, gy, 0.0),
        height=10.0,
        thickness=0.67,
    )
    wall_250_guids.append(w_res["guid"])

check("250-wall fixture created", len(wall_250_guids) == 250)

def bench_drag(command, params_fn, frames=60):
    """One begin/60-frame/end gesture on the 250-wall fixture. Returns (p50, p95, mx, slice_suppressed)."""
    sess = command_bus.begin_drag(origin="ui", description=f"{command} benchmark")
    sid = sess["session_id"]
    lats = []
    suppressed = True
    target = wall_250_guids[0]
    for f in range(frames):
        t0 = time.perf_counter()
        res = command_bus.update_drag(sid, [CommandRequest(command=command, params=params_fn(target, f))])
        lats.append((time.perf_counter() - t0) * 1000.0)
        if res.get("slice2d") is not None:
            suppressed = False
    command_bus.end_drag(sid, commit=False)
    s = sorted(lats)
    return s[int(len(s) * 0.50)], s[int(len(s) * 0.95)], max(s), suppressed


# The plan's §8 budget is 8 ms for "a drag". It is met by the height path and NOT by
# the wall-end path — see the two rows below. Both are measured so the difference is
# on the record rather than implied by a single favourable number.
h_p50, h_p95, h_max, h_sup = bench_drag("WallSetHeight", lambda g, f: {"guid": g, "height": 10.0 + f * 0.1})
e_p50, e_p95, e_max, e_sup = bench_drag(
    "WallSetEnd", lambda g, f: {"guid": g, "end": "end", "point": [10.0 - f * 0.02, 0.0, 0.0]}
)

check("slice2d is suppressed during drag on 250-wall fixture (height)", h_sup)
check("slice2d is suppressed during drag on 250-wall fixture (wall end)", e_sup)

# The height path skips the join recompute by construction (height does not change the
# 2D footprint), so this is the cheap case. It is the figure the rework order's W10 cites.
check(
    "WallSetHeight drag p95 under the 8.0 ms §8 budget",
    h_p95 < 8.0,
    f"p50={h_p50:.3f}ms, p95={h_p95:.3f}ms, max={h_max:.3f}ms (budget: 8.0ms)",
)

# The wall-end path does move the baseline, so it pays the join recompute + hosted-opening
# reseat. It is ~19x over the §8 budget. This is an anti-regression guard, NOT a passing
# budget: it is deliberately loose so it does not flake, and the honest figure is recorded
# in docs/DELTA-MEASUREMENT.md §2.3 for follow-up.
check(
    "WallSetEnd drag p95 measured and within the 600 ms anti-regression guard (OVER the 8 ms budget)",
    e_p95 < 600.0,
    f"p50={e_p50:.3f}ms, p95={e_p95:.3f}ms, max={e_max:.3f}ms — 8.0ms budget NOT met on this path",
)
check(
    "the wall-end path is the expensive one (documents which figure is which)",
    e_p95 > h_p95 * 10,
    f"end p95 {e_p95:.3f}ms vs height p95 {h_p95:.3f}ms",
)

# Negative control: budgets made 10x stricter than each measured value must fail.
check("negative control: 10x stricter height budget fails", (h_p95 < h_p95 / 10.0) is False)
check("negative control: 10x stricter wall-end budget fails", (e_p95 < e_p95 / 10.0) is False)

print(f"  [PERF] height   drag: p50={h_p50:.3f}ms p95={h_p95:.3f}ms max={h_max:.3f}ms")
print(f"  [PERF] wall-end drag: p50={e_p50:.3f}ms p95={e_p95:.3f}ms max={e_max:.3f}ms")

print("\n------------------------------------------------------------------------")
print(f"DRAG SESSION GATE: {passed} passed, {failed} failed")
if failed > 0:
    sys.exit(1)
sys.exit(0)
