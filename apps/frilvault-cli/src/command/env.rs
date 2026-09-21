use std::{
    cell::Cell,
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, BufRead, IsTerminal, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus},
};

use anyhow::{Context, Result, bail};
use frilvault_core::{
    EnvIdentity, EnvIdentityManager, EnvIdentityStore, EnvManifestStore, EnvProfileStore,
    EnvRecipient, EnvRecipientStore, FrilVaultError, FrilVaultResult, validate_env_variable_name,
    validate_profile_name,
};
use serde::Serialize;

use crate::{
    cli::env::{
        EnvAction, EnvCommand, EnvImportCommand, EnvInitCommand, EnvListCommand, EnvRunCommand,
        EnvSetCommand, EnvValidateCommand, IdentityAction, IdentityCreateCommand,
        IdentityShowCommand, RecipientsAction, RecipientsAddCommand, RecipientsListCommand,
        RecipientsRemoveCommand,
    },
    output::{OutputFormat, print_json, resolve_format},
};

const KEYRING_SERVICE: &str = "frilvault";
const KEYRING_USER: &str = "environment-identity-v1";

pub fn execute(command: EnvCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: EnvCommand, vault_path: Option<&Path>) -> Result<()> {
    match command.action {
        EnvAction::Doctor(doctor) => crate::command::doctor::execute_env(doctor, vault_path),
        EnvAction::Init(init) => execute_init(init, vault_path),
        EnvAction::Identity(identity) => match identity.action {
            IdentityAction::Create(create) => execute_identity_create(create, vault_path),
            IdentityAction::Show(show) => execute_identity_show(show, vault_path),
        },
        EnvAction::Recipients(recipients) => match recipients.action {
            RecipientsAction::List(list) => execute_recipients_list(list, vault_path),
            RecipientsAction::Add(add) => execute_recipients_add(add, vault_path),
            RecipientsAction::Remove(remove) => execute_recipients_remove(remove, vault_path),
        },
        EnvAction::Rotate(rotate) => execute_rotate(rotate, vault_path),
        EnvAction::Run(run) => execute_run(run, vault_path),
        EnvAction::Set(set) => execute_set(set, vault_path),
        EnvAction::List(list) => execute_list(list, vault_path),
        EnvAction::Validate(validate) => execute_validate(validate, vault_path),
        EnvAction::Import(import) => execute_import(import, vault_path),
    }
}

#[derive(Debug, Serialize)]
struct EnvInitOutput {
    manifest: PathBuf,
    profiles: PathBuf,
    created: bool,
}

