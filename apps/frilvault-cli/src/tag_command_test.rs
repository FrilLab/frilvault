use std::{
    fs,
    path::{Path, PathBuf},
    sync::MutexGuard,
    time::{SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use frilvault_core::{AddNoteRequest, FrilVault, LineAnchor, NoteAnchor, TagColor};

use crate::{
    cli::{
        Cli,
        format::FormatArg,
        tag::{
            TagColorAction, TagColorArg, TagColorCommand, TagColorRemoveCommand,
            TagColorSetCommand, TagCommand, TagListCommand, TagMergeCommand, TagRemoveCommand,
            TagRenameCommand,
        },
    },
    command, run,
    test_support::WORKING_DIRECTORY_LOCK,
};

struct WorkingDirectoryGuard {
    _lock: MutexGuard<'static, ()>,
    previous: PathBuf,
}

impl WorkingDirectoryGuard {
    fn change_to(path: &Path) -> Self {
        let lock = WORKING_DIRECTORY_LOCK.lock().unwrap();
        let previous = std::env::current_dir().expect("current working directory");
        std::env::set_current_dir(path).expect("set current working directory");

        Self {
            _lock: lock,
            previous,
        }
    }
}

impl Drop for WorkingDirectoryGuard {
    fn drop(&mut self) {
        std::env::set_current_dir(&self.previous).expect("restore previous working directory");
    }
}

fn create_tag_fixture() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let workspace = std::env::temp_dir().join(format!("flvt-tag-test-{unique}"));
    fs::create_dir_all(workspace.join("src")).expect("create src directory");
    fs::write(workspace.join("src/main.rs"), "").expect("create source file");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    let mut note_service = vault.notes().expect("create note service");
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "note with bug and defect tags".to_string(),
            tags: Some(vec!["bug".into(), "defect".into(), "legacy".into()]),
        })
        .expect("add note");

    let mut workspace_service = vault.workspace().expect("create workspace service");
    workspace_service
        .warm_up()
        .expect("warm up workspace index");

    workspace
}

#[test]
fn tag_rename_executes_successfully() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::Rename(TagRenameCommand {
            old_tag: "bug".into(),
            new_tag: "issue".into(),
            dry_run: false,
            format: Some(FormatArg::Json),
        }),
    })
    .expect("execute rename");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    let mut notes = vault.notes().expect("notes service");
    let list = notes.list_notes("src/main.rs").expect("list notes");
    assert!(list[0].note.tags.contains(&"issue".to_string()));
    assert!(!list[0].note.tags.contains(&"bug".to_string()));
}

#[test]
fn tag_merge_executes_successfully() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::Merge(TagMergeCommand {
            sources: vec!["bug".into(), "defect".into()],
            into: "issue".into(),
            dry_run: false,
            format: Some(FormatArg::Json),
        }),
    })
    .expect("execute merge");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    let mut notes = vault.notes().expect("notes service");
    let list = notes.list_notes("src/main.rs").expect("list notes");
    assert!(list[0].note.tags.contains(&"issue".to_string()));
    assert!(!list[0].note.tags.contains(&"bug".to_string()));
    assert!(!list[0].note.tags.contains(&"defect".to_string()));
}

#[test]
fn tag_remove_with_yes_executes_successfully() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::Remove(TagRemoveCommand {
            tag: "legacy".into(),
            yes: true,
            dry_run: false,
            format: Some(FormatArg::Json),
        }),
    })
    .expect("execute remove");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    let mut notes = vault.notes().expect("notes service");
    let list = notes.list_notes("src/main.rs").expect("list notes");
    assert!(!list[0].note.tags.contains(&"legacy".to_string()));
}

#[test]
fn tag_list_executes_successfully() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::List(TagListCommand {
            unused: false,
            format: Some(FormatArg::Json),
        }),
    })
    .expect("execute list");

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::List(TagListCommand {
            unused: true,
            format: Some(FormatArg::Json),
        }),
    })
    .expect("execute list unused");
}

#[test]
fn tag_color_can_be_assigned_and_removed_without_changing_notes() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::Color(TagColorCommand {
            action: TagColorAction::Set(TagColorSetCommand {
                tag: "bug".into(),
                color: TagColorArg::Red,
                format: Some(FormatArg::Json),
            }),
        }),
    })
    .expect("set color");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    assert_eq!(vault.tag_colors().unwrap().get("bug"), Some(&TagColor::Red));
    let mut notes = vault.notes().unwrap();
    assert!(
        notes.list_notes("src/main.rs").unwrap()[0]
            .note
            .tags
            .contains(&"bug".to_string())
    );

    command::tag::execute(TagCommand {
        action: crate::cli::tag::TagAction::Color(TagColorCommand {
            action: TagColorAction::Remove(TagColorRemoveCommand {
                tag: "#BUG".into(),
                format: Some(FormatArg::Json),
            }),
        }),
    })
    .expect("remove color");

    assert!(vault.tag_colors().unwrap().is_empty());
}

#[test]
fn run_dispatches_tag_commands() {
    let workspace = create_tag_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    let cli = Cli::parse_from([
        "flvt",
        "tag",
        "rename",
        "bug",
        "issue",
        "--dry-run",
        "--format",
        "json",
    ]);
    run(cli).expect("run tag rename");

    let cli = Cli::parse_from(["flvt", "tag", "list", "--format", "json"]);
    run(cli).expect("run tag list");

    let cli = Cli::parse_from([
        "flvt",
        "tag",
        "stats",
        "--tag",
        "bug",
        "--group-by",
        "file",
        "--format",
        "json",
    ]);
    run(cli).expect("run tag stats");
}
