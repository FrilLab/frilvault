use std::fs;

use super::helper::{
    create_test_note_service, create_test_workspace, create_test_workspace_service,
};
use crate::{
    AddNoteRequest, LineAnchor, NoteAnchor, SymbolAnchor, SymbolKind,
    tests::helper::{create_test_index_repository, create_test_vault_context},
    workspace::{IndexDiff, IndexedFile, PathResolver, WorkspaceIndex, WorkspaceIndexRepository},
};

#[test]
fn load_returns_default_index_when_missing() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let repository = WorkspaceIndexRepository::new(resolver);

    let index = repository.load().unwrap();

    assert!(index.files.is_empty());
}

#[test]
fn save_and_load_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let repository = WorkspaceIndexRepository::new(resolver);

    let mut index = WorkspaceIndex::default();

    index.files.push(IndexedFile {
        source_file: "src/main.rs".to_string(),
        note_count: 3,
        exists: true,
    });

    repository.save(&index).unwrap();

    let loaded = repository.load().unwrap();

    assert_eq!(loaded.files.len(), 1,);

    assert_eq!(loaded.files[0].note_count, 3,);
}

#[test]
fn create_if_missing_creates_index_directory() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let repository = WorkspaceIndexRepository::new(resolver.clone());

    repository.create_if_missing().unwrap();

    assert!(resolver.workspace_index_path().parent().unwrap().exists());
    assert!(!resolver.workspace_index_path().exists());
}

#[test]
fn load_or_rebuild_scans_without_writing_a_missing_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let vault_context = create_test_vault_context(workspace_root);
    vault_context
        .note_repository
        .append_note(
            std::path::Path::new("src/main.rs"),
            &crate::Note::new(AddNoteRequest {
                source_file: "src/main.rs".into(),
                anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
                content: "indexed note".to_string(),
                tags: None,
            }),
        )
        .unwrap();

    let resolver = PathResolver::new(workspace_root);
    let repository = WorkspaceIndexRepository::new(resolver.clone());

    assert!(!resolver.workspace_index_path().exists());

    let index = repository.load_or_rebuild().unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/main.rs");
    assert!(!resolver.workspace_index_path().exists());

    repository.rebuild().unwrap();
    assert!(resolver.workspace_index_path().exists());
}

#[test]
fn load_or_rebuild_loads_existing_index_without_scanning() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let repository = WorkspaceIndexRepository::new(resolver.clone());

    let mut index = WorkspaceIndex::default();
    index.files.push(IndexedFile {
        source_file: "src/main.rs".to_string(),
        note_count: 1,
        exists: true,
    });
    repository.save(&index).unwrap();

    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/other.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/other.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "unindexed note".to_string(),
            tags: None,
        })
        .unwrap();

    let loaded = repository.load_or_rebuild().unwrap();

    assert_eq!(loaded.files.len(), 2);
    assert_eq!(loaded.files[0].source_file, "src/main.rs");
    assert_eq!(loaded.files[1].source_file, "src/other.rs");
}

#[test]
fn rebuild_creates_index_from_note_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();
    fs::write(workspace_root.join("src/lib.rs"), "").unwrap();

    let resolver = PathResolver::new(workspace_root);

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor {
                line: 10,
                column: 5,
            }),
            content: "main note".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 3, column: 1 }),
            content: "lib note".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 7, column: 2 }),
            content: "second lib note".to_string(),
            tags: None,
        })
        .unwrap();

    let index_repository = WorkspaceIndexRepository::new(resolver);

    let index = index_repository.rebuild().unwrap();

    assert_eq!(index.files.len(), 2);

    assert!(
        index
            .files
            .iter()
            .any(|file| file.source_file == "src/main.rs" && file.note_count == 1)
    );

    assert!(
        index
            .files
            .iter()
            .any(|file| file.source_file == "src/lib.rs" && file.note_count == 2)
    );

    assert!(index.files.iter().all(|file| file.exists));
}

#[test]
fn rebuild_marks_missing_files_as_not_existing() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/missing.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "orphan".to_string(),
            tags: None,
        })
        .unwrap();

    let index_repository = WorkspaceIndexRepository::new(resolver);

    let index = index_repository.rebuild().unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/missing.rs");
    assert!(!index.files[0].exists);
}

#[test]
fn health_check_detects_missing_files_from_note_repository() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/missing.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),

            content: "orphan".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);

    let health = workspace_service.health_check().unwrap();

    assert_eq!(health.missing_source_files.len(), 1,);

    assert_eq!(health.missing_source_files[0], "src/missing.rs",);
}

