use super::helper::{create_test_note_service, create_test_workspace};
use crate::{
    AddNoteRequest, FrilVaultError, LineAnchor, NoteAnchor, NoteQuery, SymbolAnchor, SymbolKind,
    UpdateNoteRequest,
    constants::NOTE_FILE_EXTENSION,
    workspace::{PathResolver, WorkspaceIndexRepository},
};

use std::{fs, path::PathBuf};

#[test]
fn add_line_type_note_creates_json_file() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let input = AddNoteRequest {
        source_file: "src/main.rs".into(),
        anchor: crate::note::NoteAnchor::Line(crate::note::LineAnchor {
            line: 10,
            column: 5,
        }),
        content: "여기서 스캔이 시작된다.".to_string(),
        tags: None,
    };

    service.add_note(input).unwrap();

    let note_path = workspace_root
        .join(".vault")
        .join("notes")
        .join(format!("src/main.rs.{}", NOTE_FILE_EXTENSION));

    assert!(note_path.exists());

    let content = fs::read_to_string(note_path).unwrap();

    assert!(content.contains("여기서 스캔이 시작된다."));
}

#[test]
fn add_note_rejects_zero_based_anchor_coordinates() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    for anchor in [
        NoteAnchor::Line(LineAnchor { line: 0, column: 1 }),
        NoteAnchor::Line(LineAnchor { line: 1, column: 0 }),
        NoteAnchor::Symbol(SymbolAnchor {
            name: "main".to_string(),
            kind: SymbolKind::Function,
            signature: None,
            line_hint: Some(0),
        }),
        NoteAnchor::Symbol(SymbolAnchor {
            name: "   ".to_string(),
            kind: SymbolKind::Unknown,
            signature: None,
            line_hint: None,
        }),
    ] {
        let result = service.add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor,
            content: "invalid anchor".to_string(),
            tags: None,
        });
        assert!(result.is_err());
    }

    assert!(
        !workspace_root
            .join(format!(".vault/notes/src/main.rs.{NOTE_FILE_EXTENSION}"))
            .exists()
    );
}

#[test]
fn add_symbol_type_note_creates_json_file() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let input = AddNoteRequest {
        source_file: "src/main.rs".into(),
        anchor: crate::note::NoteAnchor::Symbol(crate::note::SymbolAnchor {
            name: "NoteService::add_note".to_string(),
            kind: SymbolKind::Method,
            signature: Some(
                "fn add_note(&self, input: AddNoteRequest) -> FrilVaultResult<Note>".to_owned(),
            ),
            line_hint: Some(34),
        }),
        content: "symbol anchor test".to_string(),
        tags: None,
    };

    service.add_note(input).unwrap();

    let note_path = workspace_root
        .join(".vault")
        .join("notes")
        .join(format!("src/main.rs.{}", NOTE_FILE_EXTENSION));

    assert!(note_path.exists());

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].note.content, "symbol anchor test");
    match &notes[0].note.anchor {
        NoteAnchor::Symbol(anchor) => {
            assert_eq!(anchor.name, "NoteService::add_note");
            assert_eq!(anchor.kind, SymbolKind::Method);
            assert_eq!(
                anchor.signature.as_deref(),
                Some("fn add_note(&self, input: AddNoteRequest) -> FrilVaultResult<Note>")
            );
            assert_eq!(anchor.line_hint, Some(34));
        }
        _ => panic!("Expected SymbolAnchor"),
    }
}

#[test]
fn load_notes_from_existing_json() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: crate::note::NoteAnchor::Line(crate::note::LineAnchor { line: 1, column: 1 }),
            content: "lib 진입점".to_string(),
            tags: None,
        })
        .unwrap();

    let notes = service.list_notes("src/lib.rs").unwrap();

    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].note.content, "lib 진입점");
}

