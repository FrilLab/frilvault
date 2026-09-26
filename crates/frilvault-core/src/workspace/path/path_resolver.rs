use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{
    FrilVaultError, FrilVaultResult,
    constants::{
        IMAGES_DIR_NAME, INDEX_DIR_NAME, NOTE_FILE_EXTENSION, NOTES_DIR_NAME, VAULT_DIR_NAME,
        WORKSPACE_FILE_NAME,
    },
    workspace::VaultMode,
};

/// Converts between workspace source paths and vault storage paths.
///
/// All vault-relative layout rules live here so repositories stay path-agnostic.
///
/// workspace source path와 vault storage path를 변환합니다.
///
/// 저장소가 경로 규칙을 몰라도 되도록 vault 상대 레이아웃 규칙을 이 타입에
/// 모읍니다.
#[derive(Debug, Clone)]
pub struct PathResolver {
    workspace_root: PathBuf,
    vault_root: PathBuf,
}

impl PathResolver {
    const GIT_VAULT_DIRECTORY: &'static str = "frilvault/vaults";

    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let workspace_root = normalize_path(&workspace_root.into());
        Self {
            vault_root: normalize_path(&workspace_root.join(VAULT_DIR_NAME)),
            workspace_root,
        }
    }

    /// Creates a resolver for an explicit vault path.
    ///
    /// Relative vault paths are resolved from the workspace root. The path is
    /// kept separate from the workspace root so source files and vault data can
    /// live in different directory trees.
    pub fn with_vault_root(
        workspace_root: impl Into<PathBuf>,
        vault_root: impl Into<PathBuf>,
    ) -> Self {
        let workspace_root = normalize_path(&workspace_root.into());
        let vault_root = vault_root.into();
        let vault_root = if vault_root.is_absolute() {
            vault_root
        } else {
            workspace_root.join(vault_root)
        };

        Self {
            workspace_root,
            vault_root: normalize_path(&vault_root),
        }
    }

    /// Alias for callers that use "path" for the vault configuration value.
    pub fn new_with_vault_root(
        workspace_root: impl Into<PathBuf>,
        vault_root: impl Into<PathBuf>,
    ) -> Self {
        Self::with_vault_root(workspace_root, vault_root)
    }

    /// Finds an existing workspace `.vault` or checkout-local FrilVault store.
    /// New workspaces default to the checkout's Git metadata directory, or to
    /// the project root for non-Git workspaces.
    ///
    /// The nearest candidate wins, which makes a vault in a nested workspace
    /// take precedence over a project-root vault when the command is run from
    /// that nested workspace.
    pub fn discover(workspace_root: impl Into<PathBuf>) -> FrilVaultResult<Self> {
        let workspace_root = workspace_root.into();
        Self::discover_from(&workspace_root, &workspace_root)
    }

    /// Performs the same nearest-ancestor lookup from an explicit directory
    /// while preserving the supplied workspace root for source-file anchors.
    pub fn discover_from(
        workspace_root: impl Into<PathBuf>,
        start_directory: impl Into<PathBuf>,
    ) -> FrilVaultResult<Self> {
        let workspace_root = normalize_path(&workspace_root.into());
        let start_directory = normalize_path(&start_directory.into());
        let existing_project_vault = find_nearest_vault(&start_directory);
        let git_vault = git_managed_vault_root(&workspace_root);
        let existing_git_vault = git_vault
            .clone()
            .filter(|path| path.exists() && is_existing_vault_candidate(path));

        let vault_root = match (existing_project_vault, existing_git_vault) {
            (Some(project), Some(git)) if normalize_path(&project) != normalize_path(&git) => {
                return Err(FrilVaultError::AmbiguousVaultPaths { project, git });
            }
            (Some(project), _) => project,
            (_, Some(git)) => git,
            (None, None) => git_vault.unwrap_or_else(|| workspace_root.join(VAULT_DIR_NAME)),
        };

        Ok(Self {
            workspace_root,
            vault_root: normalize_path(&vault_root),
        })
    }

    /// Resolves a destination for explicit initialization. Existing vaults
    /// always win over the requested mode; the mode only chooses a path when
    /// this workspace has no existing candidate.
    pub fn for_initialization(
        workspace_root: impl Into<PathBuf>,
        explicit_vault_root: Option<&Path>,
        mode: VaultMode,
    ) -> FrilVaultResult<Self> {
        let workspace_root = normalize_path(&workspace_root.into());
        if let Some(path) = explicit_vault_root {
            return Ok(Self::with_vault_root(&workspace_root, path));
        }

        let existing_project_vault = find_nearest_vault(&workspace_root);
        let git_vault = git_managed_vault_root(&workspace_root);
        let existing_git_vault = git_vault
            .clone()
            .filter(|path| path.exists() && is_existing_vault_candidate(path));

        let vault_root = match (existing_project_vault, existing_git_vault) {
            (Some(project), Some(git)) if normalize_path(&project) != normalize_path(&git) => {
                return Err(FrilVaultError::AmbiguousVaultPaths { project, git });
            }
            (Some(project), _) => project,
            (_, Some(git)) => git,
            (None, None) => match mode {
                VaultMode::Local => {
                    git_vault.unwrap_or_else(|| workspace_root.join(VAULT_DIR_NAME))
                }
                VaultMode::Shared => workspace_root.join(VAULT_DIR_NAME),
            },
        };

        Ok(Self {
            workspace_root,
            vault_root: normalize_path(&vault_root),
        })
    }

    pub fn vault_is_in_git_metadata(&self) -> bool {
        git_metadata_directory(&self.workspace_root)
            .is_some_and(|git_dir| self.vault_root.starts_with(git_dir))
    }

    pub fn note_file_name(source_file: impl AsRef<Path>) -> String {
        format!("{}.{}", source_file.as_ref().display(), NOTE_FILE_EXTENSION)
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn vault_root(&self) -> PathBuf {
        self.vault_root.clone()
    }

    pub fn vault_root_ref(&self) -> &Path {
        &self.vault_root
    }

    /// Returns a stable display path: relative when the vault is inside the
    /// workspace and absolute when it is external to it.
    pub fn display_vault_path(&self) -> PathBuf {
        self.vault_root
            .strip_prefix(&self.workspace_root)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| self.vault_root.clone())
    }

    pub fn notes_root(&self) -> PathBuf {
        self.vault_root().join(NOTES_DIR_NAME)
    }

    pub fn images_root(&self) -> PathBuf {
        self.vault_root().join(IMAGES_DIR_NAME)
    }

    pub fn note_images_dir(&self, note_id: uuid::Uuid) -> PathBuf {
        self.images_root().join(note_id.to_string())
    }

    pub fn resolve_attachment_path(
        &self,
        note_id: uuid::Uuid,
        attachment_id: uuid::Uuid,
        extension: &str,
    ) -> PathBuf {
        self.note_images_dir(note_id)
            .join(format!("{attachment_id}.{extension}"))
    }

    pub fn workspace_metadata_path(&self) -> PathBuf {
        self.vault_root().join(WORKSPACE_FILE_NAME)
    }

    pub fn workspace_index_path(&self) -> PathBuf {
        self.vault_root()
            .join(INDEX_DIR_NAME)
            .join("workspace.json")
    }

    // Map `src/main.rs` -> `<vault-root>/notes/src/main.rs.json`.
    // `src/main.rs` -> `<vault-root>/notes/src/main.rs.json`으로 매핑합니다.
    pub fn resolve_note_path(&self, source_file: impl AsRef<Path>) -> PathBuf {
        self.notes_root().join(Self::note_file_name(source_file))
    }

    pub fn source_file_from_note_path(
        &self,
        note_path: impl AsRef<Path>,
    ) -> FrilVaultResult<PathBuf> {
        let note_path = note_path.as_ref();

        let relative = note_path
            .strip_prefix(self.notes_root())
            .map_err(|_| FrilVaultError::SourcePathOutsideWorkspace)?;

        let file_name = relative.to_string_lossy();

        let suffix = format!(".{}", NOTE_FILE_EXTENSION);

        let source_file = file_name
            .strip_suffix(&suffix)
            .ok_or(FrilVaultError::InvalidNoteFilePath)?
            .to_string();

        Ok(PathBuf::from(source_file))
    }

    // Converting an Absolute Path to a Relative Path
    pub fn to_workspace_relative(&self, source_file: impl AsRef<Path>) -> FrilVaultResult<PathBuf> {
        let source_file = source_file.as_ref();

        let relative = source_file
            .strip_prefix(&self.workspace_root)
            .map_err(|_| FrilVaultError::SourcePathOutsideWorkspace)?;

        Ok(relative.to_path_buf())
    }

    pub fn note_path_for_source_file(&self, source_file: impl AsRef<Path>) -> PathBuf {
        self.resolve_note_path(source_file)
    }
}

