use std::{fs, path::Path};

use super::helper::{create_test_note_service, create_test_workspace};
use crate::{
    AddNoteRequest, FrilVaultError, FrilVaultResult, LineAnchor, NoteAnchor, TagOperationRollback,
    UpdateNoteRequest, normalize_tag, normalize_tags, note::NoteService, workspace::PathResolver,
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

#[test]
fn tag_statistics_orders_tags_by_usage_and_counts_each_tag_once_per_note() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/core/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note 1".into(),
            tags: Some(vec![
                "architecture".into(),
                "ARCHITECTURE".into(),
                "todo".into(),
            ]),
        })
        .unwrap();
    service
        .add_note(AddNoteRequest {
            source_file: "src/parser/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "note 2".into(),
            tags: Some(vec!["Architecture".into()]),
        })
        .unwrap();

    let statistics = service.tag_statistics(None, None).unwrap();

    assert_eq!(statistics.len(), 2);
    assert_eq!(statistics[0].tag.to_lowercase(), "architecture");
    assert_eq!(statistics[0].note_count, 2);
    assert!(statistics[0].breakdown.is_empty());
    assert_eq!(statistics[1].tag, "todo");
    assert_eq!(statistics[1].note_count, 1);
}

#[test]
fn tag_statistics_filters_and_groups_by_file_or_directory() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    for (source_file, line) in [
        ("src/core/a.rs", 1),
        ("src/core/b.rs", 2),
        ("src/parser/c.rs", 3),
    ] {
        service
            .add_note(AddNoteRequest {
                source_file: source_file.into(),
                anchor: NoteAnchor::Line(LineAnchor { line, column: 1 }),
                content: "architecture note".into(),
                tags: Some(vec!["architecture".into()]),
            })
            .unwrap();
    }

    let by_directory = service
        .tag_statistics(Some("ARCHITECTURE"), Some(crate::TagGroupBy::Directory))
        .unwrap();
    assert_eq!(by_directory.len(), 1);
    assert_eq!(by_directory[0].note_count, 3);
    assert_eq!(
        by_directory[0].breakdown,
        vec![
            crate::TagBreakdown {
                path: "src/core".into(),
                note_count: 2,
            },
            crate::TagBreakdown {
                path: "src/parser".into(),
                note_count: 1,
            },
        ]
    );

    let by_file = service
        .tag_statistics(Some("architecture"), Some(crate::TagGroupBy::File))
        .unwrap();
    assert_eq!(by_file[0].breakdown.len(), 3);
    assert_eq!(
        by_file[0].breakdown[0].path,
        std::path::PathBuf::from("src/core/a.rs")
    );
}

#[test]
fn tag_statistics_recomputes_after_note_changes() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note".into(),
            tags: Some(vec!["todo".into()]),
        })
        .unwrap();
    assert_eq!(
        service.tag_statistics(Some("todo"), None).unwrap()[0].note_count,
        1
    );

    service
        .update_note(
            "src/main.rs",
            note.id,
            UpdateNoteRequest {
                content: "updated".into(),
                tags: Some(vec!["architecture".into()]),
                expected_updated_at: None,
            },
        )
        .unwrap();

    assert!(
        service
            .tag_statistics(Some("todo"), None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service.tag_statistics(Some("architecture"), None).unwrap()[0].note_count,
        1
    );
}

fn create_transaction_fixture() -> (super::helper::TestWorkspace, NoteService) {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/a.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note a".into(),
            tags: Some(vec!["bug".into(), "issue".into()]),
        })
        .unwrap();
    service
        .add_note(AddNoteRequest {
            source_file: "src/b.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note b".into(),
            tags: Some(vec!["bug".into(), "defect".into()]),
        })
        .unwrap();

    (workspace, service)
}

