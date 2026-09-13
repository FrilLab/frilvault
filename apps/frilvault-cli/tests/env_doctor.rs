#[cfg(unix)]
mod unix {
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::{Command, Output},
    };

    use frilvault_core::{EnvIdentity, EnvProfileStore, EnvRecipientStore};
    use serde_json::Value;
    use uuid::Uuid;

    const SECRET: &str = "fixture-doctor-secret";

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("frilvault-env-doctor-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
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
            let path =
                std::env::temp_dir().join(format!("frilvault-doctor-identity-{}", Uuid::new_v4()));
            let identity = EnvIdentity::generate();
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

    fn manifest(required: bool) -> &'static str {
        if required {
            "version = 1\n\n[variables.REQUIRED_TOKEN]\nrequired = true\nsecret = true\n"
        } else {
            "version = 1\n\n[variables.REQUIRED_TOKEN]\nrequired = false\nsecret = true\n"
        }
    }

    fn configure(
        workspace: &TestWorkspace,
        identity_file: &IdentityFile,
        manifest_contents: &str,
        values: BTreeMap<String, String>,
    ) {
        workspace.run(&["init"]);
        fs::create_dir_all(workspace.root().join(".vault/env")).unwrap();
        fs::write(
            workspace.root().join(".vault/env/manifest.toml"),
            manifest_contents,
        )
        .unwrap();

        let identity =
            EnvIdentity::from_encoded(&fs::read_to_string(&identity_file.path).unwrap()).unwrap();
        EnvRecipientStore::new(workspace.root().join(".vault"))
            .add("owner", &identity.public_recipient().to_string())
            .unwrap();
        EnvProfileStore::new(workspace.root())
            .save_profile("development", &values, &[&identity.public_recipient()])
            .unwrap();
    }

    #[test]
    fn ready_profile_report_is_value_free_and_lists_usable_profiles() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([("REQUIRED_TOKEN".to_string(), SECRET.to_string())]),
        );
        fs::write(
            workspace.root().join(".vault/env/profiles/unrelated.age"),
            b"corrupt ciphertext",
        )
        .unwrap();

        let output = workspace.run(&[
            "env",
            "doctor",
            "--profile",
            "development",
            "--identity-file",
            identity_file.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        let stdout = String::from_utf8(output.stdout).unwrap();
        let report: Value = serde_json::from_str(&stdout).unwrap();

        assert_eq!(report["status"], "ready");
        assert_eq!(report["profile"], "development");
        for check in [
            "manifest",
            "profile_name",
            "profile",
            "recipients",
            "identity",
            "decryption",
            "required_variables",
            "profiles",
            "plaintext_export",
        ] {
            assert_eq!(report["checks"][check]["status"], "ready");
        }
        assert_eq!(
            report["usable_profiles"],
            serde_json::json!(["development"])
        );
        assert!(!stdout.contains(SECRET));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(SECRET));
    }

    #[test]
    fn malformed_manifest_and_missing_required_value_are_reported_without_values() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([("REQUIRED_TOKEN".to_string(), SECRET.to_string())]),
        );

        fs::write(
            workspace.root().join(".vault/env/manifest.toml"),
            "version = 999\n[variables.REQUIRED_TOKEN]\nrequired = true\nsecret = true\n",
        )
        .unwrap();
        let malformed = workspace.run_raw(&[
            "env",
            "doctor",
            "--profile",
            "development",
            "--identity-file",
            identity_file.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(!malformed.status.success());
        let malformed_report: Value = serde_json::from_slice(&malformed.stdout).unwrap();
        assert_eq!(malformed_report["checks"]["manifest"]["status"], "invalid");
        assert!(!String::from_utf8_lossy(&malformed.stdout).contains(SECRET));

        fs::write(
            workspace.root().join(".vault/env/manifest.toml"),
            manifest(true),
        )
        .unwrap();
        EnvProfileStore::new(workspace.root())
            .save_profile(
                "development",
                &BTreeMap::new(),
                &[&{
                    EnvIdentity::from_encoded(&fs::read_to_string(&identity_file.path).unwrap())
                        .unwrap()
                        .public_recipient()
                }],
            )
            .unwrap();

        let missing = workspace.run_raw(&[
            "env",
            "doctor",
            "--profile",
            "development",
            "--identity-file",
            identity_file.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(!missing.status.success());
        let missing_report: Value = serde_json::from_slice(&missing.stdout).unwrap();
        assert_eq!(
            missing_report["checks"]["required_variables"]["status"],
            "missing"
        );
        assert!(!String::from_utf8_lossy(&missing.stdout).contains(SECRET));
    }

    #[test]
    fn workspace_doctor_checks_corrupt_profiles_when_env_is_configured() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([("REQUIRED_TOKEN".to_string(), SECRET.to_string())]),
        );
        fs::write(
            workspace.root().join(".vault/env/profiles/development.age"),
            b"corrupt ciphertext",
        )
        .unwrap();

        let output = workspace.run(&["doctor", "--format", "json"]);
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["missing_source_files"], serde_json::json!([]));
        assert_eq!(report["env"]["profiles"][0]["status"], "invalid");
        assert!(!String::from_utf8_lossy(&output.stdout).contains(SECRET));
    }

    #[test]
    fn missing_profile_and_invalid_recipient_registry_are_not_ready() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([("REQUIRED_TOKEN".to_string(), SECRET.to_string())]),
        );

        fs::write(
            workspace.root().join(".vault/env/recipients.toml"),
            "version = 1\nrecipients = [{ id = \"owner\", recipient = \"invalid\" }]\n",
        )
        .unwrap();
        let invalid_registry = workspace.run_raw(&[
            "env",
            "doctor",
            "--profile",
            "development",
            "--identity-file",
            identity_file.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(!invalid_registry.status.success());
        let invalid_report: Value = serde_json::from_slice(&invalid_registry.stdout).unwrap();
        assert_eq!(invalid_report["checks"]["recipients"]["status"], "invalid");
        assert!(!String::from_utf8_lossy(&invalid_registry.stdout).contains(SECRET));

        fs::write(
            workspace.root().join(".vault/env/recipients.toml"),
            "version = 1\nrecipients = []\n",
        )
        .unwrap();
        fs::remove_file(workspace.root().join(".vault/env/profiles/development.age")).unwrap();
        let missing_profile = workspace.run_raw(&[
            "env",
            "doctor",
            "--profile",
            "development",
            "--identity-file",
            identity_file.path.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(!missing_profile.status.success());
        let missing_report: Value = serde_json::from_slice(&missing_profile.stdout).unwrap();
        assert_eq!(missing_report["checks"]["profile"]["status"], "missing");
        assert!(!String::from_utf8_lossy(&missing_profile.stdout).contains(SECRET));
    }

    #[test]
    fn doctor_keeps_legacy_workspace_json_shape_without_env_configuration() {
        let workspace = TestWorkspace::new();
        workspace.run(&["init"]);

        let output = workspace.run(&["doctor", "--format", "json"]);
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report, serde_json::json!({"missing_source_files": []}));
    }
}
