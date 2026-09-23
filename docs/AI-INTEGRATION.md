# AI Integration

FrilVault does not generate or manage `.vault/AGENTS.md`. New Vaults contain
only the metadata required by active FrilVault features, and initialization
never creates a repository-root `AGENTS.md` as a replacement.

Existing `.vault/AGENTS.md` files are user-owned. FrilVault leaves them
byte-for-byte unchanged during initialization and Vault operations. If an
older version created one, users may review its contents and remove it
manually when appropriate.

Vault safety is enforced by the Core and CLI through validated paths, atomic
persistence, preservation of unrelated data, controlled errors, and redacted
output. It does not depend on an AI tool discovering or following a generated
Markdown instruction file. Repository-root `AGENTS.md` files remain entirely
under repository-owner control.
