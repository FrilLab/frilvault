use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde_json::Value;
use uuid::Uuid;

struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("frilvault-cli-flow-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src/중첩 dir")).unwrap();
        fs::write(
            root.join("src/중첩 dir/main.rs"),
            "fn main() {\n    println!(\"안녕\");\n}\n",
        )
        .unwrap();
        Self { root }
    }

    fn run(&self, args: &[&str]) -> Output {
        let output = self.run_raw(args);
        assert!(
            output.status.success(),
            "flvt {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn run_raw(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap()
    }

    fn run_with_input(&self, args: &[&str], input: &str) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
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
fn cli_crud_flow_accepts_absolute_paths_and_preserves_source() {
    let workspace = TestWorkspace::new();
    let relative_source = "src/중첩 dir/main.rs";
    let absolute_source = workspace.root().join(relative_source);
    let absolute_source = absolute_source.to_str().unwrap();
    let source_before = fs::read(absolute_source).unwrap();
    workspace.run(&["init", "--format", "json"]);

    let added = workspace.run(&[
        "add",
        "--file",
        absolute_source,
        "--line",
        "1",
        "--content",
        "첫 메모\n둘째 줄",
        "--tag",
        "#검토",
        "--format",
        "json",
    ]);
    let added: Value = serde_json::from_slice(&added.stdout).unwrap();
    let note_id = added["note"]["id"].as_str().unwrap();
    let updated_at = added["note"]["updated_at"].as_str().unwrap();
    assert_eq!(added["source_file"], relative_source);

    let listed = workspace.run(&["list", "--file", relative_source, "--format", "json"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&listed.stdout)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let updated = workspace.run(&[
        "update",
        "--file",
        absolute_source,
        "--id",
        note_id,
        "--content",
        "수정된 메모",
        "--tag",
        "updated",
        "--expected-updated-at",
        updated_at,
        "--format",
        "json",
    ]);
    let updated: Value = serde_json::from_slice(&updated.stdout).unwrap();
    assert_eq!(updated["note"]["content"], "수정된 메모");

    let searched = workspace.run(&["search", "수정된", "--format", "json"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&searched.stdout)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let uri = format!(
        "frilvault://note/v1/{note_id}?workspace={}",
        percent_encode(&workspace.root().to_string_lossy())
    );
    let resolved = workspace.run(&["resolve-uri", "--uri", &uri, "--format", "json"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&resolved.stdout).unwrap()["note"]["id"],
        note_id
    );

    let image_path = workspace.root().join("diagram.png");
    fs::write(&image_path, b"fake-png").unwrap();
    let attached = workspace.run(&[
        "attach",
        "--file",
        absolute_source,
        "--id",
        note_id,
        "--image",
        image_path.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert_eq!(
        serde_json::from_slice::<Value>(&attached.stdout).unwrap()["filename"],
        "diagram.png"
    );

    workspace.run(&["delete", "--file", absolute_source, "--id", note_id]);
    let reopened = workspace.run(&["list", "--file", relative_source, "--format", "json"]);
    assert!(
        serde_json::from_slice::<Value>(&reopened.stdout)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read(absolute_source).unwrap(), source_before);
    assert!(!workspace.root().join("src/중첩 dir/main.rs.json").exists());
}

#[test]
fn cli_workspace_commands_return_valid_results_after_repeated_init() {
    let workspace = TestWorkspace::new();
    workspace.run(&["init"]);
    workspace.run(&["init", "--format", "json"]);
    workspace.run(&[
        "add",
        "--file",
        "src/중첩 dir/main.rs",
        "--symbol",
        "main",
        "--kind",
        "function",
        "--line-hint",
        "1",
        "--content",
        "symbol note",
    ]);

    let status = workspace.run(&["status"]);
    assert!(String::from_utf8_lossy(&status.stdout).contains("Notes: 1"));

    let status_json = workspace.run(&["status", "--format", "json"]);
    let status_json: Value = serde_json::from_slice(&status_json.stdout).unwrap();
    assert_eq!(
        status_json,
        serde_json::json!({
            "vault_path": ".vault",
            "mode": "local",
            "git_tracking": "not_git_repository",
            "note_count": 1
        })
    );

    for args in [
        &["doctor", "--format", "json"][..],
        &["health", "--format", "json"],
        &["stats", "--format", "json"],
        &["index", "--format", "json"],
        &["explorer", "--format", "json"],
        &["sync", "--format", "json"],
        &["repair", "--format", "json"],
        &["repair", "--apply", "--format", "json"],
    ] {
        let output = workspace.run(args);
        serde_json::from_slice::<Value>(&output.stdout).unwrap();
    }
}

#[test]
fn cli_text_diagnostics_gitignore_and_interactive_repair_work() {
    let workspace = TestWorkspace::new();
    workspace.run(&["init"]);
    let source = workspace.root().join("src/old/legacy_unique.rs");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, "fn legacy_unique() {}\n").unwrap();
    workspace.run(&[
        "add",
        "--file",
        "src/old/legacy_unique.rs",
        "--line",
        "1",
        "--content",
        "repair me",
    ]);

    for (args, expected) in [
        (&["doctor"][..], "No missing source files."),
        (&["stats"], "Total Notes: 1"),
        (&["explorer"], "legacy_unique.rs"),
        (
            &["sync", "--notes-only"],
            "Note cache and workspace index refreshed.",
        ),
        (&["repair"], "No repair suggestions."),
    ] {
        let output = workspace.run(args);
        assert!(String::from_utf8_lossy(&output.stdout).contains(expected));
    }

    let check = workspace.run(&["gitignore", "check", "--format", "json"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&check.stdout).unwrap()["ignored"],
        false
    );
    workspace.run(&["gitignore", "add"]);
    let check = workspace.run(&["gitignore", "check"]);
    assert!(String::from_utf8_lossy(&check.stdout).contains("is ignored"));

    let destination = workspace.root().join("src/new/legacy_unique.rs");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    fs::rename(&source, &destination).unwrap();
    let doctor = workspace.run(&["doctor"]);
    assert!(String::from_utf8_lossy(&doctor.stdout).contains("Missing Source Files"));
    let suggestions = workspace.run(&["repair"]);
    assert!(String::from_utf8_lossy(&suggestions.stdout).contains("Possible Matches"));

    let repaired = workspace.run_with_input(&["repair", "--interactive"], "1\n");
    assert!(repaired.status.success());
    assert!(String::from_utf8_lossy(&repaired.stdout).contains("Applied 1 repair(s)"));
    let notes = workspace.run(&[
        "list",
        "--file",
        "src/new/legacy_unique.rs",
        "--format",
        "json",
    ]);
    assert_eq!(
        serde_json::from_slice::<Value>(&notes.stdout)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn cli_rejects_escaping_paths_without_creating_sidecars() {
    let workspace = TestWorkspace::new();
    workspace.run(&["init"]);

    let traversal = workspace.run_raw(&[
        "add",
        "--file",
        "../../escaped.rs",
        "--line",
        "1",
        "--content",
        "escape",
    ]);
    assert!(!traversal.status.success());
    assert!(String::from_utf8_lossy(&traversal.stderr).contains("outside workspace"));
    assert!(!workspace.root().join("escaped.rs.json").exists());

    let outside = TestWorkspace::new();
    let outside_source = outside.root().join("outside.rs");
    let outside_result = workspace.run_raw(&[
        "add",
        "--file",
        outside_source.to_str().unwrap(),
        "--line",
        "1",
        "--content",
        "escape",
    ]);
    assert!(!outside_result.status.success());
    assert!(!outside_source.with_extension("rs.json").exists());
}

#[test]
fn cli_reports_corrupted_data_without_overwriting_it() {
    let workspace = TestWorkspace::new();
    workspace.run(&["init"]);
    let metadata_path = workspace.root().join(".vault/workspace.json");
    fs::write(&metadata_path, "{not-json").unwrap();

    let status = workspace.run_raw(&["status"]);
    assert!(!status.status.success());
    let stderr = String::from_utf8_lossy(&status.stderr);
    assert!(stderr.contains("Failed to read FrilVault workspace metadata"));
    assert!(stderr.contains(".vault/workspace.json is invalid"));
    assert_eq!(fs::read_to_string(metadata_path).unwrap(), "{not-json");

    let note_workspace = TestWorkspace::new();
    note_workspace.run(&["init"]);
    note_workspace.run(&[
        "add",
        "--file",
        "src/중첩 dir/main.rs",
        "--line",
        "1",
        "--content",
        "will be corrupted",
    ]);
    let note_path = note_workspace
        .root()
        .join(".vault/notes/src/중첩 dir/main.rs.json");
    fs::write(&note_path, "").unwrap();

    let list =
        note_workspace.run_raw(&["list", "--file", "src/중첩 dir/main.rs", "--format", "json"]);
    assert!(!list.status.success());
    assert!(String::from_utf8_lossy(&list.stderr).contains("json error"));
    assert_eq!(fs::read_to_string(note_path).unwrap(), "");
}

#[test]
fn cli_status_outside_workspace_returns_non_zero_without_creating_vault() {
    let workspace = TestWorkspace::new();

    let output = workspace.run_raw(&["status"]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No FrilVault workspace found."));
    assert!(!workspace.root().join(".vault").exists());
}

#[test]
fn cli_status_help_documents_text_and_json_contract() {
    let workspace = TestWorkspace::new();

    let output = workspace.run_raw(&["status", "--help"]);
    let help = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success());
    assert!(help.contains("--format <FORMAT>"));
    assert!(help.contains("external note changes are reflected"));
    assert!(help.contains("Git tracking: excluded"));
    assert!(help.contains("\"vault_path\": \".vault\""));
    assert!(help.contains("vault_path, mode, git_tracking, note_count"));
}

fn percent_encode(input: &str) -> String {
    input
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
