#[cfg(unix)]
mod unix {
    use std::{
        fs,
        io::Write,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::{Command, Output, Stdio},
    };

    use frilvault_core::EnvIdentity;
    use serde_json::Value;
    use uuid::Uuid;

    const DATABASE_URL: &str = "DATABASE_URL";
    const LOG_LEVEL: &str = "LOG_LEVEL";
    const EMPTY_VALUE: &str = "EMPTY_VALUE";

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("frilvault-env-profiles-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn run_raw(&self, args: &[&str]) -> Output {
            Command::new(env!("CARGO_BIN_EXE_flvt"))
                .args(args)
                .current_dir(&self.root)
                .output()
                .unwrap()
        }

        fn run_stdin(&self, args: &[&str], input: &str) -> Output {
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

    struct IdentityFile {
        path: PathBuf,
    }

    impl IdentityFile {
        fn new() -> Self {
            let identity = EnvIdentity::generate();
            let path =
                std::env::temp_dir().join(format!("frilvault-env-profile-{}", Uuid::new_v4()));
            let encoded = identity.with_encoded(str::to_owned);
            fs::write(&path, format!("{encoded}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            Self { path }
        }
    }

    impl Drop for IdentityFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn manifest() -> &'static str {
        "version = 1\n\n[variables.DATABASE_URL]\nrequired = true\nsecret = true\n\n[variables.EMPTY_VALUE]\nrequired = false\nsecret = true\n\n[variables.LOG_LEVEL]\nrequired = false\nsecret = false\ndefault = \"info\"\n"
    }

    fn configure(workspace: &TestWorkspace) {
        let init = workspace.run_raw(&["init"]);
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );

        let env_init = workspace.run_raw(&["env", "init"]);
        assert!(
            env_init.status.success(),
            "{}",
            String::from_utf8_lossy(&env_init.stderr)
        );
        fs::write(
            workspace.root().join(".vault/env/manifest.toml"),
            manifest(),
        )
        .unwrap();
    }

    fn status_for<'a>(report: &'a Value, name: &str) -> &'a str {
        report["variables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variable| variable["name"] == name)
            .unwrap()["status"]
            .as_str()
            .unwrap()
    }

