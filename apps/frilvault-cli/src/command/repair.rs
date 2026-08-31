use std::io::{self, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use frilvault_core::{FileMove, WorkspaceService};

use crate::{
    cli::repair::RepairCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: RepairCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: RepairCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;
    service.warm_up()?;
    let format = resolve_format(command.format);

    if command.interactive {
        if matches!(format, OutputFormat::Json) {
            bail!("interactive repair requires text output; omit --format json");
        }

        return execute_interactive(&mut service);
    }

    if command.apply {
        let repaired = service.apply_repairs()?;

        if matches!(format, OutputFormat::Json) {
            print_json(&repaired)?;
            return Ok(());
        }

        println!("Applied {} repair(s)", repaired,);

        return Ok(());
    }

    let suggestions = service.repair_suggestions()?;

    if matches!(format, OutputFormat::Json) {
        print_json(&suggestions)?;
        return Ok(());
    }

    if suggestions.is_empty() {
        println!("No repair suggestions.");

        return Ok(());
    }

    println!("Repair Suggestions\n");

    for suggestion in suggestions {
        println!("Missing: {}\n", suggestion.missing_file,);

        if suggestion.candidates.is_empty() {
            println!("No candidates found.\n");

            continue;
        }

        println!("Possible Matches:");

        for candidate in suggestion.candidates {
            println!("- {}", candidate,);
        }

        println!();
    }

    Ok(())
}

fn execute_interactive(service: &mut WorkspaceService) -> Result<()> {
    let suggestions = service
        .repair_suggestions()
        .context("failed to load repair suggestions")?;

    if suggestions.is_empty() {
        println!("No repair suggestions.");

        return Ok(());
    }

    let mut moves = Vec::new();

    for suggestion in suggestions {
        if suggestion.candidates.is_empty() {
            println!("Missing:\n{}\n", suggestion.missing_file);
            println!("No candidates found.\n");
            continue;
        }

        let selected = prompt_candidate(&suggestion.missing_file, &suggestion.candidates)?;

        let Some(selected) = selected else {
            println!("Skipped.\n");
            continue;
        };

        let confidence = service
            .repair_confidence(&suggestion.missing_file, &selected)
            .context("failed to score selected repair target")?;

        moves.push(FileMove {
            from: suggestion.missing_file,
            to: selected,
            confidence,
        });
    }

    if moves.is_empty() {
        println!("No repairs selected.");

        return Ok(());
    }

    let repaired = service
        .apply_repair_moves(moves)
        .context("failed to apply selected repairs")?;

    println!("Applied {} repair(s)", repaired);

    Ok(())
}

fn prompt_candidate(missing_file: &str, candidates: &[String]) -> Result<Option<String>> {
    println!("Missing:\n{}\n", missing_file);

    for (index, candidate) in candidates.iter().enumerate() {
        println!("{}. {}", index + 1, candidate);
    }

    println!("0. Skip");

    loop {
        print!("Select target: ");
        io::stdout().flush().context("failed to flush stdout")?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .context("failed to read selection")?;

        let selection = input.trim();

        if selection == "0" {
            return Ok(None);
        }

        let Ok(index) = selection.parse::<usize>() else {
            println!("Invalid selection.");
            continue;
        };

        if index == 0 || index > candidates.len() {
            println!("Invalid selection.");
            continue;
        }

        return Ok(Some(candidates[index - 1].clone()));
    }
}
