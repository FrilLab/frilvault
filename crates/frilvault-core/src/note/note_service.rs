//! Application services for note operations.
//!
//! This module contains high-level note workflows such as CRUD operations,
//! searching, attachments, and URI resolution.
//!
//! Services access storage through `VaultContext` rather than repositories directly.
//!
//! CRUD, 검색, 첨부, URI 해석 같은 고수준 note 워크플로를 제공하는
//! 애플리케이션 서비스 모듈입니다.
//!
//! 서비스는 저장소를 직접 사용하지 않고 `VaultContext`를 통해 접근합니다.

use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::Utc;
use uuid::Uuid;

use crate::{
    AddNoteRequest, AttachmentRepository, FrilVaultError, FrilVaultResult, NoteAnchor,
    NoteAttachment, NoteQuery, NoteView, SymbolKind, TagBreakdown, TagGroupBy, TagOperationResult,
    TagQuery, TagStatistic, TagSummary, UpdateNoteRequest,
    note::{Note, normalize_tag, normalize_tags, restore_file},
    runtime::VaultContext,
    symbol::SymbolResolver,
    workspace::{IndexedFile, PathResolver, WorkspaceIndex, read_source_file_content},
};

/// Application service responsible for note operations.
///
/// Coordinates repositories, caching, symbol resolution, and workspace index updates.
///
/// 노트 연산을 담당하는 애플리케이션 서비스입니다.
///
/// 저장소, 캐시, symbol 해석, workspace index 갱신을 조율합니다.
pub struct NoteService {
    vault_context: VaultContext,
}

impl NoteService {
    pub fn new(vault_context: VaultContext) -> Self {
        Self { vault_context }
    }

    fn load_notes(&mut self, source_file: impl AsRef<Path>) -> FrilVaultResult<Vec<Note>> {
        Ok(self.vault_context.load_notes(source_file.as_ref())?.notes)
    }

    fn save_notes(
        &mut self,
        source_file: impl AsRef<Path>,
        notes: Vec<Note>,
    ) -> FrilVaultResult<()> {
        let source_file = source_file.as_ref();

        self.vault_context
            .note_repository
            .replace_notes(source_file.as_ref(), notes)?;

        self.vault_context.invalidate_notes(source_file.as_ref());

        Ok(())
    }

    /// Creates and persists a new note for the requested source file.
    ///
    /// Updates the workspace index note count for that file.
    ///
    /// # Errors
    ///
    /// Returns repository or index errors when vault JSON cannot be written.
    ///
    /// 요청한 source file에 새 note를 생성하고 저장합니다.
    ///
    /// 해당 파일의 workspace index note count를 갱신합니다.
    pub fn add_note(&mut self, input: AddNoteRequest) -> FrilVaultResult<Note> {
        let mut input = input;
        validate_anchor(&input.anchor)?;
        let source_file = self
            .vault_context
            .normalize_source_file(&input.source_file)?;
        input.source_file = source_file.clone();
        let note = Note::new(input);

        self.vault_context
            .note_repository
            .append_note(&source_file, &note)?;

        self.vault_context.invalidate_notes(&source_file);

        self.vault_context
            .sync_index_for_source_file(&source_file)?;

        Ok(note)
    }

    /// Returns note views for one source file, including resolved symbol locations.
    ///
    /// 하나의 source file에 대한 note view를 반환하며, symbol 위치 해석 결과를 포함합니다.
    pub fn list_notes(&mut self, source_file: impl AsRef<Path>) -> FrilVaultResult<Vec<NoteView>> {
        self.query_notes(&NoteQuery {
            source_file: Some(source_file.as_ref().to_path_buf()),
            keyword: None,
            tag: None,
        })
    }

    pub fn search_notes_by_file(
        &mut self,
        source_file: impl AsRef<Path>,
    ) -> FrilVaultResult<Vec<NoteView>> {
        self.query_notes(&NoteQuery {
            source_file: Some(source_file.as_ref().to_path_buf()),
            keyword: None,
            tag: None,
        })
    }

    /// Applies optional file, keyword, and tag filters to note views.
    ///
    /// 선택적 file, keyword, tag 필터를 note view에 적용합니다.
    pub fn query_notes(&mut self, query: &NoteQuery) -> FrilVaultResult<Vec<NoteView>> {
        self.query_notes_with_tag_query(query, None)
    }

