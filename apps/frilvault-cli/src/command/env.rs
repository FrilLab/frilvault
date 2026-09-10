use std::{
    cell::Cell,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::{Result, bail};
use frilvault_core::{
    EnvIdentity, EnvIdentityManager, EnvIdentityStore, EnvRecipient, EnvRecipientStore,
    FrilVaultError, FrilVaultResult,
};
use serde::Serialize;

use crate::{
    cli::env::{
        EnvAction, EnvCommand, IdentityAction, IdentityCreateCommand, IdentityShowCommand,
        RecipientsAction, RecipientsAddCommand, RecipientsListCommand, RecipientsRemoveCommand,
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
        EnvAction::Identity(identity) => match identity.action {
            IdentityAction::Create(create) => execute_identity_create(create, vault_path),
            IdentityAction::Show(show) => execute_identity_show(show, vault_path),
        },
        EnvAction::Recipients(recipients) => match recipients.action {
            RecipientsAction::List(list) => execute_recipients_list(list, vault_path),
            RecipientsAction::Add(add) => execute_recipients_add(add, vault_path),
            RecipientsAction::Remove(remove) => execute_recipients_remove(remove, vault_path),
        },
    }
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

fn execute_identity_create(
    command: IdentityCreateCommand,
    vault_path: Option<&Path>,
) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let identity_file = resolve_identity_file(command.identity_file, &vault)?;
    let store = PreferredIdentityStore::new(identity_file);

    let (identity, created) = if command.stdin {
        let identity = read_identity_from_stdin()?;
        store.save_identity(&identity)?;
        (identity, true)
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
    FrilVaultError::EnvIdentityStorage(
        "platform credential store is unavailable; provide --identity-file for an explicit fallback"
            .to_string(),
    )
}

fn configure_private_file(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }
}

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
    let workspace_root = fs::canonicalize(&workspace_root).unwrap_or(workspace_root);
    let vault_root = fs::canonicalize(&vault_root).unwrap_or(vault_root);
    let identity_path_for_check = if identity_path.exists() {
        fs::canonicalize(&identity_path).unwrap_or_else(|_| identity_path.clone())
    } else {
        let parent = identity_path.parent().unwrap_or_else(|| Path::new("."));
        fs::canonicalize(parent)
            .map(|parent| parent.join(identity_path.file_name().unwrap_or_default()))
            .unwrap_or_else(|_| identity_path.clone())
    };
    if is_within(&identity_path_for_check, &workspace_root)
        || is_within(&identity_path_for_check, &vault_root)
    {
        bail!("--identity-file must be outside the workspace and selected vault");
    }
    Ok(Some(identity_path))
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
