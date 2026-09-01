use std::path::PathBuf;

use thiserror::Error;
use uuid::Uuid;

/// Describes whether a failed workspace-wide mutation was restored completely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagOperationRollback {
    Succeeded,
    Failed(String),
}

impl std::fmt::Display for TagOperationRollback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Succeeded => formatter.write_str("succeeded"),
            Self::Failed(error) => write!(formatter, "failed: {error}"),
        }
    }
}

/// Core error type returned by FrilVault domain operations.
///
/// FrilVault 코어 도메인 연산이 반환하는 공통 오류 타입입니다.
#[derive(Debug, Error)]
pub enum FrilVaultError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    JSON(#[from] serde_json::Error),

    #[error("No FrilVault workspace found.\nRun `flvt init` to initialize one.")]
    WorkspaceNotFound,

    #[error("Failed to read FrilVault workspace metadata:\n{} is invalid.", path.display())]
    InvalidWorkspaceMetadata {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    /// Returned when a caller passes an absolute source path outside the workspace root.
    ///
    /// 호출자가 워크스페이스 루트 밖의 절대 source path를 전달했을 때 반환됩니다.
    #[error("source path is outside workspace")]
    SourcePathOutsideWorkspace,

    /// Returned when a note id is not present in the requested source note file.
    ///
    /// 요청한 source note 파일에 note id가 없을 때 반환됩니다.
    #[error("note not found: {0}")]
    NoteNotFound(Uuid),

    #[error("duplicate note id: {0}")]
    DuplicateNoteId(Uuid),

    #[error("invalid note anchor: {0}")]
    InvalidAnchor(String),

    #[error("invalid note file path")]
    InvalidNoteFilePath,

    #[error("attachment not found: {0}")]
    AttachmentNotFound(Uuid),

    #[error("invalid image type: {0}")]
    InvalidImageType(String),

    #[error("image exceeds maximum size of {max_bytes} bytes")]
    ImageTooLarge { max_bytes: usize },

    /// Returned when a note URI string fails structural or security validation.
    ///
    /// note URI 문자열이 구조 또는 보안 검증에 실패했을 때 반환됩니다.
    #[error("malformed note uri: {0}")]
    MalformedNoteUri(String),

    /// Returned when a URI targets a different workspace root than the open service.
    ///
    /// URI가 열린 서비스와 다른 workspace root를 가리킬 때 반환됩니다.
    #[error("unknown workspace: {0}")]
    UnknownWorkspace(String),

    /// Returned when the indexed source file no longer exists on disk.
    ///
    /// 인덱스에 등록된 source file이 디스크에 더 이상 없을 때 반환됩니다.
    #[error("stale note: {0}")]
    StaleNote(Uuid),

    /// Returned when a symbol note cannot be resolved in current source text.
    ///
    /// symbol note를 현재 source text에서 해석할 수 없을 때 반환됩니다.
    #[error("unresolved anchor for note: {0}")]
    UnresolvedAnchor(Uuid),

    /// Returned when `expected_updated_at` does not match the stored note revision.
    ///
    /// `expected_updated_at`이 저장된 note revision과 일치하지 않을 때 반환됩니다.
    #[error("concurrent modification for note: {0}")]
    ConcurrentModification(Uuid),

    /// Returned when a tag operation receives an invalid tag name or arguments.
    ///
    /// 태그 연산에 잘못된 태그 이름 또는 인자가 전달되었을 때 반환됩니다.
    #[error("invalid tag: {0}")]
    InvalidTag(String),

    /// Returned when a tag query cannot be parsed or validated.
    #[error("invalid tag query: {0}")]
    InvalidTagQuery(String),

    /// Returned when a workspace-wide tag mutation fails while being applied.
    #[error("tag operation failed: {source}; rollback {rollback}")]
    TagOperationFailed {
        #[source]
        source: Box<FrilVaultError>,
        rollback: TagOperationRollback,
    },

    /// Returned when an environment profile name cannot safely map to one file.
    #[error("invalid environment profile name: {0}")]
    InvalidEnvProfileName(String),

    /// Returned when an environment profile payload cannot be serialized or parsed.
    #[error("invalid environment profile payload")]
    InvalidEnvProfilePayload,

    /// Returned when a persisted environment profile uses a newer payload version.
    #[error("unsupported environment profile payload version: {0}")]
    UnsupportedEnvProfilePayloadVersion(u32),

    /// Returned when an environment profile payload is not valid UTF-8.
    #[error("environment profile payload is not valid UTF-8")]
    InvalidEnvProfileUtf8,

    /// Returned when age cannot encrypt an environment profile.
    #[error("environment profile encryption failed")]
    EnvProfileEncryptionFailed,

    /// Returned when age cannot decrypt or authenticate an environment profile.
    #[error("environment profile decryption failed")]
    EnvProfileDecryptionFailed,
}

pub type FrilVaultResult<T> = Result<T, FrilVaultError>;