#[derive(Debug, Serialize)]
struct EnvVariableStatus {
    name: String,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct EnvProfileStatus {
    profile: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    variables: Vec<EnvVariableStatus>,
}

fn execute_init(command: EnvInitCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let manifest_store = EnvManifestStore::new(vault.vault_root());
    let created = manifest_store.initialize()?;
    let output = EnvInitOutput {
        manifest: manifest_store.path().to_path_buf(),
        profiles: vault.vault_root().join("env").join("profiles"),
        created,
    };

    match resolve_format(command.format) {
        OutputFormat::Text => {
            if created {
                println!("Initialized FrilVault environment metadata.");
            } else {
                println!("Environment metadata already initialized.");
            }
            println!("Manifest: {}", output.manifest.display());
            println!("Profiles: {}", output.profiles.display());
        }
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn execute_set(command: EnvSetCommand, vault_path: Option<&Path>) -> Result<()> {
    validate_env_variable_name(&command.key)?;
    validate_profile_name(&command.profile)?;

    let vault = super::open_vault(vault_path)?;
    let manifest = EnvManifestStore::new(vault.vault_root()).load()?;
    if !manifest.variables().contains_key(&command.key) {
        bail!(
            "environment variable is not declared by the manifest: {}",
            command.key
        );
    }

    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let identity = require_identity(PreferredIdentityStore::new(identity_file))?;
    let profile_store = EnvProfileStore::new_at_vault_root(vault.vault_root());
    let profile_path = profile_store.profile_path(&command.profile)?;
    let mut values = if profile_path.is_file() {
        profile_store
            .load_profile(&command.profile, &[identity.age_identity()])?
            .into_values()
    } else if profile_path.exists() {
        bail!("environment profile path is not a regular file");
    } else {
        BTreeMap::new()
    };
    if let Some(key) = values
        .keys()
        .find(|key| !manifest.variables().contains_key(*key))
    {
        bail!("environment profile contains undeclared variable: {key}");
    }

    let mode = vault.status()?.mode;
    let recipients = EnvRecipientStore::new(vault.vault_root()).load()?;

    let value = if command.stdin {
        read_value_from_stdin()?
    } else {
        rpassword::prompt_password(format!("Enter value for {}: ", command.key))?
    };
    values.insert(command.key.clone(), value);

    profile_store.save_profile_for_environment(
        &command.profile,
        &values,
        mode,
        &identity,
        &recipients,
    )?;

    let output = serde_json::json!({
        "profile": command.profile,
        "variable": command.key,
        "status": "configured",
    });
    match resolve_format(command.format) {
        OutputFormat::Text => println!(
            "Configured environment variable '{}' in profile '{}'.",
            output["variable"].as_str().unwrap_or_default(),
            output["profile"].as_str().unwrap_or_default(),
        ),
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn execute_list(command: EnvListCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let report = inspect_profile(&vault, &command.profile, command.identity_file)?;

    match resolve_format(command.format) {
        OutputFormat::Text => print_profile_status(&report),
        OutputFormat::Json => print_json(&report)?,
    }

    Ok(())
}

fn execute_validate(command: EnvValidateCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let report = inspect_profile(&vault, &command.profile, command.identity_file)?;
    let ready = report.status == "ready";

    match resolve_format(command.format) {
        OutputFormat::Text => print_profile_status(&report),
        OutputFormat::Json => print_json(&report)?,
    }

    if !ready {
        bail!(
            "environment profile '{}' is not valid ({})",
            report.profile,
            report.error_code.unwrap_or("validation_failed")
        );
    }

    Ok(())
}

fn execute_import(command: EnvImportCommand, vault_path: Option<&Path>) -> Result<()> {
    validate_profile_name(&command.profile)?;
    let values = parse_dotenv(&command.source)?;
    let vault = super::open_vault(vault_path)?;
    let manifest = EnvManifestStore::new(vault.vault_root()).load()?;
    for key in values.keys() {
        if !manifest.variables().contains_key(key) {
            bail!("environment variable is not declared by the manifest: {key}");
        }
    }

    let profile_store = EnvProfileStore::new_at_vault_root(vault.vault_root());
    let profile_path = profile_store.profile_path(&command.profile)?;
    let replaced = profile_path.exists();
    if replaced && !profile_path.is_file() {
        bail!("environment profile path is not a regular file");
    }
    if replaced && !command.replace {
        bail!(
            "environment profile '{}' already exists; pass --replace to replace it",
            command.profile
        );
    }
    if replaced
        && command.replace
        && !confirm_import(
            command.yes,
            resolve_format(command.format),
            &command.profile,
        )?
    {
        return Ok(());
    }

    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let identity = require_identity(PreferredIdentityStore::new(identity_file))?;
    let mode = vault.status()?.mode;
    let recipients = EnvRecipientStore::new(vault.vault_root()).load()?;
    profile_store.save_profile_for_environment(
        &command.profile,
        &values,
        mode,
        &identity,
        &recipients,
    )?;

    let output = serde_json::json!({
        "profile": command.profile,
        "variables": values.len(),
        "replaced": replaced,
        "status": "configured",
    });
    match resolve_format(command.format) {
        OutputFormat::Text => println!(
            "Imported {} environment variable{} into profile '{}'.",
            output["variables"].as_u64().unwrap_or_default(),
            if output["variables"].as_u64() == Some(1) {
                ""
            } else {
                "s"
            },
            output["profile"].as_str().unwrap_or_default(),
        ),
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn inspect_profile(
    vault: &frilvault_core::FrilVault,
    profile_name: &str,
    identity_file: Option<PathBuf>,
) -> Result<EnvProfileStatus> {
    validate_profile_name(profile_name)?;
    let manifest_store = EnvManifestStore::new(vault.vault_root());
    let manifest = match manifest_store.load() {
        Ok(manifest) => manifest,
        Err(error) => {
            return Ok(EnvProfileStatus {
                profile: profile_name.to_string(),
                status: "invalid",
                error_code: Some(if is_not_found(&error) {
                    "manifest_missing"
                } else {
                    "manifest_invalid"
                }),
                variables: Vec::new(),
            });
        }
    };

    let profile_store = EnvProfileStore::new_at_vault_root(vault.vault_root());
    let profile_path = profile_store.profile_path(profile_name)?;
    let variable_names: Vec<String> = manifest.variables().keys().cloned().collect();
    if !profile_path.is_file() {
        return Ok(EnvProfileStatus {
            profile: profile_name.to_string(),
            status: if profile_path.exists() {
                "invalid"
            } else {
                "missing"
            },
            error_code: Some(if profile_path.exists() {
                "profile_invalid"
            } else {
                "profile_missing"
            }),
            variables: variable_statuses(&manifest, None, false),
        });
    }

    let identity_file = resolve_identity_file(identity_file, vault)?;
    let identity_store = PreferredIdentityStore::new(identity_file);
    let identity = match identity_store.load_identity() {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            return Ok(EnvProfileStatus {
                profile: profile_name.to_string(),
                status: "unavailable",
                error_code: Some("identity_missing"),
                variables: variable_names
                    .into_iter()
                    .map(|name| EnvVariableStatus {
                        name,
                        status: "unavailable",
                    })
                    .collect(),
            });
        }
        Err(_) => {
            return Ok(EnvProfileStatus {
                profile: profile_name.to_string(),
                status: "unavailable",
                error_code: Some("identity_unavailable"),
                variables: variable_names
                    .into_iter()
                    .map(|name| EnvVariableStatus {
                        name,
                        status: "unavailable",
                    })
                    .collect(),
            });
        }
    };

    let payload = match profile_store.load_profile(profile_name, &[identity.age_identity()]) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(EnvProfileStatus {
                profile: profile_name.to_string(),
                status: "invalid",
                error_code: Some(profile_error_code(&error)),
                variables: variable_statuses(&manifest, None, true),
            });
        }
    };
    let variables = variable_statuses(&manifest, Some(payload.values()), false);
    let status = match manifest.resolve_profile(payload) {
        Ok(_) => "ready",
        Err(FrilVaultError::MissingRequiredEnvVariable(_)) => "missing",
        Err(FrilVaultError::UnknownEnvProfileVariable(_)) => "invalid",
        Err(_) => "invalid",
    };
    let error_code = match status {
        "ready" => None,
        "missing" => Some("required_variable_missing"),
        _ => Some("profile_values_invalid"),
    };

    Ok(EnvProfileStatus {
        profile: profile_name.to_string(),
        status,
        error_code,
        variables,
    })
}

fn variable_statuses(
    manifest: &frilvault_core::EnvManifest,
    values: Option<&BTreeMap<String, String>>,
    invalid: bool,
) -> Vec<EnvVariableStatus> {
    manifest
        .variables()
        .iter()
        .map(|(name, spec)| EnvVariableStatus {
            name: name.clone(),
            status: if invalid {
                "invalid"
            } else if values.is_some_and(|values| values.contains_key(name)) {
                "configured"
            } else if spec.default.is_some() {
                "default"
            } else {
                "missing"
            },
        })
        .collect()
}

fn print_profile_status(report: &EnvProfileStatus) {
    println!("Environment profile '{}'", report.profile);
    println!("Status: {}", report.status);
    if let Some(error_code) = report.error_code {
        println!("Error: {error_code}");
    }
    for variable in &report.variables {
        println!("{}: {}", variable.name, variable.status);
    }
}

fn profile_error_code(error: &FrilVaultError) -> &'static str {
    match error {
        FrilVaultError::Io(_) => "profile_unavailable",
        FrilVaultError::EnvProfileDecryptionFailed => "profile_unreadable",
        FrilVaultError::InvalidEnvProfilePayload
        | FrilVaultError::InvalidEnvProfileUtf8
        | FrilVaultError::UnsupportedEnvProfilePayloadVersion(_) => "profile_invalid",
        _ => "profile_invalid",
    }
}

fn is_not_found(error: &FrilVaultError) -> bool {
    matches!(error, FrilVaultError::Io(error) if error.kind() == io::ErrorKind::NotFound)
}

fn read_value_from_stdin() -> Result<String> {
    let mut value = String::new();
    io::stdin().read_to_string(&mut value)?;
    if let Some(stripped) = value.strip_suffix('\n') {
        value = stripped.strip_suffix('\r').unwrap_or(stripped).to_string();
    }
    Ok(value)
}

fn parse_dotenv(path: &Path) -> Result<BTreeMap<String, String>> {
    let contents = fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read dotenv source '{}'; check its path",
            path.display()
        )
    })?;

