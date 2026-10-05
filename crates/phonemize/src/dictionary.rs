//! The dictionary protocol.
//!
//! The wasm is the source of truth for *which* dictionaries are needed and what
//! is inside one; the JavaScript side only moves bytes. That split is why this
//! module speaks in names rather than paths, and why `load` takes compressed
//! bytes and does the unpacking itself: swapping a dictionary format must not
//! make the JS change.
//!
//! The registry holds decompressed bytes. That is the format the protocol asks
//! for — "解压即可用" — and the one the lindera dictionary already has: its trie and
//! connection matrix are prebuilt, so decompression is the whole of the load
//! (measured: 45.3 MB in 9.6 ms).

use std::collections::HashMap;
use std::io::Read;

use ruzstd::decoding::StreamingDecoder;

/// The zstd frame magic number (RFC 8878 §3.1.1), as it appears on the wire.
pub const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// The Japanese dictionary's name, as the JavaScript side sees it.
///
/// A constant rather than a literal in two places, because the pipeline and the
/// name list have to agree on it and nothing else would notice if they stopped:
/// the registry would hand the bytes to no one and `finish` would report them
/// loaded.
pub const IPADIC_JA: &str = "lindera-ipadic-ja";

/// The Chinese dictionary's name, as the JavaScript side sees it.
///
/// jieba's word-frequency list, uncompressed to text and handed to `jieba-rs`.
/// A dictionary rather than a compiled-in table for the reason phase 6 measured:
/// the crate's `default-dict` feature embeds exactly this file, through
/// `include-flate`, and that path pulls in the C `zstd` crate at runtime, which
/// cannot link for `wasm32-unknown-unknown` on macOS (see
/// `scripts/setup-jieba-dict.sh`). Shipping it as an asset also keeps 4.8 MB of
/// dictionary out of the wasm.
///
/// 1.6 MB compressed, built by `scripts/setup-jieba-dict.sh`.
pub const JIEBA_ZH: &str = "jieba-zh-dict";

/// The English TN tagger FST's name, as the JavaScript side sees it.
///
/// Phase 9B for English, phase 9E for the two CJK languages below. English is
/// the one language whose *phonemes* need no dictionary — the CMU dictionary is
/// compiled in — but its *numerals* come from the vendored WeText engine
/// (`crate::tn::wetext`), and that engine's grammars are OpenFST binaries,
/// so they arrive through the registry like everything else rather than being
/// embedded rather than fetched.
///
/// **The grammars are small where the numbers are.** English's pair is 707 KB
/// compressed because its cardinal grammar is enormous; Chinese's is 160 KB and
/// Japanese's 70 KB, so wiring all three adds 223 KB to an extension whose
/// dictionaries are already 9.8 MB. What is *not* small is the code: `rustfst`
/// arrived with phase 9B and is shared by all three.
///
/// The tagger is the half that recognizes an entity; the verbalizer below is the
/// half that says it. Both are needed and neither is usable without the other,
/// which is why they are two names rather than one archive: the registry's unit
/// is one zstd frame, and it already has a rule for "everything declared must
/// arrive".
pub const WETEXT_EN_TN_TAGGER: &str = "wetext-en-tn-tagger";

/// The English TN verbalizer FST's name, as the JavaScript side sees it.
///
/// 546 KB compressed, against the tagger's 161 KB. See
/// [`WETEXT_EN_TN_TAGGER`] for why there are two.
pub const WETEXT_EN_TN_VERBALIZER: &str = "wetext-en-tn-verbalizer";

/// The Chinese TN tagger FST's name, as the JavaScript side sees it.
///
/// 56 KB compressed, built by the same script from the same wheel. Chinese TN
/// needs no `full_to_half` grammar beside it: its tagger reads full-width
/// numerals and full-width punctuation itself, which the probes in
/// `crates/phonemize/tests/wetext_zh.rs` pin.
pub const WETEXT_ZH_TN_TAGGER: &str = "wetext-zh-tn-tagger";