    /// Applies a parsed tag expression together with optional file and keyword filters.
    pub fn query_notes_with_tag_query(
        &mut self,
        query: &NoteQuery,
        tag_query: Option<&TagQuery>,
    ) -> FrilVaultResult<Vec<NoteView>> {
        let exact_tag_query = query
            .tag
            .as_deref()
            .map(|tag| TagQuery::all([tag]))
            .transpose()?;
        let mut results = if let Some(source_file) = &query.source_file {
            self.note_views_for_source_file(source_file)?
        } else if query.keyword.is_some() || exact_tag_query.is_some() || tag_query.is_some() {
            self.all_note_views()?
        } else {
            Vec::new()
        };

        if let Some(exact_tag_query) = &exact_tag_query {
            results.retain(|view| exact_tag_query.matches(&view.note.tags));
        }

        if let Some(tag_query) = tag_query {
            results.retain(|view| tag_query.matches(&view.note.tags));
        }

        if let Some(keyword) = &query.keyword {
            let keyword = keyword.to_lowercase();
            results.retain(|view| note_matches_keyword(view, &keyword));
        }

        results.sort_by(|left, right| {
            left.source_file
                .cmp(&right.source_file)
                .then_with(|| left.note.created_at.cmp(&right.note.created_at))
                .then_with(|| left.note.id.cmp(&right.note.id))
        });

        Ok(results)
    }

    fn note_views_for_source_file(
        &mut self,
        source_file: impl AsRef<Path>,
    ) -> FrilVaultResult<Vec<NoteView>> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;
        let notes = self.vault_context.load_notes(&source_file)?;

