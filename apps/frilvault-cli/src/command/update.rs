use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use frilvault_core::UpdateNoteRequest;
use std::path::Path;
use uuid::Uuid;

use crate::{
    cli::update::UpdateCommand,
    output::{OutputFormat, print_json, resolve_format},
};

/// Executes `flvt update` by delegating persistence to `frilvault-core`.
///
/// JSON output returns the updated `NoteView` consumed by editor integrations.
///
/// `frilvault-core`에 저장을 위임하는 `flvt update` 실행 함수입니다.
///
/// JSON 출력은 editor integration이 사용하는 갱신된 `NoteView`를 반환합니다.
pub fn execute(command: UpdateCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: UpdateCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    let note_id = Uuid::parse_str(&command.id)?;
    let expected_updated_at = match &command.expected_updated_at {
        Some(value) => Some(
            DateTime::parse_from_rfc3339(value)
                .with_context(|| format!("invalid expected-updated-at value: {value}"))?
                .with_timezone(&Utc),
        ),
        None => None,
    };

    let updated = service.update_note(
        &command.file,
        note_id,
        UpdateNoteRequest {
            content: command.content,
            tags: (!command.tags.is_empty()).then_some(command.tags),
            expected_updated_at,
        },
    )?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        let views = service.list_notes(&command.file)?;
        let view = views
            .into_iter()
            .find(|view| view.note.id == note_id)
            .context("updated note view not found")?;
        print_json(&view)?;
        return Ok(());
    }

    println!("Note updated");
    println!("Updated at: {}", updated.updated_at.to_rfc3339());

    Ok(())
}
