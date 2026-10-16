# DECISION — finish the undo migration: no silent full-state fallback on the edit path

**Status:** Accepted, 2026-10-16. Supersedes the first draft of this record (same day), which was written from `review/AUDIT-engine-performance-vs-revit.md` §2 and had gone stale — see §11.
**Resolves:** `docs/SPECIFICATION-v0.2.md` §6 `[REQ — undo shape]` and its `[GAP]`; `docs/REFACTOR-PLAN.md` §9 Phase 2 — promoted from *"optional, do not begin"* to **decided and in progress**, with its timing gate unchanged.
**Does not change:** `docs/SPEC.md` §11.1. The `.bimworks` hybrid container is **LOCKED** and stays locked: `model.ifc` remains **the model of record**. This decision is about *the unit of a live edit*, not about what the document of record is.
**Verified against:** `db10611`.
**Amends:** `docs/SPECIFICATION-v0.3.md` §24.3.

---

## 1. The question this decides

Not *"is IFC the model of record or a boundary format"* — that was signed off on 2026-10-13 and is not reopened here. The question is:

> **What is the unit of a live edit, and what does rolling it back cost?**

And the answer has changed since the question was first asked, because **most of the work has already landed**. This record's job is therefore narrower than "decide the shape": it is to **record the shape that was chosen, and bind the two places where it is still violated**.

## 2. The requirement already existed — this is not a new requirement

`docs/SPECIFICATION-v0.2.md` §6 states it normatively:

> **[REQ — undo shape]** Undo/redo MUST be incremental or structurally shared, **not** a full
> serialization per transaction.
>
> **[GAP]** Current state is a full snapshot that deep-copies meshes per edit (plan N10, "still open —
> unchanged"). This is **known and tracked**, not an open question, and it contradicts §19.
>
> **[REA]** Revit tracks undo as discrete **episodes** — `DocumentIncrementTable::begin/end`,
> `DocumentIncrement::greatestEpisodeId`, `DocumentHistory::getEpisode` — not as element or model
> snapshots.

`docs/REFACTOR-PLAN.md` §9 scoped the work but filed it **"Optional Phase 2 — only after Phase 1 is
green. Not part of this refactor. Do not begin it."** What was missing was a decision on *shape*, which
is why it sat. In the meantime the shape was in fact adopted — §3 — and the migration is two-thirds
done. This record makes that explicit and names what remains.

**It is also not a reversal of the container decision.**
`review/RECONCILIATION-rethink-pivot-proposal-2026-10-16.md` §6 item 1 recommended writing *"IFC is the
boundary format, not the model of record"* into the spec and README. That item is **withdrawn** (see that
document's §8, added the same day): it mis-described a signed-off decision as "an inherited default",
proposed a reversal without saying so, and its substance carries a known failure mode — hand-mapping IFC
in both directions is what OpenTrace did, producing a 1,417-line exporter with **nominal** quantities
that ignore openings and junctions, `IfcOpeningElement`s with a null representation, and doors and
windows carrying no geometry (`review/REVIEW-gemini-bpmx-pivot-proposal-2026-10-16.md` §3.4).

## 3. What is already true at `db10611`

The shape the requirement asks for **has been adopted**, and this should be credited before it is
criticised:

- `execute_transaction`'s contract is now *"one journal step and **one undo entry with command-scoped
  mementos**"* (`backend/command_bus.py:1536`).
- `_execute_with_memento` dispatches per command and returns a `CommandMemento(cmd_name, undo_fn,
  redo_fn)` (`:969`). **31 of the 41 registered commands** do this.
- Rollback of a partially executed transaction is *"surgical mementos"* in reverse (`:1549-1550`), and
  undo/redo walk the memento list rather than restoring a state blob (`:1640`, `:1667`).
- The drag path is **O(1) per edit**: `WallMove`'s memento is an inverse operation —
  `undo_fn = translate_element(guid, -dx, -dy, -dz)` — with no snapshot at all.

So the two jobs are, for most commands, already separated: **rollback is a memento; durability is the
journal.** That is the decision the requirement asked for.

## 4. What is still violated — measured, at `db10611`

Three things, each with a different cause.

**(a) Ten commands still fall back to a full-state snapshot.** The `else` branch of
`_execute_with_memento` (`backend/command_bus.py:1519-1523`) is documented as *"Fallback for any other
registered command (e.g. constraints, sketch curves, etc.)"* and does:

```python
pre_snap = self.manager.snapshot_state()      # :1520 — the whole document of record
res = self.execute_single_command(cmd_name, params)
def undo_fn(mgr):
    mgr.restore_state(pre_snap)               # :1523 — re-parses STEP
```

The ten: `ConstraintAlign`, `ConstraintDelete`, `ConstraintEqualize`, `ConstraintLockDim`,
`ConstraintLockToggle`, `SetWallJoin`, `SketchCurveAdd`, `SketchCurveMoveEdge`,
`SketchCurveMoveVertex`, `SketchCurveSetSlope`. `snapshot_state()` is O(model) and **66% of it is
STEP serialisation**:

| walls | `snapshot_state()` | `model.to_string()` (STEP) | share | `restore_state()` re-parse | parametric `deepcopy` |
|---|---|---|---|---|---|
| 22 | 4.0 ms | 2.5 ms | 63% | 1.3 ms | 0.9 ms |
| 54 | 9.6 ms | 6.2 ms | 65% | 3.1 ms | 2.3 ms |
| 86 | 15.5 ms | **10.2 ms** | **66%** | 5.0 ms | 3.6 ms |

Independent larger-size measurement: ≈83 ms per snapshot at N = 1000, with 1,418,136 characters of IFC
text per snapshot (`review/AUDIT-engine-performance-vs-revit.md` §2).

**(b) `ReferenceMove` — the drag verb — captures O(model) state despite having a memento.**
`backend/command_bus.py`, `ReferenceMove` branch:

```python
pre_coords = {
    g: (self.manager.get_element_coord(g, "x"), self.manager.get_element_coord(g, "y"))
    for g in self.manager.element_meta          # every element in the model
}
```

This is not serialisation, so it does not show up in (a)'s numbers, but it is O(model) **per invocation**
on the exact verb `review/IMPLEMENTATION-PLAN-direct-manipulation.md` §5 Phase 2/3 builds the drag
session on. The memento discipline ("declare what you mutated") is satisfied in form and violated in
cost.

**(c) The undo stack is capped by entry count, not bytes.** `max_undo_depth: int = 200`
(`command_bus.py:526`, `:1583`). The audit's change item 3 is not done.

**Correcting the record:** the often-quoted "snapshot twice per transaction, ≈66 ms at 86 walls" is
**stale**. It described the pre-memento bus and was carried forward by
`scratch/_probe_snapshot_cost.py`, whose "×2 + slice" column still models two snapshots per transaction
and whose docstring still cites `command_bus.py:642, :677` — lines that no longer exist. For a
memento-covered command such as `WallMove`, `snapshot_state()` is **not called at all**. The 66 ms figure
applies to the fallback path, i.e. to the ten commands in (a), not to a wall edit.

## 5. The decision

**D1 — `model.ifc` remains the model of record; ifcopenshell remains the substrate.** No change to
`SPEC.md` §11.1. IFC stays the schema, the export format, the import target, the validation substrate
and the entity graph the geometry pipeline reads.

**D2 — The command-scoped memento is *the* undo mechanism, and the full-state fallback MUST NOT exist.**
Every registered command MUST declare a memento. The fallback at `command_bus.py:1520` MUST be removed,
and its absence MUST be asserted — because a silent O(model) fallback is invisible: it does not fail, it
only gets slower as models grow, which is exactly how this defect survived a green gate suite the first
time. If a command genuinely cannot express an inverse, that is a design problem to solve, not a licence
to snapshot the document.

**D3 — No command may capture O(model) state for undo.** A memento's cost MUST be proportional to what
the command mutated. This is what makes `ReferenceMove`'s blanket coordinate capture (b) a defect
despite it being memento-shaped.

**D4 — Undo MUST preserve object identity, on every path.** `restore_state()` re-parses the whole
document — `self.model = ifcopenshell.file.from_string(snap["ifc_text"])`
(`backend/ifc_service.py:754`) — invalidating every IFC entity handle in the process. It is reachable
from exactly one place, the fallback's `undo_fn` (`command_bus.py:1523`), so **D2 is also how D4 is
satisfied**: removing the fallback removes the identity-destroying path from the edit path entirely.

**D5 — The undo stack is capped by bytes, not by entry count.** Today it is 200 entries
(`:526`, `:1583`), and an entry's size varies by orders of magnitude between a memento and a fallback
snapshot.

**D6 — The reconciliation report is the anti-drift invariant and MUST be a gate.** The
`parametrized` / `unparametrized` / `rebuilt` / `stale` report — which compares the IFC GUID inventory
against the overlay and flags IFC entities with no parametric record
(`ifc_service.py:5380`, `:5502`) — is what makes a cheaper edit path safe: it is the check that the
document of record and the parametric layer have not diverged silently.

**D7 — The durable snapshot keeps its serialised form, once per committed gesture.** The journal and the
delta protocol keep a complete, serialisable state; that is the job serialisation is *for*. A gesture
(`review/IMPLEMENTATION-PLAN-direct-manipulation.md` §3.2 — `begin`/`update`/`end`) produces **one**
durable snapshot, at commit.

## 6. What this decision explicitly does not decide

- **That IFC stops being the model of record.** It does not. `SPEC.md` §11.1 stands.
- **That the overlay becomes the document of record.** It does not.
- **When the remaining work starts.** The ordering gate in `REFACTOR-PLAN.md` §9 is unchanged: Phase 1
  green and merged first, because D3 depends on the engine knowing what changed.
- **Whether the geometry pipeline stops using ifcopenshell.** It does not; D1 keeps it.
- **The memento representation** (inverse operation vs prior-value capture). Both satisfy D2/D3;
  `WallMove` uses the first, `ViewportMove` the second, and both are legitimate.

## 7. Consequences

**Good.** Per-edit undo cost stops depending on model size for the remaining eleven commands, including
the drag verb. The identity-destroying STEP re-parse leaves the edit path. The undo stack becomes
bounded by memory rather than by an arbitrary count whose meaning varies by command.

**Cost.** Each of the ten commands needs a real inverse; `ReferenceMove` needs to record only the
references it moved. Some of the ten are genuinely harder than `WallMove` — `ConstraintEqualize` and
`SketchCurveMoveVertex` change derived state through the solver, so their inverse is not a field
assignment. That work is real and is the reason this stayed optional.

**Risk.** Removing a working fallback removes a safety net; a command whose memento is wrong will now
corrupt undo instead of being accidentally correct. The defence is D2's assertion (no command may fall
back) plus the existing deep-compare discipline (`scripts/check-delta-equivalence.mjs`), extended to
assert that undo restores the model exactly.