#[test]
fn add_note_and_load_note() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: crate::note::NoteAnchor::Line(crate::note::LineAnchor {
                line: 10,
                column: 5,
            }),
            content: "여기서 스캔 시작".to_string(),
            tags: None,
        })
        .unwrap();

    let notes = service.list_notes("src/main.rs").unwrap();

    assert_eq!(notes.len(), 1);

    assert_eq!(notes[0].note.content, "여기서 스캔 시작");

    match &notes[0].note.anchor {
        crate::note::NoteAnchor::Line(anchor) => {
            assert_eq!(anchor.line, 10);
            assert_eq!(anchor.column, 5);
        }
        _ => panic!("Expected LineAnchor"),
    }
}

#[test]
fn add_note_accepts_absolute_workspace_path_without_writing_a_sidecar() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let source_file = workspace_root.join("src/main.rs");
    fs::create_dir_all(source_file.parent().unwrap()).unwrap();
    fs::write(&source_file, "fn main() {}\n").unwrap();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: source_file.clone(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "absolute workspace path".to_string(),
            tags: None,
        })
        .unwrap();

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].note.content, "absolute workspace path");
    assert!(!workspace_root.join("src/main.rs.json").exists());
}

#[cfg(unix)]
#[test]
fn add_note_accepts_an_absolute_path_through_a_workspace_symlink() {
    use std::os::unix::fs::symlink;

    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let source_file = workspace_root.join("src/main.rs");
    fs::create_dir_all(source_file.parent().unwrap()).unwrap();
    fs::write(&source_file, "fn main() {}\n").unwrap();
    let alias = workspace_root.with_extension("alias");
    symlink(workspace_root, &alias).unwrap();
    let mut service = create_test_note_service(workspace_root);

    let result = service.add_note(AddNoteRequest {
        source_file: alias.join("src/main.rs"),
        anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
        content: "same workspace through a symlink".to_string(),
        tags: None,
    });
    fs::remove_file(&alias).unwrap();

    result.unwrap();
    assert_eq!(service.list_notes("src/main.rs").unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn add_note_rejects_a_relative_symlink_that_escapes_the_workspace() {
    use std::os::unix::fs::symlink;

    let workspace = create_test_workspace();
    let outside = create_test_workspace();
    symlink(outside.root(), workspace.root().join("outside-link")).unwrap();
    let mut service = create_test_note_service(workspace.root());

    let result = service.add_note(AddNoteRequest {
        source_file: "outside-link/escape.rs".into(),
        anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
        content: "must not follow the symlink".to_string(),
        tags: None,
    });

    assert!(matches!(
        result,
        Err(FrilVaultError::SourcePathOutsideWorkspace)
    ));
    assert!(!outside.root().join("escape.rs.json").exists());
}

#[test]
fn add_note_rejects_parent_traversal_without_writing_outside_notes_root() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let result = service.add_note(AddNoteRequest {
        source_file: "../../escaped.rs".into(),
        anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
        content: "must not escape".to_string(),
        tags: None,
    });

    assert!(matches!(
        result,
        Err(FrilVaultError::SourcePathOutsideWorkspace)
    ));
    assert!(!workspace_root.join("escaped.rs.json").exists());
}

#[test]
fn add_note_rejects_absolute_path_outside_workspace_without_writing() {
    let workspace = create_test_workspace();
    let outside = create_test_workspace();
    let outside_source = outside.root().join("outside.rs");
    let mut service = create_test_note_service(workspace.root());

    let result = service.add_note(AddNoteRequest {
        source_file: outside_source.clone(),
        anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
        content: "must stay in the vault".to_string(),
        tags: None,
    });

    assert!(matches!(
        result,
        Err(FrilVaultError::SourcePathOutsideWorkspace)
    ));
    assert!(!outside_source.with_extension("rs.json").exists());
}

#[test]
fn update_and_delete_accept_absolute_workspace_paths() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let source_file = workspace_root.join("src/main.rs");
    fs::create_dir_all(source_file.parent().unwrap()).unwrap();
    fs::write(&source_file, "fn main() {}\n").unwrap();
    let mut service = create_test_note_service(workspace_root);
    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "before".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .update_note(
            &source_file,
            note.id,
            UpdateNoteRequest {
                content: "after".to_string(),
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        service.list_notes("src/main.rs").unwrap()[0].note.content,
        "after"
    );

    service.delete_note(&source_file, note.id).unwrap();
    assert!(service.list_notes("src/main.rs").unwrap().is_empty());
    assert!(!workspace_root.join("src/main.rs.json").exists());
}

#[test]
fn delete_note_removes_note() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: crate::note::NoteAnchor::Line(crate::note::LineAnchor {
                line: 10,
                column: 5,
            }),
            content: "delete me".to_string(),
            tags: None,
        })
        .unwrap();

    service.delete_note("src/main.rs", note.id).unwrap();

    let notes = service.list_notes("src/main.rs").unwrap();

    assert_eq!(notes.len(), 0);
}

