# P6 阶段 5：英文数字实现

> 生成日期：2026-10-03
> 工作目录：`/Users/chigusa/Dev/tts-ng`
> 当前状态：阶段 4 完成（piper-plus-g2p 已集成，wasm 4.7 MB / gzip 1.16 MB）

---

## 验证结果

### num2words 1.2.0

```
cargo add num2words
cargo build --target wasm32-unknown-unknown   ✅
cargo build --target wasm32-unknown-unknown --release (opt-level=z, lto=true)  ✅  152 KB
```

| 项目 | 结论 |
|------|------|
| 许可证 | **MIT OR Apache-2.0** ✅ |
| 依赖数量 | 2 个（`num-bigfloat 1.7.2` MIT，现有 phonemize 树中无此依赖）|
| wasm32 编译 | ✅ 通过，无条件（无 C 源码、无 fs 访问）|
| wasm 增量（lto+z） | **~152 KB**（包含 num-bigfloat）|
| 输出质量 | 见下方实测 |
| 中文支持 | ❌ 无（只有 English / French / Ukrainian）|
| 依赖冲突 | 无 |

**实测输出：**

| 输入 | num2words 输出 |
|------|---------------|
| 0 | zero |
| 1 | one |
| 3 | three |
| 42 | forty-two |
| 123 | one hundred twenty-three |
| 999 | nine hundred ninety-nine |
| 1000 | one thousand |
| 1001 | one thousand and one |
| 9999 | nine thousand nine hundred and ninety-nine |
| 2024 | two thousand and twenty-four |
| 1000000 | one million |
| 0.5 | point five |
| 3.14 | three point one four |
| -42 | minus forty-two |

**"and" 规则**：千位以上的非零百位/十位/个位加 "and"（1001 → "one thousand and one"），百位以下不加。这与 espeak en-US 的 American English 略有差异（espeak: "one thousand one"），但不影响音素质量——"and" 通过 piper 读出 /ænd/，全句语义完整。

**结论：推荐**。轻量（152 KB）、MIT、wasm32 一次通过、无 C 工具链要求、输出可直接被 piper CMU Dict 查询。

---

### num2words2-core 0.1.2

```
cargo build --target wasm32-unknown-unknown --release (opt-level=z, lto=true)  ✅  2.7 MB
```

| 项目 | 结论 |
|------|------|
| 许可证 | **MIT OR Apache-2.0** ✅ |
| 依赖数量 | **7 个**（bigdecimal、num-bigint、num-integer、num-traits、libm、autocfg）|
| wasm32 编译 | ✅ 通过 |
| wasm 增量（lto+z） | **~2.7 MB**（bigdecimal 含完整大数运算）|
| 输出质量 | 英文输出与 num2words 相同；中文支持 zh/zh_HK/zh_TW |
| 中文支持 | ✅ `一百二十三`、`九千九百九十九`（与日语 numbers_to_kanji 输出一致）|

**结论：不推荐用于英文数字**。2.7 MB 的增量（单独数字模块）无法接受——当前 wasm 已是 4.7 MB，加上这个超过 7 MB，gzip 后远超 spec ~3 MB 预算（已超，不能继续恶化）。bigdecimal + num-bigint 引入的大数运算能力远超英文 0–9999 所需。

> 注：中文数字（zh）如有需要可单独评估，但其输出（简体数字汉字）等价于现有 `numbers_to_kanji` 的汉字输出，不提供增量价值。

---

## 推荐方案

**方案 A：num2words 1.2.0**

理由：
1. 152 KB 增量（gzip 后约 +30–50 KB），可接受
2. MIT 许可证，与项目策略一致
3. wasm32 编译无条件通过
4. 输出质量足够——piper CMU Dict 包含 "three"/"twenty-four"/"thousand" 等所有常用英文数词
5. 接入模式与 `numbers_to_kanji` 完全对称：在 `segment_text` 之前调用 `numbers_to_english()`，数字就进入 Latin 运行，被 piper 正确查词

