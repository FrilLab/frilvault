# Contributing

## Scope

FrilVault is currently a small repository with a Rust core and a VS Code integration. Contributions should prefer clarity and low maintenance over adding new infrastructure.

The current checkout contains:

- `crates/frilvault-core`
- `apps/frilvault-cli`
- `apps/vscode-extension`
- `docs/`

A desktop application is planned in repository guidance, but it is not present as a source tree in the current repository.

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
npm run check-types
npm run lint
npm run compile
npm test
```

Use the exact script names from `apps/vscode-extension/package.json`. The current package exposes `check-types`, not `typecheck`.

If `npm test` aborts with `SIGABRT` under `vscode-test`, treat that as unresolved validation until the cause or workaround is documented in the change or release checklist.

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
- `AGENTS.md` captures repository-wide agent-facing rules
- `docs/github-workflow.md`, `docs/testing.md`, and `docs/RELEASES/PROCESS.md` define the detailed workflow

## Release And Publish

The repository separates release asset generation from Marketplace publishing.

- `.github/workflows/release.yml` runs from a published GitHub Release and produces platform-specific VSIX artifacts
- `.github/workflows/publish.yml` is a manual Marketplace publishing workflow that uses GitHub OIDC and Microsoft Entra ID

Marketplace users do not choose a platform manually. The Marketplace serves the matching VSIX for the user's platform.

GitHub Release users download the matching VSIX asset and install it with `Extensions: Install from VSIX...` in VS Code.

Avoid introducing a separate docs build system unless the project clearly needs public documentation hosting.

## Pull Request Checklist

- tests updated or added when behavior changes
- no accidental source-file mutation behavior introduced
- CLI and extension changes still delegate to shared core behavior where possible
- documentation updated if commands, workflows, or architecture changed
