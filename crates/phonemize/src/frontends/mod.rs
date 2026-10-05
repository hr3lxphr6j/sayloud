//! Phoneme frontends: one per phoneme inventory a Kokoro model understands
//!.
//!
//! A frontend is the last stage of the pipeline and the only one that knows the
//! model's vocabulary. Today only the v1.0 Japanese one exists; `zh_ipa`,
//! `zh_zhuyin` and `en_espeak` arrive in phases 4-6.

pub mod ja_ipa;
pub mod ja_ipa_table;
