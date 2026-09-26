use std::{
    fs,
    process::{Child, Command},
};

use uuid::Uuid;

struct Workspace(std::path::PathBuf);

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn concurrent_processes_preserve_every_successful_note_add() {
    let root = std::env::temp_dir().join(format!("frilvault-concurrent-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
    let _workspace = Workspace(root.clone());

    let init = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .arg("init")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(init.status.success());

    let mut children: Vec<Child> = (0..32)
        .map(|index| {
            let content = format!("parallel note {index}");
            Command::new(env!("CARGO_BIN_EXE_flvt"))
                .args([
                    "add",
                    "--file",
                    "main.rs",
                    "--line",
                    "1",
                    "--content",
                    &content,
                ])
                .current_dir(&root)
                .spawn()
                .unwrap()
        })
        .collect();

    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }

    let listed = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args(["list", "--file", "main.rs", "--format", "json"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(listed.status.success());
    let notes: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(notes.as_array().unwrap().len(), 32);
}

#[test]
fn autodiscovery_from_nested_directory_uses_the_vault_workspace_root() {
    let root = std::env::temp_dir().join(format!("frilvault-nested-{}", Uuid::new_v4()));
    let nested = root.join("src").join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
    let _workspace = Workspace(root.clone());

    let init = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .arg("init")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(init.status.success());
    let add = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args([
            "add",
            "--file",
            "main.rs",
            "--line",
            "1",
            "--content",
            "root note",
        ])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(add.status.success());

    let listed = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args(["list", "--file", "main.rs", "--format", "json"])
        .current_dir(&nested)
        .output()
        .unwrap();
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let notes: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(notes.as_array().unwrap().len(), 1);
    assert_eq!(notes[0]["note"]["content"], "root note");
}

#[test]
fn clear_tags_removes_the_last_tag_from_a_note() {
    let root = std::env::temp_dir().join(format!("frilvault-clear-tags-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
    let _workspace = Workspace(root.clone());

    let init = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .arg("init")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(init.status.success());
    let add = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args([
            "add",
            "--file",
            "main.rs",
            "--line",
            "1",
            "--content",
            "tagged",
            "--tag",
            "todo",
            "--format",
            "json",
        ])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(add.status.success());
    let added: serde_json::Value = serde_json::from_slice(&add.stdout).unwrap();
    let note_id = added["note"]["id"].as_str().unwrap();

    let update = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args([
            "update",
            "--file",
            "main.rs",
            "--id",
            note_id,
            "--content",
            "tagged",
            "--clear-tags",
            "--format",
            "json",
        ])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        update.status.success(),
        "{}",
        String::from_utf8_lossy(&update.stderr)
    );
    let listed = Command::new(env!("CARGO_BIN_EXE_flvt"))
        .args(["list", "--file", "main.rs", "--format", "json"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(listed.status.success());
    let notes: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert!(
        notes[0]["note"]["tags"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
}
