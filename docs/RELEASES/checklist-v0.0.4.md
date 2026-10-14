# FrilVault v0.0.4 Release Checklist

- Target version: `0.0.4`
- Target date: `2026-10-14`
- Required issues: None identified; there are no open issues assigned to v0.1.0.
- Optional issues: None.
- Deferred issues: None recorded for this release. The empty v0.1.0 milestone remains open.
- Supported platforms: macOS Apple Silicon (`darwin-arm64`), macOS Intel (`darwin-x64`), Linux x64 (`linux-x64`), and Windows x64 (`win32-x64`).
- Release artifacts: Four platform-specific VSIX packages on the GitHub Release; Marketplace publishing is a separate manual workflow.
- Known limitations: The VS Code extension targets one workspace root at a time in multi-root workspaces.

## Readiness

- [x] Release scope is based on the reviewed and merged changes on `main`.
- [x] Latest `main` CI and coverage workflows pass.
- [x] Version metadata and user-facing release notes are updated.
- [x] Local release validation passes.
- [x] Release pull request #248 is merged to `main`.
- [x] GitHub Release `frilvault-v0.0.4` is published and all four VSIX assets are verified.
- [x] Marketplace publishing workflow was run after asset verification.

## Publication Status

- GitHub Release: [v0.0.4](https://github.com/FrilLab/frilvault/releases/tag/frilvault-v0.0.4). The recovery build completed successfully in [workflow run 38553746552](https://github.com/FrilLab/frilvault/actions/runs/38553746552); all four platform VSIX assets are attached.
- Marketplace: [workflow run 38554662832](https://github.com/FrilLab/frilvault/actions/runs/38554662832) stopped on the first package because the `VSCE_PAT` repository secret has expired. No v0.0.4 package was published. Rotate `VSCE_PAT`, then rerun `publish.yml` with tag `frilvault-v0.0.4`.

## Local Validation

- PASS: `cargo fmt --all --check`
- PASS: `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- PASS: `cargo test --workspace --all-features` (312 passed)
- PASS: `cargo build --workspace --release`
- PASS: extension type checks, lint, and compile
- PASS: `npm test` (265 passed, 1 pending)