#[test]
fn health_check_refreshes_exists_flags_from_loaded_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let resolver = PathResolver::new(workspace_root);
    let index_repository = WorkspaceIndexRepository::new(resolver.clone());
    index_repository
        .save(&WorkspaceIndex {
            version: 1,
            files: vec![IndexedFile {
                source_file: "src/main.rs".to_string(),
                note_count: 1,
                exists: false,
            }],
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    let health = workspace_service.health_check().unwrap();

    assert!(health.missing_source_files.is_empty());
}

#[test]
fn stats_counts_line_and_symbol_notes() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let mut workspace_service = create_test_workspace_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),

            content: "line note".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),

            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "main".to_string(),

                kind: SymbolKind::Function,

                signature: None,

                line_hint: None,
            }),

            content: "symbol note".to_string(),
            tags: None,
        })
        .unwrap();

    let stats = workspace_service.stats().unwrap();

    assert_eq!(stats.file_count, 1);

    assert_eq!(stats.existing_files, 0);

    assert_eq!(stats.missing_files, 1);

    assert_eq!(stats.total_notes, 2);

    assert_eq!(stats.line_notes, 1);

    assert_eq!(stats.symbol_notes, 1);
}

#[test]
fn repair_suggests_matching_file_names() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src/core")).unwrap();
    fs::write(workspace_root.join("src/core/lib.rs"), "").unwrap();

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/parser/lib.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),

            content: "orphan".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);

    let suggestions = workspace_service.repair_suggestions().unwrap();

    assert_eq!(suggestions.len(), 1,);

    assert_eq!(suggestions[0].candidates.len(), 1,);

    assert_eq!(suggestions[0].candidates[0], "src/core/lib.rs",);
}

#[test]
fn apply_repairs_moves_note_file() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src/core")).unwrap();
    fs::write(workspace_root.join("src/core/lib.rs"), "").unwrap();

    let resolver = PathResolver::new(workspace_root);

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/parser/lib.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),

            content: "repair me".to_string(),
            tags: None,
        })
        .unwrap();

    let old_note_path = resolver.resolve_note_path("src/parser/lib.rs");

    assert!(old_note_path.exists());

    let mut workspace_service = create_test_workspace_service(workspace_root);

    let repaired = workspace_service.apply_repairs().unwrap();

    assert_eq!(repaired, 1,);

    let new_note_path = resolver.resolve_note_path("src/core/lib.rs");

    assert!(new_note_path.exists());

    assert!(!old_note_path.exists());

    let index = workspace_service.index_repository.load().unwrap();
    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/core/lib.rs");
    assert!(index.files[0].exists);
}

#[test]
fn detects_renamed_file_by_name_similarity() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let old = WorkspaceIndex {
        version: 1,
        files: vec![IndexedFile {
            source_file: "src/parser.rs".to_string(),
            note_count: 1,
            exists: true,
        }],
    };

    let new = WorkspaceIndex {
        version: 1,
        files: vec![IndexedFile {
            source_file: "src/core/parser.rs".to_string(),
            note_count: 1,
            exists: true,
        }],
    };

    let repo = create_test_index_repository(workspace_root);

    let moves = repo.detect_moves(&old, &new);

    assert_eq!(moves.len(), 1);
    assert!(moves[0].confidence > 0.5);
}

#[test]
fn detects_removed_and_added_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let old = WorkspaceIndex {
        version: 1,
        files: vec![IndexedFile {
            source_file: "a.rs".to_string(),
            note_count: 1,
            exists: true,
        }],
    };

    let new = WorkspaceIndex {
        version: 1,
        files: vec![IndexedFile {
            source_file: "b.rs".to_string(),
            note_count: 1,
            exists: true,
        }],
    };

    let repo = create_test_index_repository(workspace_root);

    let moves = repo.detect_moves(&old, &new);

    assert!(moves.is_empty());
}

#[test]
fn detects_strong_rename_by_name_and_path() {
    let old = "src/parser.rs";
    let new = "src/parser.rs";

    let score = IndexDiff::similarity_score(old, new);

    assert!(score >= 1.0);
}

#[test]
fn rejects_unrelated_files() {
    let old = "src/parser.rs";
    let new = "src/ui/button.rs";

    let score = IndexDiff::similarity_score(old, new);

    assert!(score < 1.0);
}
