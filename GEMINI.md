# Operational Guidelines & Guardrails (BIMWorks Refactoring)

## Core Philosophy: Evidence-Based Engineering
1. **No Blind Edits:** Never modify a file without first reading its full contents or the surrounding context (minimum 50 lines around edit target).
2. **Targeted Precision:** Do not rewrite whole files when small refactors or surgical edits suffice. Maintain existing formatting, linting rules, and comments unless actively refactoring them.
3. **Validate Every Change:** After any refactor or structural change:
   - Run the relevant build / compiler check.
   - Run affected unit tests or verification scripts.
   - If tests fail, diagnose and fix the root cause immediately—do not proceed with further refactoring on broken state.
4. **No Speculative Dependency Changes:** Do not add external packages or update language target versions unless explicitly approved in the plan.

## State & Execution Rules
- **Phase 1: Discovery & Dependency Mapping:** Map imports, entrypoints, and callers before changing signatures or file locations.
- **Phase 2: Plan & Approval:** Provide a concise breakdown of changes (files touched, signatures altered, backward compatibility impact) before executing.
- **Phase 3: Incremental Execution:** Touch 1–2 related modules at a time, followed immediately by syntax/compilation checks.