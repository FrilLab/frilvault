use clap::Parser;

use crate::cli::{
    Cli, Commands, add::SymbolKindArg, format::FormatArg, gitignore::GitignoreAction,
    tag::TagAction,
};

#[test]
fn parses_init_with_local_mode_by_default() {
    let cli = Cli::parse_from(["flvt", "init"]);

    match cli.command {
        Commands::Init(command) => assert!(!command.shared),
        _ => panic!("expected init command"),
    }
}

#[test]
fn parses_init_with_shared_mode() {
    let cli = Cli::parse_from(["flvt", "init", "--shared"]);

    match cli.command {
        Commands::Init(command) => assert!(command.shared),
        _ => panic!("expected init command"),
    }
}

#[test]
fn parses_init_json_format() {
    let cli = Cli::parse_from(["flvt", "init", "--format", "json"]);

    match cli.command {
        Commands::Init(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected init command"),
    }
}

#[test]
fn parses_list_format_json() {
    let cli = Cli::parse_from(["flvt", "list", "--file", "src/main.rs", "--format", "json"]);

    match cli.command {
        Commands::List(command) => {
            assert_eq!(command.file, "src/main.rs");
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected list command"),
    }
}

#[test]
fn parses_list_format_text() {
    let cli = Cli::parse_from(["flvt", "list", "--file", "src/main.rs", "--format", "text"]);

    match cli.command {
        Commands::List(command) => {
            assert!(matches!(command.format, Some(FormatArg::Text)));
        }
        _ => panic!("expected list command"),
    }
}

#[test]
fn parses_search_with_file_and_json_format() {
    let cli = Cli::parse_from([
        "flvt",
        "search",
        "--file",
        "src/main.rs",
        "--format",
        "json",
    ]);

    match cli.command {
        Commands::Search(command) => {
            assert_eq!(command.keyword, None);
            assert_eq!(command.file.as_deref(), Some("src/main.rs"));
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected search command"),
    }
}

#[test]
fn parses_health_command_alias() {
    let cli = Cli::parse_from(["flvt", "health"]);

    match cli.command {
        Commands::Health(command) => {
            assert!(command.format.is_none());
        }
        _ => panic!("expected health command"),
    }
}

#[test]
fn parses_stats_json_format() {
    let cli = Cli::parse_from(["flvt", "stats", "--format", "json"]);

    match cli.command {
        Commands::Stats(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected stats command"),
    }
}

#[test]
fn parses_status_command() {
    let cli = Cli::parse_from(["flvt", "status"]);

    assert!(matches!(cli.command, Commands::Status(_)));
}

#[test]
fn parses_index_json_format() {
    let cli = Cli::parse_from(["flvt", "index", "--format", "json"]);

    match cli.command {
        Commands::Index(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected index command"),
    }
}

#[test]
fn parses_explorer_json_format() {
    let cli = Cli::parse_from(["flvt", "explorer", "--format", "json"]);

    match cli.command {
        Commands::Explorer(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected explorer command"),
    }
}

#[test]
fn parses_sync_json_format() {
    let cli = Cli::parse_from(["flvt", "sync", "--format", "json"]);

    match cli.command {
        Commands::Sync(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
            assert!(!command.notes_only);
            assert!(!command.sources_only);
        }
        _ => panic!("expected sync command"),
    }
}

#[test]
fn rejects_legacy_json_flag() {
    match Cli::try_parse_from(["flvt", "doctor", "--json"]) {
        Err(error) => assert!(error.to_string().contains("--json")),
        Ok(_) => panic!("expected legacy --json flag to be rejected"),
    }
}

#[test]
fn parses_repair_json_format() {
    let cli = Cli::parse_from(["flvt", "repair", "--format", "json"]);

    match cli.command {
        Commands::Repair(command) => {
            assert!(!command.apply);
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected repair command"),
    }
}

#[test]
fn parses_repair_interactive_flag() {
    let cli = Cli::parse_from(["flvt", "repair", "--interactive"]);

    match cli.command {
        Commands::Repair(command) => {
            assert!(command.interactive);
            assert!(!command.apply);
        }
        _ => panic!("expected repair command"),
    }
}

#[test]
fn parses_health_json_format() {
    let cli = Cli::parse_from(["flvt", "health", "--format", "json"]);

    match cli.command {
        Commands::Health(command) => {
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected health command"),
    }
}

#[test]
fn parses_symbol_add_command() {
    let cli = Cli::parse_from([
        "flvt",
        "add",
        "--file",
        "src/main.rs",
        "--symbol",
        "main",
        "--kind",
        "function",
        "--content",
        "note",
    ]);

    match cli.command {
        Commands::Add(command) => {
            assert_eq!(command.symbol.as_deref(), Some("main"));
            assert!(matches!(command.kind, SymbolKindArg::Function));
            assert_eq!(command.content, "note");
        }
        _ => panic!("expected add command"),
    }
}

#[test]
fn parses_add_command_with_tags() {
    let cli = Cli::parse_from([
        "flvt",
        "add",
        "--file",
        "src/main.rs",
        "--line",
        "1",
        "--content",
        "note",
        "--tag",
        "bug",
        "--tag",
        "architecture",
    ]);

    match cli.command {
        Commands::Add(command) => {
            assert_eq!(command.tags, vec!["bug", "architecture"]);
        }
        _ => panic!("expected add command"),
    }
}

#[test]
fn parses_search_with_tag() {
    let cli = Cli::parse_from(["flvt", "search", "--tag", "bug", "--format", "json"]);

    match cli.command {
        Commands::Search(command) => {
            assert_eq!(command.tag.as_deref(), Some("bug"));
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected search command"),
    }
}

#[test]
fn parses_gitignore_check_json_format() {
    let cli = Cli::parse_from(["flvt", "gitignore", "check", "--format", "json"]);

    match cli.command {
        Commands::Gitignore(command) => match command.action {
            GitignoreAction::Check(check) => {
                assert!(matches!(check.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected gitignore check command"),
        },
        _ => panic!("expected gitignore command"),
    }
}

#[test]
fn parses_attach_command() {
    let cli = Cli::parse_from([
        "flvt",
        "attach",
        "--file",
        "src/main.rs",
        "--id",
        "550e8400-e29b-41d4-a716-446655440000",
        "--image",
        "screenshot.png",
        "--format",
        "json",
    ]);

    match cli.command {
        Commands::Attach(command) => {
            assert_eq!(command.file, "src/main.rs");
            assert_eq!(command.id, "550e8400-e29b-41d4-a716-446655440000");
            assert_eq!(command.image, "screenshot.png");
            assert!(matches!(command.format, Some(FormatArg::Json)));
        }
        _ => panic!("expected attach command"),
    }
}

#[test]
fn resolve_format_defaults_to_text() {
    use crate::output::{OutputFormat, resolve_format};

    assert!(matches!(resolve_format(None), OutputFormat::Text));
    assert!(matches!(
        resolve_format(Some(FormatArg::Text)),
        OutputFormat::Text
    ));
    assert!(matches!(
        resolve_format(Some(FormatArg::Json)),
        OutputFormat::Json
    ));
}

#[test]
fn parses_tag_rename_command() {
    let cli = Cli::parse_from([
        "flvt",
        "tag",
        "rename",
        "todo",
        "task",
        "--dry-run",
        "--format",
        "json",
    ]);

    match cli.command {
        Commands::Tag(command) => match command.action {
            TagAction::Rename(rename) => {
                assert_eq!(rename.old_tag, "todo");
                assert_eq!(rename.new_tag, "task");
                assert!(rename.dry_run);
                assert!(matches!(rename.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected tag rename action"),
        },
        _ => panic!("expected tag command"),
    }
}

#[test]
fn parses_tag_merge_command() {
    let cli = Cli::parse_from([
        "flvt", "tag", "merge", "bug", "defect", "--into", "issue", "--format", "json",
    ]);

    match cli.command {
        Commands::Tag(command) => match command.action {
            TagAction::Merge(merge) => {
                assert_eq!(merge.sources, vec!["bug", "defect"]);
                assert_eq!(merge.into, "issue");
                assert!(!merge.dry_run);
                assert!(matches!(merge.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected tag merge action"),
        },
        _ => panic!("expected tag command"),
    }
}

#[test]
fn parses_tag_remove_command() {
    let cli = Cli::parse_from([
        "flvt", "tag", "remove", "legacy", "--yes", "--format", "json",
    ]);

    match cli.command {
        Commands::Tag(command) => match command.action {
            TagAction::Remove(remove) => {
                assert_eq!(remove.tag, "legacy");
                assert!(remove.yes);
                assert!(!remove.dry_run);
                assert!(matches!(remove.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected tag remove action"),
        },
        _ => panic!("expected tag command"),
    }
}

#[test]
fn parses_tag_list_command() {
    let cli = Cli::parse_from(["flvt", "tag", "list", "--unused", "--format", "json"]);

    match cli.command {
        Commands::Tag(command) => match command.action {
            TagAction::List(list) => {
                assert!(list.unused);
                assert!(matches!(list.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected tag list action"),
        },
        _ => panic!("expected tag command"),
    }
}

#[test]
fn parses_tag_stats_command_with_directory_breakdown() {
    let cli = Cli::parse_from([
        "flvt",
        "tag",
        "stats",
        "--tag",
        "architecture",
        "--group-by",
        "directory",
        "--format",
        "json",
    ]);

    match cli.command {
        Commands::Tag(command) => match command.action {
            TagAction::Stats(stats) => {
                assert_eq!(stats.tag.as_deref(), Some("architecture"));
                assert!(matches!(
                    stats.group_by,
                    Some(crate::cli::tag::TagGroupByArg::Directory)
                ));
                assert!(matches!(stats.format, Some(FormatArg::Json)));
            }
            _ => panic!("expected tag stats action"),
        },
        _ => panic!("expected tag command"),
    }
}
