use std::io::{self, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use frilvault_core::{TagColor, TagGroupBy, TagStatistic, TagSummary};

use crate::{
    cli::tag::{
        TagAction, TagColorAction, TagColorArg, TagColorCommand, TagColorRemoveCommand,
        TagColorSetCommand, TagCommand, TagGroupByArg, TagListCommand, TagMergeCommand,
        TagRemoveCommand, TagRenameCommand, TagStatsCommand,
    },
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: TagCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: TagCommand, vault_path: Option<&Path>) -> Result<()> {
    match command.action {
        TagAction::Rename(rename) => execute_rename(rename, vault_path),
        TagAction::Merge(merge) => execute_merge(merge, vault_path),
        TagAction::Remove(remove) => execute_remove(remove, vault_path),
        TagAction::List(list) => execute_list(list, vault_path),
        TagAction::Stats(stats) => execute_stats(stats, vault_path),
        TagAction::Color(color) => execute_color(color, vault_path),
    }
}

fn execute_rename(command: TagRenameCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let format = resolve_format(command.format);

    let result = if command.dry_run {
        service.preview_rename_tag(&command.old_tag, &command.new_tag)?
    } else {
        service.rename_tag(&command.old_tag, &command.new_tag)?
    };

    if matches!(format, OutputFormat::Json) {
        print_json(&result)?;
        return Ok(());
    }

    if command.dry_run {
        println!(
            "[Dry run] Renaming tag '{}' to '{}' would affect {} note{} across {} file{}.",
            command.old_tag,
            command.new_tag,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
    } else if result.affected_notes == 0 {
        println!("No notes found with tag '{}'.", command.old_tag);
    } else {
        println!(
            "Renamed tag '{}' to '{}' in {} note{} across {} file{}.",
            command.old_tag,
            command.new_tag,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
    }

    Ok(())
}

fn execute_merge(command: TagMergeCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let format = resolve_format(command.format);

    let result = if command.dry_run {
        service.preview_merge_tags(&command.sources, &command.into)?
    } else {
        service.merge_tags(&command.sources, &command.into)?
    };

    if matches!(format, OutputFormat::Json) {
        print_json(&result)?;
        return Ok(());
    }

    let sources_display = command.sources.join(", ");
    if command.dry_run {
        println!(
            "[Dry run] Merging tag(s) [{}] into '{}' would affect {} note{} across {} file{}.",
            sources_display,
            command.into,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
    } else if result.affected_notes == 0 {
        println!("No notes found with matching source tags.");
    } else {
        println!(
            "Merged tag(s) [{}] into '{}' in {} note{} across {} file{}.",
            sources_display,
            command.into,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
    }

    Ok(())
}

fn execute_remove(command: TagRemoveCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let format = resolve_format(command.format);

    if command.dry_run {
        let result = service.preview_remove_tag(&command.tag)?;
        if matches!(format, OutputFormat::Json) {
            print_json(&result)?;
            return Ok(());
        }
        println!(
            "[Dry run] Removing tag '{}' would affect {} note{} across {} file{}.",
            command.tag,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
        return Ok(());
    }

    if !command.yes {
        if matches!(format, OutputFormat::Json) {
            bail!("tag removal requires explicit confirmation; pass --yes when using JSON format");
        }

        let preview = service.preview_remove_tag(&command.tag)?;
        if preview.affected_notes == 0 {
            println!("No notes found with tag '{}'.", command.tag);
            return Ok(());
        }

        print!(
            "Are you sure you want to remove tag '{}' from {} note{}? [y/N]: ",
            command.tag,
            preview.affected_notes,
            if preview.affected_notes == 1 { "" } else { "s" },
        );
        io::stdout().flush().context("failed to flush stdout")?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .context("failed to read confirmation")?;

        let trimmed = input.trim().to_lowercase();
        if trimmed != "y" && trimmed != "yes" {
            println!("Aborted.");
            return Ok(());
        }
    }

    let result = service.remove_tag(&command.tag)?;

    if matches!(format, OutputFormat::Json) {
        print_json(&result)?;
        return Ok(());
    }

    if result.affected_notes == 0 {
        println!("No notes found with tag '{}'.", command.tag);
    } else {
        println!(
            "Removed tag '{}' from {} note{} across {} file{}.",
            command.tag,
            result.affected_notes,
            if result.affected_notes == 1 { "" } else { "s" },
            result.affected_files,
            if result.affected_files == 1 { "" } else { "s" },
        );
    }

    Ok(())
}

fn execute_list(command: TagListCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let format = resolve_format(command.format);
    let mut tags = service.list_tags()?;
    let mut colors = vault.tag_colors()?;

    for summary in &mut tags {
        summary.color = colors.remove(&summary.tag.to_lowercase());
    }
    tags.extend(colors.into_iter().map(|(tag, color)| TagSummary {
        tag,
        note_count: 0,
        color: Some(color),
    }));
    tags.sort_by_key(|summary| summary.tag.to_lowercase());
    if command.unused {
        tags.retain(|summary| summary.note_count == 0);
    }

    if matches!(format, OutputFormat::Json) {
        print_json(&tags)?;
        return Ok(());
    }

    if tags.is_empty() {
        if command.unused {
            println!("No unused tags found.");
        } else {
            println!("No tags found.");
        }
        return Ok(());
    }

    if command.unused {
        println!(
            "Found {} unused tag{}:",
            tags.len(),
            if tags.len() == 1 { "" } else { "s" }
        );
        for item in tags {
            println!("- {}", item.tag);
        }
    } else {
        println!(
            "Found {} tag{}:",
            tags.len(),
            if tags.len() == 1 { "" } else { "s" }
        );
        for item in tags {
            println!(
                "- {} ({} note{})",
                item.tag,
                item.note_count,
                if item.note_count == 1 { "" } else { "s" }
            );
        }
    }

    Ok(())
}

fn execute_color(command: TagColorCommand, vault_path: Option<&Path>) -> Result<()> {
    match command.action {
        TagColorAction::Set(command) => execute_color_set(command, vault_path),
        TagColorAction::Remove(command) => execute_color_remove(command, vault_path),
    }
}

fn execute_color_set(command: TagColorSetCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let format = resolve_format(command.format);
    let color = match command.color {
        TagColorArg::Red => TagColor::Red,
        TagColorArg::Orange => TagColor::Orange,
        TagColorArg::Yellow => TagColor::Yellow,
        TagColorArg::Green => TagColor::Green,
        TagColorArg::Blue => TagColor::Blue,
        TagColorArg::Purple => TagColor::Purple,
    };
    vault.set_tag_color(&command.tag, color)?;

    if matches!(format, OutputFormat::Json) {
        print_json(&serde_json::json!({ "tag": command.tag, "color": color }))?;
    } else {
        println!("Set tag '{}' color to {}.", command.tag, color.as_str());
    }
    Ok(())
}

fn execute_color_remove(command: TagColorRemoveCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let format = resolve_format(command.format);
    let removed = vault.remove_tag_color(&command.tag)?;

    if matches!(format, OutputFormat::Json) {
        print_json(&serde_json::json!({ "tag": command.tag, "removed": removed }))?;
    } else if removed {
        println!("Removed color from tag '{}'.", command.tag);
    } else {
        println!("Tag '{}' has no configured color.", command.tag);
    }
    Ok(())
}

fn execute_stats(command: TagStatsCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;
    let format = resolve_format(command.format);
    let group_by = command.group_by.map(|group_by| match group_by {
        TagGroupByArg::File => TagGroupBy::File,
        TagGroupByArg::Directory => TagGroupBy::Directory,
    });
    let statistics = service.tag_statistics(command.tag.as_deref(), group_by)?;

    if matches!(format, OutputFormat::Json) {
        print_json(&statistics)?;
        return Ok(());
    }

    print_tag_statistics(&statistics);
    Ok(())
}

fn print_tag_statistics(statistics: &[TagStatistic]) {
    println!("Tag Statistics");

    if statistics.is_empty() {
        println!();
        println!("No matching tags found.");
        return;
    }

    for statistic in statistics {
        println!();
        println!("{} ({})", statistic.tag, statistic.note_count);
        for item in &statistic.breakdown {
            println!("  {} {}", item.path.display(), item.note_count);
        }
    }
}
