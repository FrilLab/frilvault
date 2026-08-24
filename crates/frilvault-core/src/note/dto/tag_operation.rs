use serde::{Deserialize, Serialize};

use crate::workspace::TagColor;

/// Result of a workspace-wide tag modification or preview operation.
///
/// 워크스페이스 전역 태그 수정 또는 미리보기 연산의 결과입니다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TagOperationResult {
    /// Number of notes whose tags were modified.
    ///
    /// 태그가 수정된 노트의 수입니다.
    pub affected_notes: usize,

    /// Number of source note JSON files modified.
    ///
    /// 수정된 소스 노트 JSON 파일의 수입니다.
    pub affected_files: usize,
}

/// Summary of a tag and its usage count across the workspace.
///
/// 워크스페이스 전역 태그와 해당 태그의 사용 횟수 요약입니다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TagSummary {
    /// Tag name.
    ///
    /// 태그 이름입니다.
    pub tag: String,

    /// Number of notes attached to this tag.
    ///
    /// 이 태그가 연결된 노트의 수입니다.
    pub note_count: usize,

    /// Optional workspace-level display color for this tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<TagColor>,
}
