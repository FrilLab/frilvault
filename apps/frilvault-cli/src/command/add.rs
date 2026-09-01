use anyhow::{Result, bail};
use frilvault_core::{AddNoteRequest, LineAnchor, NoteAnchor, SymbolAnchor, SymbolKind};
use std::path::Path;

use crate::{
    cli::add::{AddCommand, SymbolKindArg},
    output::{OutputFormat, print_json, resolve_format},
};

/// Executes `flvt add` by building a core `AddNoteRequest`.
///
/// `frilvault-core` `AddNoteRequest`를 구성해 `flvt add`를 실행합니다.
pub fn execute(command: AddCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: AddCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let source_file = command.file.clone();

    let anchor = create_anchor(&command)?;

    let note = service.add_note(AddNoteRequest {
        source_file: command.file.into(),
        anchor,
        content: command.content,
        tags: (!command.tags.is_empty()).then_some(command.tags),
    })?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        let views = service.list_notes(&source_file)?;
        let view = views
            .into_iter()
            .find(|view| view.note.id == note.id)
            .ok_or_else(|| anyhow::anyhow!("created note view not found"))?;
        print_json(&view)?;
        return Ok(());
    }

    println!("Note added successfully");

    Ok(())
}

fn create_anchor(command: &AddCommand) -> Result<NoteAnchor> {
    if let Some(symbol) = &command.symbol {
        return Ok(NoteAnchor::Symbol(SymbolAnchor {
            name: symbol.clone(),
            kind: command.kind.clone().into(),
            signature: command.signature.clone(),
            line_hint: command.line_hint,
        }));
    }

    let Some(line) = command.line else {
        bail!("either --line or --symbol must be provided");
    };

    let column = command.column.unwrap_or(1);

    Ok(NoteAnchor::Line(LineAnchor { line, column }))
}

impl From<SymbolKindArg> for SymbolKind {
    fn from(value: SymbolKindArg) -> Self {
        match value {
            SymbolKindArg::Function => SymbolKind::Function,
            SymbolKindArg::Struct => SymbolKind::Struct,
            SymbolKindArg::Enum => SymbolKind::Enum,
            SymbolKindArg::Trait => SymbolKind::Trait,
            SymbolKindArg::Impl => SymbolKind::Impl,
            SymbolKindArg::Method => SymbolKind::Method,
            SymbolKindArg::Unknown => SymbolKind::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_anchor_builds_line_anchor() {
        let command = AddCommand {
            file: "src/main.rs".to_string(),
            line: Some(12),
            column: Some(3),
            symbol: None,
            kind: SymbolKindArg::Unknown,
            signature: None,
            line_hint: None,
            content: "note".to_string(),
            tags: vec![],
            format: None,
        };

        let anchor = create_anchor(&command).unwrap();

        match anchor {
            NoteAnchor::Line(line) => {
                assert_eq!(line.line, 12);
                assert_eq!(line.column, 3);
            }
            _ => panic!("expected line anchor"),
        }
    }

    #[test]
    fn create_anchor_builds_symbol_anchor() {
        let command = AddCommand {
            file: "src/main.rs".to_string(),
            line: None,
            column: None,
            symbol: Some("main".to_string()),
            kind: SymbolKindArg::Function,
            signature: Some("fn main()".to_string()),
            line_hint: Some(1),
            content: "note".to_string(),
            tags: vec![],
            format: None,
        };

        let anchor = create_anchor(&command).unwrap();

        match anchor {
            NoteAnchor::Symbol(symbol) => {
                assert_eq!(symbol.name, "main");
                assert_eq!(symbol.kind, SymbolKind::Function);
                assert_eq!(symbol.signature.as_deref(), Some("fn main()"));
                assert_eq!(symbol.line_hint, Some(1));
            }
            _ => panic!("expected symbol anchor"),
        }
    }
}