#[test]
fn delete_note_rejects_duplicate_ids_without_deleting_any_note() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);
    let first = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first".to_string(),
            tags: None,
        })
        .unwrap();
    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "second".to_string(),
            tags: None,
        })
        .unwrap();
    let note_path = workspace_root
        .join(".vault/notes")
        .join(format!("src/main.rs.{NOTE_FILE_EXTENSION}"));
    let mut note_file: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&note_path).unwrap()).unwrap();
    note_file["notes"][1]["id"] = note_file["notes"][0]["id"].clone();
    fs::write(&note_path, serde_json::to_string(&note_file).unwrap()).unwrap();

    let mut fresh_service = create_test_note_service(workspace_root);
    let result = fresh_service.delete_note("src/main.rs", first.id);

    assert!(result.is_err());
    let persisted: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(note_path).unwrap()).unwrap();
    assert_eq!(persisted["notes"].as_array().unwrap().len(), 2);
}

#[test]
fn find_note_by_id_rejects_duplicate_ids_across_files() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);
    let first = service
        .add_note(AddNoteRequest {
            source_file: "src/first.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first".to_string(),
            tags: None,
        })
        .unwrap();
    service
        .add_note(AddNoteRequest {
            source_file: "src/second.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "second".to_string(),
            tags: None,
        })
        .unwrap();
    let second_note_path = workspace_root
        .join(".vault/notes")
        .join(format!("src/second.rs.{NOTE_FILE_EXTENSION}"));
    let mut note_file: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&second_note_path).unwrap()).unwrap();
    note_file["notes"][0]["id"] = serde_json::Value::String(first.id.to_string());
    fs::write(
        &second_note_path,
        serde_json::to_string(&note_file).unwrap(),
    )
    .unwrap();

    let mut fresh_service = create_test_note_service(workspace_root);
    assert!(fresh_service.find_note_by_id(first.id).is_err());
}

#[test]
fn update_note_changes_content() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: crate::note::NoteAnchor::Line(crate::note::LineAnchor {
                line: 10,
                column: 5,
            }),
            content: "old content".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .update_note(
            "src/main.rs",
            note.id,
            UpdateNoteRequest {
                content: "new content".to_string(),
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();

    let notes = service.list_notes("src/main.rs").unwrap();

    assert_eq!(notes.len(), 1);

    assert_eq!(notes[0].note.content, "new content");
}

#[test]
fn update_note_changes_tags() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "tagged".to_string(),
            tags: Some(vec!["alpha".to_string()]),
        })
        .unwrap();

    service
        .update_note(
            "src/main.rs",
            note.id,
            UpdateNoteRequest {
                content: "tagged".to_string(),
                tags: Some(vec!["beta".to_string(), "gamma".to_string()]),
                expected_updated_at: None,
            },
        )
        .unwrap();

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.tags, vec!["beta", "gamma"]);
}