    for (line_number, line) in contents.lines().enumerate() {
        if contains_unsupported_shell_syntax(line) {
            bail!(
                "unsupported shell syntax in dotenv source at line {}",
                line_number + 1
            );
        }
    }

    let mut values = BTreeMap::new();
    for entry in dotenvy::from_read_iter(contents.as_bytes()) {
        let (key, value) = entry.map_err(|error| match error {
            dotenvy::Error::LineParse(line, _) => {
                let line_number = contents
                    .lines()
                    .position(|candidate| candidate == line)
                    .map_or(1, |index| index + 1);
                anyhow::anyhow!("invalid dotenv syntax at line {line_number}")
            }
            dotenvy::Error::Io(_) | dotenvy::Error::EnvVar(_) => {
                anyhow::anyhow!("invalid dotenv source; expected KEY=VALUE entries")
            }
            _ => anyhow::anyhow!("invalid dotenv source; expected KEY=VALUE entries"),
        })?;
        validate_env_variable_name(&key).map_err(|_| {
            anyhow::anyhow!("invalid environment variable name in dotenv source: {key}")
        })?;
        if values.insert(key.clone(), value).is_some() {
            bail!("duplicate environment variable in dotenv source: {key}");
        }
    }
    Ok(values)
}

fn contains_unsupported_shell_syntax(line: &str) -> bool {
    let mut single_quoted = false;
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quoted {
            escaped = true;
            continue;
        }
        if character == '\'' {
            single_quoted = !single_quoted;
            continue;
        }
        if character == '`' || (character == '$' && !single_quoted) {
            return true;
        }
    }
    false
}

