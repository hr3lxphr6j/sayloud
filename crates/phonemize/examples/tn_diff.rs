//! A reading diff between two grammar builds.
//!
//! A manual upstream bump (`docs/superpowers/TN-PLAN.md` §7) rebuilds
//! the same corpus against two checkouts of WeTextProcessing and needs a
//! reviewer-readable answer to one question: which sentences does the new
//! grammar *read* differently? This example is that answer. The bump is not
//! scheduled: build both sides with `tools/fst-build/build.py`, run this, then
//! `update_lock.py` and review the pin plus the hashes.
//!
//! It is deliberately not a test: the corpus and both builds are arguments, and a
//! difference is the output rather than a failure. Only setup failures — a
//! missing directory, an unreadable FST, a corpus line that is not JSON — exit
//! non-zero, because those are the cases where a silent "no diff" would be a lie.
//!
//! # What is compared, and what is not
//!
//! Just [`tn::normalize`], on the same `(lang, input)` pairs: no phonemization,
//! no punctuation folding. What changed is what the grammar said, before the
//! rest of the pipeline (segmentation, G2P, the punctuation maps) has an opinion
//! about it. A difference in a *phoneme* therefore surfaces here as the text it
//! came from, which is the thing a reviewer can check against the rule that
//! moved.
//!
//! The two directories must have the layout `tools/fst-build/build.py --out`
//! writes:
//!
//! ```text
//! <dir>/en/tn/{tagger,verbalizer}.fst
//! <dir>/zh/tn/{tagger,verbalizer}.fst
//! <dir>/ja/tn/{tagger,verbalizer}.fst
//! <dir>/full_to_half.fst
//! <dir>/traditional_to_simple.fst
//! ```
//!
//! All eight are read, whichever languages the corpus contains — a directory
//! that is missing one is not a build of this grammar, and failing on it is
//! cheaper than a report that silently skipped a language.
//!
//! # Usage
//!
//! ```text
//! cargo run -p phonemize --example tn_diff -- \
//!     --old tools/fst-build/out-old --new tools/fst-build/out-new \
//!     --corpus tools/fst-build/corpus.jsonl --out /tmp/bump-report.md \
//!     --old-sha <old> --new-sha <new>
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use phonemize::tn::{self, Lang, Normalizer};

const USAGE: &str = "usage: tn_diff --old <dir> --new <dir> --corpus <jsonl> --out <md> \
[--old-sha <sha>] [--new-sha <sha>]";

/// The languages the corpus can ask about, in the order the report uses.
const LANGUAGES: [Lang; 3] = [Lang::En, Lang::Zh, Lang::Ja];

fn lang_name(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "en",
        Lang::Zh => "zh",
        Lang::Ja => "ja",
    }
}

/// The corpus language tag back to [`Lang`], or `None` for a language this
/// grammar does not build.
fn parse_lang(tag: &str) -> Option<Lang> {
    match tag {
        "en" => Some(Lang::En),
        "zh" => Some(Lang::Zh),
        "ja" => Some(Lang::Ja),
        _ => None,
    }
}

/// One corpus line. The other fields (`file`, `line`, `expected`) are provenance
/// for the human reading the corpus and are not needed here — `expected` in
/// particular is a snapshot of the *pinned* grammar, and comparing against it
/// would report our own rules as upstream drift.
#[derive(serde::Deserialize)]
struct Case {
    lang: String,
    input: String,
}