    #[test]
    fn initializes_sets_lists_and_validates_encrypted_profiles() {
        let workspace = TestWorkspace::new();
        let identity = IdentityFile::new();
        configure(&workspace);

        let second_init = workspace.run_raw(&["env", "init", "--format", "json"]);
        assert!(second_init.status.success());
        let second_init: Value = serde_json::from_slice(&second_init.stdout).unwrap();
        assert_eq!(second_init["created"], false);
        assert_eq!(
            fs::read_to_string(workspace.root().join(".vault/env/manifest.toml")).unwrap(),
            manifest()
        );

        let set = workspace.run_stdin(
            &[
                "env",
                "set",
                DATABASE_URL,
                "--profile",
                "development",
                "--stdin",
                "--identity-file",
                identity.path.to_str().unwrap(),
            ],
            "fixture-secret\n",
        );
        assert!(
            set.status.success(),
            "{}",
            String::from_utf8_lossy(&set.stderr)
        );

        let list = workspace.run_raw(&[
            "env",
            "list",
            "--profile",
            "development",
            "--identity-file",
            identity.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            list.status.success(),
            "{}",
            String::from_utf8_lossy(&list.stderr)
        );
        let list_stdout = String::from_utf8_lossy(&list.stdout).to_string();
        let list: Value = serde_json::from_str(&list_stdout).unwrap();
        assert_eq!(list["status"], "ready");
        assert_eq!(status_for(&list, DATABASE_URL), "configured");
        assert_eq!(status_for(&list, LOG_LEVEL), "default");
        assert!(!list_stdout.contains("fixture-secret"));

        let validate = workspace.run_raw(&[
            "env",
            "validate",
            "--profile",
            "development",
            "--identity-file",
            identity.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            validate.status.success(),
            "{}",
            String::from_utf8_lossy(&validate.stderr)
        );
        let validate_stdout = String::from_utf8_lossy(&validate.stdout).to_string();
        let validate: Value = serde_json::from_str(&validate_stdout).unwrap();
        assert_eq!(validate["status"], "ready");
        assert!(!validate_stdout.contains("fixture-secret"));

        let profile_path = workspace.root().join(".vault/env/profiles/development.age");
        assert!(profile_path.is_file());
        assert!(
            !fs::read(&profile_path)
                .unwrap()
                .windows("fixture-secret".len())
                .any(|window| window == b"fixture-secret")
        );

        let profiles = workspace.run_raw(&[
            "env",
            "profiles",
            "--identity-file",
            identity.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            profiles.status.success(),
            "{}",
            String::from_utf8_lossy(&profiles.stderr)
        );
        let profiles_stdout = String::from_utf8_lossy(&profiles.stdout).to_string();
        let profiles: Value = serde_json::from_str(&profiles_stdout).unwrap();
        assert_eq!(profiles["profiles"][0]["profile"], "development");
        assert_eq!(profiles["profiles"][0]["status"], "ready");
        assert_eq!(profiles["profiles"][0]["scope"], "this-machine");
        assert_eq!(profiles["profiles"][0]["variables"][0]["secret"], true);
        assert_eq!(
            profiles["profiles"][0]["variables"][0]["source"],
            "encrypted-profile"
        );
        assert!(!profiles_stdout.contains("fixture-secret"));
    }

    #[test]
    fn lists_profiles_without_decrypting_values_when_identity_is_unavailable() {
        let workspace = TestWorkspace::new();
        let identity = IdentityFile::new();
        configure(&workspace);

        let set = workspace.run_stdin(
            &[
                "env",
                "set",
                DATABASE_URL,
                "--profile",
                "development",
                "--stdin",
                "--identity-file",
                identity.path.to_str().unwrap(),
            ],
            "fixture-secret\n",
        );
        assert!(set.status.success());

        let profiles = workspace.run_raw(&["env", "profiles", "--format", "json"]);
        assert!(
            profiles.status.success(),
            "{}",
            String::from_utf8_lossy(&profiles.stderr)
        );
        let profiles_stdout = String::from_utf8_lossy(&profiles.stdout).to_string();
        let profiles: Value = serde_json::from_str(&profiles_stdout).unwrap();
        assert_eq!(profiles["profiles"][0]["status"], "unavailable");
        assert_eq!(profiles["profiles"][0]["scope"], "this-machine");
        assert_eq!(profiles["profiles"][0]["error_code"], "identity_missing");
        assert!(!profiles_stdout.contains("fixture-secret"));
    }

    #[test]
    fn imports_dotenv_without_overwriting_or_creating_plaintext_profiles() {
        let workspace = TestWorkspace::new();
        let identity = IdentityFile::new();
        configure(&workspace);
        let source = workspace.root().join(".env");
        let source_contents = "# local development\nexport DATABASE_URL='imported-url'\nLOG_LEVEL=debug\nEMPTY_VALUE=\n";
        fs::write(&source, source_contents).unwrap();

        let import = workspace.run_raw(&[
            "env",
            "import",
            ".env",
            "--profile",
            "imported",
            "--identity-file",
            identity.path.to_str().unwrap(),
        ]);
        assert!(
            import.status.success(),
            "{}",
            String::from_utf8_lossy(&import.stderr)
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), source_contents);

        let profile_path = workspace.root().join(".vault/env/profiles/imported.age");
        assert!(profile_path.is_file());
        assert!(
            !workspace
                .root()
                .join(".vault/env/profiles/imported")
                .exists()
        );

        let duplicate = workspace.root().join("duplicate.env");
        fs::write(&duplicate, "DATABASE_URL=first\nDATABASE_URL=second\n").unwrap();
        let duplicate_import = workspace.run_raw(&[
            "env",
            "import",
            "duplicate.env",
            "--profile",
            "duplicate",
            "--identity-file",
            identity.path.to_str().unwrap(),
        ]);
        assert!(!duplicate_import.status.success());
        assert!(
            !workspace
                .root()
                .join(".vault/env/profiles/duplicate.age")
                .exists()
        );

        let expansion = workspace.root().join("expansion.env");
        fs::write(&expansion, format!("{EMPTY_VALUE}=$HOME\n")).unwrap();
        let expansion_import = workspace.run_raw(&[
            "env",
            "import",
            "expansion.env",
            "--profile",
            "expansion",
            "--identity-file",
            identity.path.to_str().unwrap(),
        ]);
        assert!(!expansion_import.status.success());
        assert!(
            !workspace
                .root()
                .join(".vault/env/profiles/expansion.age")
                .exists()
        );

        let replacement = workspace.run_raw(&[
            "env",
            "import",
            ".env",
            "--profile",
            "imported",
            "--replace",
            "--yes",
            "--identity-file",
            identity.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            replacement.status.success(),
            "{}",
            String::from_utf8_lossy(&replacement.stderr)
        );
        let replacement_stdout = String::from_utf8_lossy(&replacement.stdout).to_string();
        let replacement: Value = serde_json::from_str(&replacement_stdout).unwrap();
        assert_eq!(replacement["replaced"], true);
        assert!(!replacement_stdout.contains("imported-url"));
    }
}
