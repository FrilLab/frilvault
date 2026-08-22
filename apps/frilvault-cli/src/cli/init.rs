use clap::Args;

#[derive(Debug, Args)]
pub struct InitCommand {
    /// Allow the vault to be version-controlled and shared with collaborators
    #[arg(long)]
    pub shared: bool,
}