struct Args {
    old: PathBuf,
    new: PathBuf,
    corpus: PathBuf,
    out: PathBuf,
    old_sha: Option<String>,
    new_sha: Option<String>,
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(Some(args)) => args,
        Ok(None) => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("tn_diff: {message}");
            eprintln!("{USAGE}");
            return ExitCode::FAILURE;
        }
    };

    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("tn_diff: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Parse by hand: one argument per flag, no dependencies. `Ok(None)` is `--help`.
fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut old = None;
    let mut new = None;
    let mut corpus = None;
    let mut out = None;
    let mut old_sha = None;
    let mut new_sha = None;

    while let Some(flag) = args.next() {
        // Every flag this tool takes is `--name <value>`; `--help` is the one
        // exception, and a typo like `--old=x` earns the usage line.
        let slot = match flag.as_str() {
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(None);
            }
            "--old" => &mut old,
            "--new" => &mut new,
            "--corpus" => &mut corpus,
            "--out" => &mut out,
            "--old-sha" => &mut old_sha,
            "--new-sha" => &mut new_sha,
            other => {
                if other.starts_with('-') {
                    return Err(format!("unknown option {other}"));
                }
                return Err(format!("unexpected argument {other}"));
            }
        };
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        *slot = Some(value);
    }

    let missing = |name: &str| format!("{name} is required");
    Ok(Some(Args {
        old: PathBuf::from(old.ok_or_else(|| missing("--old"))?),
        new: PathBuf::from(new.ok_or_else(|| missing("--new"))?),
        corpus: PathBuf::from(corpus.ok_or_else(|| missing("--corpus"))?),
        out: PathBuf::from(out.ok_or_else(|| missing("--out"))?),
        old_sha,
        new_sha,
    }))
}

fn run(args: &Args) -> Result<(), String> {
    let cases = read_corpus(&args.corpus)?;
    // Both sides always, all three languages: a directory is either a build of
    // the grammar this tool diffs or a mistake worth reporting as one.
    let old = Side::load("old", &args.old)?;
    let new = Side::load("new", &args.new)?;

    let comparisons: Vec<Comparison> = cases
        .iter()
        .map(|(lang, input)| Comparison {
            lang: *lang,
            input: input.clone(),
            before: read(&old, *lang, input),
            after: read(&new, *lang, input),
        })
        .collect();

    let changed = comparisons.iter().filter(|case| case.changed()).count();
    let report = render(args, &comparisons, changed, comparisons.len() - changed);
    write_report(&args.out, &report)?;

    let unchanged = comparisons.len() - changed;
    println!(
        "{changed} changed, {unchanged} unchanged of {} case(s); report: {}",
        comparisons.len(),
        args.out.display()
    );
    Ok(())
}

/// `(lang, input)` pairs, first occurrence wins.
///
/// Deduplicated because the corpus is grouped by rule (the same probe appears in
/// several sections to pin several rules), and the same input read twice would
/// only be the same row twice. Languages other than en/zh/ja are skipped: this
/// grammar does not build them.
fn read_corpus(path: &Path) -> Result<Vec<(Lang, String)>, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut seen = HashSet::new();
    let mut cases = Vec::new();

    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(line).map_err(|error| {
            format!(
                "{}:{}: not a corpus line: {error}",
                path.display(),
                index + 1
            )
        })?;
        let Some(lang) = parse_lang(&case.lang) else {
            continue;
        };
        if seen.insert((lang_name(lang), case.input.clone())) {
            cases.push((lang, case.input));
        }
    }

    if cases.is_empty() {
        return Err(format!(
            "{}: no en/zh/ja case in the corpus; nothing to diff",
            path.display()
        ));
    }
    Ok(cases)
}

/// The three normalizers one build directory holds.
///
/// Built by the same constructors the pipeline uses ([`tn::english`],
/// [`tn::chinese`], [`tn::japanese`]), so a reading here is the reading the
/// shipped wasm produces — including which of upstream's switches are on.
struct Side {
    en: Normalizer,
    zh: Normalizer,
    ja: Normalizer,
}

impl Side {
    fn load(label: &str, dir: &Path) -> Result<Self, String> {
        let load = |lang| normalizer(dir, lang).map_err(|error| format!("{label}: {error}"));
        Ok(Self {
            en: load(Lang::En)?,
            zh: load(Lang::Zh)?,
            ja: load(Lang::Ja)?,
        })
    }

    fn get(&self, lang: Lang) -> &Normalizer {
        match lang {
            Lang::En => &self.en,
            Lang::Zh => &self.zh,
            Lang::Ja => &self.ja,
        }
    }
}

fn bytes(dir: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = dir.join(relative);
    fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))
}