// Regression: stale expected_updated_at must not overwrite a newer note revision.
// 회귀 검증: stale expected_updated_at로 더 새로운 note revision을 덮어쓰면 안 됩니다.
#[test]
fn update_note_rejects_stale_expected_updated_at() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "original".to_string(),
            tags: None,
        })
        .unwrap();

    let stale = note.updated_at - chrono::Duration::seconds(1);

    assert!(matches!(
        service.update_note(
            "src/main.rs",
            note.id,
            UpdateNoteRequest {
                content: "conflict".to_string(),
                tags: None,
                expected_updated_at: Some(stale),
            },
        ),
        Err(FrilVaultError::ConcurrentModification(id)) if id == note.id
    ));

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes[0].note.content, "original");
}

#[test]
fn search_notes_finds_matching_notes() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor {
                line: 10,
                column: 5,
            }),

            content: "parser 개선 필요".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 3, column: 1 }),

            content: "Parser trait 검토".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/mod.rs".into(),

            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),

            content: "hello world".to_string(),
            tags: None,
        })
        .unwrap();

    let notes = service.search_notes("parser").unwrap();

    assert_eq!(notes.len(), 2,);

    assert!(
        notes
            .iter()
            .any(|result| result.source_file == std::path::Path::new("src/main.rs"))
    );

    // case_insensitive
    let notes = service.search_notes("PARSER").unwrap();

    assert_eq!(notes.len(), 2,);
}

#[test]
fn search_finds_symbol_anchor() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/service.rs".into(),

            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "NoteService::add_note".to_string(),

                kind: SymbolKind::Method,

                signature: None,

                line_hint: None,
            }),

            content: "service logic".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service.search_notes("add_note").unwrap();

    assert_eq!(results.len(), 1,);
}

#[test]
fn search_by_symbol_returns_matching_notes() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),

            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "main".to_string(),

                kind: SymbolKind::Function,

                signature: None,

                line_hint: None,
            }),

            content: "main symbol note".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service.search_by_symbol("main").unwrap();

    assert_eq!(results.len(), 1);

    assert_eq!(results[0].note.content, "main symbol note");
}

#[test]
fn search_by_symbol_returns_empty_when_not_found() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),

            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "main".to_string(),

                kind: SymbolKind::Function,

                signature: None,

                line_hint: None,
            }),

            content: "main symbol note".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service.search_by_symbol("parser").unwrap();

    assert!(results.is_empty());
}

#[test]
fn list_symbol_notes_returns_only_symbol_notes() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "line".to_string(),
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
            content: "symbol".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service.list_symbol_notes("src/main.rs").unwrap();

    assert_eq!(results.len(), 1);

    match &results[0].note.anchor {
        NoteAnchor::Symbol(anchor) => {
            assert_eq!(anchor.name, "main");
        }
        _ => panic!("expected symbol note"),
    }
}

#[test]
fn find_symbol_note_returns_matching_symbol() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "Parser".to_string(),
                kind: SymbolKind::Struct,
                signature: None,
                line_hint: None,
            }),
            content: "parser note".to_string(),
            tags: None,
        })
        .unwrap();

    let result = service.find_symbol_note("src/main.rs", "Parser").unwrap();

    assert!(result.is_some());

    assert_eq!(result.unwrap().note.content, "parser note");
}

#[test]
fn add_note_updates_persisted_index() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut service = create_test_note_service(workspace_root);
    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "indexed note".to_string(),
            tags: None,
        })
        .unwrap();

    let index = WorkspaceIndexRepository::new(PathResolver::new(workspace_root))
        .load()
        .unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].source_file, "src/main.rs");
    assert_eq!(index.files[0].note_count, 1);
    assert!(index.files[0].exists);
}

#[test]
fn delete_note_updates_persisted_index_count() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "").unwrap();

    let mut service = create_test_note_service(workspace_root);
    let first = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first".to_string(),
            tags: None,
        })
        .unwrap();
    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "second".to_string(),
            tags: None,
        })
        .unwrap();

    service.delete_note("src/main.rs", first.id).unwrap();

    let index = WorkspaceIndexRepository::new(PathResolver::new(workspace_root))
        .load()
        .unwrap();

    assert_eq!(index.files.len(), 1);
    assert_eq!(index.files[0].note_count, 1);
}

