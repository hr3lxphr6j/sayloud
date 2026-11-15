//! Token parsing and reordering for FST output
//!
//! This module parses the tagged token output from tagger FST and reorders
//! fields according to predefined orders for each token type.

use std::collections::HashMap;

use super::config::{Language, Operator};
use super::error::{Result, WeTextError};

// Const arrays for token field orders
// These are used to build the HashMap on-demand rather than recreating them each time

pub const TN_ORDERS_DATE: &[&str] = &["year", "month", "day"];
pub const TN_ORDERS_FRACTION: &[&str] = &["denominator", "numerator"];
pub const TN_ORDERS_MEASURE: &[&str] = &["denominator", "numerator", "value"];
pub const TN_ORDERS_MONEY: &[&str] = &["value", "currency"];
pub const TN_ORDERS_TIME: &[&str] = &["noon", "hour", "minute", "second"];

pub const EN_TN_ORDERS_DATE: &[&str] = &["preserve_order", "text", "day", "month", "year"];
pub const EN_TN_ORDERS_MONEY: &[&str] = &[
    "integer_part",
    "fractional_part",
    "quantity",
    "currency_maj",
];

pub const ITN_ORDERS_DATE: &[&str] = &["year", "month", "day"];
pub const ITN_ORDERS_FRACTION: &[&str] = &["sign", "numerator", "denominator"];
pub const ITN_ORDERS_MEASURE: &[&str] = &["numerator", "denominator", "value"];
pub const ITN_ORDERS_MONEY: &[&str] = &["currency", "value", "decimal"];
pub const ITN_ORDERS_TIME: &[&str] = &["hour", "minute", "second", "noon"];

/// Token structure representing a tagged entity
#[derive(Debug, Clone)]
pub struct Token {
    /// Token type name (e.g., "date", "money", "time")
    pub name: String,
    /// Order of fields as they were parsed
    pub order: Vec<String>,
    /// Field key-value pairs
    pub members: HashMap<String, String>,
}

impl Token {
    /// Create a new token with the given name
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            order: Vec::new(),
            members: HashMap::new(),
        }
    }

    /// Append a key-value pair to the token
    pub fn append(&mut self, key: &str, value: &str) {
        self.order.push(key.to_string());
        self.members.insert(key.to_string(), value.to_string());
    }

    /// Convert token to string with specified field order
    pub fn to_string_with_order(&self, orders: &HashMap<String, Vec<String>>) -> String {
        let mut output = format!("{} {{", self.name);

        // Determine field order
        let order = if let Some(defined_order) = orders.get(&self.name) {
            if self.members.get("preserve_order") != Some(&"true".to_string()) {
                defined_order.clone()
            } else {
                self.order.clone()
            }
        } else {
            self.order.clone()
        };

        for key in &order {
            if let Some(value) = self.members.get(key) {
                output.push_str(&format!(" {}: \"{}\"", key, value));
            }
        }

        output.push_str(" }");
        output
    }
}

/// Token parser for reordering FST output fields
///
/// Parses tagger FST output and reorders fields according to predefined orders
pub struct TokenParser {
    orders: HashMap<String, Vec<String>>,
}

impl TokenParser {
    /// Create a new token parser for the given language and operator
    ///
    /// # Arguments
    /// * `lang` - Language type
    /// * `operator` - Operation type (TN or ITN)
    pub fn new(lang: Language, operator: Operator) -> Self {
        // Note: Japanese uses the same orders as Chinese (matching Python behavior)
        // English ITN is not supported in Python (raises NotImplementedError),
        // so we return empty HashMap which means fields keep original order
        let orders = match (lang, operator) {
            (Language::En, Operator::Tn) => Self::en_tn_orders(),
            (Language::Zh | Language::Ja, Operator::Tn) => Self::tn_orders(),
            (Language::Zh | Language::Ja, Operator::Itn) => Self::itn_orders(),
            _ => HashMap::new(), // English ITN: not supported, use original order
        };

        Self { orders }
    }

