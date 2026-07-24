use crate::{ResolvedSymbol, SymbolAnchor, SymbolKind};

use super::marker::{symbol_marker, symbol_marker_for_name};

/// Resolves symbol anchors to current line/column positions in source text.
///
/// Resolution is text-based and uses stored signatures or symbol names as markers.
pub struct SymbolResolver;

impl SymbolResolver {
    pub fn resolve(anchor: &SymbolAnchor, content: &str) -> Option<ResolvedSymbol> {
        let marker = symbol_marker(anchor);
        let mut candidates = find_marker_positions(content, &marker);

        if candidates.is_empty() {
            // Fall back to a looser name-based marker when signature matching fails.
            let fallback = symbol_marker_for_name(&anchor.name, anchor.kind);
            if fallback != marker {
                candidates = find_marker_positions(content, &fallback);
            }
        }

        pick_best_candidate(candidates, anchor.line_hint)
    }

    pub fn find_by_name(name: &str, kind: SymbolKind, content: &str) -> Option<ResolvedSymbol> {
        let marker = symbol_marker_for_name(name, kind);
        pick_best_candidate(find_marker_positions(content, &marker), None)
    }
}

fn find_marker_positions(content: &str, marker: &str) -> Vec<ResolvedSymbol> {
    let trimmed_marker = marker.trim();

    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed_line = line.trim();

            if trimmed_line.contains(trimmed_marker) {
                let column = line
                    .find(trimmed_marker)
                    .map(|offset| offset + 1)
                    .unwrap_or(1);

                Some(ResolvedSymbol {
                    line: (index + 1) as u32,
                    column: column as u32,
                })
            } else {
                None
            }
        })
        .collect()
}

fn pick_best_candidate(
    candidates: Vec<ResolvedSymbol>,
    line_hint: Option<u32>,
) -> Option<ResolvedSymbol> {
    if candidates.is_empty() {
        return None;
    }

    match line_hint {
        Some(hint) => candidates
            .into_iter()
            .min_by_key(|candidate| candidate.line.abs_diff(hint)),
        None => candidates.into_iter().next(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SymbolAnchor;

    #[test]
    fn resolve_uses_signature_marker() {
        let anchor = SymbolAnchor {
            name: "main".to_string(),
            kind: SymbolKind::Function,
            signature: Some("fn main()".to_string()),
            line_hint: None,
        };

        let content = "fn helper() {}\n\nfn main() {\n}\n";

        let resolved = SymbolResolver::resolve(&anchor, content).unwrap();

        assert_eq!(resolved.line, 3);
    }

    #[test]
    fn resolve_prefers_line_hint_when_multiple_matches() {
        let anchor = SymbolAnchor {
            name: "process".to_string(),
            kind: SymbolKind::Function,
            signature: Some("fn process()".to_string()),
            line_hint: Some(5),
        };

        let content = "fn process() {}\n\nfn other() {}\n\nfn process() {}\n";

        let resolved = SymbolResolver::resolve(&anchor, content).unwrap();

        assert_eq!(resolved.line, 5);
    }

    #[test]
    fn find_by_name_locates_symbol() {
        let content = "struct UserService {\n    id: u64,\n}\n";

        let resolved =
            SymbolResolver::find_by_name("UserService", SymbolKind::Struct, content).unwrap();

        assert_eq!(resolved.line, 1);
    }
}
