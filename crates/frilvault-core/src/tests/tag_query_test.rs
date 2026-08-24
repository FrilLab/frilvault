use crate::{FrilVaultError, TagQuery};

#[test]
fn tag_query_applies_boolean_precedence_and_normalization() {
    let query = TagQuery::parse("tag:BUG OR tag:security AND NOT tag:legacy").unwrap();

    assert!(query.matches(&["#bug".into()]));
    assert!(query.matches(&["Security".into()]));
    assert!(!query.matches(&["security".into(), "LEGACY".into()]));
    assert!(!query.matches(&["unrelated".into()]));
}

#[test]
fn tag_query_supports_parentheses_exclusion_and_quoted_names() {
    let query = TagQuery::parse("(tag:architecture OR \"tag:needs review\") NOT #legacy").unwrap();

    assert!(query.matches(&["needs review".into()]));
    assert!(query.matches(&["architecture".into()]));
    assert!(!query.matches(&["architecture".into(), "legacy".into()]));
}

#[test]
fn repeated_tags_build_an_and_query() {
    let query = TagQuery::all([" #Performance ", "parser"]).unwrap();

    assert!(query.matches(&["performance".into(), "PARSER".into()]));
    assert!(!query.matches(&["performance".into()]));
}

#[test]
fn malformed_queries_return_actionable_errors() {
    for (input, expected) in [
        ("", "query cannot be empty"),
        ("tag:bug OR", "OR must be followed"),
        ("tag:bug tag:security", "expected an operator"),
        ("path:src", "only tag filters are supported"),
        ("(tag:bug", "missing closing"),
        ("\"tag:needs review", "unterminated quoted tag"),
    ] {
        let error = TagQuery::parse(input).unwrap_err();
        assert!(matches!(error, FrilVaultError::InvalidTagQuery(_)));
        assert!(error.to_string().contains(expected), "{error}");
    }
}
