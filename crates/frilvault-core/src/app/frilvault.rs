use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::{
    FrilVaultError, FrilVaultResult,
    note::{NoteRepository, NoteService},
    runtime::VaultContext,
    workspace::{
        GitTrackingStatus, PathResolver, VaultMode, WorkspaceIndexRepository, WorkspaceRepository,
        WorkspaceService, WorkspaceStatus,
    },
};

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
        let resolver = PathResolver::new(&self.workspace_root);
        let workspace_repository = WorkspaceRepository::new(resolver.clone());
        let metadata = workspace_repository.initialize(mode)?;

        let index_repository = WorkspaceIndexRepository::new(resolver);
        index_repository.create_if_missing()?;

        Ok(metadata.mode)
    }

    /// Reads a concise snapshot of the existing workspace without modifying it.
    pub fn status(&self) -> FrilVaultResult<WorkspaceStatus> {
        let resolver = PathResolver::new(&self.workspace_root);
        let workspace_repository = WorkspaceRepository::new(resolver.clone());

        if !workspace_repository.exists() {
            return Err(FrilVaultError::WorkspaceNotFound);
        }

        let metadata = workspace_repository.load()?;
        let index_repository = WorkspaceIndexRepository::new(resolver.clone());
        let note_count = if index_repository.exists() {
            index_repository
                .load()?
                .files
                .iter()
                .map(|file| file.note_count)
                .sum()
        } else {
            NoteRepository::new(resolver.clone())
                .list_all_note_files()?
                .iter()
                .map(|record| record.note_file.notes.len())
                .sum()
        };

        Ok(WorkspaceStatus {
            vault_path: PathBuf::from(crate::constants::VAULT_DIR_NAME),
            mode: metadata.mode,
            git_tracking: self.git_tracking_status()?,
            note_count,
        })
    }

    fn git_tracking_status(&self) -> FrilVaultResult<GitTrackingStatus> {
        let inside_work_tree = self.git_output(["rev-parse", "--is-inside-work-tree"])?;
        if !inside_work_tree.status.success()
            || String::from_utf8_lossy(&inside_work_tree.stdout).trim() != "true"
        {
            return Ok(GitTrackingStatus::NotGitRepository);
        }

        let tracked = self.git_output(["ls-files", "--", crate::constants::VAULT_DIR_NAME])?;
        if tracked.status.success() && !tracked.stdout.is_empty() {
            return Ok(GitTrackingStatus::Tracked);
        }

        let ignored = self.git_output([
            "check-ignore",
            "--quiet",
            "--",
            crate::constants::VAULT_DIR_NAME,
        ])?;
        if ignored.status.success() {
            return Ok(GitTrackingStatus::Excluded);
        }

        Ok(GitTrackingStatus::Trackable)
    }

    fn git_output<const N: usize>(
        &self,
        arguments: [&str; N],
    ) -> FrilVaultResult<std::process::Output> {
        Ok(Command::new("git")
            .args(arguments)
            .current_dir(&self.workspace_root)
            .output()?)
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
