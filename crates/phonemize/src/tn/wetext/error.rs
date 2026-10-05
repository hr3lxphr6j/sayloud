//! Error types for WeText-RS

use thiserror::Error;

/// WeText error types
///
/// Upstream also has an `IoError(#[from] std::io::Error)` variant, for the
/// `std::fs` constructors this copy does not have. It is gone with them: an
/// unused `From` impl is a way for an I/O error to arrive somewhere that has
/// no filesystem.
#[derive(Error, Debug)]
pub enum WeTextError {
    /// An FST the configuration asked for was not supplied, or a file is absent
    ///
    /// Renamed from upstream's `FstNotFound(path)`: nothing here has a path to
    /// report, so the string is the relative name the FSTs are keyed by
    /// (`"en/tn/tagger.fst"`) and the failure means "not preloaded".
    #[error("FST not available: {0}")]
    FstNotFound(String),

    /// Failed to load FST
    #[error("Failed to load FST: {0}")]
    FstLoadError(String),

    /// FST operation failed
    #[error("FST operation failed: {0}")]
    FstOperationError(String),

    /// Invalid language
    #[error("Invalid language: {0}")]
    InvalidLanguage(String),

    /// Invalid operator
    #[error("Invalid operator: {0}")]
    InvalidOperator(String),

    /// Token parse error
    #[error("Token parse error: {0}")]
    TokenParseError(String),
}

/// Result type alias for WeText operations
pub type Result<T> = std::result::Result<T, WeTextError>;
