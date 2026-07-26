use clap::Args;

use super::format::FormatArg;

#[derive(Debug, Args)]
pub struct IndexCommand {
    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
