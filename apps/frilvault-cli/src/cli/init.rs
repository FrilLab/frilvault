use clap::Args;

use crate::cli::format::FormatArg;

#[derive(Debug, Args)]
pub struct InitCommand {
    /// Allow the vault to be version-controlled and shared with collaborators
    #[arg(long)]
    pub shared: bool,

    /// Select output format
    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