fn confirm_import(yes: bool, format: OutputFormat, profile: &str) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if matches!(format, OutputFormat::Json) || !io::stdin().is_terminal() {
        bail!("replacing an environment profile requires --yes in non-interactive use");
    }

    print!("Replace encrypted environment profile '{profile}'? [y/N]: ");
    io::stdout().flush()?;
    let mut confirmation = String::new();
    io::stdin().read_line(&mut confirmation)?;
    Ok(matches!(
        confirmation.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

pub(crate) fn load_identity_for_doctor(
    vault: &frilvault_core::FrilVault,
    identity_file: Option<PathBuf>,
) -> Result<Option<EnvIdentity>> {
    let identity_file = resolve_identity_file(identity_file, vault)?;
    let store = PreferredIdentityStore::new(identity_file);

    Ok(EnvIdentityManager::new(&store).load()?)
}

#[derive(Debug)]
pub(crate) struct ChildProcessExit(ExitStatus);

impl ChildProcessExit {
    pub(crate) fn exit_code(&self) -> i32 {
        self.0.code().unwrap_or_else(|| {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;

                self.0.signal().map_or(1, |signal| 128 + signal)
            }

            #[cfg(not(unix))]
            {
                1
            }
        })
    }
}

impl std::fmt::Display for ChildProcessExit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "child process exited with status {}",
            self.exit_code()
        )
    }
}

impl std::error::Error for ChildProcessExit {}

fn execute_run(command: EnvRunCommand, vault_path: Option<&Path>) -> Result<()> {
    if command.command.is_empty() {
        anyhow::bail!("a child command is required after `--`");
    }

    let vault = super::open_vault(vault_path)?;
    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let identity_store = PreferredIdentityStore::new(identity_file);
    let identity = EnvIdentityManager::new(&identity_store)
        .load()?
        .ok_or_else(|| {
            anyhow::anyhow!("no environment identity is configured; run `flvt env identity create`")
        })?;

    let manifest = EnvManifestStore::new(vault.vault_root()).load()?;
    let profile_store = EnvProfileStore::new_at_vault_root(vault.vault_root());
    let profile = profile_store.load_profile(&command.profile, &[identity.age_identity()])?;
    let profile_values = manifest.resolve_profile(profile)?;

    let mut child = Command::new(&command.command[0]);
    child.args(&command.command[1..]);
    configure_child_environment(&mut child, std::env::vars_os(), profile_values);

    let status = child.status().map_err(|error| {
        anyhow::anyhow!(
            "failed to spawn child process '{}': {error}",
            command.command[0].to_string_lossy()
        )
    })?;

    if status.success() {
        Ok(())
    } else {
        Err(anyhow::Error::new(ChildProcessExit(status)))
    }
}

fn configure_child_environment(
    child: &mut Command,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    profile_values: BTreeMap<String, String>,
) {
    child.env_clear();
    child.envs(inherited);
    child.envs(profile_values);
}

#[derive(Debug, Serialize)]
struct IdentityCreateOutput {
    created: bool,
    recipient: String,
    storage: &'static str,
}

#[derive(Debug, Serialize)]
struct IdentityShowOutput {
    recipient: String,
    storage: &'static str,
}

#[derive(Debug, Serialize)]
struct RemovedRecipientOutput {
    removed: EnvRecipient,
    warning: &'static str,
}

