use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use crate::{
    FrilVaultError, FrilVaultResult,
    note::{NoteRepository, NoteService},
    runtime::VaultContext,
    workspace::{
        GitExcludeStatus, PathResolver, TagColor, TagSettings, VaultMode, WorkspaceIndexRepository,
        WorkspaceRepository, WorkspaceService, WorkspaceStatus, ensure_local_vault_excluded,
        vault_git_tracking_status,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitializationResult {
    pub mode: VaultMode,
    pub git_exclude: Option<GitExcludeStatus>,
}

/// Top-level entry point for opening a FrilVault workspace.
///
/// `FrilVault` does not hold long-lived runtime state. Each accessor builds the
/// repositories and `VaultContext` needed for a single service call chain.
///
/// FrilVault 워크스페이스를 여는 최상위 진입점입니다.
///
/// `FrilVault`는 장기 실행 상태를 보관하지 않으며, 각 접근자는 단일 서비스 호출
/// 체인에 필요한 저장소와 `VaultContext`를 구성합니다.
pub struct FrilVault {
    workspace_root: PathBuf,
}

impl FrilVault {
    /// Opens a workspace rooted at `workspace_root`.
    ///
    /// This only records the root path. Vault directories are created lazily when
    /// services first touch repositories.
    ///
    /// `workspace_root`를 루트로 하는 워크스페이스를 엽니다.
    ///
    /// 루트 경로만 기록하며, vault 디렉터리는 서비스가 저장소에 처음 접근할 때
    /// 지연 생성됩니다.
    pub fn open(workspace_root: impl AsRef<Path>) -> FrilVaultResult<Self> {
        Ok(Self {
            workspace_root: workspace_root.as_ref().to_path_buf(),
        })
    }

    /// Initializes the workspace with the requested storage policy.
    ///
    /// Existing workspace metadata is preserved, including its current mode.
    pub fn initialize(&self, mode: VaultMode) -> FrilVaultResult<VaultMode> {
        self.initialize_with_status(mode).map(|result| result.mode)
    }

    pub fn initialize_with_status(&self, mode: VaultMode) -> FrilVaultResult<InitializationResult> {
        let resolver = PathResolver::new(&self.workspace_root);
        let workspace_repository = WorkspaceRepository::new(resolver.clone());
        let metadata = workspace_repository.initialize(mode)?;

        let index_repository = WorkspaceIndexRepository::new(resolver);
        index_repository.create_if_missing()?;

        let git_exclude = if metadata.mode == VaultMode::Local {
            Some(ensure_local_vault_excluded(&self.workspace_root)?)
        } else {
            None
        };

        Ok(InitializationResult {
            mode: metadata.mode,
            git_exclude,
        })
    }

    /// Reads a concise snapshot of the existing workspace without modifying it.
    pub fn status(&self) -> FrilVaultResult<WorkspaceStatus> {
        let resolver = PathResolver::new(&self.workspace_root);
        let workspace_repository = WorkspaceRepository::new(resolver.clone());

        if !workspace_repository.exists() {
            return Err(FrilVaultError::WorkspaceNotFound);
        }

        let metadata = workspace_repository.load()?;
        // Status promises the current count, so read note files directly rather
        // than trusting an index that may be stale after an external edit.
        let note_count = NoteRepository::new(resolver)
            .list_all_note_files()?
            .iter()
            .map(|record| record.note_file.notes.len())
            .sum();

        Ok(WorkspaceStatus {
            vault_path: PathBuf::from(crate::constants::VAULT_DIR_NAME),
            mode: metadata.mode,
            git_tracking: vault_git_tracking_status(&self.workspace_root)?,
            note_count,
        })
    }

    /// Returns the workspace-level tag color assignments, keyed case-insensitively.
    pub fn tag_colors(&self) -> FrilVaultResult<BTreeMap<String, TagColor>> {
        let repository = WorkspaceRepository::new(PathResolver::new(&self.workspace_root));
        let metadata = repository.load()?;

        Ok(metadata
            .settings
            .tags
            .into_iter()
            .map(|(tag, settings)| (tag, settings.color))
            .collect())
    }

    /// Assigns a theme-safe display color to a tag without modifying any note.
    pub fn set_tag_color(&self, tag: &str, color: TagColor) -> FrilVaultResult<()> {
        let tag = crate::normalize_tag(tag);
        if tag.is_empty() {
            return Err(FrilVaultError::InvalidTag(
                "tag name cannot be empty".to_string(),
            ));
        }

        let repository = WorkspaceRepository::new(PathResolver::new(&self.workspace_root));
        let mut metadata = repository.load()?;
        metadata
            .settings
            .tags
            .insert(tag.to_lowercase(), TagSettings { color });
        metadata.updated_at = chrono::Utc::now();
        repository.save(&metadata)
    }

    /// Removes a tag's display color without modifying the tag or any note.
    pub fn remove_tag_color(&self, tag: &str) -> FrilVaultResult<bool> {
        let tag = crate::normalize_tag(tag);
        if tag.is_empty() {
            return Err(FrilVaultError::InvalidTag(
                "tag name cannot be empty".to_string(),
            ));
        }

        let repository = WorkspaceRepository::new(PathResolver::new(&self.workspace_root));
        let mut metadata = repository.load()?;
        let removed = metadata.settings.tags.remove(&tag.to_lowercase()).is_some();
        if removed {
            metadata.updated_at = chrono::Utc::now();
            repository.save(&metadata)?;
        }
        Ok(removed)
    }

    fn build_context(&self) -> FrilVaultResult<(VaultContext, WorkspaceIndexRepository)> {
        let resolver = PathResolver::new(&self.workspace_root);

        let workspace_repository = WorkspaceRepository::new(resolver.clone());
        workspace_repository.create_if_missing()?;

        let index_repository = WorkspaceIndexRepository::new(resolver.clone());
        index_repository.create_if_missing()?;

        let note_repository = NoteRepository::new(resolver.clone());

        let vault_context = VaultContext::new(note_repository, index_repository.clone());

        Ok((vault_context, index_repository))
    }

    /// Returns a note service scoped to this workspace.
    ///
    /// Callers use this for CRUD, search, attachment, and URI resolution workflows.
    ///
    /// 이 워크스페이스에 범위가 지정된 노트 서비스를 반환합니다.
    ///
    /// 호출자는 CRUD, 검색, 첨부, URI 해석 워크플로에 이 서비스를 사용합니다.
    pub fn notes(&self) -> FrilVaultResult<NoteService> {
        let (context, _) = self.build_context()?;
        Ok(NoteService::new(context))
    }

    /// Returns a workspace service scoped to this workspace.
    ///
    /// Callers use this for stats, health checks, sync, and repair workflows.
    ///
    /// 이 워크스페이스에 범위가 지정된 워크스페이스 서비스를 반환합니다.
    ///
    /// 호출자는 통계, 상태 점검, 동기화, 복구 워크플로에 이 서비스를 사용합니다.
    pub fn workspace(&self) -> FrilVaultResult<WorkspaceService> {
        let (context, index_repository) = self.build_context()?;
        Ok(WorkspaceService::new(context, index_repository))
    }
}
