//! Human-readable and JSON output helpers for CLI commands.
//!
//! CLI command용 사람이 읽기 쉬운 출력과 JSON 출력 helper입니다.

use anyhow::Result;
use frilvault_core::{NoteAnchor, NoteView};
use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub enum OutputFormat {
    Text,
    Json,
}

pub fn resolve_format(format: Option<crate::cli::format::FormatArg>) -> OutputFormat {
    match format {
        Some(crate::cli::format::FormatArg::Json) => OutputFormat::Json,
        Some(crate::cli::format::FormatArg::Text) | None => OutputFormat::Text,
    }
}

pub fn print_note_count(count: usize) {
    println!("Found {} note{}", count, if count == 1 { "" } else { "s" });

    println!();
}

pub fn print_notes(notes: &[NoteView], format: OutputFormat) -> Result<()> {
    match format {
        OutputFormat::Text => {
            print_note_count(notes.len());

            for note in notes {
                print_note_view(note);
            }
        }

        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(notes,)?);
        }
    }

    Ok(())
}

pub fn print_json<T>(value: &T) -> Result<()>
where
    T: Serialize,
{
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn print_note_view(view: &NoteView) {
    println!("────────────────────────────────");

    println!("ID: {}", view.note.id,);

    println!("File: {}", view.source_file.display(),);

    match &view.note.anchor {
        NoteAnchor::Line(anchor) => {
            println!("Location: {}:{}", anchor.line, anchor.column,);
        }

        NoteAnchor::Symbol(anchor) => {
            println!("Symbol: {}", anchor.name,);

            println!("Kind: {:?}", anchor.kind,);

            if let Some(signature) = &anchor.signature {
                println!("Signature: {}", signature);
            }

            if let Some(line_hint) = anchor.line_hint {
                println!("Line hint: {}", line_hint);
            }

            if let Some(resolved) = &view.resolved {
                println!("Resolved: {}:{}", resolved.line, resolved.column);
            }
        }
    }

    if !view.note.tags.is_empty() {
        println!("Tags: {}", view.note.tags.join(", "));
    }

    println!();

    println!("{}", view.note.content,);

    println!();
}
