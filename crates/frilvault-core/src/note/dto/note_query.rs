use std::path::PathBuf;

/// Unified query for listing and searching notes.
///
/// 통합 노트 목록/검색 쿼리입니다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteQuery {
    /// Restrict results to a single source file.
    ///
    /// 단일 source file 결과로 제한합니다.
    pub source_file: Option<PathBuf>,

    /// Case-insensitive substring match on note content and symbol names.
    ///
    /// note content와 symbol name에 대한 대소문자 무시 부분 문자열 검색입니다.
    pub keyword: Option<String>,

    /// Case-insensitive exact tag match.
    ///
    /// 대소문자 무시 정확 tag 일치 검색입니다.
    pub tag: Option<String>,

    /// Case-insensitive substring match on symbol anchor names.
    ///
    /// symbol anchor name에 대한 대소문자 무시 부분 문자열 검색입니다.
    pub symbol: Option<String>,
}