/// The Chinese TN verbalizer FST's name, as the JavaScript side sees it.
///
/// 104 KB compressed. See [`WETEXT_ZH_TN_TAGGER`].
pub const WETEXT_ZH_TN_VERBALIZER: &str = "wetext-zh-tn-verbalizer";

/// The Japanese TN tagger FST's name, as the JavaScript side sees it.
///
/// 32 KB compressed — the smallest of the three, because Japanese entities are
/// the most regular. See [`WETEXT_ZH_TN_TAGGER`] for why Chinese and Japanese
/// need no separate full-width grammar.
pub const WETEXT_JA_TN_TAGGER: &str = "wetext-ja-tn-tagger";

/// The Japanese TN verbalizer FST's name, as the JavaScript side sees it.
///
/// 36 KB compressed. See [`WETEXT_JA_TN_TAGGER`].
pub const WETEXT_JA_TN_VERBALIZER: &str = "wetext-ja-tn-verbalizer";

/// What each frontend can speak.
///
/// The frontend is the model's phoneme inventory, and the two do not cover the
/// same languages: v1.1-zh has no Japanese frontend, so a Japanese voice on that
/// model has to fail loudly rather than phonemize into characters its tokenizer
/// drops.
pub fn supported_languages(frontend: &str) -> Option<&'static [&'static str]> {
    match frontend {
        "kokoro-v1" => Some(&["zh", "ja", "en"]),
        "kokoro-v11-zh" => Some(&["zh", "en"]),
        _ => None,
    }
}

/// The dictionaries one language needs, by primary subtag.
///
/// `None` means "not a language this pipeline knows", which is different from
/// "needs nothing" — the caller checks the frontend's language list first.
///
/// Empty is still a real answer, though no language gives it today: the English
/// CMU dictionary and the Chinese pinyin tables are compiled into the wasm
///, and only the parts that cannot be are fetched.
///
/// **Every language now fetches the two WeText TN grammars, and that is the
/// whole of what phase 9E changed here.** They are the *numeral* step rather
/// than the phoneme step, which is why a non-empty list here does not contradict
/// the rule that the phoneme data is compiled in.
fn dictionaries_for(language: &str) -> Option<&'static [&'static str]> {
    match language {
        // IPADic: prebuilt trie + connection matrix, ~10 MB compressed and
        // 45.3 MB in memory.
        "ja" => Some(&[IPADIC_JA, WETEXT_JA_TN_TAGGER, WETEXT_JA_TN_VERBALIZER]),
        // jieba's word list: plain text, 1.6 MB compressed and 4.8 MB in memory,
        // read by `jieba-rs` rather than by a dictionary builder. It is the one
        // part of Chinese that is not compiled in, because the only way
        // `jieba-rs` can embed it cannot link for wasm (see [`JIEBA_ZH`]).
        "zh" => Some(&[JIEBA_ZH, WETEXT_ZH_TN_TAGGER, WETEXT_ZH_TN_VERBALIZER]),
        // English's *phonemes* need no dictionary at all — the CMU dictionary is
        // compiled in — so this list is entirely numerals (phase 9B).
        "en" => Some(&[WETEXT_EN_TN_TAGGER, WETEXT_EN_TN_VERBALIZER]),
        _ => None,
    }
}