#[derive(Debug, Serialize)]
struct RotateOutput {
    profile: String,
    recipients: usize,
    warning: &'static str,
}

fn execute_identity_create(
    command: IdentityCreateCommand,
    vault_path: Option<&Path>,
) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let store = PreferredIdentityStore::new(identity_file);

    let (identity, created) = if command.stdin {
        EnvIdentityManager::new(&store).import_or_reuse(read_identity_from_stdin()?)?
    } else {
        EnvIdentityManager::new(&store).create_or_reuse()?
    };

    let output = IdentityCreateOutput {
        created,
        recipient: identity.public_recipient().to_string(),
        storage: store.storage_label(),
    };
    match resolve_format(command.format) {
        OutputFormat::Text => {
            if created {
                println!("Created FrilVault environment identity.");
            } else {
                println!("Reused existing FrilVault environment identity.");
            }
            println!("Recipient: {}", output.recipient);
            println!("Storage: {}", output.storage);
        }
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn execute_identity_show(command: IdentityShowCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let store = PreferredIdentityStore::new(identity_file);
    let identity = EnvIdentityManager::new(&store).load()?.ok_or_else(|| {
        anyhow::anyhow!("no environment identity is configured; run `flvt env identity create`")
    })?;
    let output = IdentityShowOutput {
        recipient: identity.public_recipient().to_string(),
        storage: store.storage_label(),
    };

    match resolve_format(command.format) {
        OutputFormat::Text => {
            println!("Environment identity");
            println!("Recipient: {}", output.recipient);
            println!("Storage: {}", output.storage);
        }
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn execute_recipients_list(
    command: RecipientsListCommand,
    vault_path: Option<&Path>,
) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let recipients = EnvRecipientStore::new(vault.vault_root()).load()?;
    let entries: Vec<EnvRecipient> = recipients.entries().cloned().collect();

    match resolve_format(command.format) {
        OutputFormat::Text => {
            if entries.is_empty() {
                println!("No environment recipients are registered.");
            } else {
                for entry in entries {
                    println!("{}\t{}", entry.id, entry.recipient);
                }
            }
        }
        OutputFormat::Json => print_json(&entries)?,
    }

    Ok(())
}

fn execute_recipients_add(command: RecipientsAddCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let entry = EnvRecipientStore::new(vault.vault_root())
        .add(&command.recipient_id, &command.age_recipient)?;

    match resolve_format(command.format) {
        OutputFormat::Text => println!("Added environment recipient '{}'.", entry.id),
        OutputFormat::Json => print_json(&entry)?,
    }

    Ok(())
}

fn execute_recipients_remove(
    command: RecipientsRemoveCommand,
    vault_path: Option<&Path>,
) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let removed = EnvRecipientStore::new(vault.vault_root()).remove(&command.recipient_id)?;
    let output = RemovedRecipientOutput {
        removed,
        warning: "Removing a recipient does not revoke plaintext already viewed; rotate affected profiles separately.",
    };

    match resolve_format(command.format) {
        OutputFormat::Text => {
            println!("Removed environment recipient '{}'.", output.removed.id);
            println!("Warning: {}", output.warning);
        }
        OutputFormat::Json => print_json(&output)?,
    }

    Ok(())
}

fn execute_rotate(
    command: crate::cli::env::EnvRotateCommand,
    vault_path: Option<&Path>,
) -> Result<()> {
    let format = resolve_format(command.format);
    if !command.yes && (matches!(format, OutputFormat::Json) || !io::stdin().is_terminal()) {
        bail!(
            "environment profile rotation requires explicit confirmation; pass --yes in non-interactive use"
        );
    }

    let vault = super::open_vault(vault_path)?;
    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let identity_store = PreferredIdentityStore::new(identity_file);
    let identity = require_identity(&identity_store)?;
    let recipients = EnvRecipientStore::new(vault.vault_root()).load()?;

    if recipients.is_empty() {
        bail!(
            "environment profile rotation requires at least one registered recipient; add a recipient before rotating"
        );
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let should_rotate = confirm_rotation(
        command.yes,
        format,
        stdin.is_terminal(),
        &command.profile,
        recipients.len(),
        &mut input,
        &mut output,
    )?;

    if should_rotate {
        EnvProfileStore::new_at_vault_root(vault.vault_root()).rotate_profile(
            &command.profile,
            &identity,
            &recipients,
        )?;

        let output = RotateOutput {
            profile: command.profile,
            recipients: recipients.len(),
            warning: "This rotates FrilVault ciphertext only. Revoke and reissue the actual API key, password, or token at its provider, then run this rotation workflow.",
        };

        match format {
            OutputFormat::Text => {
                println!(
                    "Rotated environment profile '{}' for {} current recipient{}.",
                    output.profile,
                    output.recipients,
                    if output.recipients == 1 { "" } else { "s" },
                );
                println!("Warning: {}", output.warning);
            }
            OutputFormat::Json => print_json(&output)?,
        }
    }

    Ok(())
}

fn require_identity<S>(store: S) -> Result<EnvIdentity>
where
    S: EnvIdentityStore,
{
    EnvIdentityManager::new(store)
        .load()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no environment identity is configured; run `flvt env identity create` or provide --identity-file"
            )
        })
}

