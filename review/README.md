# `review/` — how this folder is organised

This folder holds the audits, plans, work orders and reconciliations that sit behind the
specification. The spec (`docs/SPECIFICATION-v0.3.md`) is the contract; the documents here are the
reasoning, the evidence and the sequencing.

**Folders should hold documents.** If you find a script in here, it belongs in `scratch/` — that is why
`probe-sketch-validation.py` moved to `scratch/probe_sketch_validation.py`.

## The subfolders

| Folder | Means | Test to apply |
|---|---|---|
| *(root of `review/`)* | **Live.** Read this to know what is true now. | The work it describes is still in progress, or it is reference material the live plans cite. |
| `archive/` | **Completed work.** The work described is done and verified. | Every item is closed, or everything still open has been carried into a live plan. |
| `old/` | **Outdated.** Superseded thinking, kept so the reasoning is not lost. | It describes an approach that was changed, not work that was finished. |

`archive/` and `old/` are different claims, which is why there are two of them. "Completed" means the
plan was carried out; "outdated" means the plan was replaced. Do not merge them without deciding which
claim each document is making.

## Naming

`AUDIT-` diagnoses a gap against a reference (usually Revit). `REVIEW-` verifies someone's work.
`IMPLEMENTATION-PLAN-` is a forward plan with its own status table. `REWORK-ORDER-` is an executable
work order produced by an audit. `RECONCILIATION-` reconciles two documents or a document against the
tree. `OPTIONS-` weighs alternatives.

## Live documents

| Document | Role |
|---|---|
| `IMPLEMENTATION-PLAN-revit-feel.md` | **The main track.** Editing semantics and the performance that makes them usable. Phases 0–7; 0.2, 1.5, 2.7, Phase 0 Exit, Phase 4 and Phase 7 remain open. |
| `IMPLEMENTATION-PLAN-direct-manipulation.md` | The gesture layer (Track B) and the testability/UI blockers (Track A). **All of A1–A7 and P0–P8 are closed**; §0.4 lists what was deliberately deferred. |
| `AUDIT-*-vs-revit.md` (5) | Parity diagnoses. Reference material — `AUDIT-engine-performance` is the evidence base for revit-feel's open performance items. |
| `REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` | The IngeTrazo reference for the gesture layer. |
| `REVIEW-gemini-bpmx-pivot-proposal-2026-10-16.md`, `RECONCILIATION-rethink-pivot-proposal-2026-10-16.md` | A withdrawn pivot (`.bpmx` container/recipe), recorded with its verdict. |

## Conventions

**Do not rewrite a plan's history.** Plans carry dated reconciliation passes (`§0a`, `§0b`, `§0c`…) and
a status table pinned to a commit. When the tree moves, **add a dated pass** with a `This plan says /
Verified / Evidence` shape; leave the older pinned snapshots as they were written. A pinned table that
no longer matches HEAD is not a defect — it is the record of what was true then.

**One owner per item.** `IMPLEMENTATION-PLAN-revit-feel.md` §2b divides work between the plans so a
reader never has to reconcile two statuses for the same feature.

**Reference paths are repository-root-relative.** A document cited from a plan reads
`review/archive/<NAME>.md`, not `archive/<NAME>.md`. When a document moves, repoint every citation
rather than leaving a dangling path — check with:

```bash
for f in $(git ls-files '*.md' '*.py' '*.mjs' '*.ts' '*.tsx' '*.json'); do
  grep -o 'review/[A-Za-z0-9._/-]*\.\(md\|py\)' "$f" | sort -u | while read -r p; do
    [ -e "$p" ] || echo "$f -> $p"
  done
done
```

One expected hit is not a defect: `RECONCILIATION-rethink-pivot-proposal-2026-10-16.md` names a
philosophy write-up inside a sentence stating that the file was never committed, so the path is
deliberately pointing at something absent.

**Gates must be able to fail.** A plan's §8 gate table pairs every assertion with the negative control
that fails it. Three claims in this folder were found to be resting on gates that could not fail or
could not observe the thing they claimed — see `README.md` at the repository root.
