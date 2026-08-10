# AGENTS.md

## Product

This repository is **Sequence Control Tower**, the current Electron/React
desktop product for Windows and macOS validation engineers. It combines a
VS Code/Notepad++-style log workbench with local rules, structured results,
evaluation history, an Agent-native workflow, and optional OpenCode support.

## Source Map

- `src/`: renderer UI, domain models, and views
- `electron/main/`: local services, Agent harness, OpenCode/MCP integration
- `electron/preload/`: renderer-safe desktop API
- `tests/`: product and regression tests
- `docs/manual/`: current Korean operator manual

## Product Principles

- Keep source logs read-only and keep every result traceable to its evidence.
- Use deterministic parsing for firm judgments; use the Agent for context,
  uncertainty, questions, trends, and project memory.
- Keep LLM requests bounded and safe for slow OpenAI-compatible providers.
- Keep the established dark workbench compact and consistent; reuse the Log
  page controls and avoid box-heavy layouts or repetitive helper text.
- Update tests and the current manual with user-visible behavior.

## Validation

Use focused tests while editing. For shared behavior, run `npm run typecheck`,
`npm test`, and `npm run build`. Package versions come from `package.json`.
