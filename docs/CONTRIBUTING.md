# Contributing

## Scope

FrilVault is currently a small repository with a Rust core and a VS Code integration. Contributions should prefer clarity and low maintenance over adding new infrastructure.

## Environment

### Rust

```bash
cargo test -p frilvault-core
cargo test -p frilvault-cli
```

### VS Code extension

```bash
cd apps/vscode-extension
npm install
npm run compile
npm test
```

## Contribution Guidelines

- keep business logic in `crates/frilvault-core`
- keep CLI and editor integrations thin
- do not modify user source files as part of the note system
- prefer small, reviewable changes over broad rewrites
- update `README.md` or `docs/*.md` when behavior or workflows materially change

## Documentation Policy

- `README.md` is the main entry point
- `docs/ARCHITECTURE.md` explains current system shape
- `docs/ROADMAP.md` tracks intended direction
- `docs/AGENTS.md` captures agent-facing repository guidance

Avoid introducing a separate docs build system unless the project clearly needs public documentation hosting.

## Pull Request Checklist

- tests updated or added when behavior changes
- no accidental source-file mutation behavior introduced
- CLI and extension changes still delegate to shared core behavior where possible
- documentation updated if commands, workflows, or architecture changed
