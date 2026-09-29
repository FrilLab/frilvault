use clap::Args;

use super::format::FormatArg;

#[derive(Debug, Args)]
#[command(
    about = "Show the current FrilVault workspace status",
    after_help = r#"The note count is read from note files at command time, so external note changes are reflected.

Examples:
  flvt status
  flvt status --format json

Text output:
  Vault: <git-dir>/frilvault/vaults/root
  Mode: local
  Git tracking: outside Git worktree
  Notes: 42

JSON output:
  {
    "vault_path": "<git-dir>/frilvault/vaults/root",
    "mode": "local",
    "git_tracking": "outside_work_tree",
    "note_count": 42
  }

JSON fields:
  vault_path, mode, git_tracking, note_count"#
)]
pub struct StatusCommand {
    /// Select output format (text by default)
    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
