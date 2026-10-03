//! Rust phonemization pipeline for SayLoud (P6).
//!
//! Compiled to a single wasm module that replaces the JavaScript chain
//! (kuromoji + kuroshiro + jieba + espeak + pinyin-pro). See
//! `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`.
//!
//! Japanese is the language that works end to end today: the dictionary
//! protocol (§3.2) is what gets IPADic into the module, and [`pipeline`] is what
//! turns text into phonemes with it. English is wired as well — first as the
//! backend the Latin runs of a Japanese sentence go through, then as a pipeline
//! of its own once the numeral reading landed ([`pipeline::phonemize_en`]); the
//! dictionary it needs is compiled in, so there is nothing to fetch for it.
//! Chinese is complete as of phase 6: [`pipeline::phonemize_zh`] has the numeral,
//! punctuation, word-boundary and mixed-script rules, and the one thing it
//! fetches is jieba's word list, because the crate's own embedded-dictionary
//! feature cannot link for wasm (see [`dictionary::JIEBA_ZH`]).

use std::sync::OnceLock;

use wasm_bindgen::prelude::*;

pub mod backends;
pub mod dictionary;
pub mod frontends;
pub mod kana;
pub mod pipeline;
pub mod text;
mod types;
pub mod vocab;

use backends::g2p_en::EnglishG2p;
use backends::segmenter_ja::{SegmenterError, SegmenterJa};
use backends::segmenter_zh::{SegmenterZh, SegmenterZhError};
use dictionary::{DictionaryError, DictionaryRegistry, IPADIC_JA, JIEBA_ZH};
use pipeline::PipelineError;
use vocab::{validate_phonemes, Vocab, VocabError};

pub use types::{FrontendId, PhonemeSpan, PhonemizeOptions, PhonemizeResult};

