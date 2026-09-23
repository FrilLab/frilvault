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
        let root = std::env::temp_dir().join(format!("frilvault-missing-read-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(init.success());
        Self { root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap()
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn read_commands_report_a_missing_workspace_without_creating_or_changing_files() {
    let workspace = TestWorkspace::new();
    let exclude_path = git_path(workspace.root(), "info/exclude");
    let exclude_before = fs::read(&exclude_path).unwrap();
    let gitignore_before = fs::read(workspace.root().join(".gitignore")).unwrap();
    let commands: &[&[&str]] = &[
        &["list", "--file", "src/main.rs", "--format", "json"],
        &["search", "missing", "--format", "json"],
        &["explorer", "--format", "json"],
        &["stats", "--format", "json"],
        &["health", "--format", "json"],
        &["doctor", "--format", "json"],
        &["status", "--format", "json"],
        &["index", "--format", "json"],
        &["repair", "--format", "json"],
        &[
            "resolve-uri",
            "--uri",
            "frilvault://note/invalid",
            "--format",
            "json",
        ],
        &["gitignore", "check", "--format", "json"],
        &["tag", "list", "--format", "json"],
        &["tag", "stats", "--format", "json"],
        &["env", "profiles", "--format", "json"],
        &[
            "env",
            "list",
            "--profile",
            "development",
            "--format",
            "json",
        ],
        &[
            "env",
            "validate",
            "--profile",
            "development",
            "--format",
            "json",
        ],
        &[
            "env",
            "doctor",
            "--profile",
            "development",
            "--format",
            "json",
        ],
        &["env", "identity", "show", "--format", "json"],
        &["env", "recipients", "list", "--format", "json"],
    ];

    for args in commands {
        let output = workspace.run(args);
        assert!(
            !output.status.success(),
            "flvt {args:?} unexpectedly succeeded"
        );
        assert!(output.stdout.is_empty(), "flvt {args:?} wrote to stdout");
        let diagnostic: Value = serde_json::from_slice(&output.stderr)
            .unwrap_or_else(|error| panic!("flvt {args:?} returned invalid JSON error: {error}"));
        assert_eq!(
            diagnostic["error"]["code"], "workspace_not_found",
            "flvt {args:?}"
        );
        assert_eq!(
            diagnostic["error"]["message"],
            "No FrilVault workspace found.\nRun `flvt init` to initialize one.",
            "flvt {args:?}"
        );
        assert!(!workspace.root().join(".vault").exists(), "flvt {args:?}");
        assert_eq!(
            fs::read(&exclude_path).unwrap(),
            exclude_before,
            "flvt {args:?}"
        );
        assert_eq!(
            fs::read(workspace.root().join(".gitignore")).unwrap(),
            gitignore_before,
            "flvt {args:?}"
        );
        assert!(
            git_stdout(workspace.root(), &["ls-files"]).is_empty(),
            "flvt {args:?} changed the Git index"
        );
    }
}

#[test]
fn write_commands_do_not_choose_a_mode_or_create_an_uninitialized_vault() {
    let workspace = TestWorkspace::new();
    let exclude_path = git_path(workspace.root(), "info/exclude");
    let exclude_before = fs::read(&exclude_path).unwrap();
    let gitignore_before = fs::read(workspace.root().join(".gitignore")).unwrap();

    for args in [
        &[
            "add",
            "--file",
            "src/main.rs",
            "--line",
            "1",
            "--content",
            "note",
            "--format",
            "json",
        ][..],
        &["env", "init", "--format", "json"][..],
        &["tag", "color", "set", "todo", "blue", "--format", "json"][..],
    ] {
        let output = workspace.run(args);
        assert!(
            !output.status.success(),
            "flvt {args:?} unexpectedly succeeded"
        );
        let diagnostic: Value = serde_json::from_slice(&output.stderr)
            .unwrap_or_else(|error| panic!("flvt {args:?} returned invalid JSON error: {error}"));
        assert_eq!(
            diagnostic["error"]["code"], "workspace_not_found",
            "flvt {args:?}"
        );
        assert!(!workspace.root().join(".vault").exists(), "flvt {args:?}");
        assert_eq!(
            fs::read(&exclude_path).unwrap(),
            exclude_before,
            "flvt {args:?}"
        );
        assert_eq!(
            fs::read(workspace.root().join(".gitignore")).unwrap(),
            gitignore_before,
            "flvt {args:?}"
        );
        assert!(git_stdout(workspace.root(), &["ls-files"]).is_empty());
    }
}

#[test]
fn explicit_init_preserves_local_shared_and_external_vault_contracts() {
    let local = TestWorkspace::new();
    let local_exclude = git_path(local.root(), "info/exclude");
    let local_exclude_before = fs::read(&local_exclude).unwrap();
    let local_gitignore_before = fs::read(local.root().join(".gitignore")).unwrap();

    let local_init = local.run(&["init", "--format", "json"]);
    assert!(local_init.status.success());
    let local_result: Value = serde_json::from_slice(&local_init.stdout).unwrap();
    assert_eq!(local_result["mode"], "local");
    assert_eq!(local_result["git_exclude"], "added");
    assert_ne!(fs::read(&local_exclude).unwrap(), local_exclude_before);
    assert_eq!(
        fs::read(local.root().join(".gitignore")).unwrap(),
        local_gitignore_before
    );
    assert_eq!(workspace_status(&local, None)["mode"], "local");
    assert_eq!(workspace_status(&local, None)["git_tracking"], "excluded");

    let shared = TestWorkspace::new();
    let shared_exclude = git_path(shared.root(), "info/exclude");
    let shared_exclude_before = fs::read(&shared_exclude).unwrap();
    let shared_gitignore_before = fs::read(shared.root().join(".gitignore")).unwrap();

    let shared_init = shared.run(&["init", "--shared", "--format", "json"]);
    assert!(shared_init.status.success());
    let shared_result: Value = serde_json::from_slice(&shared_init.stdout).unwrap();
    assert_eq!(shared_result["mode"], "shared");
    assert!(shared_result["git_exclude"].is_null());
    assert_eq!(fs::read(&shared_exclude).unwrap(), shared_exclude_before);
    assert_eq!(
        fs::read(shared.root().join(".gitignore")).unwrap(),
        shared_gitignore_before
    );

    let metadata_before = fs::read(shared.root().join(".vault/workspace.json")).unwrap();
    let repeated = shared.run(&["init", "--format", "json"]);
    assert!(repeated.status.success());
    let repeated_result: Value = serde_json::from_slice(&repeated.stdout).unwrap();
    assert_eq!(repeated_result["mode"], "shared");
    assert!(repeated_result["git_exclude"].is_null());
    assert_eq!(
        fs::read(shared.root().join(".vault/workspace.json")).unwrap(),
        metadata_before
    );

    let local_vault_repository = TestWorkspace::new();
    let local_vault = local_vault_repository.root().join("frilvault-data");
    let local_external_exclude = git_path(local_vault_repository.root(), "info/exclude");
    let local_external_before = fs::read(&local_external_exclude).unwrap();
    let external_local_init = local.run(&[
        "--vault",
        local_vault.to_str().unwrap(),
        "init",
        "--format",
        "json",
    ]);
    assert!(external_local_init.status.success());
    let external_local_result: Value = serde_json::from_slice(&external_local_init.stdout).unwrap();
    assert_eq!(external_local_result["mode"], "local");
    assert_eq!(external_local_result["git_exclude"], "added");
    assert_ne!(
        fs::read(&local_external_exclude).unwrap(),
        local_external_before
    );
    assert_eq!(
        workspace_status(&local, Some(&local_vault))["git_tracking"],
        "excluded"
    );

    let shared_vault_repository = TestWorkspace::new();
    let shared_vault = shared_vault_repository.root().join("frilvault-data");
    let shared_external_exclude = git_path(shared_vault_repository.root(), "info/exclude");
    let shared_external_before = fs::read(&shared_external_exclude).unwrap();
    let external_shared_init = shared.run(&[
        "--vault",
        shared_vault.to_str().unwrap(),
        "init",
        "--shared",
        "--format",
        "json",
    ]);
    assert!(external_shared_init.status.success());
    let external_shared_result: Value =
        serde_json::from_slice(&external_shared_init.stdout).unwrap();
    assert_eq!(external_shared_result["mode"], "shared");
    assert!(external_shared_result["git_exclude"].is_null());
    assert_eq!(
        fs::read(&shared_external_exclude).unwrap(),
        shared_external_before
    );
    assert_eq!(
        workspace_status(&shared, Some(&shared_vault))["git_tracking"],
        "trackable"
    );
}

#[test]
fn missing_workspace_has_the_same_actionable_human_error() {
    let workspace = TestWorkspace::new();
    let output = workspace.run(&["status"]);

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "No FrilVault workspace found.\nRun `flvt init` to initialize one.\n"
    );
    assert!(!workspace.root().join(".vault").exists());
}

fn workspace_status(workspace: &TestWorkspace, vault_path: Option<&Path>) -> Value {
    let mut args = Vec::new();
    if let Some(vault_path) = vault_path {
        args.extend(["--vault", vault_path.to_str().unwrap()]);
    }
    args.extend(["status", "--format", "json"]);
    let output = workspace.run(&args);
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

fn git_path(root: &Path, path: &str) -> PathBuf {
    let output = Command::new("git")
        .args(["rev-parse", "--git-path", path])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(output.status.success());
    let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn git_stdout(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}
