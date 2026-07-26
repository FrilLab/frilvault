use std::{fs, path::Path};

use crate::{
    AddNoteRequest, ExplorerGroup, ExplorerNode, LineAnchor, NoteAnchor, SymbolAnchor, SymbolKind,
    note::NoteRepository,
    runtime::VaultContext,
    tests::helper::{
        create_test_note_service, create_test_workspace, create_test_workspace_service,
    },
    workspace::{PathResolver, WorkspaceIndexRepository, WorkspaceService},
};

#[test]
fn index_returns_file_counts_for_indexed_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 10, column: 5 }),
            content: "index note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let index = workspace_service.index().unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/main.rs");
    assert_eq!(index.files[0].note_count, 1);
    assert!(index.files[0].exists);
}

#[test]
fn warm_up_succeeds_without_notes_folder() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let vault_context = VaultContext::new(
        NoteRepository::new(resolver.clone()),
        WorkspaceIndexRepository::new(resolver.clone()),
    );
    let mut service = WorkspaceService::new(
        vault_context,
        WorkspaceIndexRepository::new(resolver.clone()),
    );

    assert!(!resolver.notes_root().exists());

    let index = service.warm_up().unwrap();

    assert!(index.files.is_empty());
    assert!(resolver.workspace_index_path().exists());

    let loaded = service.index_repository.load().unwrap();
    assert!(loaded.files.is_empty());
}

#[test]
fn warm_up_builds_index_from_note_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor {
                line: 10,
                column: 5,
            }),
            content: "warm up note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    let index = workspace_service.warm_up().unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/main.rs");
    assert_eq!(index.files[0].note_count, 1);
    assert!(index.files[0].exists);
}

#[test]
fn warm_up_uses_persisted_index_without_rescanning() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    let first = workspace_service.warm_up().unwrap();
    assert_eq!(first.files.len(), 1);

    note_service
        .add_note(AddNoteRequest {
            source_file: "src/other.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "second note".to_string(),
            tags: None,
        })
        .unwrap();

    let second = workspace_service.warm_up().unwrap();
    assert_eq!(second.files.len(), 2);
    assert_eq!(second.files[0].source_file, "src/main.rs");
    assert_eq!(second.files[1].source_file, "src/other.rs");
}

#[test]
fn sync_notes_directory_changes_clears_cache_and_rebuilds_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let source_file = Path::new("src/main.rs");
    workspace_service
        .vault_context
        .load_notes(source_file)
        .unwrap();
    assert!(
        workspace_service
            .vault_context
            .contains_cached_notes(source_file)
    );

    note_service
        .add_note(AddNoteRequest {
            source_file: "src/other.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "external note".to_string(),
            tags: None,
        })
        .unwrap();

    workspace_service.sync_notes_directory_changes().unwrap();

    assert!(
        !workspace_service
            .vault_context
            .contains_cached_notes(source_file)
    );

    let index = workspace_service.index_repository.load().unwrap();
    assert_eq!(index.files.len(), 2);
}

#[test]
fn sync_notes_directory_changes_succeeds_without_notes_folder() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let vault_context = VaultContext::new(
        NoteRepository::new(resolver.clone()),
        WorkspaceIndexRepository::new(resolver.clone()),
    );
    let mut service = WorkspaceService::new(
        vault_context,
        WorkspaceIndexRepository::new(resolver.clone()),
    );

    service.warm_up().unwrap();
    assert!(!resolver.notes_root().exists());

    service.sync_notes_directory_changes().unwrap();

    let index = service.index_repository.load().unwrap();
    assert!(index.files.is_empty());
}

#[test]
fn sync_notes_directory_changes_detects_renamed_note_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "move me".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let old_note_path = resolver.note_path_for_source_file("src/main.rs");
    let new_note_path = resolver.note_path_for_source_file("src/main_renamed.rs");
    fs::rename(old_note_path, new_note_path).unwrap();

    workspace_service.sync_notes_directory_changes().unwrap();

    let index = workspace_service.index_repository.load().unwrap();
    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/main_renamed.rs");
}

