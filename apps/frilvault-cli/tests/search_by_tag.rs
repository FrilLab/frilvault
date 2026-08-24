use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use serde_json::Value;
use uuid::Uuid;

struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("frilvault-cli-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "fn parse() {\n    println!(\"parse\");\n}\n",
        )
        .unwrap();

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

    fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn add_normalizes_hash_prefixes_and_duplicate_tags() {
    let workspace = TestWorkspace::new();

    let output = workspace.run(&[
        "add",
        "--file",
        "src/lib.rs",
        "--line",
        "1",
        "--content",
        "normalized tags",
        "--tag",
        "#Performance",
        "--tag",
        "performance",
        "--tag",
        "#permission",
        "--format",
        "json",
    ]);
    let view: Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(
        view["note"]["tags"],
        serde_json::json!(["Performance", "permission"])
    );
}

#[test]
fn search_tag_matches_line_and_symbol_notes_with_or_without_hash_prefix() {
    let workspace = TestWorkspace::new();

    workspace.run(&[
        "add",
        "--file",
        "src/lib.rs",
        "--line",
        "1",
        "--content",
        "line todo",
        "--tag",
        "todo",
    ]);
    workspace.run(&[
        "add",
        "--file",
        "src/lib.rs",
        "--symbol",
        "parse",
        "--kind",
        "function",
        "--line-hint",
        "1",
        "--content",
        "symbol todo",
        "--tag",
        "#todo",
    ]);

    for tag in ["todo", "#todo"] {
        let output = workspace.run(&["search", "--tag", tag, "--format", "json"]);
        let notes: Value = serde_json::from_slice(&output.stdout).unwrap();
        let notes = notes.as_array().unwrap();

        assert_eq!(notes.len(), 2);
        assert!(
            notes
                .iter()
                .any(|view| view["note"]["anchor"]["type"] == "Line")
        );
        assert!(
            notes
                .iter()
                .any(|view| view["note"]["anchor"]["type"] == "Symbol")
        );
        assert!(notes.iter().all(|view| view["source_file"] == "src/lib.rs"));
    }

    assert!(workspace.root().join("src/lib.rs").exists());
}

#[test]
fn search_tag_prints_result_details_and_a_clear_empty_state() {
    let workspace = TestWorkspace::new();

    workspace.run(&[
        "add",
        "--file",
        "src/lib.rs",
        "--line",
        "2",
        "--column",
        "3",
        "--content",
        "remember this parser detail",
        "--tag",
        "architecture",
    ]);

    let matching = workspace.run(&["search", "--tag", "architecture"]);
    let matching = String::from_utf8(matching.stdout).unwrap();
    assert!(matching.contains("File: src/lib.rs"));
    assert!(matching.contains("Location: 2:3"));
    assert!(matching.contains("Tags: architecture"));
    assert!(matching.contains("remember this parser detail"));

    let empty = workspace.run(&["search", "--tag", "missing"]);
    assert_eq!(
        String::from_utf8(empty.stdout).unwrap(),
        "No notes found.\n"
    );
}
