use anyhow::Result;
use std::path::Path;

use crate::{
    cli::gitignore::{GitignoreAction, GitignoreCheckCommand, GitignoreCommand},
    output::{OutputFormat, print_json, resolve_format},
};

#[derive(serde::Serialize)]
struct GitignoreStatus {
    ignored: bool,
}

pub fn execute(command: GitignoreCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: GitignoreCommand, vault_path: Option<&Path>) -> Result<()> {
    match command.action {
        GitignoreAction::Check(check) => execute_check(check, vault_path),
        GitignoreAction::Add => execute_add(vault_path),
    }
}

fn execute_check(command: GitignoreCheckCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let service = vault.workspace()?;
    let ignored = service.is_vault_gitignored()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&GitignoreStatus { ignored })?;
        return Ok(());
    }

    let vault_path = vault.vault_path();
    if ignored {
        println!("{}/ is ignored by Git.", vault_path.display());
    } else {
        println!("{}/ is not ignored by Git.", vault_path.display());
    }

    Ok(())
}

fn execute_add(vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let service = vault.workspace()?;
    service.append_vault_to_gitignore()?;
    println!("Added {}/ to .gitignore.", vault.vault_path().display());

    Ok(())
}