#[test]
fn sync_source_file_changes_relocates_notes_after_source_rename() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    fs::create_dir_all(workspace_root.join("src/parser")).unwrap();
    fs::create_dir_all(workspace_root.join("src/core")).unwrap();
    fs::write(workspace_root.join("src/parser/lib.rs"), "fn lib() {}").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/parser/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "keep this note".to_string(),
            tags: None,
        })
        .unwrap();

    fs::rename(
        workspace_root.join("src/parser/lib.rs"),
        workspace_root.join("src/core/lib.rs"),
    )
    .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let old_note_path = resolver.note_path_for_source_file("src/parser/lib.rs");
    let new_note_path = resolver.note_path_for_source_file("src/core/lib.rs");

    assert!(old_note_path.exists());
    assert!(!new_note_path.exists());

    let repaired = workspace_service.sync_source_file_changes().unwrap();

    assert_eq!(repaired, 1);
    assert!(!old_note_path.exists());
    assert!(new_note_path.exists());

    let index = workspace_service.index_repository.load().unwrap();
    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/core/lib.rs");
    assert!(index.files[0].exists);
}

#[test]
fn repair_suggests_content_match_when_source_file_is_renamed() {
    use crate::{SymbolAnchor, SymbolKind};

    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src/parser")).unwrap();
    fs::write(
        workspace_root.join("src/parser/service.rs"),
        "pub struct UserService;\n",
    )
    .unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/parser/service.rs".into(),
            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "UserService".to_string(),
                kind: SymbolKind::Struct,
                signature: Some("pub struct UserService".to_string()),
                line_hint: None,
            }),
            content: "track service".to_string(),
            tags: None,
        })
        .unwrap();

    fs::create_dir_all(workspace_root.join("src/core")).unwrap();
    fs::rename(
        workspace_root.join("src/parser/service.rs"),
        workspace_root.join("src/core/user_service.rs"),
    )
    .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let suggestions = workspace_service.repair_suggestions().unwrap();

    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].missing_file, "src/parser/service.rs");
    assert_eq!(suggestions[0].candidates, vec!["src/core/user_service.rs"]);
}

#[test]
fn explorer_builds_directory_file_and_note_groups() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();
    fs::write(workspace_root.join("src/lib.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "line note".to_string(),
            tags: None,
        })
        .unwrap();
    note_service
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
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 3, column: 1 }),
            content: "lib note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let explorer = workspace_service.explorer().unwrap();

    let ExplorerNode::Directory { children, .. } = &explorer.root else {
        panic!("expected root directory");
    };

    let src_dir = children
        .iter()
        .find(|node| matches!(node, ExplorerNode::Directory { name, .. } if name == "src"))
        .expect("expected src directory");

    let ExplorerNode::Directory { children, .. } = src_dir else {
        panic!("expected src directory node");
    };

    assert_eq!(children.len(), 2);

    let main_file = children
        .iter()
        .find(|node| {
            matches!(
                node,
                ExplorerNode::File { source_file, .. } if source_file == "src/main.rs"
            )
        })
        .expect("expected src/main.rs file node");

    let ExplorerNode::File { groups, exists, .. } = main_file else {
        panic!("expected file node");
    };

    assert!(*exists);
    assert_eq!(groups.len(), 2);
    assert!(matches!(groups[0], ExplorerGroup::LineNotes { .. }));
    assert!(matches!(groups[1], ExplorerGroup::SymbolNotes { .. }));

    match &groups[0] {
        ExplorerGroup::LineNotes { notes } => {
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].content, "line note");
        }
        _ => panic!("expected line notes group"),
    }

    match &groups[1] {
        ExplorerGroup::SymbolNotes { notes } => {
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].content, "symbol note");
        }
        _ => panic!("expected symbol notes group"),
    }
}

#[test]
fn sync_external_changes_refreshes_cache_and_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut note_service = create_test_note_service(workspace_root);
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "cached note".to_string(),
            tags: None,
        })
        .unwrap();

    let mut workspace_service = create_test_workspace_service(workspace_root);
    workspace_service.warm_up().unwrap();

    let source_file = Path::new("src/main.rs");
    workspace_service
        .vault_context
        .load_notes(source_file)
        .unwrap();
    assert!(
        workspace_service
            .vault_context
            .contains_cached_notes(source_file)
    );

    note_service
        .add_note(AddNoteRequest {
            source_file: "src/other.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "external note".to_string(),
            tags: None,
        })
        .unwrap();

    let result = workspace_service
        .sync_external_changes(true, false)
        .unwrap();

    assert!(result.notes_synced);
    assert_eq!(result.repairs_applied, 0);
    assert!(
        !workspace_service
            .vault_context
            .contains_cached_notes(source_file)
    );

    let index = workspace_service.index_repository.load().unwrap();
    assert_eq!(index.files.len(), 2);
}
