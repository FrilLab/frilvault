# AI Integration

FrilVault generates `.vault/AGENTS.md` during `flvt init`. This file is a
knowledge-layer contract for AI tools working with FrilVault metadata; it is
not a replacement for the repository's root `AGENTS.md` and does not authorize
source-code changes.

The generated guidance covers:

- the Vault storage model and the CLI-first note workflow
- line and symbol anchor selection
- tag normalization and reuse
- preservation of note IDs, unknown fields, and unrelated notes
- validation after Vault changes
- Local/Shared mode and external Vault path behavior

Initialization writes the file only when it is absent. If a user customizes
`.vault/AGENTS.md`, later `flvt init` commands preserve it byte-for-byte. The
file contains a separate template-format version so future template changes
can be reviewed without silently replacing user content.

Recommended AI workflow:

1. Read the repository `AGENTS.md`, then read the selected Vault's
   `.vault/AGENTS.md`.
2. Inspect existing notes and tags before making a change.
3. Use `flvt` commands whenever an equivalent operation exists.
4. Run focused Vault validation and confirm unrelated notes remain unchanged.

The generated file is placed at the resolved Vault Path. With no explicit
`--vault` option, FrilVault uses the nearest existing `.vault` or creates the
workspace-root `.vault`; an explicit path remains authoritative.
