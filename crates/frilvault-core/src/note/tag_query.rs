use std::collections::HashSet;

use crate::{FrilVaultError, FrilVaultResult, normalize_tag};

/// A parsed boolean expression for matching note tags.
///
/// Plain tag names and `tag:<name>` terms are supported. `NOT` binds most
/// tightly, followed by `AND`, then `OR`. Parentheses may override precedence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagQuery {
    expression: TagExpression,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TagExpression {
    Tag(String),
    And(Box<Self>, Box<Self>),
    Or(Box<Self>, Box<Self>),
    Not(Box<Self>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Term(String),
    And,
    Or,
    Not,
    LeftParen,
    RightParen,
}

impl TagQuery {
    /// Parses a tag expression such as `tag:performance AND NOT tag:legacy`.
    pub fn parse(input: &str) -> FrilVaultResult<Self> {
        let tokens = tokenize(input)?;

        if tokens.is_empty() {
            return Err(invalid_query("query cannot be empty"));
        }

        let mut parser = Parser::new(tokens);
        let expression = parser.parse_expression()?;

        if let Some(token) = parser.peek() {
            return Err(invalid_query(format!(
                "expected an operator before {}",
                describe_token(token)
            )));
        }

        Ok(Self { expression })
    }

    /// Builds an `AND` query from exact tag names.
    pub fn all<I, S>(tags: I) -> FrilVaultResult<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut expressions = tags.into_iter().map(|tag| tag_expression(tag.as_ref()));
        let Some(first) = expressions.next() else {
            return Err(invalid_query("at least one tag is required"));
        };

        let expression = expressions.try_fold(first?, |left, right| {
            Ok::<_, FrilVaultError>(TagExpression::And(Box::new(left), Box::new(right?)))
        })?;

        Ok(Self { expression })
    }

    /// Returns whether normalized note tags satisfy this expression.
    pub fn matches(&self, tags: &[String]) -> bool {
        let normalized = tags
            .iter()
            .map(|tag| normalize_tag(tag).to_lowercase())
            .collect::<HashSet<_>>();

        self.expression.matches(&normalized)
    }
}

impl TagExpression {
    fn matches(&self, tags: &HashSet<String>) -> bool {
        match self {
            Self::Tag(tag) => tags.contains(tag),
            Self::And(left, right) => left.matches(tags) && right.matches(tags),
            Self::Or(left, right) => left.matches(tags) || right.matches(tags),
            Self::Not(expression) => !expression.matches(tags),
        }
    }
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            position: 0,
        }
    }

    fn parse_expression(&mut self) -> FrilVaultResult<TagExpression> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> FrilVaultResult<TagExpression> {
        let mut expression = self.parse_and()?;

        while self.consume(&Token::Or) {
            if self.peek().is_none() || self.peek() == Some(&Token::RightParen) {
                return Err(invalid_query("OR must be followed by a tag expression"));
            }
            let right = self.parse_and()?;
            expression = TagExpression::Or(Box::new(expression), Box::new(right));
        }

        Ok(expression)
    }

    fn parse_and(&mut self) -> FrilVaultResult<TagExpression> {
        let mut expression = self.parse_unary()?;

        loop {
            if self.consume(&Token::And) {
                if self.peek().is_none() || self.peek() == Some(&Token::RightParen) {
                    return Err(invalid_query("AND must be followed by a tag expression"));
                }
                let right = self.parse_unary()?;
                expression = TagExpression::And(Box::new(expression), Box::new(right));
            } else if self.consume(&Token::Not) {
                if self.peek().is_none() || self.peek() == Some(&Token::RightParen) {
                    return Err(invalid_query("NOT must be followed by a tag expression"));
                }
                let right = self.parse_unary()?;
                expression = TagExpression::And(
                    Box::new(expression),
                    Box::new(TagExpression::Not(Box::new(right))),
                );
            } else {
                break;
            }
        }

        Ok(expression)
    }

    fn parse_unary(&mut self) -> FrilVaultResult<TagExpression> {
        if self.consume(&Token::Not) {
            return Ok(TagExpression::Not(Box::new(self.parse_unary()?)));
        }

        self.parse_primary()
    }

    fn parse_primary(&mut self) -> FrilVaultResult<TagExpression> {
        match self.next() {
            Some(Token::Term(term)) => tag_expression(&term),
            Some(Token::LeftParen) => {
                let expression = self.parse_expression()?;
                if !self.consume(&Token::RightParen) {
                    return Err(invalid_query("missing closing ')'"));
                }
                Ok(expression)
            }
            Some(token) => Err(invalid_query(format!(
                "expected a tag, found {}",
                describe_token(&token)
            ))),
            None => Err(invalid_query("expected a tag expression")),
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.peek()?.clone();
        self.position += 1;
        Some(token)
    }

    fn consume(&mut self, expected: &Token) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

fn tokenize(input: &str) -> FrilVaultResult<Vec<Token>> {
    let chars = input.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut position = 0;

    while position < chars.len() {
        match chars[position] {
            character if character.is_whitespace() => position += 1,
            '(' => {
                tokens.push(Token::LeftParen);
                position += 1;
            }
            ')' => {
                tokens.push(Token::RightParen);
                position += 1;
            }
            '"' => {
                position += 1;
                let start = position;
                while position < chars.len() && chars[position] != '"' {
                    position += 1;
                }
                if position == chars.len() {
                    return Err(invalid_query("unterminated quoted tag"));
                }
                tokens.push(Token::Term(chars[start..position].iter().collect()));
                position += 1;
            }
            _ => {
                let start = position;
                while position < chars.len()
                    && !chars[position].is_whitespace()
                    && !matches!(chars[position], '(' | ')')
                {
                    position += 1;
                }
                let value = chars[start..position].iter().collect::<String>();
                tokens.push(match value.to_ascii_uppercase().as_str() {
                    "AND" => Token::And,
                    "OR" => Token::Or,
                    "NOT" => Token::Not,
                    _ => Token::Term(value),
                });
            }
        }
    }

    Ok(tokens)
}

fn tag_expression(term: &str) -> FrilVaultResult<TagExpression> {
    let tag = if let Some((filter, value)) = term.split_once(':') {
        if !filter.eq_ignore_ascii_case("tag") {
            return Err(invalid_query(format!(
                "unsupported filter '{filter}:'; only tag filters are supported"
            )));
        }
        value
    } else {
        term
    };
    let tag = normalize_tag(tag);

    if tag.is_empty() {
        return Err(invalid_query("tag names cannot be empty"));
    }

    Ok(TagExpression::Tag(tag.to_lowercase()))
}

fn invalid_query(message: impl Into<String>) -> FrilVaultError {
    FrilVaultError::InvalidTagQuery(message.into())
}

fn describe_token(token: &Token) -> String {
    match token {
        Token::Term(term) => format!("'{term}'"),
        Token::And => "'AND'".to_string(),
        Token::Or => "'OR'".to_string(),
        Token::Not => "'NOT'".to_string(),
        Token::LeftParen => "'('".to_string(),
        Token::RightParen => "')'".to_string(),
    }
}