## 8. Verification — the gate this decision is held to

| # | Assertion | Negative control that must fail it |
|---|---|---|
| V1 | **Zero** registered commands fall back to `snapshot_state()` for undo | Re-introduce the fallback branch → the gate must fail |
| V2 | No command captures state proportional to model size for undo (the `ReferenceMove` shape) | Add a whole-model comprehension to a memento → the gate must fail |
| V3 | An entity reference held across `undo` is still valid (identity preserved) | Route an undo through `restore_state` → the held handle must be stale |
| V4 | `undo` restores the model **exactly** — deep compare, the `check-delta-equivalence.mjs` style | Skip one mutated record in the memento → the compare must fail |
| V5 | The undo stack is bounded by bytes | Fill it with mementos of wildly different sizes → entry-count cap must not be what stops it |
| V6 | The reconciliation report is clean after a scripted edit/undo/redo cycle | Let the overlay and the IFC inventory diverge → the report must flag it |

**V1 is executable today** and is added to `scratch/_probe_engine_smoke.py` — a static scan of
`_execute_with_memento` for the fallback branch and a count of registered commands without a memento.
It currently reports **10 of 41**, so the gate fails until the migration completes.
`scratch/_probe_snapshot_cost.py` measures the underlying O(model) cost and needs its stale
"×2 per transaction" model and its dead `command_bus` citations corrected.

