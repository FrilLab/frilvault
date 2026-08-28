# Testing and Validation

This document defines the validation expected before a FrilVault change is submitted or merged.

## Principles

- Test observable behavior rather than implementation details.
- Add regression coverage for every confirmed bug fix.
- Keep tests isolated from the user's real workspace.
- Use temporary directories for file-system tests.
- Do not depend on test execution order.
- Do not make tests pass by weakening assertions.
- Do not delete existing tests without documenting why they are obsolete.
- Keep shared test helpers close to the layer they support.
- Prefer deterministic inputs and outputs.

## Determine the Affected Surfaces

Before running commands, identify which parts changed:

- Rust core crate
- CLI
- VS Code extension
- desktop application
- GitHub Actions or release configuration
- documentation only

Run the checks relevant to every affected surface.

## Rust Workspace

Minimum validation:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

For release-sensitive changes:

```bash
cargo build --workspace --release
```

For documentation-sensitive Rust changes, when configured:

```bash
cargo doc --workspace --all-features --no-deps
```

Do not add broad `#[allow(...)]` attributes merely to silence Clippy. Fix the warning or document why a narrowly scoped allowance is necessary.

## Focused Rust Tests

During implementation, run the smallest relevant test first:

```bash
cargo test -p frilvault-core <TEST_NAME>
cargo test -p frilvault-cli <TEST_NAME>
```

Before opening the Pull Request, run the full required workspace checks.

## File-System Tests

File-system tests must:

- create isolated temporary directories
- avoid global user paths
- clean up automatically
- avoid assumptions about path separators
- handle UTF-8 paths where practical
- verify both success and failure behavior
- avoid depending on pre-existing `.vault` data

Destructive operations should be tested against temporary fixtures only.

## CLI Tests

CLI behavior should verify, as applicable:

- command parsing
- required and optional arguments
- exit status
- standard output
- standard error
- JSON or other structured output
- invalid input handling
- missing workspace handling
- file path normalization

When adding a format option, verify that output remains stable and machine-readable.

## VS Code Extension and Node Components

Inspect the actual scripts before running commands:

```bash
cat package.json
```

Do not invent script names.

Common checks may include:

```bash
npm run format:check
npm run lint
npm run check-types
npm test
npm run compile
npm run package
```

Use only scripts that exist in the relevant `package.json`.

When the extension calls the CLI or native bridge, test the boundary instead of duplicating core behavior in JavaScript tests.

Current repository reality:

- `apps/vscode-extension/package.json` exposes `check-types`, not `typecheck`.
- `npm run compile` is the normal local validation path for the extension bundle.
- `npm run test:coverage` runs the extension test suite with V8 coverage and writes LCOV output to `apps/vscode-extension/coverage/lcov.info`.
- Linux CI runs extension tests under `xvfb-run` because the VS Code Electron host requires a display.
- `npm test` runs `vscode-test`. In restricted macOS sandboxes the Electron host may abort with `SIGABRT`; rerun outside the sandbox before treating it as a code failure.

## Desktop Application

For desktop changes, validate:

- application build
- core command integration
- startup behavior
- file-system permissions
- packaged asset paths
- platform-specific configuration
- updater or release metadata, when applicable

When full platform testing is unavailable, state exactly which operating system and packaging paths were not verified.

## GitHub Actions

Workflow changes should be checked for:

- valid YAML
- valid action versions
- correct event filters
- appropriate permissions
- cache keys
- artifact paths
- release conditions
- absence of secrets in logs

When practical, inspect workflow syntax with available repository tooling before pushing.

Do not claim that a workflow succeeds locally when it can only be validated by GitHub Actions.

## Documentation-Only Changes

Documentation-only changes do not normally require a full release build.

Still verify:

- code examples match the current CLI
- paths and package names exist
- internal links are valid
- commands do not contain destructive mistakes
- release or installation instructions match the actual pipeline

For Local/Shared vault mode documentation, also verify the focused contract:

- `flvt --help` lists `init`, and `flvt init --help` lists `--shared`.
- A fresh `flvt init` reports `Mode: local`; a fresh `flvt init --shared`
  reports `Mode: shared`.
- `.vault/workspace.json` uses the top-level `mode` field with the serialized
  values `local` or `shared`.
- Removing `mode` from legacy metadata still loads the workspace as Local.
- Local initialization adds `.vault/` to repository-local
  `.git/info/exclude` without changing `.gitignore`; Shared initialization does
  not add that local exclusion.
- README, architecture, and release documentation describe the same
  default/opt-in behavior and do not promise mode switching or migration.

## Failed Validation

When a check fails, report:

```text
Command:
Status:
Relevant error:
Introduced by this change:
Next action:
```

Distinguish among:

- a failure introduced by the branch
- a pre-existing base-branch failure
- an environment limitation
- a flaky external dependency
- a skipped check

Do not mark skipped checks as passed.

## Pull Request Validation Section

Use a concrete checklist:

```markdown
## Validation

- [x] `cargo fmt --all --check`
- [x] `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- [x] `cargo test --workspace --all-features`
- [ ] Manual desktop launch on Windows
```

Unchecked items must include a reason when they are expected for the issue.

## Merge Requirement

A Pull Request must not be merged while a required check is failing.

Exceptions require an explicit decision from the repository maintainer and must be recorded in the Pull Request.