/// Text-to-phonemes engine.
///
/// The JS side keeps one instance per phonemize worker, in
/// `lib/models/phonemize-rust.ts`.
#[wasm_bindgen]
#[derive(Default)]
pub struct Phonemizer {
    dictionaries: DictionaryRegistry,
    /// The Japanese segmenter, built once from the dictionary bytes.
    ///
    /// Not rebuilt on a later `prepare`: the dictionary is immutable and never
    /// evicted, so a second build could only arrive at the same object at the
    /// cost of another 45 MB of copying.
    japanese: Option<SegmenterJa>,
    /// The Chinese segmenter, built the same way and for the same reason.
    ///
    /// A second `Option` rather than a shared one because the two are not
    /// interchangeable: they read different dictionaries and answer different
    /// questions, and a language that has been prepared keeps its segmenter when
    /// a later `prepare` is for another one.
    chinese: Option<SegmenterZh>,
    /// The English backend, built on the first use rather than on `prepare`.
    ///
    /// It needs no dictionary — the CMU dictionary is compiled into this module
    /// — but building it parses that dictionary, which is 27 ms and ~13 MB in the
    /// wasm. A Japanese sentence with no Latin text in it never uses it, and
    /// most of them have none, so the cost is paid by the text that asks for it.
    ///
    /// `None` inside the cell is a build that cannot phonemize English at all;
    /// see `pipeline::phonemize_ja` for why that is a warning rather than an
    /// error.
    english: OnceLock<Option<EnglishG2p>>,
}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Which dictionaries this `(frontend, lang)` pair needs, by name.
    ///
    /// The JS side asks rather than decides: which files a dictionary consists
    /// of is a Rust-side detail, and a change of format should not be a change
    /// of JavaScript (spec §3.2). Names, not URLs — the caller owns where the
    /// bytes come from, because the extension already has a resource cache and
    /// the wasm should not grow a second one.
    ///
    /// Throws for a frontend this build does not know, and for a language that
    /// frontend cannot speak (spec §2.2).
    pub fn required_dictionaries(
        &mut self,
        frontend: &str,
        lang: &str,
    ) -> Result<Vec<String>, JsValue> {
        self.dictionaries
            .declare_required(frontend, lang)
            .map_err(dictionary_error)
    }

    /// Feed one dictionary, compressed. Repeatable, and order-independent.
    ///
    /// `name` has to be one `required_dictionaries` returned. An unknown name
    /// throws instead of being ignored, so a missing dictionary is a failure to
    /// start rather than a handful of words read wrong.
    pub fn load_dictionary(&mut self, name: &str, compressed: &[u8]) -> Result<(), JsValue> {
        self.dictionaries
            .load(name, compressed)
            .map_err(dictionary_error)
    }

    /// Everything the last request asked for has arrived; build what is built
    /// from it.
    ///
    /// Throws with the names still missing. The caller is expected to have
    /// awaited every fetch first — this is the seam that turns a partial load
    /// into an error rather than into a pipeline that runs with half its
    /// dictionary.
    ///
    /// It is also where a dictionary stops being bytes: the Japanese segmenter
    /// is constructed here, so a container that cannot be unpacked, or that
    /// lindera rejects, fails before the user picks a voice rather than in the
    /// middle of a sentence.
    pub fn finish_loading(&mut self) -> Result<(), JsValue> {
        self.dictionaries.finish().map_err(dictionary_error)?;
        self.build_backends().map_err(backend_error)
    }

    /// Resolves once the module is usable.
    ///
    /// Nothing to wait for yet: the module is usable as soon as wasm-bindgen has
    /// instantiated it, which the JS `init()` already awaits. Dictionaries are
    /// loaded later and explicitly, through `prepare()` on the JS side (spec
    /// §3.1), so this stays a resolved promise.
    pub fn ready(&self) -> js_sys::Promise {
        js_sys::Promise::resolve(&JsValue::NULL)
    }

    /// Text to phonemes, synchronously.
    ///
    /// Throws when the frontend cannot speak `lang`, and when `prepare` was
    /// never called for it — a missing dictionary is a failure to phonemize, not
    /// a sentence that comes out short.
    pub fn phonemize(&self, text: &str, options: &JsValue) -> Result<JsValue, JsValue> {
        let options: PhonemizeOptions = serde_wasm_bindgen::from_value(options.clone())
            .map_err(|error| thrown_error("invalid-options", &error.to_string()))?;

        let result = self
            .phonemize_with(text, &options)
            .map_err(phonemize_error)?;

        serde_wasm_bindgen::to_value(&result)
            .map_err(|error| thrown_error("serialization", &error.to_string()))
    }
}