fn confirm_rotation(
    yes: bool,
    format: OutputFormat,
    interactive: bool,
    profile: &str,
    recipient_count: usize,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<bool> {
    if !yes && (matches!(format, OutputFormat::Json) || !interactive) {
        bail!(
            "environment profile rotation requires explicit confirmation; pass --yes in non-interactive use"
        );
    }

    if yes {
        return Ok(true);
    }

    write!(
        output,
        "Rotate encrypted environment profile '{}' for {} current recipient{}? [y/N]: ",
        profile,
        recipient_count,
        if recipient_count == 1 { "" } else { "s" },
    )?;
    output.flush().context("failed to flush stdout")?;

    let mut confirmation = String::new();
    input
        .read_line(&mut confirmation)
        .context("failed to read confirmation")?;
    if !matches!(
        confirmation.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ) {
        writeln!(output, "Aborted.")?;
        return Ok(false);
    }

    Ok(true)
}

fn read_identity_from_stdin() -> Result<EnvIdentity> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    EnvIdentity::from_encoded(&input).map_err(Into::into)
}

#[derive(Clone, Copy, Debug)]
enum IdentityStorageKind {
    CredentialStore,
    FileFallback,
}

impl IdentityStorageKind {
    fn label(self) -> &'static str {
        match self {
            Self::CredentialStore => "platform credential store",
            Self::FileFallback => "explicit permission-restricted file",
        }
    }
}

struct PreferredIdentityStore {
    keyring: Option<KeyringIdentityStore>,
    file: Option<FileIdentityStore>,
    last_storage: Cell<Option<IdentityStorageKind>>,
}

impl PreferredIdentityStore {
    fn new(file: Option<PathBuf>) -> Self {
        Self {
            keyring: KeyringIdentityStore::new().ok(),
            file: file.map(FileIdentityStore::new),
            last_storage: Cell::new(None),
        }
    }

    fn storage_label(&self) -> &'static str {
        self.last_storage
            .get()
            .map(IdentityStorageKind::label)
            .unwrap_or("not loaded")
    }
}

impl EnvIdentityStore for PreferredIdentityStore {
    fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
        if let Some(keyring) = &self.keyring {
            match keyring.load_identity() {
                Ok(Some(identity)) => {
                    self.last_storage
                        .set(Some(IdentityStorageKind::CredentialStore));
                    return Ok(Some(identity));
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(file) = &self.file {
                        let identity = file.load_identity()?;
                        if identity.is_some() {
                            self.last_storage
                                .set(Some(IdentityStorageKind::FileFallback));
                        }
                        return Ok(identity);
                    }
                    return Err(error);
                }
            }

            if self.file.is_none() {
                return Ok(None);
            }
        }

        if let Some(file) = &self.file {
            let identity = file.load_identity()?;
            if identity.is_some() {
                self.last_storage
                    .set(Some(IdentityStorageKind::FileFallback));
            }
            return Ok(identity);
        }

        Err(identity_storage_unavailable())
    }

    fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()> {
        if let Some(keyring) = &self.keyring {
            match keyring.save_identity(identity) {
                Ok(()) => {
                    self.last_storage
                        .set(Some(IdentityStorageKind::CredentialStore));
                    return Ok(());
                }
                Err(error) => {
                    if let Some(file) = &self.file {
                        file.save_identity(identity)?;
                        self.last_storage
                            .set(Some(IdentityStorageKind::FileFallback));
                        return Ok(());
                    }
                    return Err(error);
                }
            }
        }

        if let Some(file) = &self.file {
            file.save_identity(identity)?;
            self.last_storage
                .set(Some(IdentityStorageKind::FileFallback));
            return Ok(());
        }

        Err(identity_storage_unavailable())
    }
}

struct KeyringIdentityStore {
    entry: keyring::Entry,
}

impl KeyringIdentityStore {
    fn new() -> FrilVaultResult<Self> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|_| identity_storage_unavailable())?;
        Ok(Self { entry })
    }
}

