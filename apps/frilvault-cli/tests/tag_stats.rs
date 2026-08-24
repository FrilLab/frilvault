use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

use serde_json::Value;
use uuid::Uuid;

struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("frilvault-tag-stats-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src/core")).unwrap();
        fs::create_dir_all(root.join("src/parser")).unwrap();
        fs::write(root.join("src/core/a.rs"), "").unwrap();
        fs::write(root.join("src/core/b.rs"), "").unwrap();
        fs::write(root.join("src/parser/c.rs"), "").unwrap();

        let workspace = Self { root };
        workspace.run(&["init"]);
        workspace
    }

    fn run(&self, args: &[&str]) -> Output {
        let output = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "flvt {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn add_note(&self, source_file: &str, tag: &str) {
        self.run(&[
            "add",
            "--file",
            source_file,
            "--line",
            "1",
            "--content",
            "tag statistic fixture",
            "--tag",
            tag,
        ]);
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn tag_stats_prints_most_used_tags_and_directory_breakdown() {
    let workspace = TestWorkspace::new();
    workspace.add_note("src/core/a.rs", "architecture");
    workspace.add_note("src/core/b.rs", "architecture");
    workspace.add_note("src/parser/c.rs", "architecture");
    workspace.add_note("src/parser/c.rs", "todo");

    let summary = String::from_utf8(workspace.run(&["tag", "stats"]).stdout).unwrap();
    assert_eq!(summary, "Tag Statistics\n\narchitecture (3)\n\ntodo (1)\n");

    let breakdown = String::from_utf8(
        workspace
            .run(&[
                "tag",
                "stats",
                "--tag",
                "architecture",
                "--group-by",
                "directory",
            ])
            .stdout,
    )
    .unwrap();
    assert_eq!(
        breakdown,
        "Tag Statistics\n\narchitecture (3)\n  src/core 2\n  src/parser 1\n"
    );
}

#[test]
fn tag_stats_json_is_machine_readable_for_cli_consumers() {
    let workspace = TestWorkspace::new();
    workspace.add_note("src/core/a.rs", "architecture");

    let output = workspace.run(&["tag", "stats", "--group-by", "file", "--format", "json"]);
    let statistics: Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(statistics[0]["tag"], "architecture");
    assert_eq!(statistics[0]["note_count"], 1);
    assert_eq!(statistics[0]["breakdown"][0]["path"], "src/core/a.rs");
    assert_eq!(statistics[0]["breakdown"][0]["note_count"], 1);
}
