use clap::Args;

use crate::cli::format::FormatArg;

#[derive(Debug, Args)]
#[command(
    about = "Initialize the selected vault using Local mode by default",
    after_help = "In a Git checkout, a new Local vault is stored in that checkout's Git metadata. A new Shared vault uses the project-root .vault/. Non-Git Local projects keep the project-root .vault/ location."
)]
pub struct InitCommand {
    /// Create a Shared vault at the project-root .vault/ (mode does not follow --vault PATH)
    #[arg(long)]
    pub shared: bool,

    /// Select output format
    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
