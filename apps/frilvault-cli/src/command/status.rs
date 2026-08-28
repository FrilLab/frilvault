use anyhow::Result;
use frilvault_core::{FrilVault, GitTrackingStatus, VaultMode, WorkspaceStatus};

use crate::{
    cli::status::StatusCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: StatusCommand) -> Result<()> {
    let vault = FrilVault::open(std::env::current_dir()?)?;
    let status = vault.status()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&status)?;
    } else {
        print!("{}", format_status(&status));
    }

    Ok(())
}

fn format_status(status: &WorkspaceStatus) -> String {
    let mut output = format!(
        "Vault: {}\nMode: {}\nGit tracking: {}\nNotes: {}\n",
        status.vault_path.display(),
        status.mode.as_str(),
        status.git_tracking.as_str(),
        status.note_count,
    );

    if status.mode == VaultMode::Local && status.git_tracking == GitTrackingStatus::Tracked {
        output.push_str("\nWarning: Local vault is currently tracked by Git.\n");
    }

    output
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn formats_concise_workspace_status() {
        let status = WorkspaceStatus {
            vault_path: PathBuf::from(".vault"),
            mode: VaultMode::Shared,
            git_tracking: GitTrackingStatus::Trackable,
            note_count: 42,
        };

        assert_eq!(
            format_status(&status),
            "Vault: .vault\nMode: shared\nGit tracking: trackable\nNotes: 42\n"
        );
    }

    #[test]
    fn warns_when_local_vault_is_tracked() {
        let status = WorkspaceStatus {
            vault_path: PathBuf::from(".vault"),
            mode: VaultMode::Local,
            git_tracking: GitTrackingStatus::Tracked,
            note_count: 0,
        };

        assert!(
            format_status(&status)
                .contains("\nWarning: Local vault is currently tracked by Git.\n")
        );
    }
}
