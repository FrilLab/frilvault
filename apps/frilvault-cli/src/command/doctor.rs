use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use frilvault_core::{
    EnvIdentity, EnvProfileStore, EnvReadiness, EnvReadinessReport, EnvReadinessStatus,
    FrilVaultError,
};
use serde_json::Value;

use crate::{
    cli::{env::EnvDoctorCommand, health::HealthCommand},
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: HealthCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: HealthCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;
    let health = service.health_check()?;

    let env_report = if EnvProfileStore::new_at_vault_root(vault.vault_root())
        .env_root()
        .exists()
    {
        let (identity, identity_status) = load_identity_status(&vault, None)?;
        Some(EnvReadiness::inspect(
            vault.vault_root(),
            None,
            identity.as_ref(),
            identity_status,
        ))
    } else {
        None
    };

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        if let Some(env_report) = env_report {
            let mut output = serde_json::to_value(&health)?;
            if let Value::Object(fields) = &mut output {
                fields.insert("env".to_string(), serde_json::to_value(env_report)?);
            }
            print_json(&output)?;
        } else {
            print_json(&health)?;
        }
        return Ok(());
    }

    println!("Workspace Health Check\n");

    if health.missing_source_files.is_empty() {
        println!("No missing source files.");
    } else {
        println!("Missing Source Files\n");

        for file in health.missing_source_files {
            println!("- {}", file);
        }
    }

    if let Some(env_report) = env_report {
        println!();
        print_env_report(&env_report);
    }

    Ok(())
}

pub(crate) fn execute_env(command: EnvDoctorCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let (identity, identity_status) = load_identity_status(&vault, command.identity_file)?;
    let profile_name = command.profile;
    let report = EnvReadiness::inspect(
        vault.vault_root(),
        Some(&profile_name),
        identity.as_ref(),
        identity_status,
    );

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&report)?;
    } else {
        print_env_report(&report);
    }

    if report.status != EnvReadinessStatus::Ready {
        bail!("environment profile '{profile_name}' is not ready")
    }

    Ok(())
}

fn load_identity_status(
    vault: &frilvault_core::FrilVault,
    identity_file: Option<PathBuf>,
) -> Result<(Option<EnvIdentity>, EnvReadinessStatus)> {
    match crate::command::env::load_identity_for_doctor(vault, identity_file) {
        Ok(Some(identity)) => Ok((Some(identity), EnvReadinessStatus::Ready)),
        Ok(None) => Ok((None, EnvReadinessStatus::Missing)),
        Err(error) => {
            let status = if error
                .downcast_ref::<FrilVaultError>()
                .is_some_and(|error| matches!(error, FrilVaultError::InvalidEnvIdentity))
            {
                EnvReadinessStatus::Invalid
            } else {
                EnvReadinessStatus::Unavailable
            };
            Ok((None, status))
        }
    }
}

fn print_env_report(report: &EnvReadinessReport) {
    println!("Environment Readiness");
    if let Some(profile) = &report.profile {
        println!("Profile: {profile}");
    }
    println!("Status: {}\n", report.status.label());

    for (name, check) in &report.checks {
        print!("{name}: {}", check.status.label());
        if let Some(path) = &check.path {
            print!(" ({})", path.display());
        }
        println!();
        if let Some(remediation) = check.remediation {
            println!("  Remediation: {remediation}");
        }
    }

    println!("\nProfiles:");
    if report.profiles.is_empty() {
        println!("- none");
    } else {
        for profile in &report.profiles {
            println!(
                "- {}: {} ({})",
                profile.profile,
                profile.status.label(),
                profile.path.display()
            );
        }
    }

    if report.usable_profiles.is_empty() {
        println!("\nCurrent usable profiles: none");
    } else {
        println!(
            "\nCurrent usable profiles: {}",
            report.usable_profiles.join(", ")
        );
    }
}
