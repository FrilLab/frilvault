use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AddNoteRequest,
    note::{NoteAnchor, normalize_tags},
};

/// Persistent note record stored inside a source-file note JSON file.
///
/// A `Note` is identified by `id` and anchored to source code through `anchor`.
/// Source files themselves are never rewritten; only `.vault/notes/*.json` changes.
///
/// 소스 파일별 note JSON 파일에 저장되는 영속 노트 레코드입니다.
///
/// `Note`는 `id`로 식별되며 `anchor`를 통해 소스 코드에 고정됩니다.
/// 소스 파일 본문은 변경하지 않고 `.vault/notes/*.json`만 수정됩니다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Note {
    /// Stable note identity used by links, updates, and attachments.
    ///
    /// 링크, 수정, 첨부에서 사용하는 안정적인 노트 식별자입니다.
    pub id: Uuid,

    /// Location in source code, either a line/column pair or a symbol descriptor.
    ///
    /// 소스 코드 위치로, line/column 쌍 또는 symbol 설명자 중 하나입니다.
    pub anchor: NoteAnchor,

    /// Markdown note body persisted in vault JSON.
    ///
    /// vault JSON에 저장되는 Markdown 본문입니다.
    pub content: String,

    /// Optional labels stored with the note.
    ///
    /// 노트와 함께 저장되는 선택적 태그입니다.
    #[serde(default)]
    pub tags: Vec<String>,

    /// Image attachments stored under `.vault/images/<note-id>/`.
    ///
    /// `.vault/images/<note-id>/` 아래에 저장되는 이미지 첨부입니다.
    #[serde(default)]
    pub attachments: Vec<crate::note::NoteAttachment>,

    /// Creation timestamp in UTC.
    ///
    /// UTC 기준 생성 시각입니다.
    pub created_at: DateTime<Utc>,

    /// Last modification timestamp in UTC.
    ///
    /// Used for optimistic concurrency checks during updates.
    ///
    /// UTC 기준 마지막 수정 시각입니다.
    ///
    /// 수정 시 낙관적 동시성 검사에 사용됩니다.
    pub updated_at: DateTime<Utc>,
}

impl Note {
    /// Creates a new note with a generated id and matching created/updated timestamps.
    ///
    /// 새 id와 동일한 created/updated 타임스탬프를 가진 노트를 생성합니다.
    pub fn new(input: AddNoteRequest) -> Self {
        let now = Utc::now();

        Self {
            id: Uuid::new_v4(),
            anchor: input.anchor,
            content: input.content,
            tags: normalize_tags(input.tags.unwrap_or_default()),
            attachments: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}