fn normalizer(dir: &Path, lang: Lang) -> Result<Normalizer, String> {
    let label = lang_name(lang);
    let built = match lang {
        Lang::En => tn::english(
            &bytes(dir, "en/tn/tagger.fst")?,
            &bytes(dir, "en/tn/verbalizer.fst")?,
            &bytes(dir, "full_to_half.fst")?,
        ),
        Lang::Zh => tn::chinese(
            &bytes(dir, "zh/tn/tagger.fst")?,
            &bytes(dir, "zh/tn/verbalizer.fst")?,
            &bytes(dir, "traditional_to_simple.fst")?,
        ),
        Lang::Ja => tn::japanese(
            &bytes(dir, "ja/tn/tagger.fst")?,
            &bytes(dir, "ja/tn/verbalizer.fst")?,
            &bytes(dir, "full_to_half.fst")?,
        ),
    };
    built.map_err(|error| format!("{}: {label}: {error}", dir.display()))
}

/// One reading: the text the grammar produced, or why it produced none.
///
/// The two are compared as one value because "it used to be read and now the
/// engine declines it" is exactly the change a reviewer needs to see, and it
/// would be invisible if errors were filtered out before the comparison.
#[derive(PartialEq, Eq)]
enum Reading {
    Text(String),
    Error(String),
}

impl Reading {
    fn table_cell(&self) -> String {
        match self {
            Self::Text(text) => cell(text),
            Self::Error(message) => format!("_(error: {})_", cell(message)),
        }
    }
}

fn read(side: &Side, lang: Lang, input: &str) -> Reading {
    match tn::normalize(input, lang, Some(side.get(lang))) {
        Ok(text) => Reading::Text(text.into_owned()),
        Err(error) => Reading::Error(error.to_string()),
    }
}

struct Comparison {
    lang: Lang,
    input: String,
    before: Reading,
    after: Reading,
}

impl Comparison {
    fn changed(&self) -> bool {
        self.before != self.after
    }
}

/// A table cell that cannot break the table: `|` would end the column and a
/// newline would end the row. Nothing else is escaped — the text is the reading,
/// and mangling it would be the one thing a reading diff must not do.
fn cell(text: &str) -> String {
    text.replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
}

fn render(args: &Args, comparisons: &[Comparison], changed: usize, unchanged: usize) -> String {
    let mut out = String::new();
    out.push_str("# TN reading diff\n\n");
    out.push_str(&format!(
        "before: `{}`\nafter: `{}`\n\n",
        args.old_sha.as_deref().unwrap_or("(not recorded)"),
        args.new_sha.as_deref().unwrap_or("(not recorded)")
    ));
    // The one line a caller can grep for: the counts, in a fixed shape.
    out.push_str(&format!("{changed} changed, {unchanged} unchanged\n\n"));

    if changed == 0 {
        out.push_str(
            "No reading changed. The FST bytes can still differ — state numbering is not \
             stable across toolchains — and the `lock.json` update in this PR is what carries \
             that.\n\n",
        );
    }

    for lang in LANGUAGES {
        // Languages the corpus does not mention get no section: an empty table
        // under `### ja` would suggest the corpus had cases that did not move.
        let cases: Vec<&Comparison> = comparisons
            .iter()
            .filter(|case| case.lang == lang)
            .collect();
        if cases.is_empty() {
            continue;
        }
        let lang_changed = cases.iter().filter(|case| case.changed()).count();
        out.push_str(&format!(
            "## {} ({} changed, {} unchanged)\n\n",
            lang_name(lang),
            lang_changed,
            cases.len() - lang_changed
        ));

        if lang_changed == 0 {
            out.push_str("No reading changed for this language.\n\n");
            continue;
        }

        out.push_str("| input | before | after |\n| --- | --- | --- |\n");
        for case in cases.iter().filter(|case| case.changed()) {
            out.push_str(&format!(
                "| {} | {} | {} |\n",
                cell(&case.input),
                case.before.table_cell(),
                case.after.table_cell()
            ));
        }
        out.push('\n');
    }

    out
}

fn write_report(path: &Path, report: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
    }
    fs::write(path, report).map_err(|error| format!("{}: {error}", path.display()))
}