fn assert_tag_operation_rolls_back<F, G>(configure_failure: F, operation: G)
where
    F: FnOnce(&NoteService),
    G: FnOnce(&mut NoteService) -> FrilVaultResult<crate::TagOperationResult>,
{
    let (workspace, mut service) = create_transaction_fixture();
    let resolver = PathResolver::new(workspace.root());
    let note_a_path = resolver.resolve_note_path("src/a.rs");
    let note_b_path = resolver.resolve_note_path("src/b.rs");
    let index_path = resolver.workspace_index_path();
    let note_a_before = fs::read(&note_a_path).unwrap();
    let note_b_before = fs::read(&note_b_path).unwrap();
    let index_before = fs::read(&index_path).unwrap();
    let note_a_modified_before = fs::metadata(&note_a_path).unwrap().modified().unwrap();
    let note_b_modified_before = fs::metadata(&note_b_path).unwrap().modified().unwrap();
    let index_modified_before = fs::metadata(&index_path).unwrap().modified().unwrap();

    service.preload_notes("src/a.rs").unwrap();
    assert!(service.contains_cached_notes(Path::new("src/a.rs")));
    assert!(!service.contains_cached_notes(Path::new("src/b.rs")));
    configure_failure(&service);

    let error = operation(&mut service).unwrap_err();
    assert!(matches!(
        &error,
        FrilVaultError::TagOperationFailed {
            rollback: TagOperationRollback::Succeeded,
            ..
        }
    ));
    assert!(error.to_string().contains("rollback succeeded"));

    assert_eq!(fs::read(&note_a_path).unwrap(), note_a_before);
    assert_eq!(fs::read(&note_b_path).unwrap(), note_b_before);
    assert_eq!(fs::read(&index_path).unwrap(), index_before);
    assert_eq!(
        fs::metadata(&note_a_path).unwrap().modified().unwrap(),
        note_a_modified_before
    );
    assert_eq!(
        fs::metadata(&note_b_path).unwrap().modified().unwrap(),
        note_b_modified_before
    );
    assert_eq!(
        fs::metadata(&index_path).unwrap().modified().unwrap(),
        index_modified_before
    );
    assert!(service.contains_cached_notes(Path::new("src/a.rs")));
    assert!(!service.contains_cached_notes(Path::new("src/b.rs")));
    assert_eq!(
        service.list_notes("src/a.rs").unwrap()[0].note.tags,
        vec!["bug", "issue"]
    );
}

#[test]
fn successful_tag_operation_invalidates_all_updated_note_cache_entries() {
    let (_workspace, mut service) = create_transaction_fixture();

    service.preload_notes("src/a.rs").unwrap();
    service.preload_notes("src/b.rs").unwrap();
    assert!(service.contains_cached_notes(Path::new("src/a.rs")));
    assert!(service.contains_cached_notes(Path::new("src/b.rs")));

    service.rename_tag("bug", "fixed").unwrap();

    assert!(!service.contains_cached_notes(Path::new("src/a.rs")));
    assert!(!service.contains_cached_notes(Path::new("src/b.rs")));
}

#[test]
fn rename_tag_rolls_back_everything_when_a_later_note_write_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_note_writes_after(1),
        |service| service.rename_tag("bug", "fixed"),
    );
}

#[test]
fn merge_tags_rolls_back_everything_when_a_later_note_write_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_note_writes_after(1),
        |service| service.merge_tags(&["bug".into(), "defect".into()], "issue"),
    );
}

#[test]
fn remove_tag_rolls_back_everything_when_a_later_note_write_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_note_writes_after(1),
        |service| service.remove_tag("bug"),
    );
}

#[test]
fn rename_tag_rolls_back_everything_when_index_sync_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_index_writes_after(0),
        |service| service.rename_tag("bug", "fixed"),
    );
}

#[test]
fn merge_tags_rolls_back_everything_when_index_sync_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_index_writes_after(0),
        |service| service.merge_tags(&["bug".into(), "defect".into()], "issue"),
    );
}

#[test]
fn remove_tag_rolls_back_everything_when_index_sync_fails() {
    assert_tag_operation_rolls_back(
        |service| service.fail_index_writes_after(0),
        |service| service.remove_tag("bug"),
    );
}