**方案 B 备用（规则引擎）**：若 num2words 在 CI 或目标平台出现问题，可用约 150 行 Rust 实现 0–9999 的规则引擎（espeak en_rules 风格）。工作量约 2–3 小时，但输出需要独立验证与 espeak 的一致性。推荐优先尝试方案 A。

---

## 接入原理

数字在 `segment_text` 中落入 `Other` 类（`'3'` U+0033 → OTHER），然后被 `keep_punctuation` 静默丢弃——这是 "I have 3 cats" → `aɪ hæv kˈæts`（3 消失）的根本原因。

解法与日语完全对称：在 `segment_text` 之前运行 `numbers_to_english()`，把数字替换成英文单词：

```
"I have 3 cats" 
  → numbers_to_english → "I have three cats"
  → segment_text → [Latin("I"), Other(" "), Latin("have"), Other(" "), Latin("three"), Other(" "), Latin("cats")]
  → piper → "aɪ hæv θɹˈiː kˈæts"
```

---

## 实施计划

### 任务 5.1：添加 num2words 依赖并实现 `numbers_to_english`

**文件：**
- 修改：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/backends/numbers_en.rs`
- 修改：`crates/phonemize/src/backends/mod.rs`

**步骤：**

1. 在 `Cargo.toml` 添加依赖：
   ```toml
   num2words = "1.2.0"
   ```
   放在 `[dependencies]` 下，紧随现有依赖，加注释说明版本固定理由。

2. 创建 `src/backends/numbers_en.rs`：
   ```rust
   //! English numeral normalization.
   //!
   //! Mirrors `lib/models/phonemize/english.ts` `expandNumbers()`.
   //! Must run before `segment_text` for the same reason as `numbers_to_kanji`:
   //! a digit char falls into `Other` and is silently dropped by `keep_punctuation`.
   
   use num2words::{Num2Words, Lang};
   
   /// Replace every decimal integer run in `text` with its English words.
   ///
   /// Handles: integers 0–i64::MAX, negative integers (−42 → "minus forty-two"),
   /// and decimal fractions (3.14 → "three point one four").
   /// Comma-separated groups (1,000) are left intact — keep_punctuation drops the comma.
   /// Only ASCII digits are matched; full-width digits must be normalized earlier.
   pub fn numbers_to_english(text: &str) -> String {
       let chars: Vec<char> = text.chars().collect();
       let mut out = String::with_capacity(text.len() * 2);
       let mut i = 0;
   
       while i < chars.len() {
           // Detect optional leading minus
           let negative = i < chars.len() && chars[i] == '-'
               && i + 1 < chars.len() && chars[i + 1].is_ascii_digit();
           if negative { i += 1; }
   
           if i < chars.len() && chars[i].is_ascii_digit() {
               let start = i;
               while i < chars.len() && chars[i].is_ascii_digit() { i += 1; }
               let whole: String = chars[start..i].iter().collect();
   
               // Check for decimal fraction
               let mut fraction = String::new();
               if i + 1 < chars.len() && chars[i] == '.' && chars[i + 1].is_ascii_digit() {
                   i += 1; // skip dot
                   let frac_start = i;
                   while i < chars.len() && chars[i].is_ascii_digit() { i += 1; }
                   fraction = chars[frac_start..i].iter().collect();
               }
   
               let n: i64 = whole.parse().unwrap_or(0);
               let n = if negative { -n } else { n };
               let words = Num2Words::new(n)
                   .lang(Lang::English)
                   .to_words()
                   .unwrap_or_else(|_| whole.clone());
   
               out.push_str(&words);
   
               if !fraction.is_empty() {
                   out.push_str(" point ");
                   for ch in fraction.chars() {
                       let d = Num2Words::new(ch as i64 - '0' as i64)
                           .lang(Lang::English)
                           .to_words()
                           .unwrap_or_else(|_| ch.to_string());
                       out.push_str(&d);
                       out.push(' ');
                   }
                   // trim trailing space added by digit loop
                   if out.ends_with(' ') { out.pop(); }
               }
           } else {
               if negative { out.push('-'); }
               out.push(chars[i]);
               i += 1;
           }
       }
   
       out
   }
   ```

3. 在 `src/backends/mod.rs` 暴露模块：
   ```rust
   pub mod numbers_en;
   ```

**测试：** 见任务 5.3

**预计：** 45 分钟

---

### 任务 5.2：实现 `phonemize_en` 流水线

**文件：**
- 修改：`crates/phonemize/src/pipeline.rs`
- 修改：`crates/phonemize/src/lib.rs`

**步骤：**

1. 在 `pipeline.rs` 添加 `phonemize_en`：

   ```rust
   use crate::backends::numbers_en::numbers_to_english;
   
   /// English text to IPA, for the v1.0 frontend.
   ///
   /// Steps (order is load-bearing, same logic as `phonemize_ja`):
   /// 1. Normalize punctuation
   /// 2. Expand numerals (before segment_text — digits fall into Other and get dropped)
   /// 3. Segment into script runs
   /// 4. Route: Latin → piper G2P, Other → keep_punctuation
   pub fn phonemize_en(
       text: &str,
       english: Option<&EnglishG2p>,
   ) -> Result<Phonemized, PipelineError> {
       let normalized = normalize_punctuation(text);
       let with_words = numbers_to_english(&normalized);
       let runs = segment_text(&with_words);
   
       let mut parts: Vec<String> = Vec::new();
       let mut warnings: Vec<String> = Vec::new();
   
       for run in &runs {
           match run {
               ScriptRun::Latin(run_text) => {
                   let phonemes = match english {
                       Some(eng) => eng.phonemize(run_text)?,
                       None => String::new(),
                   };
                   if phonemes.is_empty() {
                       warnings.push(no_pronunciation(run_text));
                   } else {
                       parts.push(phonemes);
                   }
               }
               ScriptRun::Other(run_text) => parts.push(keep_punctuation(run_text)),
               // Han/Kana in an English sentence are dropped — a CJK character
               // in "hello 世界" is treated like punctuation.
               ScriptRun::Han(_) | ScriptRun::Kana(_) => {}
           }
       }
   
       Ok(Phonemized {
           phonemes: collapse_whitespace(&parts.concat()),
           warnings,
       })
   }
   ```

2. 在 `lib.rs` 的 `phonemize_with` 中接入，把 `"en"` 从 `_`（NotImplemented）分支移出：

   ```rust
   "ja" => { /* existing code */ }
   "en" => {
       pipeline::phonemize_en(text, self.english())
           .map_err(PhonemizeError::Pipeline)?
   }
   _ => { /* NotImplemented */ }
   ```

3. 更新 `ja_pipeline.rs` 中 `reports_a_whole_english_sentence_as_not_wired_up_yet` 测试——该测试现在应该 **通过**（不再报 `pipeline-not-implemented`），把断言改为验证正确输出：

   ```rust
   // Before: expects_err("English has no whole-sentence pipeline yet")
   // After:
   let result = phonemizer.phonemize_with("hello world", &options).expect("English pipeline now wired");
   assert!(!result.phonemes.is_empty());
   ```

**预计：** 45 分钟

---

### 任务 5.3：单元测试 + 集成测试 + 对照测试

**文件：**
- 修改：`crates/phonemize/src/backends/numbers_en.rs`（内联 `#[cfg(test)]`）
- 修改：`crates/phonemize/tests/ja_g2p.rs` 或新建 `tests/en_g2p.rs`
- 修改：`crates/phonemize/tests/ja_pipeline.rs`

