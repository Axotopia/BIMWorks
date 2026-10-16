# REVIEW — Gemini's Round 3 fixes (`f4540ac`)

**Reviewed commit:** `f4540ac` — *"fix(references): surface lost dimensions in contract and clarify reference_key semantics"*
**Parent:** `3601b2d` (my Round 2 review, `REVIEW-geometric-references-round2-2026-10-15.md`)
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-15

---

## 0. Verdict

**All three Round 3 items are implemented correctly and I could not falsify any of them.** The two
follow-ups I recommended last round are genuinely closed, and the frontend/type work is sound
(`tsc` clean, and the pre-existing server-side SVG renderer already guards the new `None`
coordinates). No regressions in any suite.

Two findings, both from the same root cause — **the contract treats the *stored* `status` as
authoritative and never reconciles it with live resolution**:

| | Severity |
|---|---|
| **F1** — a dimension whose witness appears later stays `"lost"` forever and is hidden *(new in this commit)* | low–medium |
| **F2** — `status` is sticky: a dimension that resolves `"exact"` on both witnesses reports `"repaired"` after any move | cosmetic |

Both are fixed by the same one-line change (§3). Neither is blocking.

---

## 1. Item 1 — lost dimensions surfaced in the contract: ✅ done

Verified with a healthy and a lost dimension coexisting:

```
id=dim_5080c537 status=exact start=[0.0, 0.0]      end=[10.0, 0.0] offset_norm=[-0.0, 1.0] text=10'-0"
id=dim_c81b7efe status=lost  start=None             end=None        offset_norm=[0.0, 1.0]  text=5'-0"
  lost dim surfaced?         True
  overall dims substituted?  False
```

The `continue` is replaced by an append carrying `status: "lost"` and `None` coordinates, so the
dimension is no longer invisible in the payload, and it is still never anchored to `(0, 0)`.

**No consumer breaks on the `None` coordinates.** I checked every reader of `contract["dimensions"]`:

- `src/components/drafting/PlanViewport2D.tsx:1210` — guarded (`if (!dim.start || !dim.end || dim.status === 'lost') return null;`).
- `scripts/render_2d_view.py` — **both** readers already wrap in `try/except (… TypeError …)`, so
  `tuple(None)` and unpacking `None` are caught. Confirmed by running them against the mixed contract:

  ```
  build_svg OK, len: 3214
  dimension_svg OK, len: 442        (no crash)
  ```
- No backend code iterates the contract's dimensions for drawing (the SVG is built client-side; the
  sheet/PDF path compiles already-rendered SVGs).

The test gate was inverted correctly — `test_dimensions_crud` 16d used to assert the dangling
dimension was *excluded*; it now asserts it is *emitted* with `status: "lost"` and
`start/end is None` (+3 checks → **69 passed, 0 failed**).

The frontend work is also a genuine robustness improvement beyond the ask: `dim.offset_norm[0]`
became `(dim.offset_norm || [0, 1])[0]`, and `Sliced2DData.dimensions` now models nullable
`start`/`end`/`offset_norm` plus `status`.

## 2. Items 2 and 3 — docstrings: ✅ done

- `backend/references.py` — *"collision-resistant"* is gone; the docstring now states that full
  identity requires element sources or a persistent `guid`/`id`, and that hint-less points share the
  deterministic `point:unresolved` sentinel by design. That is exactly the honest form of option (b)
  I asked for.
- `scratch/_probe_reference_key_stability.py` — the stale *"expected to exit non-zero"* note is
  retired and replaced with *"Confirmed fixed in Round 2."*

## 3. ⚠️ F1 (new) — a `lost` dimension never recovers, and is hidden

The new condition ORs in the **stored** status:

```python
if pa is None or pb is None or out_a == "lost" or out_b == "lost" or d.get("status") == "lost":
```

Because nothing ever clears a stored `"lost"`, a dimension whose witness *returns* stays lost in the
contract — with `start/end: None`, so the frontend renders nothing. Verified:

```
initial stored status: lost
ref_a resolves: (None, 'lost')

after the referenced element exists again:
  ref_a resolves:  ((0.0, 0.0), 'exact')
  stored status still: lost
  contract entry:  {'status': 'lost', 'start': None, 'end': None}
  reports 'lost' while it RESOLVES?  True
```