/// The primary subtag of a BCP-47 tag, lowercased.
///
/// `ja-JP`, `ja` and `JA` all name the same pipeline; `zh-Hant-TW` and `zh-CN`
/// do too, because the choice of Chinese script is the frontend's business, not
/// the dictionary's. Underscores are accepted because tags that came through
/// some other system's locale formatting use them.
pub fn primary_language(lang: &str) -> String {
    lang.split(['-', '_'])
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// The names one `(frontend, lang)` pair needs, or why it cannot be prepared.
pub fn dictionary_names(frontend: &str, lang: &str) -> Result<Vec<String>, DictionaryError> {
    let languages =
        supported_languages(frontend).ok_or_else(|| DictionaryError::UnknownFrontend {
            frontend: frontend.to_string(),
        })?;

    let primary = primary_language(lang);
    if !languages.contains(&primary.as_str()) {
        return Err(DictionaryError::UnsupportedLanguage {
            frontend: frontend.to_string(),
            lang: lang.to_string(),
        });
    }

    // `unwrap_or` rather than `unreachable!`: a panic inside the wasm takes the
    // whole worker with it, and the two tables disagreeing is exactly the kind
    // of edit that happens. An empty list degrades to "no dictionary", which is
    // the same failure the language would have had before this table grew.
    Ok(dictionaries_for(&primary)
        .unwrap_or(&[])
        .iter()
        .map(|name| (*name).to_string())
        .collect())
}

/// Why a dictionary could not be loaded.
///
/// Each variant has a stable [`code`](Self::code) so the JavaScript wrapper can
/// classify the failure without parsing the message, which is free to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DictionaryError {
    /// The frontend name is not one this build knows.
    UnknownFrontend { frontend: String },
    /// The frontend exists but has no pipeline for this language.
    UnsupportedLanguage { frontend: String, lang: String },
    /// `load` was called with a name `declare_required` never returned.
    UnknownDictionary { name: String, declared: Vec<String> },
    /// The bytes are not a zstd frame at all.
    NotZstd { name: String, leading: Vec<u8> },
    /// A zstd frame that does not survive decoding.
    Decompress { name: String, detail: String },
    /// `finish` was called before every required dictionary had arrived.
    Missing { names: Vec<String> },
}

impl DictionaryError {
    /// The machine-readable half of the failure, mirrored by
    /// `DictionaryFailureReason` in `lib/models/phonemize-dict.ts`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownFrontend { .. } => "unknown-frontend",
            Self::UnsupportedLanguage { .. } => "unsupported-language",
            Self::UnknownDictionary { .. } => "unknown-dictionary",
            Self::NotZstd { .. } => "dictionary-format",
            Self::Decompress { .. } => "dictionary-decompress",
            Self::Missing { .. } => "missing-dictionaries",
        }
    }
}

impl std::fmt::Display for DictionaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            Self::UnknownFrontend { frontend } => {
                write!(f, "{frontend:?} is not a frontend this build knows")
            }
            Self::UnsupportedLanguage { frontend, lang } => {
                write!(f, "{frontend} has no pipeline for {lang:?}")
            }
            Self::UnknownDictionary { name, declared } => {
                write!(f, "{name:?} was never required")?;
                if declared.is_empty() {
                    write!(f, " (nothing has been)")
                } else {
                    write!(f, "; expected one of: {}", declared.join(", "))
                }
            }
            Self::NotZstd { name, leading } => {
                // The leading bytes are in the message on purpose: "not zstd"
                // does not say whether the file was gzip, plain text or an error
                // page, and the first four bytes usually do.
                write!(f, "{name:?} is not a zstd frame")?;
                if leading.is_empty() {
                    write!(f, " (it is empty)")
                } else {
                    let hex: Vec<String> =
                        leading.iter().map(|byte| format!("{byte:02x}")).collect();
                    write!(f, " (it starts with {})", hex.join(" "))
                }
            }
            Self::Decompress { name, detail } => {
                write!(f, "{name:?} could not be decompressed: {detail}")
            }
            Self::Missing { names } => {
                write!(f, "no bytes arrived for {}", names.join(", "))
            }
        }
    }
}

impl std::error::Error for DictionaryError {}

/// Which dictionaries have been asked for, and which have arrived.
///
/// Three sets, and the difference between them matters:
///
/// - `required` is what the *last* [`declare_required`](Self::declare_required)
///   asked for. [`finish`](Self::finish) checks this one, because the caller's
///   flow is ask → fetch → feed → finish.
/// - `declared` is everything ever asked for. [`load`](Self::load) accepts these
///   and no others, so a name that no one asked about is an error rather than a
///   silently useless 45 MB.
/// - `loaded` is what is in memory. Never evicted: a dictionary is an immutable
///   extension asset, and the alternative — dropping it when the user switches
///   voices — buys back 45 MB at the price of a re-decompression on the way
///   back.
#[derive(Debug, Default)]
pub struct DictionaryRegistry {
    required: Vec<String>,
    declared: Vec<String>,
    loaded: HashMap<String, Vec<u8>>,
}