fn git_managed_vault_root(workspace_root: &Path) -> Option<PathBuf> {
    let git_dir = git_metadata_directory(workspace_root)?;
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["rev-parse", "--show-prefix"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = String::from_utf8(output.stdout).ok()?;
    let prefix = prefix.trim();
    let workspace_key = if prefix.is_empty() {
        PathBuf::from("root")
    } else {
        PathBuf::from(prefix.trim_end_matches('/'))
    };
    Some(
        git_dir
            .join(PathResolver::GIT_VAULT_DIRECTORY)
            .join(workspace_key),
    )
}

fn git_metadata_directory(workspace_root: &Path) -> Option<PathBuf> {
    let work_tree = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .ok()?;
    if !work_tree.status.success() || String::from_utf8_lossy(&work_tree.stdout).trim() != "true" {
        return None;
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let git_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    (!git_dir.as_os_str().is_empty()).then_some(normalize_path(&git_dir))
}

fn find_nearest_vault(start_directory: &Path) -> Option<PathBuf> {
    let mut directory = start_directory;

    loop {
        let candidate = directory.join(VAULT_DIR_NAME);
        if candidate.exists() && is_existing_vault_candidate(&candidate) {
            return Some(candidate);
        }

        let parent = directory.parent()?;
        directory = parent;
    }
}

fn is_existing_vault_candidate(path: &Path) -> bool {
    if !path.is_dir() {
        return true;
    }

    match std::fs::read_dir(path).and_then(|mut entries| entries.next().transpose()) {
        Ok(None) => false,
        Ok(Some(_)) | Err(_) => true,
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }

    if normalized.as_os_str().is_empty() {
        normalized.push(".");
    }

    normalized
}
