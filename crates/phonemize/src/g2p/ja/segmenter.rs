//! Japanese segmentation, on lindera with IPADic.
//!
//! # Why this builds a `Dictionary` by hand
//!
//! lindera's Rust crate has no way to load a dictionary from memory. Its only
//! entry point is [`Dictionary::load_from_path`], which takes a directory and
//! calls `Path::is_dir()` on it — and on `wasm32-unknown-unknown` there is no
//! filesystem for it to find. The byte-loading API that the P6 verification
//! exercised (`loadDictionaryFromBytes`) belongs to `lindera-wasm`, the npm
//! package, not to the crate this builds against.
//!
//! What the crate does offer is enough to do it here: `Dictionary`'s five fields
//! are public and have no `#[non_exhaustive]`, and every component has a
//! constructor that takes bytes —
//! [`PrefixDictionary::load`](lindera_dictionary::dictionary::prefix_dictionary::PrefixDictionary::load),
//! [`ConnectionCostMatrix::load`], [`CharacterDefinition::load`],
//! [`UnknownDictionary::load`], [`Metadata::load`]. `load_from_path` is a thin
//! wrapper that reads nine files and calls exactly those. This module is the
//! same wrapper with the filesystem replaced by the dictionary container.
//!
//! The cost of that is a real coupling: this code depends on another crate's
//! struct literal and on five constructor signatures. It is pinned through
//! `Cargo.lock`, and the tests that load the real dictionary are what would
//! notice a change.
//!
//! # The container
//!
//! The nine files arrive as one zstd frame holding a tar archive, because the
//! extension ships one asset per dictionary rather than nine
//! (`public/dictionaries/lindera-ipadic-ja.bin.zst`, built by
//! `scripts/setup/setup-lindera-dict.sh`). The inner format is lindera's own,
//! untouched — the tar is a transport wrapper, and `tar tzf` after `zstd -d` is
//! a complete description of what is inside.
//!
//! # What it costs in memory
//!
//! The registry keeps the decompressed tar (45.4 MB), and the `Dictionary` built
//! from it holds a second copy of the same nine files. That is ~91 MB for
//! Japanese, against the 45.3 MB the dictionary itself needs. It is a known cost,
//! not an oversight: the fix is either to release the container once the
//! dictionary is built, or to leak one aligned buffer and hand lindera
//! `Data::Static` slices of it, and both change the phase 2 registry contract or
//! depend on worker recycling behaviour that nothing here has verified yet. The
//! memory budget has no test on either side of that trade; this is the item such
//! a test should start from.

use std::borrow::Cow;
use std::io::Read;
use std::sync::Arc;

use lindera::dictionary::Dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera_dictionary::dictionary::character_definition::CharacterDefinition;
use lindera_dictionary::dictionary::connection_cost_matrix::ConnectionCostMatrix;
use lindera_dictionary::dictionary::metadata::Metadata;
use lindera_dictionary::dictionary::prefix_dictionary::PrefixDictionary;
use lindera_dictionary::dictionary::unknown_dictionary::UnknownDictionary;

use crate::kana::{has_hiragana, has_japanese, is_kana, to_raw_katakana};

/// The file names lindera's `load_from_path` reads, and where each one goes.
///
/// Spelled out rather than derived, because the mapping from file to component
/// is the thing being reproduced; a name missing from this list is a dictionary
/// that fails to load rather than one that loads without its connection costs.
const TRIE: &str = "dict.trie";
const VALS_IDX: &str = "dict.valsidx";
const VALS: &str = "dict.vals";
const WORDS_IDX: &str = "dict.wordsidx";
const WORDS: &str = "dict.words";
const CHAR_DEF: &str = "char_def.bin";
const UNK: &str = "unk.bin";
const MATRIX: &str = "matrix.mtx";
const METADATA: &str = "metadata.json";

/// The schema field the katakana reading lives in.
///
/// **`pronunciation`, not `reading`.** IPADic carries both, and they differ
/// exactly where Japanese is written one way and said another: the topic particle
/// `は` is ハ as a reading and **ワ** as a pronunciation, `学校` is ガッコウ and
/// **ガッコー**, `調査` is チョウサ and **チョーサ**. Every front end that reads
/// Japanese for a speech model uses the pronunciation — `pron` in OpenJTalk, which
/// is what the first-generation misaki used when Kokoro's Japanese voices were
/// trained, and `pron` in UniDic, which is what the versions after it use.
///
/// Looked up by name rather than as the index it happens to be in IPADic's
/// detail array: the index is lindera's business and follows its schema, and
/// `Token::get` is the accessor that knows that.
const PRONUNCIATION_FIELD: &str = "pronunciation";

/// One dictionary word: its text, and how it is said.
///
/// `pronunciation` is `None` for a word IPADic has no pronunciation for — an
/// unknown word, a run of digits, a symbol. The caller decides what that means;
/// kuroshiro falls back to the surface form, and `read_as_katakana` below does
/// the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JaToken {
    pub surface: String,
    pub pronunciation: Option<String>,
}