impl EnvIdentityStore for KeyringIdentityStore {
    fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
        match self.entry.get_password() {
            Ok(encoded) => EnvIdentity::from_encoded(&encoded).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(identity_storage_unavailable()),
        }
    }

    fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()> {
        let result = identity.with_encoded(|encoded| self.entry.set_password(encoded));
        result.map_err(|_| identity_storage_unavailable())
    }
}

struct FileIdentityStore {
    path: PathBuf,
}

impl FileIdentityStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[cfg(windows)]
    fn check_permissions(&self) -> FrilVaultResult<()> {
        Err(file_fallback_unavailable())
    }

    #[cfg(not(windows))]
    fn check_permissions(&self) -> FrilVaultResult<()> {
        let metadata = fs::metadata(&self.path)?;
        if !metadata.is_file() {
            return Err(FrilVaultError::EnvIdentityStorage(
                "identity file is not a regular file".to_string(),
            ));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(FrilVaultError::EnvIdentityStorage(
                    "identity file permissions must be owner-only".to_string(),
                ));
            }
        }

        Ok(())
    }
}

impl EnvIdentityStore for FileIdentityStore {
    fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        self.check_permissions()?;
        EnvIdentity::from_encoded(&contents).map(Some)
    }

    fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()> {
        if self.path.exists() {
            self.check_permissions()?;
        } else {
            ensure_file_fallback_available()?;
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("identity");
        let temp_path = parent.join(format!(".{file_name}.tmp.{}", uuid::Uuid::new_v4()));

        let write_result = (|| -> io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            configure_private_file(&mut options);
            let mut file = options.open(&temp_path)?;
            identity.with_encoded(|encoded| -> io::Result<()> {
                file.write_all(encoded.as_bytes())?;
                file.write_all(b"\n")
            })?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp_path, &self.path)
        })();

        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp_path);
            return Err(error.into());
        }

        Ok(())
    }
}

fn identity_storage_unavailable() -> FrilVaultError {
    #[cfg(windows)]
    let message = "platform credential store is unavailable; Windows file fallback is disabled because owner-only ACL cannot be verified";
    #[cfg(not(windows))]
    let message = "platform credential store is unavailable; provide --identity-file for an explicit fallback";

    FrilVaultError::EnvIdentityStorage(message.to_string())
}

#[cfg(windows)]
fn file_fallback_unavailable() -> FrilVaultError {
    FrilVaultError::EnvIdentityStorage(
        "Windows identity file fallback is disabled because owner-only ACL cannot be verified; use the platform credential store".to_string(),
    )
}

#[cfg(windows)]
fn ensure_file_fallback_available() -> FrilVaultResult<()> {
    Err(file_fallback_unavailable())
}

#[cfg(not(windows))]
fn ensure_file_fallback_available() -> FrilVaultResult<()> {
    Ok(())
}

#[cfg(unix)]
fn configure_private_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn configure_private_file(_options: &mut OpenOptions) {}

fn resolve_identity_file(
    path: Option<PathBuf>,
    vault: &frilvault_core::FrilVault,
) -> Result<Option<PathBuf>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let workspace_root = normalize_path(vault.workspace_root(), &std::env::current_dir()?);
    let vault_root = normalize_path(vault.vault_root(), &std::env::current_dir()?);
    let identity_path = normalize_path(&path, &std::env::current_dir()?);
    let workspace_root = canonicalize_with_nearest_existing_ancestor(&workspace_root);
    let vault_root = canonicalize_with_nearest_existing_ancestor(&vault_root);
    let identity_path_for_check = canonicalize_with_nearest_existing_ancestor(&identity_path);
    if is_within(&identity_path_for_check, &workspace_root)
        || is_within(&identity_path_for_check, &vault_root)
    {
        bail!("--identity-file must be outside the workspace and selected vault");
    }
    Ok(Some(identity_path))
}

fn canonicalize_with_nearest_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    let mut unresolved = Vec::<OsString>::new();

    while !current.exists() {
        let Some(name) = current.file_name() else {
            return path.to_path_buf();
        };
        unresolved.push(name.to_os_string());
        if !current.pop() {
            return path.to_path_buf();
        }
    }

    let mut canonical = fs::canonicalize(&current).unwrap_or(current);
    for component in unresolved.iter().rev() {
        canonical.push(component);
    }
    canonical
}

