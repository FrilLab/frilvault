use super::helper::{create_test_note_service, create_test_workspace};
use crate::{
    AddNoteRequest, FrilVaultError, LineAnchor, NoteAnchor, UpdateNoteRequest, normalize_tag,
    normalize_tags,
};

#[test]
fn tag_normalization_removes_hash_and_case_insensitive_duplicates() {
    assert_eq!(normalize_tag("  #Performance  "), "Performance");
    assert_eq!(normalize_tag("#  "), "");
    assert_eq!(
        normalize_tags(vec![
            " #Performance ".into(),
            "performance".into(),
            "#permission".into(),
            "  ".into(),
        ]),
        vec!["Performance", "permission"]
    );
}

#[test]
fn create_and_update_normalize_tags_at_the_core_boundary() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note".into(),
            tags: Some(vec![" #Bug ".into(), "bug".into(), "#Docs".into()]),
        })
        .unwrap();

    assert_eq!(note.tags, vec!["Bug", "Docs"]);

    let updated = service
        .update_note(
            "src/main.rs",
            note.id,
            UpdateNoteRequest {
                content: "updated".into(),
                tags: Some(vec!["#PERFORMANCE".into(), " performance ".into()]),
                expected_updated_at: None,
            },
        )
        .unwrap();

    assert_eq!(updated.tags, vec!["PERFORMANCE"]);
}

#[test]
fn rename_tag_replaces_tag_across_multiple_files_and_notes() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["performance".into(), "backend".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "note 2".into(),
            tags: Some(vec!["PERFORMANCE".into(), "frontend".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor {
                line: 10,
                column: 1,
            }),
            content: "note 3".into(),
            tags: Some(vec!["unrelated".into()]),
        })
        .unwrap();

    let result = service.rename_tag("performance", "optimization").unwrap();

    assert_eq!(result.affected_notes, 2);
    assert_eq!(result.affected_files, 2);

    let notes_a = service.list_notes("src/a.rs").unwrap();
    assert_eq!(notes_a[0].note.tags, vec!["optimization", "backend"]);

    let notes_b = service.list_notes("src/b.rs").unwrap();
    assert_eq!(notes_b[0].note.tags, vec!["optimization", "frontend"]);
    assert_eq!(notes_b[1].note.tags, vec!["unrelated"]);
}

#[test]
fn rename_tag_eliminates_duplicates_when_target_tag_already_present() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["todo".into(), "task".into()]),
        })
        .unwrap();

    let result = service.rename_tag("todo", "task").unwrap();
    assert_eq!(result.affected_notes, 1);
    assert_eq!(result.affected_files, 1);

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["task"]);
}

#[test]
fn rename_tag_case_renaming() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["todo".into()]),
        })
        .unwrap();

    let result = service.rename_tag("todo", "TODO").unwrap();
    assert_eq!(result.affected_notes, 1);

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["TODO"]);
}

#[test]
fn rename_tag_returns_zero_when_no_notes_match() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["other".into()]),
        })
        .unwrap();

    let result = service.rename_tag("nonexistent", "target").unwrap();
    assert_eq!(result.affected_notes, 0);
    assert_eq!(result.affected_files, 0);
}

#[test]
fn rename_tag_rejects_empty_tags() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    assert!(matches!(
        service.rename_tag("", "target"),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.rename_tag("   ", "target"),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.rename_tag("source", ""),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.rename_tag("source", "  "),
        Err(FrilVaultError::InvalidTag(_))
    ));
}

#[test]
fn preview_rename_tag_does_not_modify_disk() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["todo".into()]),
        })
        .unwrap();

    let preview = service.preview_rename_tag("todo", "task").unwrap();
    assert_eq!(preview.affected_notes, 1);
    assert_eq!(preview.affected_files, 1);

    // Verify disk content unchanged
    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["todo"]);
}