        Ok(notes
            .notes
            .into_iter()
            .map(|note| self.build_note_view(&source_file, note))
            .collect())
    }

    pub fn preload_notes(&mut self, source_file: impl AsRef<Path>) -> FrilVaultResult<()> {
        self.vault_context.preload_notes(source_file.as_ref())
    }

    /// Deletes a note and removes any stored attachments for its id.
    ///
    /// # Errors
    ///
    /// Returns `NoteNotFound` when the id is absent from the source note file.
    ///
    /// note를 삭제하고 해당 id의 저장된 첨부를 함께 제거합니다.
    pub fn delete_note(
        &mut self,
        source_file: impl AsRef<Path>,
        note_id: Uuid,
    ) -> FrilVaultResult<()> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;

        let mut notes = self.load_notes(&source_file)?;

        let note_index = unique_note_index(&notes, note_id)?;
        notes.remove(note_index);

        self.save_notes(&source_file, notes)?;

        self.vault_context
            .sync_index_for_source_file(&source_file)?;

        self.attachment_repository().remove_all_for_note(note_id)?;

        Ok(())
    }

    /// Updates note content and optionally tags.
    ///
    /// When `expected_updated_at` is provided, the update is rejected if another
    /// writer changed the note first.
    ///
    /// # Errors
    ///
    /// Returns `NoteNotFound` or `ConcurrentModification` when applicable.
    ///
    /// note content와 선택적으로 tags를 수정합니다.
    ///
    /// `expected_updated_at`가 주어지면 다른 writer가 먼저 수정한 경우 거부됩니다.
    pub fn update_note(
        &mut self,
        source_file: impl AsRef<Path>,
        note_id: Uuid,
        request: UpdateNoteRequest,
    ) -> FrilVaultResult<Note> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;

        let mut notes = self.load_notes(&source_file)?;

        let note_index = unique_note_index(&notes, note_id)?;
        let note = &mut notes[note_index];

        if let Some(expected) = request.expected_updated_at
            && note.updated_at != expected
        {
            return Err(FrilVaultError::ConcurrentModification(note_id));
        }

        note.content = request.content;

        if let Some(tags) = request.tags {
            note.tags = normalize_tags(tags);
        }

        note.updated_at = Utc::now();

        let updated = note.clone();
        self.save_notes(&source_file, notes)?;

        self.vault_context
            .sync_index_for_source_file(&source_file)?;

        Ok(updated)
    }

    pub fn attach_image(
        &mut self,
        source_file: impl AsRef<Path>,
        note_id: Uuid,
        image_path: impl AsRef<Path>,
    ) -> FrilVaultResult<NoteAttachment> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;
        let mut notes = self.load_notes(&source_file)?;

        let note_index = unique_note_index(&notes, note_id)?;
        let note = &mut notes[note_index];

        let attachment_repository = self.attachment_repository();
        let attachment = attachment_repository.store(note_id, image_path.as_ref())?;

        note.attachments.push(attachment.clone());
        note.updated_at = Utc::now();

        if let Err(error) = self.save_notes(&source_file, notes) {
            let _ = attachment_repository.remove(note_id, &attachment);
            return Err(error);
        }
        self.vault_context
            .sync_index_for_source_file(&source_file)?;

        Ok(attachment)
    }

    pub fn detach_image(
        &mut self,
        source_file: impl AsRef<Path>,
        note_id: Uuid,
        attachment_id: Uuid,
    ) -> FrilVaultResult<()> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;
        let mut notes = self.load_notes(&source_file)?;

        let note_index = unique_note_index(&notes, note_id)?;
        let note = &mut notes[note_index];

        let attachment_index = note
            .attachments
            .iter()
            .position(|attachment| attachment.id == attachment_id)
            .ok_or(FrilVaultError::AttachmentNotFound(attachment_id))?;

        let attachment = note.attachments.remove(attachment_index);
        note.updated_at = Utc::now();

        self.save_notes(&source_file, notes)?;
        self.vault_context
            .sync_index_for_source_file(&source_file)?;

        self.attachment_repository().remove(note_id, &attachment)?;

        Ok(())
    }

    fn attachment_repository(&self) -> AttachmentRepository {
        AttachmentRepository::new(PathResolver::new(
            self.vault_context
                .workspace_index_repository
                .workspace_root(),
        ))
    }

    fn all_note_views(&mut self) -> FrilVaultResult<Vec<NoteView>> {
        let records = self.vault_context.list_all_note_files()?;

        let mut results = Vec::new();

        for record in records {
            for note in record.note_file.notes {
                results.push(self.build_note_view(&record.source_file, note));
            }
        }

        Ok(results)
    }

    fn build_note_view(&self, source_file: &Path, note: Note) -> NoteView {
        let resolved = match &note.anchor {
            NoteAnchor::Symbol(anchor) => self.resolve_symbol_anchor(source_file, anchor),
            _ => None,
        };

        NoteView {
            source_file: source_file.to_path_buf(),
            note,
            resolved,
        }
    }

    fn resolve_symbol_anchor(
        &self,
        source_file: &Path,
        anchor: &crate::SymbolAnchor,
    ) -> Option<crate::ResolvedSymbol> {
        let workspace_root = self
            .vault_context
            .workspace_index_repository
            .workspace_root();
        let relative_path = source_file.to_string_lossy();

        read_source_file_content(workspace_root, relative_path.as_ref())
            .and_then(|content| SymbolResolver::resolve(anchor, &content))
    }

    pub fn find_symbol_in_source(
        &self,
        source_file: impl AsRef<Path>,
        symbol: &str,
        kind: SymbolKind,
    ) -> FrilVaultResult<Option<crate::ResolvedSymbol>> {
        let source_file = self
            .vault_context
            .normalize_source_file(source_file.as_ref())?;
        let workspace_root = self
            .vault_context
            .workspace_index_repository
            .workspace_root();
        let relative_path = source_file.to_string_lossy();

        Ok(
            read_source_file_content(workspace_root, relative_path.as_ref())
                .and_then(|content| SymbolResolver::find_by_name(symbol, kind, &content)),
        )
    }

    pub fn search_notes(&mut self, keyword: &str) -> FrilVaultResult<Vec<NoteView>> {
        self.query_notes(&NoteQuery {
            source_file: None,
            keyword: Some(keyword.to_string()),
            tag: None,
        })
    }

    pub fn search_by_symbol(&mut self, symbol: &str) -> FrilVaultResult<Vec<NoteView>> {
        let symbol = symbol.to_lowercase();

        Ok(self
            .all_note_views()?
            .into_iter()
            .filter(|view| {
                matches!(
                    &view.note.anchor,
                    NoteAnchor::Symbol(anchor)
                        if anchor.name.to_lowercase().contains(&symbol)
                )
            })
            .collect())
    }

    pub fn search_by_tag(&mut self, tag: &str) -> FrilVaultResult<Vec<NoteView>> {
        self.query_notes(&NoteQuery {
            source_file: None,
            keyword: None,
            tag: Some(tag.to_string()),
        })
    }

    /// Renames a tag across all notes in the workspace.
    ///
    /// Duplicate tags resulting from rename are automatically eliminated.
    ///
    /// 워크스페이스 내 모든 노트에서 태그 이름을 변경합니다.
    /// 변경으로 인해 발생하는 중복 태그는 자동으로 제거됩니다.
    pub fn rename_tag(&mut self, from: &str, to: &str) -> FrilVaultResult<TagOperationResult> {
        let from = validate_tag_name(from, "source tag")?;
        let to = validate_tag_name(to, "target tag")?;
        let from_lower = from.to_lowercase();
        self.apply_tag_mutation(false, |note| rename_tag_in_note(note, &from_lower, &to))
    }

    /// Previews renaming a tag across all notes in the workspace without modifying disk.
    ///
    /// 디스크를 수정하지 않고 워크스페이스 내 태그 이름 변경 영향을 미리 확인합니다.
    pub fn preview_rename_tag(
        &mut self,
        from: &str,
        to: &str,
    ) -> FrilVaultResult<TagOperationResult> {
        let from = validate_tag_name(from, "source tag")?;
        let to = validate_tag_name(to, "target tag")?;
        let from_lower = from.to_lowercase();
        self.apply_tag_mutation(true, |note| rename_tag_in_note(note, &from_lower, &to))
    }

    /// Merges multiple source tags into a target tag across all notes in the workspace.
    ///
    /// Duplicate tags resulting from merge are automatically eliminated.
    ///
    /// 워크스페이스 내 여러 소스 태그를 하나의 대상 태그로 병합합니다.
    /// 병합으로 인해 발생하는 중복 태그는 자동으로 제거됩니다.
    pub fn merge_tags(
        &mut self,
        sources: &[String],
        target: &str,
    ) -> FrilVaultResult<TagOperationResult> {
        let target = validate_tag_name(target, "target tag")?;
        if sources.is_empty() {
            return Err(FrilVaultError::InvalidTag(
                "at least one source tag is required for merge".to_string(),
            ));
        }
        let mut source_set = std::collections::HashSet::new();
        for src in sources {
            let valid_src = validate_tag_name(src, "source tag")?;
            source_set.insert(valid_src.to_lowercase());
        }
        self.apply_tag_mutation(false, |note| merge_tags_in_note(note, &source_set, &target))
    }

    /// Previews merging multiple source tags into a target tag without modifying disk.
    ///
    /// 디스크를 수정하지 않고 워크스페이스 내 태그 병합 영향을 미리 확인합니다.
    pub fn preview_merge_tags(
        &mut self,
        sources: &[String],
        target: &str,
    ) -> FrilVaultResult<TagOperationResult> {
        let target = validate_tag_name(target, "target tag")?;
        if sources.is_empty() {
            return Err(FrilVaultError::InvalidTag(
                "at least one source tag is required for merge".to_string(),
            ));
        }
        let mut source_set = std::collections::HashSet::new();
        for src in sources {
            let valid_src = validate_tag_name(src, "source tag")?;
            source_set.insert(valid_src.to_lowercase());
        }
        self.apply_tag_mutation(true, |note| merge_tags_in_note(note, &source_set, &target))
    }

    /// Removes a tag from all notes in the workspace.
    ///
    /// 워크스페이스 내 모든 노트에서 지정된 태그를 제거합니다.
    pub fn remove_tag(&mut self, tag: &str) -> FrilVaultResult<TagOperationResult> {
        let tag = validate_tag_name(tag, "tag to remove")?;
        let tag_lower = tag.to_lowercase();
        self.apply_tag_mutation(false, |note| remove_tag_in_note(note, &tag_lower))
    }

    /// Previews removing a tag from all notes in the workspace without modifying disk.
    ///
    /// 디스크를 수정하지 않고 워크스페이스 내 태그 제거 영향을 미리 확인합니다.
    pub fn preview_remove_tag(&mut self, tag: &str) -> FrilVaultResult<TagOperationResult> {
        let tag = validate_tag_name(tag, "tag to remove")?;
        let tag_lower = tag.to_lowercase();
        self.apply_tag_mutation(true, |note| remove_tag_in_note(note, &tag_lower))
    }

    /// Lists all distinct tags used across the workspace with their note counts.
    ///
    /// 워크스페이스 전체에서 사용 중인 고유 태그 목록과 각 태그별 노트 수를 반환합니다.
    pub fn list_tags(&mut self) -> FrilVaultResult<Vec<TagSummary>> {
        let mut summaries: Vec<TagSummary> = self
            .tag_statistics(None, None)?
            .into_iter()
            .map(|statistic| TagSummary {
                tag: statistic.tag,
                note_count: statistic.note_count,
                color: None,
            })
            .collect();

        summaries.sort_by_key(|summary| summary.tag.to_lowercase());
        Ok(summaries)
    }

    /// Aggregates note counts per tag, optionally filtering by tag and grouping
    /// each tag's distribution by source file or immediate parent directory.
    ///
    /// Results are recomputed from current note files and ordered by descending
    /// note count, then tag name. A tag is counted at most once per note.
    pub fn tag_statistics(
        &mut self,
        tag: Option<&str>,
        group_by: Option<TagGroupBy>,
    ) -> FrilVaultResult<Vec<TagStatistic>> {
        let records = self.vault_context.note_repository.list_all_note_files()?;
        let tag_filter = tag
            .map(|tag| validate_tag_name(tag, "tag"))
            .transpose()?
            .map(|tag| tag.to_lowercase());
        let mut tag_counts: std::collections::HashMap<
            String,
            (String, usize, std::collections::HashMap<PathBuf, usize>),
        > = std::collections::HashMap::new();

        for record in records {
            for note in record.note_file.notes {
                let mut seen_in_note = std::collections::HashSet::new();
                for tag in note.tags {
                    let normalized = normalize_tag(&tag);
                    let key = normalized.to_lowercase();
                    if normalized.is_empty()
                        || tag_filter.as_ref().is_some_and(|filter| filter != &key)
                        || !seen_in_note.insert(key.clone())
                    {
                        continue;
                    }

                    let entry = tag_counts
                        .entry(key)
                        .or_insert_with(|| (normalized, 0, std::collections::HashMap::new()));
                    entry.1 += 1;

                    if let Some(group_by) = group_by {
                        let path = tag_group_path(&record.source_file, group_by);
                        *entry.2.entry(path).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut statistics: Vec<TagStatistic> = tag_counts
            .into_values()
            .map(|(tag, note_count, breakdown)| {
                let mut breakdown: Vec<TagBreakdown> = breakdown
                    .into_iter()
                    .map(|(path, note_count)| TagBreakdown { path, note_count })
                    .collect();
                breakdown.sort_by(|left, right| {
                    right.note_count.cmp(&left.note_count).then_with(|| {
                        left.path
                            .to_string_lossy()
                            .cmp(&right.path.to_string_lossy())
                    })
                });

                TagStatistic {
                    tag,
                    note_count,
                    breakdown,
                }
            })
            .collect();

        statistics.sort_by(|left, right| {
            right
                .note_count
                .cmp(&left.note_count)
                .then_with(|| left.tag.to_lowercase().cmp(&right.tag.to_lowercase()))
        });
        Ok(statistics)
    }

    /// Identifies tags that are no longer attached to any note.
    ///
    /// 어떤 노트에도 연결되지 않은 미사용 태그 목록을 반환합니다.
    pub fn list_unused_tags(&mut self) -> FrilVaultResult<Vec<TagSummary>> {
        let tags = self.list_tags()?;
        Ok(tags.into_iter().filter(|t| t.note_count == 0).collect())
    }

    fn apply_tag_mutation<F>(
        &mut self,
        dry_run: bool,
        mut mutate_note: F,
    ) -> FrilVaultResult<TagOperationResult>
    where
        F: FnMut(&mut Note) -> bool,
    {
        let mut records = self.vault_context.note_repository.list_all_note_files()?;
        let mut affected_notes = 0;
        let mut affected_files = 0;
        let mut changed_files = std::collections::HashSet::new();

        for record in &mut records {
            let mut file_changed = false;
            for note in &mut record.note_file.notes {
                if mutate_note(note) {
                    affected_notes += 1;
                    file_changed = true;
                }
            }
            if file_changed {
                affected_files += 1;
                changed_files.insert(record.source_file.clone());
            }
        }

        if dry_run || affected_files == 0 {
            return Ok(TagOperationResult {
                affected_notes,
                affected_files,
            });
        }

        // Prepare every output and every rollback snapshot before replacing a file.
        // The filesystem cannot atomically replace several paths at once, so the
        // commit below uses these snapshots to provide a workspace transaction.
        let files_to_update = records
            .iter()
            .filter(|record| changed_files.contains(&record.source_file))
            .map(|record| {
                let path = self
                    .vault_context
                    .note_repository
                    .resolve_note_path(&record.source_file);
                Ok(PreparedTagFile {
                    source_file: record.source_file.clone(),
                    serialized: self
                        .vault_context
                        .note_repository
                        .serialize(&record.note_file)?,
                    snapshot: FileSnapshot::capture(path)?,
                })
            })
            .collect::<FrilVaultResult<Vec<_>>>()?;

        let index_path = self.vault_context.workspace_index_repository.path();
        let index_snapshot = FileSnapshot::capture(index_path)?;
        let mut index = if index_snapshot.contents.is_some() {
            self.vault_context.workspace_index_repository.load()?
        } else {
            WorkspaceIndex {
                version: 1,
                files: records
                    .iter()
                    .map(|record| IndexedFile {
                        source_file: record.source_file.to_string_lossy().into_owned(),
                        note_count: record.note_file.notes.len(),
                        exists: self
                            .vault_context
                            .workspace_index_repository
                            .workspace_root()
                            .join(&record.source_file)
                            .exists(),
                    })
                    .collect(),
            }
        };

        for record in &records {
            if !changed_files.contains(&record.source_file) {
                continue;
            }
            let source_file = record.source_file.to_string_lossy().into_owned();
            index.upsert_file(IndexedFile {
                source_file: source_file.clone(),
                note_count: record.note_file.notes.len(),
                exists: self
                    .vault_context
                    .workspace_index_repository
                    .workspace_root()
                    .join(&source_file)
                    .exists(),
            });
        }

        let prepared_index = PreparedIndex {
            serialized: serde_json::to_string(&index)?,
            snapshot: index_snapshot,
        };

        self.commit_tag_mutation(files_to_update, prepared_index)?;

        Ok(TagOperationResult {
            affected_notes,
            affected_files,
        })
    }

    fn commit_tag_mutation(
        &mut self,
        files: Vec<PreparedTagFile>,
        index: PreparedIndex,
    ) -> FrilVaultResult<()> {
        for file in &files {
            if let Err(error) = self
                .vault_context
                .note_repository
                .write_serialized(&file.source_file, &file.serialized)
            {
                return Err(self.tag_operation_failure(error, &files, &index));
            }
        }

        if let Err(error) = self
            .vault_context
            .workspace_index_repository
            .write_serialized(&index.serialized)
        {
            return Err(self.tag_operation_failure(error, &files, &index));
        }

        for file in &files {
            self.vault_context.invalidate_notes(&file.source_file);
        }

        Ok(())
    }

    fn tag_operation_failure(
        &mut self,
        source: FrilVaultError,
        files: &[PreparedTagFile],
        index: &PreparedIndex,
    ) -> FrilVaultError {
        match rollback_tag_mutation(files, index) {
            Ok(()) => FrilVaultError::TagOperationFailed {
                source: Box::new(source),
                rollback: crate::TagOperationRollback::Succeeded,
            },
            Err(rollback_error) => {
                self.vault_context.clear_notes_cache();
                FrilVaultError::TagOperationFailed {
                    source: Box::new(source),
                    rollback: crate::TagOperationRollback::Failed(rollback_error),
                }
            }
        }
    }

    /// Configures a deterministic note-write failure for filesystem transaction tests.
    #[cfg(test)]
    pub(crate) fn fail_note_writes_after(&self, successful_writes: usize) {
        self.vault_context
            .note_repository
            .fail_writes_after(successful_writes);
    }

    /// Configures a deterministic index-write failure for filesystem transaction tests.
    #[cfg(test)]
    pub(crate) fn fail_index_writes_after(&self, successful_writes: usize) {
        self.vault_context
            .workspace_index_repository
            .fail_writes_after(successful_writes);
    }

    #[cfg(test)]
    pub(crate) fn contains_cached_notes(&self, source_file: &Path) -> bool {
        self.vault_context.contains_cached_notes(source_file)
    }

    pub fn list_symbol_notes(
        &mut self,
        source_file: impl AsRef<Path>,
    ) -> FrilVaultResult<Vec<NoteView>> {
        Ok(self
            .list_notes(source_file)?
            .into_iter()
            .filter(|view| matches!(view.note.anchor, NoteAnchor::Symbol(_)))
            .collect())
    }

    pub fn find_symbol_note(
        &mut self,
        source_file: impl AsRef<Path>,
        symbol: &str,
    ) -> FrilVaultResult<Option<NoteView>> {
        let symbol = symbol.to_lowercase();

        Ok(self
            .list_symbol_notes(source_file)?
            .into_iter()
            .find(|view| match &view.note.anchor {
                NoteAnchor::Symbol(anchor) => anchor.name.to_lowercase() == symbol,
                _ => false,
            }))
    }

    /// Returns the absolute workspace root associated with this service.
    ///
    /// 이 서비스와 연결된 절대 workspace root를 반환합니다.
    pub fn workspace_root(&self) -> PathBuf {
        self.vault_context
            .workspace_index_repository
            .workspace_root()
            .to_path_buf()
    }

    /// Loads the workspace index and refreshes source-file existence flags.
    ///
    /// workspace index를 불러오고 source file 존재 여부 플래그를 갱신합니다.
    pub fn load_workspace_index(&self) -> FrilVaultResult<crate::workspace::WorkspaceIndex> {
        self.vault_context.load_index()
    }

    /// Finds a note by stable id across all indexed source files.
    ///
    /// # Errors
    ///
    /// Returns `NoteNotFound` when no note with the id exists in the workspace.
    ///
    /// 인덱스된 모든 source file에서 stable id로 note를 찾습니다.
    pub fn find_note_by_id(&mut self, note_id: Uuid) -> FrilVaultResult<NoteView> {
        let mut matches = self
            .all_note_views()?
            .into_iter()
            .filter(|view| view.note.id == note_id);
        let note = matches
            .next()
            .ok_or(FrilVaultError::NoteNotFound(note_id))?;

        if matches.next().is_some() {
            return Err(FrilVaultError::DuplicateNoteId(note_id));
        }

        Ok(note)
    }

    /// Resolves a stable note URI into a current `NoteView`.
    ///
    /// # Errors
    ///
    /// Returns URI, workspace, stale-note, or unresolved-anchor errors when validation fails.
    ///
    /// stable note URI를 현재 `NoteView`로 해석합니다.
    pub fn resolve_note_uri(&mut self, uri: &str) -> FrilVaultResult<NoteView> {
        crate::uri::NoteUriResolver::resolve(self, uri)
    }

    /// Serializes a versioned note URI for the current workspace root.
    ///
    /// 현재 workspace root 기준 versioned note URI를 직렬화합니다.
    pub fn note_uri(&self, note_id: Uuid) -> FrilVaultResult<String> {
        crate::uri::NoteUriResolver::serialize(note_id, &self.workspace_root())
    }
}

fn tag_group_path(source_file: &Path, group_by: TagGroupBy) -> PathBuf {
    match group_by {
        TagGroupBy::File => source_file.to_path_buf(),
        TagGroupBy::Directory => source_file
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
    }
}

fn unique_note_index(notes: &[Note], note_id: Uuid) -> FrilVaultResult<usize> {
    let mut matches = notes
        .iter()
        .enumerate()
        .filter(|(_, note)| note.id == note_id)
        .map(|(index, _)| index);
    let index = matches
        .next()
        .ok_or(FrilVaultError::NoteNotFound(note_id))?;

    if matches.next().is_some() {
        return Err(FrilVaultError::DuplicateNoteId(note_id));
    }

    Ok(index)
}

fn validate_anchor(anchor: &NoteAnchor) -> FrilVaultResult<()> {
    match anchor {
        NoteAnchor::Line(anchor) if anchor.line == 0 || anchor.column == 0 => Err(
            FrilVaultError::InvalidAnchor("line and column must be 1-based".to_string()),
        ),
        NoteAnchor::Symbol(anchor) if anchor.name.trim().is_empty() => Err(
            FrilVaultError::InvalidAnchor("symbol name cannot be empty".to_string()),
        ),
        NoteAnchor::Symbol(anchor) if anchor.line_hint == Some(0) => Err(
            FrilVaultError::InvalidAnchor("symbol line hint must be 1-based".to_string()),
        ),
        _ => Ok(()),
    }
}

struct PreparedTagFile {
    source_file: PathBuf,
    serialized: String,
    snapshot: FileSnapshot,
}

struct PreparedIndex {
    serialized: String,
    snapshot: FileSnapshot,
}

struct FileSnapshot {
    path: PathBuf,
    contents: Option<Vec<u8>>,
    permissions: Option<fs::Permissions>,
    modified: Option<SystemTime>,
}

impl FileSnapshot {
    fn capture(path: PathBuf) -> FrilVaultResult<Self> {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let (contents, permissions, modified) = match metadata {
            Some(metadata) => (
                Some(fs::read(&path)?),
                Some(metadata.permissions()),
                Some(metadata.modified()?),
            ),
            None => (None, None, None),
        };

        Ok(Self {
            path,
            contents,
            permissions,
            modified,
        })
    }

    fn restore(&self) -> std::io::Result<()> {
        restore_file(&self.path, self.contents.as_deref())?;

        if self.contents.is_some() {
            if let Some(permissions) = &self.permissions {
                fs::set_permissions(&self.path, permissions.clone())?;
            }
            if let Some(modified) = self.modified {
                fs::File::open(&self.path)?.set_modified(modified)?;
            }
        }

        Ok(())
    }
}

fn rollback_tag_mutation(files: &[PreparedTagFile], index: &PreparedIndex) -> Result<(), String> {
    let mut errors = Vec::new();

    for file in files {
        if let Err(error) = file.snapshot.restore() {
            errors.push(format!("{}: {error}", file.snapshot.path.display()));
        }
    }

    if let Err(error) = index.snapshot.restore() {
        errors.push(format!("{}: {error}", index.snapshot.path.display()));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn note_matches_keyword(view: &NoteView, keyword: &str) -> bool {
    let content_match = view.note.content.to_lowercase().contains(keyword);

    let symbol_match = matches!(
        &view.note.anchor,
        NoteAnchor::Symbol(anchor) if anchor.name.to_lowercase().contains(keyword)
    );

    content_match || symbol_match
}

fn validate_tag_name(tag: &str, field_name: &str) -> FrilVaultResult<String> {
    let normalized = normalize_tag(tag);
    if normalized.is_empty() {
        return Err(FrilVaultError::InvalidTag(format!(
            "{field_name} cannot be empty"
        )));
    }
    Ok(normalized)
}

fn deduplicate_tags(tags: Vec<String>) -> Vec<String> {
    normalize_tags(tags)
}

fn rename_tag_in_note(note: &mut Note, from_lower: &str, to: &str) -> bool {
    let mut new_tags = Vec::with_capacity(note.tags.len());
    for tag in &note.tags {
        if normalize_tag(tag).to_lowercase() == from_lower {
            new_tags.push(to.to_string());
        } else {
            new_tags.push(tag.clone());
        }
    }
    let deduplicated = deduplicate_tags(new_tags);
    if deduplicated != note.tags {
        note.tags = deduplicated;
        note.updated_at = Utc::now();
        true
    } else {
        false
    }
}

fn merge_tags_in_note(
    note: &mut Note,
    source_set: &std::collections::HashSet<String>,
    target: &str,
) -> bool {
    let mut new_tags = Vec::with_capacity(note.tags.len());
    for tag in &note.tags {
        if source_set.contains(&normalize_tag(tag).to_lowercase()) {
            new_tags.push(target.to_string());
        } else {
            new_tags.push(tag.clone());
        }
    }
    let deduplicated = deduplicate_tags(new_tags);
    if deduplicated != note.tags {
        note.tags = deduplicated;
        note.updated_at = Utc::now();
        true
    } else {
        false
    }
}

fn remove_tag_in_note(note: &mut Note, target_lower: &str) -> bool {
    let new_tags: Vec<String> = note
        .tags
        .iter()
        .filter(|t| normalize_tag(t).to_lowercase() != target_lower)
        .cloned()
        .collect();
    let deduplicated = deduplicate_tags(new_tags);
    if deduplicated != note.tags {
        note.tags = deduplicated;
        note.updated_at = Utc::now();
        true
    } else {
        false
    }
}
