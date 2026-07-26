use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use frilvault_core::{AddNoteRequest, FrilVault, LineAnchor, NoteAnchor};

use crate::{
    cli::{format::FormatArg, index::IndexCommand, Cli},
    command,
    run,
};

static WORKING_DIRECTORY_LOCK: Mutex<()> = Mutex::new(());

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
        std::env::set_current_dir(&self.previous)
            .expect("restore previous working directory");
    }
}

fn create_index_fixture() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let workspace = std::env::temp_dir().join(format!("flvt-index-test-{unique}"));
    fs::create_dir_all(workspace.join("src")).expect("create src directory");
    fs::write(workspace.join("src/main.rs"), "").expect("create source file");

    let vault = FrilVault::open(&workspace).expect("open workspace");
    let mut note_service = vault.notes().expect("create note service");
    note_service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 10, column: 5 }),
            content: "index command note".to_string(),
            tags: None,
        })
        .expect("add note");

    let mut workspace_service = vault.workspace().expect("create workspace service");
    workspace_service.warm_up().expect("warm up workspace index");

    workspace
}

#[test]
fn index_command_outputs_json_workspace_counts() {
    let workspace = create_index_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::index::execute(IndexCommand {
        format: Some(FormatArg::Json),
    })
    .expect("execute index command");
}

#[test]
fn index_command_outputs_text_workspace_counts() {
    let workspace = create_index_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    command::index::execute(IndexCommand {
        format: Some(FormatArg::Text),
    })
    .expect("execute index command");
}

#[test]
fn run_dispatches_index_command() {
    let workspace = create_index_fixture();
    let _guard = WorkingDirectoryGuard::change_to(&workspace);

    let cli = Cli::parse_from(["flvt", "index", "--format", "json"]);

    run(cli).expect("run index command");
}