This is reachable in normal use: re-adding an element with the same GUID (import, undo of a delete
where the dimension survived, or a re-opened overlay) leaves the dimension permanently invisible.
`_re_resolve_dimensions_after_move` only runs from `translate_element` and only for dimensions whose
witness is the moved element, so nothing clears it.

## 4. ⚠️ F2 (carried) — `status` is optimistic and sticky

The healthy branch is `d.get("status", …)`, so the stored value wins over the live outcome. A move
stamps `"repaired"` unconditionally, and it is never reset:

```
created      -> stored: exact        contract: ('exact', [0.0, 0.0])
after move   -> stored: repaired     contract: ('repaired', [2.0, 0.0])
live resolution of ref_a/ref_b: exact exact
-> reported status matches live outcome?  False
```

So `status` is not a reliable live indicator: any dimension a move has touched reports `"repaired"`
even when both witnesses resolve exactly. (Noted in Round 1 as optimistic labelling; it now
propagates into the client payload, which is why it is worth closing here.)

**Root cause for both:** the contract already computes `out_a`/`out_b` on the line above, so the
status can be derived from the live outcome — and the stored status reconciled on a successful
re-resolve — instead of being trusted as-is. That single change closes F1 and F2 together.

## 5. Observation — the migration signal reaches the client, but nothing shows it

`dim.status` has **exactly one** consumer in `src/`:

```
$ grep -rn "\.status" src/components/drafting/PlanViewport2D.tsx
1211:  if (!dim.start || !dim.end || dim.status === 'lost') return null;
```

There is no badge, list, inspector or count that surfaces a broken dimension, so the user-visible
outcome is unchanged: the dimension silently vanishes from the canvas.

The Round 3 summary describes the guard as *"allowing the client-side state / inspectors to process
the `status: "lost"` migration signal"* — no such inspector exists. The **backend** half (emit it)
is what I asked for and it is done; the **user-visible** half is still open, and plan §5.2's
*"communicated as a migration, with a triage pass"* is not yet met. Worth stating plainly so it is
not mistaken for finished.

Related, minor: lost entries still carry a stale `length`/`text` (e.g. `text: "5'-0""`), so any
future consumer must key off `status`, not `text`. And `src/types/bim.ts` still types
`ref_a`/`ref_b` as `{ guid: string; ref?: string }` while the backend sends full normalized
References (`sources`/`hint`, and no `guid` for point refs) — pre-existing, not introduced here.

## 6. Gates and regressions

`npm run check` → **exit 0**:

```
check:bus    37/37 UI actions declared and dispatched
check:ui     130 checks passed
check:state  45 checks passed
check:delta  21 checks passed
check:snap   21 passed, 0 failed
check:py     58 / 69 / 32 / 42 / 11 / 41   (all "0 failed")
tsc --noEmit clean (0 errors)
```

All six committed probes exit 0.

Full Python suite (30 files): **no new failures**. Only `test_update_roof.py` fails —
`FileNotFoundError: 'Z:/PROJECTS/…'`, environmental, pre-existing.

(Drag p95 measured 3.44/3.61 ms here; the summary quotes 2.95 ms. Host timing variance, all well
inside the 16 ms budget.)

## 7. Recommendation

Round 3 is good work and nothing is blocking. In priority order:

1. **Derive the contract `status` from the live `out_a`/`out_b`** (already computed), and reconcile
   `d["status"]` on a successful re-resolve. This closes F1 (permanently hidden dimension) and F2
   (sticky `"repaired"`) in one place. Dropping `or d.get("status") == "lost"` from the condition is
   the minimum fix for F1.
2. **Optionally surface the signal in the UI** — a broken-dimension indicator or list — so §5.2's
   migration is actually visible to the user rather than only present in the payload.
3. Tidy-ups: note in the contract/type that lost entries' `length`/`text` are stale, and correct the
   `ref_a`/`ref_b` types to the real Reference shape.

Carried forward, still open and not claimed as fixed in any round: §3.3.1 (2D `level_plane` returns
`(0.0, elevation)` labelled `"exact"`) and §3.3.2 (level **name** fallback retained).
