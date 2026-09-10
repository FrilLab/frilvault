#[cfg(unix)]
mod unix {
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::{Command, Output},
    };

    use frilvault_core::{EnvIdentity, EnvProfileStore};
    use uuid::Uuid;

    const SECRET_KEY: &str = "FLVT_ENV_TEST_SECRET";
    const COLLISION_KEY: &str = "FLVT_ENV_TEST_COLLISION";
    const SECRET_VALUE: &str = "fixture-profile-secret";

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("frilvault-env-run-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn init(&self) {
            let output = self.run_raw(&["init"]);
            assert!(
                output.status.success(),
                "flvt init failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
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
                std::env::temp_dir().join(format!("frilvault-env-identity-{}", Uuid::new_v4()));
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

    fn configure_profile(
        workspace: &TestWorkspace,
        identity_file: &IdentityFile,
        manifest: &str,
        values: BTreeMap<String, String>,
    ) {
        workspace.init();
        fs::create_dir_all(workspace.root().join(".vault/env")).unwrap();
        fs::write(workspace.root().join(".vault/env/manifest.toml"), manifest).unwrap();

        let identity =
            EnvIdentity::from_encoded(&fs::read_to_string(&identity_file.path).unwrap()).unwrap();
        let recipient = identity.public_recipient();
        EnvProfileStore::new(workspace.root())
            .save_profile("development", &values, &[&recipient])
            .unwrap();
    }

    fn manifest(required: bool) -> &'static str {
        if required {
            "version = 1\n\n[variables.FLVT_ENV_TEST_SECRET]\nrequired = true\nsecret = true\n\n[variables.FLVT_ENV_TEST_COLLISION]\nrequired = false\nsecret = true\n"
        } else {
            "version = 1\n\n[variables.FLVT_ENV_TEST_SECRET]\nrequired = false\nsecret = true\n\n[variables.FLVT_ENV_TEST_COLLISION]\nrequired = false\nsecret = true\n"
        }
    }

    #[test]
    fn injects_profile_values_and_preserves_parent_environment() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure_profile(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([
                (SECRET_KEY.to_string(), SECRET_VALUE.to_string()),
                (COLLISION_KEY.to_string(), "profile-value".to_string()),
            ]),
        );

        let output = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                "printf '%s\\n%s' \"$FLVT_ENV_TEST_SECRET\" \"$FLVT_ENV_TEST_COLLISION\"",
            ])
            .env(COLLISION_KEY, "parent-value")
            .current_dir(workspace.root())
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "fixture-profile-secret\nprofile-value"
        );
        assert!(output.stderr.is_empty());
        assert!(!workspace.root().join(".env").exists());
    }

    #[test]
    fn preserves_child_output_and_exit_status_without_printing_a_secret() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure_profile(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([(SECRET_KEY.to_string(), SECRET_VALUE.to_string())]),
        );

        let output = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                "printf '%s' child-stderr >&2; exit 23",
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(23));
        assert_eq!(String::from_utf8_lossy(&output.stderr), "child-stderr");
        assert!(!String::from_utf8_lossy(&output.stderr).contains(SECRET_VALUE));
    }

    #[test]
    fn rejects_missing_required_values_before_spawning() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure_profile(&workspace, &identity_file, manifest(true), BTreeMap::new());
        let marker = workspace.root().join("spawned");
        let marker_string = marker.to_str().unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                &format!("touch '{marker_string}'"),
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();

        assert!(!output.status.success());
        assert!(!marker.exists());
        assert!(String::from_utf8_lossy(&output.stderr).contains("required environment variable"));
    }

    #[test]
    fn rejects_invalid_manifest_and_missing_profile_before_spawning() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure_profile(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([(SECRET_KEY.to_string(), SECRET_VALUE.to_string())]),
        );
        let manifest_path = workspace.root().join(".vault/env/manifest.toml");
        let invalid_manifest = "version = 1\n\n[variables.FLVT_ENV_TEST_SECRET]\nrequired = true\nsecret = true\ndefault = \"fixture-secret-must-not-be-accepted\"\n";
        fs::write(&manifest_path, invalid_manifest).unwrap();
        let invalid_marker = workspace.root().join("invalid-manifest-spawned");

        let invalid = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                "touch invalid-manifest-spawned",
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();
        assert!(!invalid.status.success());
        assert!(!invalid_marker.exists());
        assert!(!String::from_utf8_lossy(&invalid.stderr).contains(SECRET_VALUE));

        fs::write(&manifest_path, manifest(false)).unwrap();
        fs::remove_file(workspace.root().join(".vault/env/profiles/development.age")).unwrap();
        let missing = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                "touch missing-profile-spawned",
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();
        assert!(!missing.status.success());
        assert!(!workspace.root().join("missing-profile-spawned").exists());
        assert!(!String::from_utf8_lossy(&missing.stderr).contains(SECRET_VALUE));
    }

    #[test]
    fn rejects_corrupt_profiles_and_spawn_failures_without_secret_errors() {
        let workspace = TestWorkspace::new();
        let identity_file = IdentityFile::new();
        configure_profile(
            &workspace,
            &identity_file,
            manifest(false),
            BTreeMap::from([(SECRET_KEY.to_string(), SECRET_VALUE.to_string())]),
        );
        let profile_path = workspace.root().join(".vault/env/profiles/development.age");
        fs::write(profile_path, b"corrupt ciphertext").unwrap();

        let corrupt = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "sh",
                "-c",
                "touch spawned",
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();
        assert!(!corrupt.status.success());
        assert!(!workspace.root().join("spawned").exists());
        assert!(!String::from_utf8_lossy(&corrupt.stderr).contains(SECRET_VALUE));

        let identity =
            EnvIdentity::from_encoded(&fs::read_to_string(&identity_file.path).unwrap()).unwrap();
        let recipient = identity.public_recipient();
        EnvProfileStore::new(workspace.root())
            .save_profile(
                "development",
                &BTreeMap::from([(SECRET_KEY.to_string(), SECRET_VALUE.to_string())]),
                &[&recipient],
            )
            .unwrap();

        let spawn_failure = Command::new(env!("CARGO_BIN_EXE_flvt"))
            .args([
                "env",
                "run",
                "--profile",
                "development",
                "--identity-file",
                identity_file.path.to_str().unwrap(),
                "--",
                "flvt-command-does-not-exist",
            ])
            .current_dir(workspace.root())
            .output()
            .unwrap();
        assert!(!spawn_failure.status.success());
        assert!(
            String::from_utf8_lossy(&spawn_failure.stderr)
                .contains("failed to spawn child process")
        );
        assert!(!String::from_utf8_lossy(&spawn_failure.stderr).contains(SECRET_VALUE));
    }
}