**单元测试（numbers_en.rs 内联）：**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_zero()      { assert_eq!(numbers_to_english("0"),    "zero"); }
    #[test]
    fn converts_three()     { assert_eq!(numbers_to_english("3"),    "three"); }
    #[test]
    fn converts_in_sentence() {
        assert_eq!(numbers_to_english("I have 3 cats"), "I have three cats");
    }
    #[test]
    fn converts_decimal()   { assert_eq!(numbers_to_english("3.14"), "three point one four"); }
    #[test]
    fn converts_negative()  { assert_eq!(numbers_to_english("-42"),  "minus forty-two"); }
    #[test]
    fn converts_large()     { assert_eq!(numbers_to_english("1000"), "one thousand"); }
    #[test]
    fn leaves_non_digit_alone() {
        assert_eq!(numbers_to_english("hello"), "hello");
    }
    #[test]
    fn multiple_numbers()   {
        assert_eq!(numbers_to_english("2 cats and 3 dogs"), "two cats and three dogs");
    }
    #[test]
    fn year()               { assert_eq!(numbers_to_english("2024"), "two thousand and twenty-four"); }
}
```

**集成测试（tests/en_g2p.rs）：**

```rust
//! English whole-sentence pipeline tests.

// 需要 build 先在 tests/common/ 里加载 IPADic（参考 ja_pipeline.rs）
// 但 "en" 不需要 dictionary，所以可以直接用 Phonemizer::new()

