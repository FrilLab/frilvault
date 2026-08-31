use anyhow::{Context, Result};
use std::path::Path;

use crate::{
    cli::resolve_uri::ResolveUriCommand,
    output::{OutputFormat, print_json, resolve_format},
};

/// Executes `flvt resolve-uri` and prints the resolved note view.
///
/// `flvt resolve-uri`를 실행하고 해석된 note view를 출력합니다.
pub fn execute(command: ResolveUriCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: ResolveUriCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    let note_view = service
        .resolve_note_uri(&command.uri)
        .context("failed to resolve note uri")?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&note_view)?;
        return Ok(());
    }

    println!("{}:{}", note_view.source_file.display(), note_view.note.id);

    Ok(())
}
