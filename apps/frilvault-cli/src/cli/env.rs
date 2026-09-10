use clap::{Args, Subcommand};
use std::path::PathBuf;

use super::format::FormatArg;

#[derive(Debug, Args)]
pub struct EnvCommand {
    #[command(subcommand)]
    pub action: EnvAction,
}

#[derive(Debug, Subcommand)]
pub enum EnvAction {
    Identity(IdentityCommand),
    Recipients(RecipientsCommand),
}

#[derive(Debug, Args)]
pub struct IdentityCommand {
    #[command(subcommand)]
    pub action: IdentityAction,
}

#[derive(Debug, Subcommand)]
pub enum IdentityAction {
    Create(IdentityCreateCommand),
    Show(IdentityShowCommand),
}

#[derive(Debug, Args)]
pub struct IdentityCreateCommand {
    /// Read an existing age identity from stdin without echoing it.
    #[arg(long)]
    pub stdin: bool,

    /// Explicit permission-restricted fallback file, also usable as CI input.
    #[arg(long, value_name = "PATH")]
    pub identity_file: Option<PathBuf>,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct IdentityShowCommand {
    /// Explicit permission-restricted fallback file.
    #[arg(long, value_name = "PATH")]
    pub identity_file: Option<PathBuf>,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct RecipientsCommand {
    #[command(subcommand)]
    pub action: RecipientsAction,
}

#[derive(Debug, Subcommand)]
pub enum RecipientsAction {
    List(RecipientsListCommand),
    Add(RecipientsAddCommand),
    Remove(RecipientsRemoveCommand),
}

#[derive(Debug, Args)]
pub struct RecipientsListCommand {
    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct RecipientsAddCommand {
    /// Stable collaborator identifier.
    pub recipient_id: String,

    /// Public age recipient (age1...).
    pub age_recipient: String,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct RecipientsRemoveCommand {
    /// Stable collaborator identifier to remove.
    pub recipient_id: String,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
