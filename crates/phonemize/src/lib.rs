//! Rust phonemization pipeline for SayLoud (P6).
//!
//! Compiled to a single wasm module that replaces the JavaScript chain
//! (kuromoji + kuroshiro + jieba + espeak + pinyin-pro). See
//! `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`.
//!
//! The pipeline behind the boundary is still to come; what exists today is the
//! dictionary protocol (spec §3.2), which the pipeline will read from.

use wasm_bindgen::prelude::*;

pub mod dictionary;
mod types;

use dictionary::{DictionaryError, DictionaryRegistry};

pub use types::{FrontendId, PhonemeSpan, PhonemizeOptions, PhonemizeResult};

/// Text-to-phonemes engine.
///
/// The JS side keeps one instance per phonemize worker, in
/// `lib/models/phonemize-rust.ts`.
#[wasm_bindgen]
#[derive(Default)]
pub struct Phonemizer {
    dictionaries: DictionaryRegistry,
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
    pub fn finish_loading(&mut self) -> Result<(), JsValue> {
        self.dictionaries.finish().map_err(dictionary_error)
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
}

/// A dictionary failure, as the JavaScript wrapper sees it.
///
/// An `Error` rather than the bare string wasm-bindgen would throw for
/// `JsValue::from_str`: the wrapper has to tell a network failure from a corrupt
/// file to pick the right message (spec §8.1), and a `code` property is a
/// contract the message text is not. The message keeps the same code as a
/// prefix, so a log line says which failure it was without a lookup table.
fn dictionary_error(error: DictionaryError) -> JsValue {
    let thrown = js_sys::Error::new(&error.to_string());
    let _ = js_sys::Reflect::set(
        &thrown,
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code()),
    );
    thrown.into()
}
