use super::helper::{create_test_note_service, create_test_workspace};
use crate::{
    AddNoteRequest, AttachmentRepository, FrilVaultError, LineAnchor, NoteAnchor,
    workspace::PathResolver,
};

use std::fs;

#[test]
fn attach_image_stores_file_and_updates_note_metadata() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();

    let image_path = workspace_root.join("screenshot.png");
    fs::write(&image_path, b"\x89PNG\r\n\x1a\n").unwrap();

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "see screenshot".to_string(),
            tags: None,
        })
        .unwrap();

    let attachment = service
        .attach_image("src/main.rs", note.id, &image_path)
        .unwrap();

    assert_eq!(attachment.filename, "screenshot.png");
    assert_eq!(attachment.mime_type, "image/png");
    assert_eq!(attachment.extension, "png");

    let stored_path = PathResolver::new(workspace_root).resolve_attachment_path(
        note.id,
        attachment.id,
        &attachment.extension,
    );
    assert!(stored_path.exists());

    let notes = service.list_notes("src/main.rs").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].note.attachments.len(), 1);
    assert_eq!(notes[0].note.attachments[0].id, attachment.id);
}

#[test]
fn detach_image_removes_file_and_metadata() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();

    let image_path = workspace_root.join("diagram.jpg");
    fs::write(&image_path, b"fake-jpeg").unwrap();

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "diagram".to_string(),
            tags: None,
        })
        .unwrap();

    let attachment = service
        .attach_image("src/main.rs", note.id, &image_path)
        .unwrap();

    service
        .detach_image("src/main.rs", note.id, attachment.id)
        .unwrap();

    let stored_path = PathResolver::new(workspace_root).resolve_attachment_path(
        note.id,
        attachment.id,
        &attachment.extension,
    );
    assert!(!stored_path.exists());

    let notes = service.list_notes("src/main.rs").unwrap();
    assert!(notes[0].note.attachments.is_empty());
}

#[test]
fn delete_note_removes_image_directory() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);

    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();

    let image_path = workspace_root.join("photo.webp");
    fs::write(&image_path, b"fake-webp").unwrap();

    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "photo note".to_string(),
            tags: None,
        })
        .unwrap();

    service
        .attach_image("src/main.rs", note.id, &image_path)
        .unwrap();

    let images_dir = PathResolver::new(workspace_root).note_images_dir(note.id);
    assert!(images_dir.exists());

    service.delete_note("src/main.rs", note.id).unwrap();

    assert!(!images_dir.exists());
}

#[cfg(unix)]
#[test]
fn failed_note_delete_preserves_attachments() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();
    let image_path = workspace_root.join("photo.png");
    fs::write(&image_path, b"fake-png").unwrap();
    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "must remain intact".to_string(),
            tags: None,
        })
        .unwrap();
    let attachment = service
        .attach_image("src/main.rs", note.id, &image_path)
        .unwrap();
    let resolver = PathResolver::new(workspace_root);
    let stored_path =
        resolver.resolve_attachment_path(note.id, attachment.id, &attachment.extension);
    let notes_parent = resolver.notes_root().join("src");

    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o555)).unwrap();
    let result = service.delete_note("src/main.rs", note.id);
    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(result.is_err());
    assert!(stored_path.exists());
    assert_eq!(service.list_notes("src/main.rs").unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn failed_attachment_detach_preserves_the_image() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();
    let image_path = workspace_root.join("diagram.png");
    fs::write(&image_path, b"fake-png").unwrap();
    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "must remain attached".to_string(),
            tags: None,
        })
        .unwrap();
    let attachment = service
        .attach_image("src/main.rs", note.id, &image_path)
        .unwrap();
    let resolver = PathResolver::new(workspace_root);
    let stored_path =
        resolver.resolve_attachment_path(note.id, attachment.id, &attachment.extension);
    let notes_parent = resolver.notes_root().join("src");

    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o555)).unwrap();
    let result = service.detach_image("src/main.rs", note.id, attachment.id);
    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(result.is_err());
    assert!(stored_path.exists());
    assert_eq!(
        service.list_notes("src/main.rs").unwrap()[0]
            .note
            .attachments
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn failed_attachment_add_removes_the_new_orphan_file() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let mut service = create_test_note_service(workspace_root);
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/main.rs"), "fn main() {}\n").unwrap();
    let image_path = workspace_root.join("new.png");
    fs::write(&image_path, b"fake-png").unwrap();
    let note = service
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "attachment must be atomic".to_string(),
            tags: None,
        })
        .unwrap();
    let resolver = PathResolver::new(workspace_root);
    let notes_parent = resolver.notes_root().join("src");

    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o555)).unwrap();
    let result = service.attach_image("src/main.rs", note.id, &image_path);
    fs::set_permissions(&notes_parent, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(result.is_err());
    let image_files = fs::read_dir(resolver.note_images_dir(note.id))
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(image_files, 0);
    assert!(
        service.list_notes("src/main.rs").unwrap()[0]
            .note
            .attachments
            .is_empty()
    );
}

#[test]
fn attachment_repository_rejects_unsupported_image_type() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let repository = AttachmentRepository::new(PathResolver::new(workspace_root));

    let note_id = uuid::Uuid::new_v4();
    let image_path = workspace_root.join("notes.txt");
    fs::write(&image_path, b"not an image").unwrap();

    let error = repository.store(note_id, &image_path).unwrap_err();

    assert!(matches!(error, FrilVaultError::InvalidImageType(_)));
}

#[test]
fn attachment_repository_rejects_oversized_image() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let repository = AttachmentRepository::new(PathResolver::new(workspace_root));

    let note_id = uuid::Uuid::new_v4();
    let image_path = workspace_root.join("large.png");
    fs::write(
        &image_path,
        vec![0_u8; crate::constants::MAX_IMAGE_BYTES + 1],
    )
    .unwrap();

    let error = repository.store(note_id, &image_path).unwrap_err();

    assert!(matches!(error, FrilVaultError::ImageTooLarge { .. }));
}