/// Why a Japanese dictionary could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmenterError {
    /// The container is not a tar archive, or an entry in it is unreadable.
    Container { detail: String },
    /// A file the dictionary is made of is not in the container.
    MissingFile { name: String },
    /// lindera rejected one of the files.
    Component { file: String, detail: String },
    /// Segmentation itself failed.
    Tokenize { detail: String },
}

impl SegmenterError {
    /// A stable code for the JavaScript side, following
    /// [`DictionaryError::code`](crate::dictionary::DictionaryError::code).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Container { .. } => "dictionary-container",
            Self::MissingFile { .. } => "dictionary-incomplete",
            Self::Component { .. } => "dictionary-component",
            Self::Tokenize { .. } => "segment-failed",
        }
    }
}

impl std::fmt::Display for SegmenterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            Self::Container { detail } => write!(f, "dictionary container: {detail}"),
            Self::MissingFile { name } => {
                write!(f, "the dictionary has no {name:?}")
            }
            Self::Component { file, detail } => {
                write!(f, "{file:?} is not a usable dictionary component: {detail}")
            }
            Self::Tokenize { detail } => write!(f, "could not segment: {detail}"),
        }
    }
}

impl std::error::Error for SegmenterError {}

/// Japanese tokenization, backed by one loaded IPADic dictionary.
pub struct SegmenterJa {
    segmenter: Segmenter,
    /// The dictionary's placeholder for a detail field it does not have.
    ///
    /// IPADic writes `*` into every field it has no value for, and lindera keeps
    /// that placeholder rather than leaving the field out — so `Token::get`
    /// returns `Some("*")` for the reading of a word the dictionary does not
    /// know. kuromoji, which is what the JavaScript pipeline runs, reports no
    /// reading at all for the same word, and kuroshiro then falls back to the
    /// surface form.
    ///
    /// Reading the placeholder as a value is not a cosmetic difference: キャンプ
    /// has no IPADic entry, so its "reading" is `*`, and a pipeline that believed
    /// it produced `*` where the JavaScript produces `キャンプ` — one character of
    /// output where there were four.
    ///
    /// Taken from the dictionary's own metadata rather than hard-coded, because
    /// the placeholder is a property of the dictionary file and a differently
    /// built one could use another character.
    absent_field: String,
}

impl SegmenterJa {
    /// Build a segmenter from the decompressed dictionary container.
    ///
    /// `container` is the tar archive the registry holds — already decompressed,
    /// because the zstd frame is unwrapped before it reaches this module.
    pub fn from_container(container: &[u8]) -> Result<Self, SegmenterError> {
        let mut files = unpack(container)?;

        let prefix_dictionary = PrefixDictionary::load(
            take(&mut files, TRIE)?,
            take(&mut files, VALS_IDX)?,
            take(&mut files, VALS)?,
            take(&mut files, WORDS_IDX)?,
            take(&mut files, WORDS)?,
        )
        .map_err(|error| SegmenterError::Component {
            file: TRIE.to_string(),
            detail: error.to_string(),
        })?;

        let connection_cost_matrix = ConnectionCostMatrix::load(take(&mut files, MATRIX)?)
            .map_err(|error| SegmenterError::Component {
                file: MATRIX.to_string(),
                detail: error.to_string(),
            })?;

        let character_definition = CharacterDefinition::load(&take(&mut files, CHAR_DEF)?)
            .map_err(|error| SegmenterError::Component {
                file: CHAR_DEF.to_string(),
                detail: error.to_string(),
            })?;

        let unknown_dictionary =
            UnknownDictionary::load(&take(&mut files, UNK)?).map_err(|error| {
                SegmenterError::Component {
                    file: UNK.to_string(),
                    detail: error.to_string(),
                }
            })?;

        let metadata = Metadata::load(&take(&mut files, METADATA)?).map_err(|error| {
            SegmenterError::Component {
                file: METADATA.to_string(),
                detail: error.to_string(),
            }
        })?;

        let absent_field = metadata.default_field_value.clone();

        let dictionary = Dictionary {
            prefix_dictionary: Arc::new(prefix_dictionary),
            connection_cost_matrix: Arc::new(connection_cost_matrix),
            character_definition: Arc::new(character_definition),
            unknown_dictionary: Arc::new(unknown_dictionary),
            metadata: Arc::new(metadata),
        };

        // `Mode::Normal` is MeCab's normal mode, which is what kuromoji's
        // default tokenizer uses — and kuromoji is what the JavaScript pipeline
        // this has to agree with runs.
        Ok(Self {
            segmenter: Segmenter::new(Mode::Normal, dictionary, None),
            absent_field,
        })
    }

