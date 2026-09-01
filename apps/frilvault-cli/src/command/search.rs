use anyhow::{Result, bail};
use frilvault_core::{NoteQuery, TagQuery};
use std::path::Path;

use crate::{
    cli::search::SearchCommand,
    output::{OutputFormat, print_notes, resolve_format},
};

pub fn execute(command: SearchCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: SearchCommand, vault_path: Option<&Path>) -> Result<()> {
    if command.keyword.is_none()
        && command.file.is_none()
        && command.tags.is_empty()
        && command.tag_query.is_none()
    {
        bail!("search requires a keyword, --file, --tag, or --tag-query");
    }

    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    let tag_query = if let Some(query) = command.tag_query {
        Some(TagQuery::parse(&query)?)
    } else if command.tags.is_empty() {
        None
    } else {
        Some(TagQuery::all(&command.tags)?)
    };

    let query = NoteQuery {
        source_file: command.file.map(Into::into),
        keyword: command.keyword,
        tag: None,
    };

    let results = service.query_notes_with_tag_query(&query, tag_query.as_ref())?;
    let format = resolve_format(command.format);

    if results.is_empty() && matches!(format, OutputFormat::Text) {
        println!("No notes found.");
    } else {
        print_notes(&results, format)?;
    }

    Ok(())
}
