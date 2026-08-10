# AGENTS.md

## Repository Identity

This is the canonical Sequence Control Tower repository.

- Local path: `/Users/taehoje/sequence-control-tower`
- Git remote: `https://github.com/stpcoder/sequence-control-tower.git`
- Package name: `sequence-control-tower`
- Product name: `Sequence Control Tower`

Sequence Control Tower is the default target for ambiguous software, UI,
Agent, log parsing, evaluation history, documentation, packaging, release, and
deployment requests. Do not redirect these tasks to `/Users/taehoje/skhy` or a
temporary `/tmp/sct-*` checkout.

Before making changes, verify the Git remote and the package name. If either
does not match the values above, stop before editing and report the mismatch.

## Product Context

This repository builds the Electron/React desktop Log Workbench for Windows
and macOS validation engineers. It manages multiple log folders, text search,
pattern rules, deterministic classification, structured results, evaluation
history, OpenAI-compatible LLM integration, and release packages.

The local deterministic parser and its line evidence remain the authority for
PASS/FAIL-style results. LLM or Agent output must retain source identity,
bounded evidence, explicit uncertainty, and an auditable confirmation path.
Never send complete logs, absolute paths, API keys, or secrets to an LLM.

## Implementation Rules

- Preserve the established three-pane dark workbench: log folders on the left,
  text editor in the center, analysis/results on the right.
- Treat the Log page design tokens and controls as the UI source of truth.
  Reuse them instead of introducing page-specific buttons, dropdowns, toggles,
  colors, or box-heavy layouts.
- Keep source logs read-only. Derived rules, metadata, results, and evaluation
  history must remain traceable to artifact/source IDs.
- Use `SKEW` for process-corner fields. Do not rename it to `SKU`.
- Qualcomm and MediaTek boot profiles must remain independently selectable;
  do not force UEFI stages onto MediaTek flows.
- Keep LLM calls bounded for slow OpenAI-compatible providers and preserve
  retry/resume behavior without duplicate writes.
- Update the current manual when user-visible behavior changes. Remove or
  rewrite obsolete instructions rather than layering contradictory guidance.

## Validation

Run focused tests while editing. Before committing shared behavior, run:

```bash
npm run typecheck
npm test
npm run build
```

For UI work, run the built macOS app when available, inspect the actual desktop
screens at a practical window size, and capture the current screens required by
the manual. Windows packaging is validated by the repository GitHub Actions.

## Git and Release

Preserve unrelated worktree changes. Commit only the intended Sequence Control
Tower files. Push the active branch after requested implementation and let the
configured CI/release workflows run; do not repeatedly poll unchanged CI state
unless the user explicitly asks for monitoring.
