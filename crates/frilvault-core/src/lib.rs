//! Local-first note vault core for source-code workspaces.
//!
//! `frilvault-core` owns domain models, persistence boundaries, workspace indexing,
//! symbol resolution, and application services used by the CLI and editor integrations.
//!
//! 소스 코드 워크스페이스를 위한 로컬 우선 노트 vault 코어입니다.
//!
//! `frilvault-core`는 CLI와 에디터 연동에서 공통으로 사용하는 도메인 모델,
//! 저장소 경계, 워크스페이스 인덱스, 심볼 해석, 애플리케이션 서비스를 소유합니다.
mod app;
mod constants;
mod error;
mod note;
mod parser;
mod runtime;
mod symbol;
mod uri;
mod workspace;

pub use app::{FrilVault, InitializationResult};

pub use error::{FrilVaultError, FrilVaultResult, TagOperationRollback};
pub use note::{
    AddNoteRequest, AttachmentRepository, LineAnchor, Note, NoteAnchor, NoteAttachment, NoteQuery,
    NoteView, SymbolAnchor, SymbolKind, TagBreakdown, TagGroupBy, TagOperationResult, TagQuery,
    TagStatistic, TagSummary, UpdateNoteRequest, normalize_tag, normalize_tags,
};
pub use symbol::{ResolvedSymbol, SymbolResolver, symbol_marker};
pub use uri::{NOTE_URI_SCHEME, NOTE_URI_VERSION, NoteUriResolver, ParsedNoteUri};
pub use workspace::{
    ExplorerGroup, ExplorerNode, FileMove, GitExcludeStatus, GitTrackingStatus, RepairSuggestion,
    SyncResult, TagColor, TagSettings, VaultMode, WorkspaceExplorer, WorkspaceHealth,
    WorkspaceService, WorkspaceStats, WorkspaceStatus,
};

#[cfg(test)]
mod tests;
