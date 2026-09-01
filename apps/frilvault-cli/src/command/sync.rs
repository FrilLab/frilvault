use anyhow::{Result, bail};
use std::path::Path;

use crate::{
    cli::sync::SyncCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: SyncCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: SyncCommand, vault_path: Option<&Path>) -> Result<()> {
    if command.notes_only && command.sources_only {
        bail!("cannot use --notes-only and --sources-only together");
    }

    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;
    service.warm_up()?;

    let sync_notes = !command.sources_only;
    let sync_sources = !command.notes_only;

    let result = service.sync_external_changes(sync_notes, sync_sources)?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&result)?;
        return Ok(());
    }

    if result.notes_synced {
        println!("Note cache and workspace index refreshed.");
    }

    println!("Applied {} source repair(s)", result.repairs_applied);

    Ok(())
}