impl DictionaryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what `(frontend, lang)` needs, and return those names.
    ///
    /// Returns only this pair's names, not the union of every call: the caller
    /// is asking "what do I fetch for this voice", and a list that grew with
    /// every voice the user had ever tried would make it fetch them all again.
    ///
    /// Fails for a frontend that does not exist and for a language that frontend
    /// cannot speak, which is what makes `prepare` the earliest point a bad
    /// voice/language pairing can be reported — the user has just picked a
    /// voice, and nothing is playing yet.
    pub fn declare_required(
        &mut self,
        frontend: &str,
        lang: &str,
    ) -> Result<Vec<String>, DictionaryError> {
        let names = dictionary_names(frontend, lang)?;

        // Only after the fallible part: a rejected call must leave the state the
        // caller can still finish.
        for name in &names {
            if !self.declared.contains(name) {
                self.declared.push(name.clone());
            }
        }
        self.required = names.clone();
        Ok(names)
    }

    /// The names the last [`declare_required`](Self::declare_required) asked for.
    pub fn required(&self) -> &[String] {
        &self.required
    }

    /// Feed one dictionary, compressed.
    ///
    /// Safe to call twice for the same name: the second call is ignored, because
    /// `prepare` runs again on every voice switch and re-decompressing 45.3 MB to
    /// arrive at the bytes already in memory is pure cost. A name that was never
    /// declared is an error, not a silent no-op — dropping a dictionary would
    /// otherwise show up as a few words mispronounced rather than as a failure to
    /// start.
    pub fn load(&mut self, name: &str, compressed: &[u8]) -> Result<(), DictionaryError> {
        if !self.declared.iter().any(|declared| declared == name) {
            return Err(DictionaryError::UnknownDictionary {
                name: name.to_string(),
                declared: self.declared.clone(),
            });
        }
        if self.loaded.contains_key(name) {
            return Ok(());
        }

        let decompressed = decompress(name, compressed)?;
        self.loaded.insert(name.to_string(), decompressed);
        Ok(())
    }

    /// Check that everything the last request asked for has arrived.
    ///
    /// This only answers "did everything arrive". Turning the bytes into
    /// something usable is the next step, and it is `Phonemizer::finish_loading`
    /// that takes it: the segmenters and the text normalizers are built there.
    pub fn finish(&self) -> Result<(), DictionaryError> {
        let missing: Vec<String> = self
            .required
            .iter()
            .filter(|name| !self.loaded.contains_key(*name))
            .cloned()
            .collect();

        if missing.is_empty() {
            Ok(())
        } else {
            Err(DictionaryError::Missing { names: missing })
        }
    }

    /// The decompressed bytes of one dictionary, once it has arrived.
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.loaded.get(name).map(Vec::as_slice)
    }
}

/// Unpack a zstd frame, telling "not zstd" apart from "broken zstd".
///
/// The distinction is the point: the first is a build or packaging mistake and
/// the second is a corrupted file, and they are not fixed by the same action.
/// `ruzstd` would report both as a decode failure.
fn decompress(name: &str, compressed: &[u8]) -> Result<Vec<u8>, DictionaryError> {
    if compressed.len() < ZSTD_MAGIC.len() || compressed[..ZSTD_MAGIC.len()] != ZSTD_MAGIC {
        return Err(DictionaryError::NotZstd {
            name: name.to_string(),
            leading: compressed.iter().take(ZSTD_MAGIC.len()).copied().collect(),
        });
    }

    let mut decoder =
        StreamingDecoder::new(compressed).map_err(|error| DictionaryError::Decompress {
            name: name.to_string(),
            detail: error.to_string(),
        })?;

    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|error| DictionaryError::Decompress {
            name: name.to_string(),
            detail: error.to_string(),
        })?;

    Ok(decompressed)
}