use phonemize::{Phonemizer, PhonemizeOptions};

fn phonemize(text: &str) -> String {
    let phonemizer = Phonemizer::new();
    let opts = PhonemizeOptions { frontend: "kokoro-v1".into(), lang: "en-US".into() };
    phonemizer.phonemize_with(text, &opts).expect("phonemize").phonemes
}

#[test]
fn plain_sentence() {
    let ipa = phonemize("hello world");
    assert!(!ipa.is_empty(), "should produce phonemes");
    // "hello" and "world" are in CMU Dict
    assert!(ipa.contains('h') || ipa.contains('ˈ'), "looks like IPA: {ipa}");
}

#[test]
fn sentence_with_number() {
    // The key regression test: "3" must not silently disappear
    let ipa = phonemize("I have 3 cats");
    // "three" IPA: /θɹˈiː/ — contains θ
    assert!(ipa.contains('θ'), "3 should phonemize as 'three' (θ): {ipa}");
}

#[test]
fn sentence_with_large_number() {
    let ipa = phonemize("There are 1000 ways");
    // "thousand" contains /θ/ as well — or at minimum a 't' sound
    assert!(!ipa.is_empty(), "1000 in a sentence: {ipa}");
}

#[test]
fn does_not_report_not_implemented() {
    let phonemizer = Phonemizer::new();
    let opts = PhonemizeOptions { frontend: "kokoro-v1".into(), lang: "en-US".into() };
    let result = phonemizer.phonemize_with("hello world", &opts);
    assert!(result.is_ok(), "English pipeline should be wired: {:?}", result.err());
}
```

**预计：** 30 分钟

---

### 任务 5.4：wasm 构建验证

**步骤：**

```bash
cd /Users/chigusa/Dev/tts-ng
pnpm biome check crates/phonemize/src/backends/numbers_en.rs  # 可选
cargo test -p phonemize --lib                                  # 单元测试
cargo test -p phonemize                                        # 集成测试
cargo build -p phonemize --target wasm32-unknown-unknown --release
ls -lh target/wasm32-unknown-unknown/release/phonemize.wasm    # 确认增量
gzip -9 -c target/wasm32-unknown-unknown/release/phonemize.wasm | wc -c
```

预期：wasm 从 4.7 MB → ~4.85 MB（增量 ~150 KB），gzip 从 1.16 MB → ~1.20 MB。

**预计：** 15 分钟

---

### 任务 5.5（可选）：对照测试覆盖

在 `tests/fixtures/` 下添加 `en_corpus.json`（参照现有 `ja_pipeline.rs` 中的语料结构）：

```json
[
  {"input": "I have 3 cats",         "note": "single digit in sentence"},
  {"input": "There are 1000 people", "note": "thousands"},
  {"input": "The year 2024",         "note": "year"},
  {"input": "It costs $99",          "note": "dollar sign (dropped)"},
  {"input": "3.14 is pi",            "note": "decimal"},
  {"input": "hello world",           "note": "no numbers baseline"}
]
```

与 JS 侧 espeak 输出对比（JS pipeline 在 `lib/models/phonemize/` 中已存在），写出 40 条双向锁定对照用例（参照阶段 3 的 ja 语料格式）。

**预计：** 45 分钟（可延后）

---

## 总工时估算

| 任务 | 内容 | 预计 |
|------|------|------|
| 5.1 | num2words 依赖 + numbers_to_english | 45 min |
| 5.2 | phonemize_en 流水线 + lib.rs 接入 | 45 min |
| 5.3 | 单元 + 集成测试 | 30 min |
| 5.4 | wasm 构建验证 | 15 min |
| 5.5 | 对照语料（可选） | 45 min |
| **合计** | **（不含 5.5）** | **~2.25 小时** |

---

## 验收标准

- [ ] `cargo test -p phonemize` 全绿（Rust 测试数量 ≥ 71 + 新增测试）
- [ ] `"I have 3 cats"` 经 `phonemize_en` 产出含 /θ/ 的 IPA（"three" 被读出）
- [ ] `lang="en"` 不再报 `pipeline-not-implemented`
- [ ] `numbers_to_english("3.14")` = `"three point one four"`
- [ ] `numbers_to_english("I have 3 cats")` = `"I have three cats"`
- [ ] wasm 增量 ≤ 250 KB（raw）、gzip 后 ≤ +60 KB
- [ ] 现有 71 条 Rust 测试无退化
- [ ] 现有 1459 条 TS 测试无退化（wasm 接口未变）

---

## 风险与注意事项

1. **"and" 规则差异**：num2words 在 "one thousand and one" 中加 "and"，espeak en-US 不加。对 G2P 目的无影响（piper 能读 "and"），但若未来做对照测试需要把 "and" 纳入允许的差异集。

2. **数字范围**：num2words 支持到 `i64::MAX`（约 9.2 × 10¹⁸），远超实际场景需要。超出时 `to_words()` 返回 `Err`，代码已用 `unwrap_or(whole.clone())` 回退到原始字符串。

3. **负数前置 `-`**：`segment_text` 中 `-` 落入 `Other`，与数字字符会被分开处理，所以 `numbers_to_english` 中需要检测 `'-'` 紧跟数字的组合（任务 5.1 实现中已处理）。

4. **大数中的逗号**：`1,000` 中的 `,` 落入 `Other`，`1` 和 `000` 分别处于两个 Other run 中间，会被单独转换为 "one" 和 "zero"。这与 `numbers_to_kanji` 的已知缺口（"一,二百三十四"）行为一致，已知且可接受。

5. **浮点精度**：`3.14` 解析为 `i64` 时整数部分没有精度问题；小数部分按字符逐位转换，不经过浮点。

---

## 文件清单

| 操作 | 路径 |
|------|------|
| 新增 | `crates/phonemize/src/backends/numbers_en.rs` |
| 新增 | `crates/phonemize/tests/en_g2p.rs` |
| 修改 | `crates/phonemize/Cargo.toml` |
| 修改 | `crates/phonemize/src/backends/mod.rs` |
| 修改 | `crates/phonemize/src/pipeline.rs` |
| 修改 | `crates/phonemize/src/lib.rs` |
| 修改 | `crates/phonemize/tests/ja_pipeline.rs` |
| 可选 | `crates/phonemize/tests/fixtures/en_corpus.json` |