    /// Chinese/Japanese TN field orders
    fn tn_orders() -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert(
            "date".to_string(),
            TN_ORDERS_DATE.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "fraction".to_string(),
            TN_ORDERS_FRACTION.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "measure".to_string(),
            TN_ORDERS_MEASURE.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "money".to_string(),
            TN_ORDERS_MONEY.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "time".to_string(),
            TN_ORDERS_TIME.iter().map(|s| s.to_string()).collect(),
        );
        m
    }

    /// English TN field orders
    fn en_tn_orders() -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert(
            "date".to_string(),
            EN_TN_ORDERS_DATE.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "money".to_string(),
            EN_TN_ORDERS_MONEY.iter().map(|s| s.to_string()).collect(),
        );
        m
    }

    /// ITN field orders
    fn itn_orders() -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert(
            "date".to_string(),
            ITN_ORDERS_DATE.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "fraction".to_string(),
            ITN_ORDERS_FRACTION.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "measure".to_string(),
            ITN_ORDERS_MEASURE.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "money".to_string(),
            ITN_ORDERS_MONEY.iter().map(|s| s.to_string()).collect(),
        );
        m.insert(
            "time".to_string(),
            ITN_ORDERS_TIME.iter().map(|s| s.to_string()).collect(),
        );
        m
    }

    /// Reorder token string fields according to predefined orders
    ///
    /// # Arguments
    /// * `input` - Tagged token string from tagger FST
    ///
    /// # Returns
    /// Reordered token string, or original input if not in token format
    pub fn reorder(&self, input: &str) -> Result<String> {
        // Handle empty input gracefully
        if input.trim().is_empty() {
            return Ok(String::new());
        }

        // Check if input looks like token format (contains '{')
        // If not, return as-is (non-token output from FST)
        if !input.contains('{') {
            return Ok(input.to_string());
        }

        match self.parse(input) {
            Ok(tokens) => {
                let output: Vec<String> = tokens
                    .iter()
                    .map(|t| t.to_string_with_order(&self.orders))
                    .collect();
                Ok(output.join(" "))
            }
            Err(_) => {
                // If parsing fails, return original input
                Ok(input.to_string())
            }
        }
    }

    /// Helper to skip characters while a predicate is true
    fn skip_while(chars: &[char], index: &mut usize, predicate: impl Fn(char) -> bool) {
        while *index < chars.len() && predicate(chars[*index]) {
            *index += 1;
        }
    }

    /// Parse token string into structured tokens
    ///
    /// Expected format: `token_name { key1: "value1" key2: "value2" }`
    fn parse(&self, input: &str) -> Result<Vec<Token>> {
        let mut tokens = Vec::new();
        let chars: Vec<char> = input.chars().collect();
        let mut index = 0;

        while index < chars.len() {
            // Skip whitespace
            Self::skip_while(&chars, &mut index, |c| c.is_whitespace());

            if index >= chars.len() {
                break;
            }

            // Parse token name (must be alphabetic or underscore)
            let name_start = index;
            Self::skip_while(&chars, &mut index, |c| c.is_ascii_alphabetic() || c == '_');
            let name: String = chars[name_start..index].iter().collect();

            // If no valid name found, check if we're at an unexpected character
            if name.is_empty() {
                // Skip unexpected characters to prevent infinite loop
                if index < chars.len() {
                    return Err(WeTextError::TokenParseError(format!(
                        "Unexpected character '{}' at position {}",
                        chars[index], index
                    )));
                }
                break;
            }

            // Skip whitespace and opening brace '{'
            Self::skip_while(&chars, &mut index, |c| c.is_whitespace() || c == '{');

            let mut token = Token::new(&name);

            // Parse key-value pairs
            loop {
                // Skip whitespace
                Self::skip_while(&chars, &mut index, |c| c.is_whitespace());

                // Check for end of token or end of input
                if index >= chars.len() || chars[index] == '}' {
                    if index < chars.len() {
                        index += 1; // Skip '}'
                    }
                    break;
                }

                // Parse key
                let key_start = index;
                Self::skip_while(&chars, &mut index, |c| c.is_ascii_alphabetic() || c == '_');
                let key: String = chars[key_start..index].iter().collect();

                // Skip empty keys (can happen with malformed input)
                if key.is_empty() {
                    // Skip the problematic character to avoid infinite loop
                    if index < chars.len() && chars[index] != '}' {
                        index += 1;
                    }
                    continue;
                }

                // Skip ':' and spaces
                Self::skip_while(&chars, &mut index, |c| c == ':' || c == ' ');

                // Skip opening quote '"'
                if index < chars.len() && chars[index] == '"' {
                    index += 1;
                }

                // Parse value (handle escape sequences)
                let mut value = String::new();
                let mut escape = false;
                while index < chars.len() && (escape || chars[index] != '"') {
                    if escape {
                        value.push(chars[index]);
                        escape = false;
                    } else if chars[index] == '\\' {
                        escape = true;
                        value.push(chars[index]);
                    } else {
                        value.push(chars[index]);
                    }
                    index += 1;
                }

                // Skip closing quote '"'
                if index < chars.len() && chars[index] == '"' {
                    index += 1;
                }

                token.append(&key, &value);
            }

            tokens.push(token);
        }

        Ok(tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_token() {
        let parser = TokenParser::new(Language::Zh, Operator::Tn);
        let input = r#"date { year: "2024" month: "1" day: "15" }"#;
        let result = parser.reorder(input).unwrap();
        // Should be ordered as year, month, day
        assert!(result.contains("year: \"2024\""));
    }

    #[test]
    fn test_empty_input() {
        let parser = TokenParser::new(Language::Zh, Operator::Tn);
        assert_eq!(parser.reorder("").unwrap(), "");
        assert_eq!(parser.reorder("   ").unwrap(), "");
    }
}