/// The half of the engine that does not cross the wasm boundary.
///
/// Split from the `#[wasm_bindgen]` block because these take and return plain
/// Rust types: `wasm-bindgen` can only export signatures it can express, and
/// keeping the pipeline callable from a native test is the whole reason the
/// parity corpus runs under `cargo test`.
impl Phonemizer {
    /// Text to phonemes, against a plain options struct.
    pub fn phonemize_with(
        &self,
        text: &str,
        options: &PhonemizeOptions,
    ) -> Result<PhonemizeResult, PhonemizeError> {
        // Which languages a frontend can speak is the dictionary table's
        // question, so ask it rather than repeating the answer — this is the
        // same check `required_dictionaries` makes, and the same one that
        // rejects a Japanese voice on v1.1-zh (spec §1.3, review focus #3).
        dictionary::dictionary_names(&options.frontend, &options.lang)
            .map_err(PhonemizeError::Dictionary)?;

        let language = dictionary::primary_language(&options.lang);
        let phonemes = match language.as_str() {
            "ja" => {
                let segmenter =
                    self.japanese
                        .as_ref()
                        .ok_or_else(|| PhonemizeError::NotPrepared {
                            lang: options.lang.clone(),
                        })?;
                pipeline::phonemize_ja(text, segmenter, self.english())
                    .map_err(PhonemizeError::Pipeline)?
            }
            // English has no dictionary to wait for — the CMU dictionary is
            // compiled in — so this arm needs no `prepare` and no `NotPrepared`
            // check. The backend itself is still built lazily on the first call;
            // see the `english` field.
            "en" => {
                pipeline::phonemize_en(text, self.english()).map_err(PhonemizeError::Pipeline)?
            }
            // Chinese needs jieba's word list, so like Japanese it can be asked
            // to phonemize before `prepare` ran — and that is a failure rather
            // than a sentence read without word boundaries, because the
            // boundaries are audible (人设, 曾经).
            "zh" => {
                let segmenter =
                    self.chinese
                        .as_ref()
                        .ok_or_else(|| PhonemizeError::NotPrepared {
                            lang: options.lang.clone(),
                        })?;
                pipeline::phonemize_zh(text, segmenter, self.english())
                    .map_err(PhonemizeError::Pipeline)?
            }
            // Every language the frontend table lists has a pipeline now, so this
            // arm is unreachable through `phonemize_with` — the frontend check at
            // the top of this function rejects anything else first. It stays as
            // the honest answer for the next language that is added to
            // `supported_languages` before its pipeline exists: an error rather
            // than an empty string, because a sentence that phonemizes to nothing
            // plays as silence, and silence is exactly what this migration exists
            // to stop producing quietly.
            _ => {
                return Err(PhonemizeError::NotImplemented {
                    lang: options.lang.clone(),
                })
            }
        };

        // The gate (spec §1.3, §4.2.1). Every pipeline ends here, so a frontend
        // whose inventory does not match the phonemes fails loudly instead of
        // losing the characters the tokenizer would silently delete.
        //
        // The frontend was already checked by `dictionary_names` above, so this
        // lookup cannot fail — and an error rather than a panic, because a panic
        // inside the wasm takes the worker with it.
        let vocab = Vocab::for_frontend(&options.frontend).ok_or_else(|| {
            PhonemizeError::Dictionary(DictionaryError::UnknownFrontend {
                frontend: options.frontend.clone(),
            })
        })?;
        // Repair before validating, so that a character the vocabulary cannot
        // express is rewritten rather than reported — `ɚ` → `əɹ` for v1.1-zh.
        let repaired = vocab.repair(&phonemes.phonemes);
        validate_phonemes(&repaired, vocab).map_err(PhonemizeError::Vocab)?;

        Ok(PhonemizeResult {
            phonemes: repaired.into_owned(),
            spans: None,
            warnings: phonemes.warnings,
        })
    }

    /// The English backend, built on first use.
    ///
    /// `OnceLock` rather than a field built in `build_backends`, because that
    /// runs on every `prepare` and this costs 27 ms and ~13 MB of hash map even
    /// for text that never contains a Latin character. The failure is cached too
    /// — a build whose embedded dictionary will not parse fails the same way
    /// every time, and retrying it per sentence would only be slower.
    fn english(&self) -> Option<&EnglishG2p> {
        self.english.get_or_init(|| EnglishG2p::new().ok()).as_ref()
    }

    /// Build the segmenters the last `required_dictionaries` asked for.
    ///
    /// Idempotent, and additive: a segmenter that has been built stays built
    /// even when a later `prepare` is for a language that does not need it,
    /// which is the same lifetime the registry gives its bytes.
    ///
    /// **This is where a dictionary stops being bytes**, and it is the seam that
    /// turns a partial load into an error rather than into a pipeline running
    /// with half its dictionary. Both of these parse their whole word list, which
    /// is the expensive part of loading either language, so a corrupt file fails
    /// here — when the voice is picked — rather than in the middle of a sentence.
    fn build_backends(&mut self) -> Result<(), BackendError> {
        if self.japanese.is_none() {
            if let Some(bytes) = self.dictionaries.get(IPADIC_JA) {
                self.japanese = Some(SegmenterJa::from_container(bytes)?);
            }
        }
        if self.chinese.is_none() {
            if let Some(bytes) = self.dictionaries.get(JIEBA_ZH) {
                self.chinese = Some(SegmenterZh::from_dictionary(bytes)?);
            }
        }
        Ok(())
    }
}