#[test]
fn merge_tags_combines_multiple_source_tags_and_eliminates_duplicates() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["bug".into(), "p1".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "note 2".into(),
            tags: Some(vec!["defect".into(), "p2".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 5, column: 1 }),
            content: "note 3".into(),
            tags: Some(vec!["BUG".into(), "Defect".into(), "feature".into()]),
        })
        .unwrap();

    let sources = vec!["bug".to_string(), "defect".to_string()];
    let result = service.merge_tags(&sources, "issue").unwrap();

    assert_eq!(result.affected_notes, 3);
    assert_eq!(result.affected_files, 2);

    let notes_a = service.list_notes("src/a.rs").unwrap();
    assert_eq!(notes_a[0].note.tags, vec!["issue", "p1"]);

    let notes_b = service.list_notes("src/b.rs").unwrap();
    assert_eq!(notes_b[0].note.tags, vec!["issue", "p2"]);
    assert_eq!(notes_b[1].note.tags, vec!["issue", "feature"]);
}

#[test]
fn merge_tags_with_target_tag_already_present() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["bug".into(), "issue".into()]),
        })
        .unwrap();

    let sources = vec!["bug".to_string()];
    let result = service.merge_tags(&sources, "issue").unwrap();

    assert_eq!(result.affected_notes, 1);

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["issue"]);
}

#[test]
fn merge_tags_rejects_empty_sources_or_target() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    assert!(matches!(
        service.merge_tags(&[], "target"),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.merge_tags(&["src".into()], ""),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.merge_tags(&["  ".into()], "target"),
        Err(FrilVaultError::InvalidTag(_))
    ));
}

#[test]
fn preview_merge_tags_does_not_modify_disk() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["bug".into(), "defect".into()]),
        })
        .unwrap();

    let sources = vec!["bug".to_string(), "defect".to_string()];
    let preview = service.preview_merge_tags(&sources, "issue").unwrap();
    assert_eq!(preview.affected_notes, 1);
    assert_eq!(preview.affected_files, 1);

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["bug", "defect"]);
}

#[test]
fn remove_tag_removes_tag_from_all_matching_notes() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["legacy".into(), "v1".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 2".into(),
            tags: Some(vec!["LEGACY".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 5, column: 1 }),
            content: "note 3".into(),
            tags: Some(vec!["v2".into()]),
        })
        .unwrap();

    let result = service.remove_tag("legacy").unwrap();
    assert_eq!(result.affected_notes, 2);
    assert_eq!(result.affected_files, 2);

    let notes_a = service.list_notes("src/a.rs").unwrap();
    assert_eq!(notes_a[0].note.tags, vec!["v1"]);

    let notes_b = service.list_notes("src/b.rs").unwrap();
    assert!(notes_b[0].note.tags.is_empty());
    assert_eq!(notes_b[1].note.tags, vec!["v2"]);
}

#[test]
fn remove_tag_rejects_empty_tag() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    assert!(matches!(
        service.remove_tag(""),
        Err(FrilVaultError::InvalidTag(_))
    ));
    assert!(matches!(
        service.remove_tag("   "),
        Err(FrilVaultError::InvalidTag(_))
    ));
}

#[test]
fn preview_remove_tag_does_not_modify_disk() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["legacy".into()]),
        })
        .unwrap();

    let preview = service.preview_remove_tag("legacy").unwrap();
    assert_eq!(preview.affected_notes, 1);
    assert_eq!(preview.affected_files, 1);

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["legacy"]);
}

#[test]
fn list_tags_aggregates_and_counts_tags() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec!["bug".into(), "todo".into()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "note 2".into(),
            tags: Some(vec!["BUG".into(), "feature".into()]),
        })
        .unwrap();

    let tags = service.list_tags().unwrap();
    assert_eq!(tags.len(), 3);
    assert_eq!(tags[0].tag.to_lowercase(), "bug");
    assert_eq!(tags[0].note_count, 2);
    assert_eq!(tags[1].tag, "feature");
    assert_eq!(tags[1].note_count, 1);
    assert_eq!(tags[2].tag, "todo");
    assert_eq!(tags[2].note_count, 1);

    let unused = service.list_unused_tags().unwrap();
    assert!(unused.is_empty());
}
