use anyhow::Result;
use frilvault_core::{ExplorerGroup, ExplorerNode, WorkspaceExplorer};
use std::path::Path;

use crate::{
    cli::explorer::ExplorerCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: ExplorerCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: ExplorerCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;

    let explorer = service.explorer()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&explorer)?;
        return Ok(());
    }

    print_text_tree(&explorer);
    Ok(())
}

fn print_text_tree(explorer: &WorkspaceExplorer) {
    println!("Workspace Explorer\n");
    print_node(&explorer.root, 0);
}

fn print_node(node: &ExplorerNode, depth: usize) {
    let indent = "  ".repeat(depth);

    match node {
        ExplorerNode::Directory { name, children, .. } => {
            if !name.is_empty() {
                println!("{indent}{name}/");
            }

            for child in children {
                print_node(child, if name.is_empty() { depth } else { depth + 1 });
            }
        }
        ExplorerNode::File {
            source_file,
            groups,
            ..
        } => {
            let file_name = source_file.rsplit('/').next().unwrap_or(source_file);
            println!("{indent}{file_name}");

            for group in groups {
                match group {
                    ExplorerGroup::LineNotes { notes } => {
                        println!("{indent}  Line Notes ({})", notes.len());
                    }
                    ExplorerGroup::SymbolNotes { notes } => {
                        println!("{indent}  Symbol Notes ({})", notes.len());
                    }
                }
            }
        }
    }
}