/// Why phonemizing failed.
#[derive(Debug)]
pub enum PhonemizeError {
    /// The frontend is unknown, or cannot speak the language.
    Dictionary(DictionaryError),
    /// The language's dictionary was never loaded — `prepare` was not called, or
    /// the caller did not check its result.
    NotPrepared { lang: String },
    /// This build has no pipeline for a language the frontend can speak.
    ///
    /// Distinct from [`DictionaryError::UnsupportedLanguage`]: the voice is
    /// fine, the migration is not finished.
    NotImplemented { lang: String },
    /// The pipeline itself failed.
    Pipeline(PipelineError),
    /// The phonemes do not belong to the frontend's vocabulary, and the tokenizer
    /// would drop the characters it does not know without saying so.
    Vocab(VocabError),
}

impl PhonemizeError {
    /// A stable code for the JavaScript side.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Dictionary(error) => error.code(),
            Self::NotPrepared { .. } => "dictionary-not-loaded",
            Self::NotImplemented { .. } => "pipeline-not-implemented",
            Self::Pipeline(error) => error.code(),
            Self::Vocab(error) => error.code(),
        }
    }
}

impl std::fmt::Display for PhonemizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            Self::Dictionary(error) => write!(f, "{error}"),
            Self::NotPrepared { lang } => write!(
                f,
                "nothing was prepared for {lang:?} — call prepare() before phonemize()"
            ),
            Self::NotImplemented { lang } => {
                write!(f, "this build has no pipeline for {lang:?} yet")
            }
            Self::Pipeline(error) => write!(f, "{error}"),
            Self::Vocab(error) => write!(f, "{error}"),
        }
    }
}

impl From<VocabError> for PhonemizeError {
    fn from(error: VocabError) -> Self {
        Self::Vocab(error)
    }
}

impl std::error::Error for PhonemizeError {}

/// Why a backend could not be built from the dictionaries that arrived.
///
/// One type for both segmenters, because `finish_loading` is one seam and has to
/// report one failure: which language's dictionary was unusable is part of the
/// message, and the `code` is the one the JavaScript side switches on.
#[derive(Debug)]
enum BackendError {
    Japanese(SegmenterError),
    Chinese(SegmenterZhError),
}

impl BackendError {
    fn code(&self) -> &'static str {
        match self {
            Self::Japanese(error) => error.code(),
            Self::Chinese(error) => error.code(),
        }
    }
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Japanese(error) => write!(f, "{error}"),
            Self::Chinese(error) => write!(f, "{error}"),
        }
    }
}

impl From<SegmenterError> for BackendError {
    fn from(error: SegmenterError) -> Self {
        Self::Japanese(error)
    }
}

impl From<SegmenterZhError> for BackendError {
    fn from(error: SegmenterZhError) -> Self {
        Self::Chinese(error)
    }
}

/// A failure, as the JavaScript wrapper sees it.
///
/// An `Error` rather than the bare string wasm-bindgen would throw for
/// `JsValue::from_str`: the wrapper has to tell a network failure from a corrupt
/// file to pick the right message (spec §8.1), and a `code` property is a
/// contract the message text is not. The message keeps the same code as a
/// prefix, so a log line says which failure it was without a lookup table.
fn thrown_error(code: &str, message: &str) -> JsValue {
    let thrown = js_sys::Error::new(message);
    let _ = js_sys::Reflect::set(
        &thrown,
        &JsValue::from_str("code"),
        &JsValue::from_str(code),
    );
    thrown.into()
}

fn dictionary_error(error: DictionaryError) -> JsValue {
    thrown_error(error.code(), &error.to_string())
}

fn backend_error(error: BackendError) -> JsValue {
    thrown_error(error.code(), &error.to_string())
}

fn phonemize_error(error: PhonemizeError) -> JsValue {
    thrown_error(error.code(), &error.to_string())
}