fn normalize_path(path: &Path, base: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn is_within(path: &Path, parent: &Path) -> bool {
    path == parent || path.starts_with(parent)
}

impl EnvIdentityStore for &PreferredIdentityStore {
    fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
        (*self).load_identity()
    }

    fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()> {
        (*self).save_identity(identity)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        path::{Path, PathBuf},
    };

    use frilvault_core::{EnvIdentity, EnvIdentityStore, FrilVault, FrilVaultResult};

    use super::*;

    struct TestDirectory {
        root: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("frilvault-cli-env-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct EmptyIdentityStore;

    impl EnvIdentityStore for EmptyIdentityStore {
        fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
            Ok(None)
        }

        fn save_identity(&self, _identity: &EnvIdentity) -> FrilVaultResult<()> {
            Ok(())
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn file_identity_store_round_trips_with_owner_only_permissions() {
        let directory = TestDirectory::new();
        let path = directory.path().join("identity");
        let identity = EnvIdentity::generate();
        let store = FileIdentityStore::new(path.clone());

        store.save_identity(&identity).unwrap();

        let loaded = store.load_identity().unwrap().unwrap();
        assert_eq!(loaded.public_recipient(), identity.public_recipient());
        assert!(format!("{loaded:?}").contains("<redacted>"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn file_identity_store_rejects_unverifiable_permissions() {
        let directory = TestDirectory::new();
        let store = FileIdentityStore::new(directory.path().join("identity"));

        let error = store.save_identity(&EnvIdentity::generate()).unwrap_err();

        assert!(error.to_string().contains("owner-only ACL"));
    }

    #[cfg(unix)]
    #[test]
    fn identity_file_path_resolves_symlinked_nearest_existing_ancestor() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        let workspace_root = directory.path().join("workspace");
        fs::create_dir_all(&workspace_root).unwrap();
        let symlink_path = directory.path().join("workspace-link");
        symlink(&workspace_root, &symlink_path).unwrap();
        let identity_path = symlink_path.join("new").join("identity");
        let vault = FrilVault::open(&workspace_root).unwrap();

        let error = resolve_identity_file(Some(identity_path), &vault).unwrap_err();

        assert!(error.to_string().contains("outside the workspace"));
    }

    #[test]
    fn rotation_confirmation_covers_yes_no_and_interactive_acceptance() {
        let mut accepted_input = Cursor::new(b"yes\n");
        let mut accepted_output = Vec::new();
        assert!(
            confirm_rotation(
                false,
                OutputFormat::Text,
                true,
                "development",
                1,
                &mut accepted_input,
                &mut accepted_output,
            )
            .unwrap()
        );
        assert!(
            String::from_utf8(accepted_output)
                .unwrap()
                .contains("development")
        );

        let mut declined_input = Cursor::new(b"no\n");
        let mut declined_output = Vec::new();
        assert!(
            !confirm_rotation(
                false,
                OutputFormat::Text,
                true,
                "development",
                2,
                &mut declined_input,
                &mut declined_output,
            )
            .unwrap()
        );
        assert!(
            String::from_utf8(declined_output)
                .unwrap()
                .contains("Aborted.")
        );

        let mut unused_input = Cursor::new(Vec::<u8>::new());
        let mut unused_output = Vec::new();
        assert!(
            confirm_rotation(
                true,
                OutputFormat::Json,
                false,
                "development",
                0,
                &mut unused_input,
                &mut unused_output,
            )
            .unwrap()
        );
    }

    #[test]
    fn rotation_confirmation_rejects_noninteractive_without_yes() {
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();

        let error = confirm_rotation(
            false,
            OutputFormat::Text,
            false,
            "development",
            1,
            &mut input,
            &mut output,
        )
        .unwrap_err();

        assert!(error.to_string().contains("--yes"));
    }

    #[test]
    fn require_identity_reports_missing_configuration_without_secret_material() {
        EmptyIdentityStore
            .save_identity(&EnvIdentity::generate())
            .unwrap();
        let error = require_identity(EmptyIdentityStore).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("no environment identity is configured")
        );
    }

    #[cfg(windows)]
    #[test]
    fn child_environment_overlay_respects_case_insensitive_names() {
        let mut child = Command::new(std::env::var_os("ComSpec").unwrap());
        configure_child_environment(
            &mut child,
            std::iter::once((
                OsString::from("FrilVault_Case_Test"),
                OsString::from("parent"),
            )),
            BTreeMap::from([(String::from("FRILVAULT_CASE_TEST"), String::from("profile"))]),
        );
        child.args(["/C", "echo", "%FRILVAULT_CASE_TEST%"]);

        let output = child.output().unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "profile");
    }
}