#[test]
fn search_notes_by_file_returns_notes_for_source_file() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "main note".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/parser/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 3, column: 2 }),
            content: "parser note".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service.search_notes_by_file("src/parser/lib.rs").unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].source_file, PathBuf::from("src/parser/lib.rs"));
    assert_eq!(results[0].note.content, "parser note");
}

#[test]
fn search_notes_by_file_accepts_absolute_workspace_paths() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "absolute path note".to_string(),
            tags: None,
        })
        .unwrap();

    let results = service
        .search_notes_by_file(workspace_root.join("src/main.rs"))
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].source_file, PathBuf::from("src/main.rs"));
}

#[test]
fn search_by_tag_returns_matching_notes() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "bug fix".to_string(),
            tags: Some(vec!["bug".to_string(), "optimization".to_string()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: NoteAnchor::Symbol(SymbolAnchor {
                name: "Architecture".to_string(),
                kind: SymbolKind::Struct,
                signature: None,
                line_hint: Some(7),
            }),
            content: "architecture note".to_string(),
            tags: Some(vec!["#architecture".to_string()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/other.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "untagged".to_string(),
            tags: None,
        })
        .unwrap();

    let bug_notes = service.search_by_tag("bug").unwrap();
    assert_eq!(bug_notes.len(), 1);
    assert_eq!(bug_notes[0].note.content, "bug fix");

    let architecture_notes = service.search_by_tag("ARCHITECTURE").unwrap();
    assert_eq!(architecture_notes.len(), 1);
    assert_eq!(architecture_notes[0].note.content, "architecture note");
    assert!(matches!(
        architecture_notes[0].note.anchor,
        NoteAnchor::Symbol(_)
    ));

    let prefixed_architecture_notes = service.search_by_tag("#architecture").unwrap();
    assert_eq!(prefixed_architecture_notes.len(), 1);
}

#[test]
fn search_by_tag_returns_empty_when_not_found() {
    let workspace = create_test_workspace();
    let mut service = create_test_note_service(workspace.root());

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "tagged note".to_string(),
            tags: Some(vec!["todo".to_string()]),
        })
        .unwrap();

    assert!(service.search_by_tag("architecture").unwrap().is_empty());
}

#[test]
fn query_notes_combines_file_keyword_and_tag_filters() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();

    let mut service = create_test_note_service(workspace_root);

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "parser bug fix".to_string(),
            tags: Some(vec!["bug".to_string()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 2, column: 1 }),
            content: "architecture note".to_string(),
            tags: Some(vec!["architecture".to_string()]),
        })
        .unwrap();

    service
        .add_note(AddNoteRequest {
            source_file: "src/lib.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "parser in lib".to_string(),
            tags: Some(vec!["bug".to_string()]),
        })
        .unwrap();

    let keyword_and_file = service
        .query_notes(&NoteQuery {
            source_file: Some("src/main.rs".into()),
            keyword: Some("parser".to_string()),
            tag: None,
        })
        .unwrap();
    assert_eq!(keyword_and_file.len(), 1);
    assert_eq!(keyword_and_file[0].note.content, "parser bug fix");

    let tag_and_file = service
        .query_notes(&NoteQuery {
            source_file: Some("src/main.rs".into()),
            keyword: None,
            tag: Some("bug".to_string()),
        })
        .unwrap();
    assert_eq!(tag_and_file.len(), 1);
    assert_eq!(tag_and_file[0].note.content, "parser bug fix");

    let all_filters = service
        .query_notes(&NoteQuery {
            source_file: Some("src/main.rs".into()),
            keyword: Some("parser".to_string()),
            tag: Some("bug".to_string()),
        })
        .unwrap();
    assert_eq!(all_filters.len(), 1);
    assert_eq!(all_filters[0].note.content, "parser bug fix");

    let tag_and_keyword = service
        .query_notes(&NoteQuery {
            source_file: None,
            keyword: Some("parser".to_string()),
            tag: Some("bug".to_string()),
        })
        .unwrap();
    assert_eq!(tag_and_keyword.len(), 2);
}
