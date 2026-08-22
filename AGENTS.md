# AGENTS.md

## Architecture

- Preserve local-first behavior and never modify source files to store notes.
- Keep reusable domain logic in `crates/frilvault-core`.
- Keep CLI, desktop, and editor integrations thin.
- Reuse the existing CLI or Node integration path; do not add another VS Code integration path without an architectural decision.
- Keep platform-specific behavior outside the core unless it is reusable domain logic.

## Changes

- Follow the relevant GitHub Issue and implement the smallest complete change.
- Keep one purpose per branch and Pull Request.
- Add or update tests when behavior changes.
- Do not remove tests or silently change public behavior.
- Avoid unrelated refactoring and broad architectural rewrites.
- Report architectural mismatches and out-of-scope findings instead of fixing them incidentally.
- Keep the repository releasable.

## Safety

- Do not rewrite Git history, force-push, delete repository resources, or run destructive cleanup commands without explicit approval.
- Never commit credentials, local environment files, temporary files, or unintended build outputs.
- Preserve existing uncommitted changes.

## References

Follow:

- [`docs/github-workflow.md`](docs/github-workflow.md)
- [`docs/testing.md`](docs/testing.md)
- [`docs/RELEASES/PROCESS.md`](docs/RELEASES/PROCESS.md)

Instruction priority:

1. Explicit user instruction
2. This `AGENTS.md`
3. Referenced documentation
4. Existing repository conventions
