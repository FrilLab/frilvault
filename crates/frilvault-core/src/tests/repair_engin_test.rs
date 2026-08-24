use std::path::Path;

use crate::{
    AddNoteRequest, LineAnchor, Note, NoteAnchor,
    tests::helper::{create_test_vault_context, create_test_workspace},
    workspace::{FileMove, PathResolver, RepairEngine},
};

#[test]
fn repair_engine_moves_note_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let mut vault_context = create_test_vault_context(workspace_root);

    vault_context
        .note_repository
        .append_note(
            Path::new("src/main.rs"),
            &Note::new(AddNoteRequest {
                source_file: "src/main.rs".into(),
                anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
                content: "test note".to_string(),
                tags: None,
            }),
        )
        .unwrap();

    let moves = vec![FileMove {
        from: "src/main.rs".to_string(),
        to: "src/main_renamed.rs".to_string(),
        confidence: 1.0,
    }];

    let repaired = RepairEngine::apply_moves(&mut vault_context, moves).unwrap();

    assert_eq!(repaired, 1);

    let old_path = resolver.note_path_for_source_file("src/main.rs");
    let new_path = resolver.note_path_for_source_file("src/main_renamed.rs");

    assert!(!old_path.exists());
    assert!(new_path.exists());
}

#[test]
fn repair_engine_invalidates_cache_correctly() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut vault_context = create_test_vault_context(workspace_root);

    let _ = vault_context.load_notes("src/main.rs".as_ref());

    assert!(vault_context.contains_cached_notes(Path::new("src/main.rs")));

    let moves = vec![FileMove {
        from: "src/main.rs".to_string(),
        to: "src/main_renamed.rs".to_string(),
        confidence: 1.0,
    }];

    RepairEngine::apply_moves(&mut vault_context, moves).unwrap();

    assert!(!vault_context.contains_cached_notes(Path::new("src/main.rs")));
    assert!(vault_context.contains_cached_notes(Path::new("src/main_renamed.rs")));
}

#[test]
fn repair_engine_applies_high_confidence_moves_when_threshold_allows() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let mut vault_context = create_test_vault_context(workspace_root);

    vault_context
        .note_repository
        .append_note(
            Path::new("src/parser/lib.rs"),
            &Note::new(AddNoteRequest {
                source_file: "src/parser/lib.rs".into(),
                anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
                content: "test note".to_string(),
                tags: None,
            }),
        )
        .unwrap();

    let moves = vec![FileMove {
        from: "src/parser/lib.rs".to_string(),
        to: "src/core/lib.rs".to_string(),
        confidence: 0.8,
    }];

    let repaired =
        RepairEngine::apply_moves_with_min_confidence(&mut vault_context, moves, 0.7).unwrap();

    assert_eq!(repaired.len(), 1);

    let old_path = resolver.note_path_for_source_file("src/parser/lib.rs");
    let new_path = resolver.note_path_for_source_file("src/core/lib.rs");

    assert!(!old_path.exists());
    assert!(new_path.exists());
}

#[test]
fn repair_engine_preserves_notes_already_stored_at_the_destination() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut vault_context = create_test_vault_context(workspace_root);
    for (source_file, content) in [
        ("src/old.rs", "moved note"),
        ("src/new.rs", "existing destination note"),
    ] {
        vault_context
            .note_repository
            .append_note(
                Path::new(source_file),
                &Note::new(AddNoteRequest {
                    source_file: source_file.into(),
                    anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
                    content: content.to_string(),
                    tags: None,
                }),
            )
            .unwrap();
    }
    let moves = vec![FileMove {
        from: "src/old.rs".to_string(),
        to: "src/new.rs".to_string(),
        confidence: 1.0,
    }];

    RepairEngine::apply_moves(&mut vault_context, moves).unwrap();

    let repaired = vault_context.load_notes(Path::new("src/new.rs")).unwrap();
    let mut contents = repaired
        .notes
        .into_iter()
        .map(|note| note.content)
        .collect::<Vec<_>>();
    contents.sort();
    assert_eq!(contents, ["existing destination note", "moved note"]);
    assert!(!vault_context.resolve_note_path("src/old.rs").exists());
}

#[test]
fn repair_engine_rejects_a_source_path_outside_the_workspace() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let escaped_path = workspace_root.join("escaped.rs.json");
    std::fs::write(&escaped_path, "outside data").unwrap();
    let mut vault_context = create_test_vault_context(workspace_root);
    let moves = vec![FileMove {
        from: "../../escaped.rs".to_string(),
        to: "src/safe.rs".to_string(),
        confidence: 1.0,
    }];

    let result = RepairEngine::apply_moves(&mut vault_context, moves);

    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(escaped_path).unwrap(),
        "outside data"
    );
}

#[test]
fn repair_engine_rejects_a_destination_path_outside_the_workspace() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);
    let mut vault_context = create_test_vault_context(workspace_root);
    vault_context
        .note_repository
        .append_note(
            Path::new("src/main.rs"),
            &Note::new(AddNoteRequest {
                source_file: "src/main.rs".into(),
                anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
                content: "must stay put".to_string(),
                tags: None,
            }),
        )
        .unwrap();
    let original_path = resolver.note_path_for_source_file("src/main.rs");
    let escaped_path = workspace_root.join("escaped.rs.json");
    let moves = vec![FileMove {
        from: "src/main.rs".to_string(),
        to: "../../escaped.rs".to_string(),
        confidence: 1.0,
    }];

    let result = RepairEngine::apply_moves(&mut vault_context, moves);

    assert!(result.is_err());
    assert!(original_path.exists());
    assert!(!escaped_path.exists());
}
