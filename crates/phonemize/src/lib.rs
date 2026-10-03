//! Rust phonemization pipeline for SayLoud (P6).
//!
//! Compiled to a single wasm module that replaces the JavaScript chain
//! (kuromoji + kuroshiro + jieba + espeak + pinyin-pro). See
//! `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`.
//!
//! This is the phase-1 scaffold: the boundary exists, the pipeline behind it
//! does not yet.

use wasm_bindgen::prelude::*;

mod types;

pub use types::{FrontendId, PhonemeSpan, PhonemizeOptions, PhonemizeResult};

/// Text-to-phonemes engine.
///
/// The JS side keeps one instance per phonemize worker, in
/// `lib/models/phonemize-rust.ts`.
#[wasm_bindgen]
#[derive(Default)]
pub struct Phonemizer {}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {}
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