## 9. Rejected alternatives

- **Keep the fallback as a safety net for hard commands.** Rejected: it is silent. It does not fail, it
  degrades in proportion to model size, and it already survived an audit, a plan and a green gate suite.
  A command that cannot express an inverse should not be committing.
- **Re-platform onto an internal model with IFC as a pure boundary** (the reconciliation's §6.1
  recommendation — withdrawn, see §2). Rejected: reverses a locked decision by prose, and requires
  hand-mapping IFC in both directions, which is the documented OpenTrace failure mode.
- **Optimise `to_string()` / `deepcopy()` and keep full-state snapshots.** Rejected on the measurement:
  two-thirds of the cost is serialisation the edit path does not need, so this leaves an O(model) floor.
- **Reuse the fallback for the drag session** by snapshotting once per gesture rather than per frame.
  Insufficient: it bounds the *frequency*, not the *cost per gesture*, and `ReferenceMove` (b) is
  O(model) on its own.

## 10. Provenance

Decision taken 2026-10-16, revised the same day after verifying its citations against the tree (§11).

Measured on `db10611`: `scratch/_probe_snapshot_cost.py` (snapshot cost by model size) and an attribution
run isolating `model.to_string()` and `ifcopenshell.file.from_string()` from the parametric `deepcopy`
walk. Independent larger-size measurement quoted, not re-measured:
`review/AUDIT-engine-performance-vs-revit.md` §2 (≈83 ms per snapshot, N = 1000). Memento-coverage count
by static scan of `_execute_with_memento`: 31 of 41 registered commands.

Requirements and prior findings this rests on, none of which it overturns:
`docs/SPECIFICATION-v0.2.md` §6 `[REQ — undo shape]` + `[GAP]`; `docs/REFACTOR-PLAN.md` §9;
`docs/SPEC.md` §11.1 (locked container); `review/AUDIT-engine-performance-vs-revit.md` §2;
`review/REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` §4.3;
`review/IMPLEMENTATION-PLAN-direct-manipulation.md` §3.2 and §5 Phase 2.

Code read at `db10611`: `backend/command_bus.py` — `_execute_with_memento` `:991`, the memento
contract `:1536`, the fallback branch `:1519-1523` (`snapshot_state` `:1520`, `restore_state` `:1523`),
surgical rollback `:1549-1550`, `abort_transaction` `:1612`, `undo` `:1640`, `redo` `:1667`,
`max_undo_depth` `:526`/`:1583`; `backend/ifc_service.py` — `snapshot_state` `:695`, `ifc_text` `:718`,
`restore_state` `:752`, `from_string` `:754`, reconciliation report `:5380`/`:5502`.

**Re-verified at `db10611`**, which landed `command_bus.py` changes while this record was being written:
every citation above was re-derived against the tree, and the two behavioural claims were re-checked —
`WallMove`'s memento is still the O(1) inverse operation, and `ReferenceMove` still walks
`self.manager.element_meta` in full. The fallback count is unchanged at 10 of 41.

## 11. Why this record was revised the same day

The first version asserted that the bus *"snapshots full state twice per transaction"*, citing
`command_bus.py:642, :677` (taken from `AUDIT-engine-performance-vs-revit.md` §2) and quoting ≈66 ms per
transaction. On verifying the citations against `db10611`, those lines do not exist and the claim is
false: the command-scoped memento refactor has landed for 31 of 41 commands, `snapshot_state()` is called
at most once per fallback command, and `WallMove` does not call it at all.

The substantive decision survived — the fallback is still O(model) and still on the edit path for ten
commands — but the *reason* changed, and the measure of "how much is left" changed from "all of it" to
"eleven commands". That is the difference between a rewrite and a completion, and publishing the first
version would have misdirected the work. The audit's finding was correct when written; three weeks of
refactoring moved past it. This is the same citation-drift failure the project keeps recording
(`IMPLEMENTATION-PLAN-direct-manipulation.md` §9.2), and it is the argument for verifying every citation
in a decision record against the tree immediately before publishing it.
