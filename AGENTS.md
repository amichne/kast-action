---
type: Engineering Guide
title: "Kast action engineering guide"
description: "Names the action adapters, installer owner, and focused development commands."
resource: "repo://kast-action"
tags: [kast, actions, installation]
timestamp: "2026-11-06T17:00:00Z"
source_revision: 91c914d
code_sources:
  - path: action.yml
  - path: setup_kast.py
  - path: bin/install-kast
  - path: src/index.ts
  - path: tests/test_setup.py
  - path: mise.toml
  - path: .github/workflows/build.yml
---

# Kast action

`src/index.ts` adapts the Node action host to `bin/install-kast`.
`setup_kast.py` owns input admission, authenticated download, bootstrap dispatch, and action exports.
The composed bundle's Kast installer owns runtime extraction, component installation, private state, and workspace trust.
Keep that installer in the Kast source repository.

Use `mise exec -- npm ci`, `mise exec -- npm run lint`, and `mise exec -- npm test` for TypeScript.
Commit generated `dist/index.js` after changes to `src/index.ts`.
Use the locked uv project for `ruff check .`, `ruff format --check .`, `pyright`, and `pytest -q`.
Run `mise exec -- uv run --locked --script bin/install-kast --help` for the standalone command.
Keep its lock beside the executable.

The fixture installer in `tests/test_setup.py` proves adapter behavior with real child processes.
It does not prove native Kast semantics or a live Devin environment.
Keep those claims separate from the native evidence in Kast.
Do not restore the retired daemon, `KAST_HOME/current`, or Gradle cache inputs.
Do not edit historical tags or publish a release without explicit authorization.
