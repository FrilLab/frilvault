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
  Vault: .vault
  Mode: local
  Git tracking: excluded
  Notes: 42

JSON output:
  {
    "vault_path": ".vault",
    "mode": "local",
    "git_tracking": "excluded",
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
