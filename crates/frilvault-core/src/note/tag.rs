use std::collections::HashSet;

/// Trims a tag and removes one optional leading `#`.
pub fn normalize_tag(tag: &str) -> String {
    tag.trim()
        .strip_prefix('#')
        .unwrap_or(tag.trim())
        .trim()
        .to_string()
}

/// Normalizes tags and removes case-insensitive duplicates while preserving
/// the spelling and order of the first occurrence.
pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();

    tags.into_iter()
        .filter_map(|tag| {
            let tag = normalize_tag(&tag);
            (!tag.is_empty() && seen.insert(tag.to_lowercase())).then_some(tag)
        })
        .collect()
}