    /// Split `text` into words, with the pronunciation IPADic gives each one.
    pub fn tokenize(&self, text: &str) -> Result<Vec<JaToken>, SegmenterError> {
        let mut tokens = self
            .segmenter
            .segment(Cow::Borrowed(text))
            .map_err(|error| SegmenterError::Tokenize {
                detail: error.to_string(),
            })?;

        Ok(tokens
            .iter_mut()
            .map(|token| JaToken {
                surface: token.surface.to_string(),
                pronunciation: token
                    .get(PRONUNCIATION_FIELD)
                    // A field holding the dictionary's placeholder is a field the
                    // dictionary has no value for; see `absent_field`.
                    .filter(|reading| *reading != self.absent_field)
                    .map(str::to_string),
            })
            .collect())
    }

    /// The reading of `text` as katakana, which is what the IPA table is keyed in.
    ///
    /// **`text` should be a run of Japanese, not a run of one script.** The
    /// dictionary is what decides where the words are, and a kana run is not a
    /// word: 「詳しい」 is a Han character followed by a kana run, and reading those
    /// two separately leaves 「詳」 with no pronunciation of its own — the same split
    /// reads 「語る」 as カタリ + ル, which is a different word.
    /// `pipeline::phonemize_ja` therefore hands this one
    /// [run](crate::text::segment_japanese) at a time: a clause at most, split by
    /// punctuation and by Latin rather than between the scripts. Latin, digits and
    /// marks never reach it.
    ///
    /// The interesting part is not the dictionary lookup but what happens when
    /// it has no answer, and that is copied from kuroshiro's `patchTokens`
    /// because the JavaScript pipeline's output depends on it:
    ///
    /// - A word IPADic has no reading for — digits, a symbol, a name it does not
    ///   know — falls back to its surface form, **except** when the surface is
    ///   entirely kana, which is shifted to katakana. So an unknown かな word
    ///   still becomes カナ and is phonemized, while an unknown 漢字 word stays
    ///   as itself and its characters are dropped by the vocabulary gate.
    /// - A reading that contains hiragana is shifted to katakana. IPADic readings
    ///   are katakana already, so this only fires on the fallback above.
    /// - A surface with no Japanese in it is used as-is, which is how Latin text
    ///   inside a Japanese sentence reaches the pipeline as its own characters.
    ///
    /// The empty string counts as "no reading" here as it does in JavaScript,
    /// where the check is a truthiness test rather than a null test.
    pub fn read_as_katakana(&self, text: &str) -> Result<String, SegmenterError> {
        let tokens = self.tokenize(text)?;
        Ok(tokens.iter().map(read_one_token).collect())
    }
}

/// One token's contribution to the katakana reading, following kuroshiro.
fn read_one_token(token: &JaToken) -> String {
    if !has_japanese(&token.surface) {
        return token.surface.clone();
    }

    let reading = token.pronunciation.as_deref().unwrap_or("");
    if reading.is_empty() {
        return if token.surface.chars().all(is_kana) {
            to_raw_katakana(&token.surface)
        } else {
            token.surface.clone()
        };
    }

    if has_hiragana(reading) {
        to_raw_katakana(reading)
    } else {
        reading.to_string()
    }
}

/// Take one file out of the unpacked container, by name.
///
/// Removes rather than copies: the largest component is 32.7 MB
/// (`dict.words`), and handing lindera a clone of it would double that for no
/// reason — `Data` owns its `Vec` either way.
fn take(files: &mut Vec<(String, Vec<u8>)>, name: &str) -> Result<Vec<u8>, SegmenterError> {
    let index = files
        .iter()
        .position(|(file, _)| file == name)
        .ok_or_else(|| SegmenterError::MissingFile {
            name: name.to_string(),
        })?;
    Ok(files.remove(index).1)
}

/// Read the nine files out of the tar container.
///
/// Matched on the file name alone, so the archive's directory prefix is the
/// packer's business and not a second thing that has to agree.
fn unpack(container: &[u8]) -> Result<Vec<(String, Vec<u8>)>, SegmenterError> {
    let mut archive = tar::Archive::new(container);
    let entries = archive
        .entries()
        .map_err(|error| SegmenterError::Container {
            detail: error.to_string(),
        })?;

    let mut files = Vec::new();
    for entry in entries {
        let mut entry = entry.map_err(|error| SegmenterError::Container {
            detail: error.to_string(),
        })?;

        let path = entry
            .path()
            .map_err(|error| SegmenterError::Container {
                detail: error.to_string(),
            })?
            .to_path_buf();

        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            // A directory entry, or a name that is not UTF-8. Neither is a file
            // this dictionary is made of, so skipping is right — and a *missing*
            // file is caught by name below rather than by arithmetic here.
            continue;
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| SegmenterError::Container {
                detail: format!("{name}: {error}"),
            })?;
        files.push((name.to_string(), bytes));
    }

    Ok(files)
}
