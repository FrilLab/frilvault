//! JSON-backed note repository.
//!
//! Notes are persisted as JSON files inside `.vault/notes`.
//! This module does not modify source files themselves.
//!
//! JSON 기반 note 저장소입니다.
//!
//! note는 `.vault/notes` 아래 JSON 파일로 저장되며, 이 모듈은 source file
//! 본문을 수정하지 않습니다.

use std::fs;
use std::path::{Path, PathBuf};

use crate::note::{NoteFile, NoteFileRecord};
use crate::parser::JsonParser;
use crate::workspace::PathResolver;
use crate::{FrilVaultResult, Note};

/// Persists note JSON files under `.vault/notes`.
///
/// `.vault/notes` 아래 note JSON 파일을 저장합니다.
#[derive(Debug, Clone)]
pub struct NoteRepository {
    path_resolver: PathResolver,
    parser: JsonParser,
}

impl NoteRepository {
    pub fn new(path_resolver: PathResolver) -> Self {
        Self {
            path_resolver,
            parser: JsonParser,
        }
    }

    pub fn append_note(&self, source_file: &Path, note: &Note) -> FrilVaultResult<()> {
        let mut note_file = self.load_by_source_file(source_file)?;

        note_file.notes.push(note.clone());

        self.save_by_source_file(source_file, &note_file)?;

        Ok(())
    }

    pub fn load_by_source_file(&self, source_file: &Path) -> FrilVaultResult<NoteFile> {
        let note_path = self.path_resolver.resolve_note_path(source_file);

        self.load_by_note_path(&note_path)
    }

    pub fn save_by_source_file(
        &self,
        source_file: &Path,
        note_file: &NoteFile,
    ) -> FrilVaultResult<()> {
        let note_path = self.path_resolver.resolve_note_path(source_file);

        let json = self.parser.serialize(note_file)?;

        atomic_write(&note_path, &json)?;

        Ok(())
    }

    pub fn replace_notes(&self, source_file: &Path, notes: Vec<Note>) -> FrilVaultResult<()> {
        let note_file = NoteFile { notes };

        self.save_by_source_file(source_file, &note_file)
    }

    pub fn list_all_note_files(&self) -> FrilVaultResult<Vec<NoteFileRecord>> {
        let notes_root = self.path_resolver.notes_root();

        if !notes_root.exists() {
            return Ok(Vec::new());
        }

        let mut records = Vec::new();

        self.collect_note_files(&notes_root, &mut records)?;

        Ok(records)
    }

    fn collect_note_files(
        &self,
        directory: &Path,
        records: &mut Vec<NoteFileRecord>,
    ) -> FrilVaultResult<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                self.collect_note_files(&path, records)?;
                continue;
            }

            if !Self::is_note_file(&path) {
                continue;
            }

            let source_file = self.path_resolver.source_file_from_note_path(&path)?;
            let note_file = self.load_by_note_path(&path)?;

            records.push(NoteFileRecord {
                source_file,
                note_file,
            });
        }

        Ok(())
    }

    fn load_by_note_path(&self, note_path: &Path) -> FrilVaultResult<NoteFile> {
        if !note_path.exists() {
            return Ok(NoteFile::default());
        }

        let content = fs::read_to_string(note_path)?;
        let note_file = self.parser.deserialize(&content)?;

        Ok(note_file)
    }

    fn is_note_file(path: &Path) -> bool {
        path.extension().and_then(|extension| extension.to_str())
            == Some(crate::constants::NOTE_FILE_EXTENSION)
    }

    pub fn resolve_note_path(&self, source_file: impl AsRef<Path>) -> PathBuf {
        self.path_resolver.resolve_note_path(source_file)
    }
}

pub(crate) fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temp_file_name = format!(
        ".{}.tmp.{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("note"),
        uuid::Uuid::new_v4()
    );
    let temp_path = parent.join(temp_file_name);
    fs::write(&temp_path, content)?;
    if let Err(err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    Ok(())
}
