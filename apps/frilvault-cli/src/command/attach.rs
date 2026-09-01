use anyhow::{Context, Result};
use std::path::Path;
use uuid::Uuid;

use crate::{
    cli::attach::AttachCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: AttachCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: AttachCommand, vault_path: Option<&Path>) -> Result<()> {
    let note_id = Uuid::parse_str(&command.id).context("invalid note id")?;

    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    let attachment = service.attach_image(&command.file, note_id, &command.image)?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&attachment)?;
        return Ok(());
    }

    println!(
        "Attached {} ({})",
        attachment.filename, attachment.mime_type
    );

    Ok(())
}
