# V1 API 调研：`piper-plus@0.7.0` 的 Rust wasm G2P

**日期**: 2026-10-03
**目标包**: `piper-plus@0.7.0` → `piper-plus/wasm/multilingual`
**wasm 版本**: `piper-plus-wasm` 0.5.0（`getApiVersion()` 返回 `"0.5.0"`）

---

## 0. 一句话结论

**这个 wasm 不返回音素串，只返回音素 ID**——`phonemize(text, lang)` 的产物是 `Int32Array`，即调用方自己传进去的 `phoneme_id_map` 的下标。想拿到音素，必须自己把映射反过来解。这不是文档疏漏，是 piper-plus 的设计（它服务的是自己的 ONNX 模型，不是别的模型的 tokenizer）。

对 P6 而言这是**结构性错配**：P6 §0.1 要的输出是「目标 Kokoro 模型可以直接进 tokenizer 的音素串」，而这个 API 的前提是「音素串 → 你自己模型的 ID」——方向正好相反。

---

## 1. API 表面

### 1.1 三个入口，只有一个能拿到 wasm

| 入口 | 实际内容 | 能否用 |
|---|---|---|
| `piper-plus` (`.`) | `PiperPlus` 合成主类，需要 ONNX 模型 + fetch + IndexedDB | ❌ 是合成器，不是 G2P |
| `piper-plus/phonemizer` | **纯 re-export `@piper-plus/g2p`** | ❌ 就是 V0 判定失败的包 |
| `piper-plus/wasm/multilingual` | **wasm-bindgen 胶水，直接暴露 `WasmPhonemizer`** | ✅ 唯一可用的 Rust G2P 入口 |

`src/index.js` 内部另有一个 `RustWasmAdapter`（把 wasm 包成 `PhonemizerInterface`），但它**没有独立导出**，只能经由合成主类或直接 import 内部文件使用。

### 1.2 `piper-plus/wasm/multilingual` 的完整导出

```ts
class WasmPhonemizer {
  constructor(config_json: string);            // 需要 phoneme_id_map + language_id_map
  phonemize(text: string, language?: string): PhonemizeResult;
  detectLanguage(text: string): string;
  getSupportedLanguages(): string[];
  isZhEnDispatchEnabled(): boolean;
  setZhEnDispatch(enabled: boolean): void;
  setChineseDictionary(single_json: Uint8Array, phrase_json: Uint8Array): void;
  free(): void;
}

class PhonemizeResult {
  readonly phonemeCount: number;
  readonly phonemeIds: Int32Array;        // ← 唯一的内容出口
  readonly prosodyFeatures: Int32Array;   // 扁平 [N*3]，A1/A2/A3
  free(): void;
}

function getApiVersion(): string;         // "0.5.0"
function isSsml(text: string): boolean;
function parseSsml(text: string): string; // JSON 数组 [{text, breakMs, rate}]
function init_panic_hook(): void;
function initSync(module): InitOutput;
function default_init(module_or_path?): Promise<InitOutput>;
```

**没有 `setJapaneseDictionary`**——这正是「本构建把日语词典编进去了」的证据：上游 `rust-wasm-adapter.js` 的逻辑是「如果存在 setter 说明是 external 构建，否则说明词典已内置」，并据此返回 `"unsupported"`。

**没有任何返回音素串的函数。** 没有 `phonemes()`、没有 `textToPhonemes()`，`PhonemizeResult` 里也没有字符串字段。

### 1.3 初始化实测（Node，冷启动）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `import('piper-plus/wasm/multilingual')` | **0.81 ms** | 只是 24 KB 胶水 |
| `initSync({ module: bytes })` | **13.2 – 20.6 ms** | 编译 + 实例化 57 MB；实测多次在 13–21 ms 区间 |
| `new WasmPhonemizer(config)` | **14.5 – 25 ms** | 含配置 JSON 解析；63k 条映射时 25 ms，Kokoro 词表（~120 条）时更短 |
| 合计冷启动 | **≈ 30–45 ms** | 远低于 P6 §0.4 的 100 ms 预算 |

57 MB 编译只用 ~13 ms，是因为 **96% 的体积是数据段而非代码**（上游 Cargo 注释），V8 的数据段复制与惰性函数编译都很便宜。这一点比预期好得多。

---

## 2. 配置契约：`phoneme_id_map` 是必填的，而且语义比想象的重

`new WasmPhonemizer(configJson)` 要求：

```json
{ "phoneme_id_map": { "^": [1], "_": [0], "$": [2], "a": [10], ... },
  "language_id_map": { "ja": 0, "en": 1, "zh": 2 } }
```

### 2.1 三个标记符号是硬要求

```
map = { a: [1] }  →  CONFIG_PARSE_ERROR: Invalid config: phoneme_id_map missing required BOS marker '^'
```

`^`（BOS）与 `$`（EOS）必须存在，否则构造直接抛错。`_`（PAD，id 0）是音素之间的分隔符。

### 2.2 输出结构（实测推导）

对 N 个音素的输入，ID 序列恒为：

```
[BOS] ( [PAD] phoneme_ids... ) × N  [PAD] [EOS]
```

长度 = `2 + 2N`（每个音素恰好贡献 1 个 id 时）。`phonemeCount` 返回的正是这个总长度（含标记），**不是音素数**——实测 `こんにちは` 10 音素 → `phonemeCount = 23`。

### 2.3 ⚠️ 未知音素被静默替换成 PAD——本次调研最重要的机制发现

用一个只含 `^ $ _ k o n i w a` 的 9 条映射跑 `こんにちは`：

```
map A（穷举 BMP）  → ^ _ k _ o _ [ _ <N_n> _ n _ i _ <ch> _ i _ w _ a _ $     count=23
map B（9 条）      → ^ _ k _ o _ _ _ n _ i _ _ i _ w _ a _ $                 count=20
map D（只有标记）   → ^ _ _ _ _ _ _ _ _ _ _ _ _ $                            count=13
```

差异全部是 PAD（`_`）——**映射里没有的音素不报错、不标记，直接变成分隔符**。后果有两个，方向相反：

1. **做适配层时是陷阱**：拿一份受限词表当 id map，你会得到一个「看起来正常但少了音素」的结果，没有任何错误信号。这就是 V0 里「中文 0.002 ms 空操作」那类假绿的同构版本。
2. **做验收时是量具**：把 Kokoro 词表本身当 id map，`PAD 数 - 1` 就是真实音素总数，非 PAD 的 id 数就是词表覆盖数，两者之差**就是词表会吞掉的音素数**。`vocab-check.json` 用的正是这个办法，比事后比字符集可靠。

### 2.4 其他契约细节

- **多 ID 数组被支持**（piper 惯例）：`k → [10,11]` 实测输出 `10,11` 两个 id。Kokoro 的 tokenizer 每个音素单 id，用不到，但说明这个映射不是简化版。
- **`language_id_map` 决定可用语言**：传 `{ja:0, en:1}` 时 `getSupportedLanguages()` 返回 `['ja','en']`；传了 `zh` 就多一个 `zh`。**构造失败会抛 `UNSUPPORTED_LANGUAGE`**，可用于提前探测。
- **`phoneme_id_map` 里语言相关的键会被校验**：本构建对 ja/zh/en 都能构造成功。

---

## 3. 语言参数不是摆设：`detectLanguage` 不可靠，提示必须显式传

`.d.ts` 的注释写着：

> `language` is an optional language code hint ... **Currently auto-detection is always used for the actual phonemization; the parameter is reserved for future forced-language support.**

**这句是错的。** 实测 `language` 参数直接决定走哪条语言路径，而且**必须**传——否则纯汉字日文会被判成中文。

### 3.1 实测：`detectLanguage` 把所有纯汉字串判成 `zh`

| 输入 | `detectLanguage` | hint=`ja` | hint=`zh` / 不传 |
|---|---|---|---|
| 経営 | **zh** | `ke[eee` ✅ | `経営` ❌ |
| 日本語 | **zh** | `ni[hoN_nggo` ✅ | `日本語` ❌ |
| 漢字 | **zh** | `ka[N_uvularji` ✅ | `漢字` ❌ |
| 経験 / 経済 / 計画 / 時計 / 世界 / 友達 / 中国 / 日本 / 東京 | **全部 zh** | 全部正确日文读音 | 全部透传原文 |
| けいえい / こんにちは / テスト / ありがとう / カタカナ / ひらがな / お元気ですか | ja | 正确 | 透传原文 |

即：**只要串里全是汉字，检测器一律答 `zh`**（含「日本語」「東京」这种日语特有词）。30 条样本里 3/10 日语样本被误判（経営 / 日本語 / 漢字）。

**影响**：不传 hint 时，纯汉字日文会被送进中文路径；而中文路径在缺词典时是**透传**，于是你会拿到汉字本身而不是音素——一个静默的、看起来很正常的错误。传了 `ja` 就完全正常（`経営` → `ke[eee` = けーえー，正确）。

### 3.2 顺带验证：日语读音质量是对的

| 输入（hint=ja） | wasm 输出 | 说明 |
|---|---|---|
| こんにちは | `ko[N_nnichiwa` | は 作助词读 wa ✅ |
| 東京 | `to[okyoo` | とうきょう → 长音双写 ✅ |
| 経営 | `ke[eee` | けいえい → けーえー ✅ |
| 日本語 | `ni[hoN_nggo` | にほんご，N_ng = 后接 g 的拨音变体 ✅ |
| 漢字 | `ka[N_uvularji` | かんじ ✅ |
| ありがとう | `a[ri]gatoo` | ありがとー ✅ |
| お元気ですか | `o[ge]N_ngkidesUka` | `U` = 无声化 u ✅ |

对照现有 JS 链：`こんにちは` → `koɴniʨiha`（は 读 ha，**是错的**）、`東京` → 无此样本、`ありがとう` → `ariɡatou`。**wasm 的日语读音质量明显高于现有 kana2ipa 链路**（长音、助词、拨音变体、无声化都处理了）。

### 3.3 `[` `]` 不是边界符，是音高标记

上游 `id_maps.py` 的 `_SPECIAL_TOKENS` 是权威定义：

```python
"_",  # short pause (pad, id=0)
"^",  # BOS
"$",  # EOS (declarative)
"?", "?!", "?.", "?~",   # 疑问句 EOS 变体
"#",  # accent phrase boundary
"[",  # rising pitch mark
"]",  # falling pitch mark
```

所以 `こんにちは` → `k o [ N_n n i ch i w a` 里的 `[` 是**上升音高标记**，不是「句子边界」也不是错误字符。它是 piper-plus 音素体系的一部分，Kokoro 词表里没有。

---

## 4. PUA 契约：多字符音素被压成单码位

piper-plus 把每个**多码位**音素 token 映射到 U+E000–U+E064 的单个 PUA 码位，理由是「让模型 config 能用单字符键」（C++ 运行时要求 `char32_t` 键）。

上游 `docs/spec/pua-contract.toml` 的分配表：

| 区间 | 归属 | 条数 |
|---|---|---|
| U+E000–E01C | 日语 | 29 |
| U+E01D–E01E | 多语共用（`rr`, `y_vowel`） | 2 |
| U+E020–E04A | 中文 | 43 |
| U+E04B–E052 | 韩语 | 8 |
| U+E054–E055 | 西/葡（`tʃ`, `dʒ`） | 2 |
| U+E056–E058 | 法语鼻化元音 | 3 |
| U+E059–E061 | 瑞典语长元音 | 9 |
| U+E062–E064 | v2 增补（`ɔɪ`, `œ̃`, `ɐ̃`） | 3 |

实例（本报告的解码用表，`upstream-assets/pua-map.js`）：

```
日语  a:→U+E000  i:→U+E001  ...  ky→U+E006  ch→U+E00E  ts→U+E00F
      N_m→U+E019  N_n→U+E01A  N_ng→U+E01B  N_uvular→U+E01C
中文  tʰ→U+E021  tɕ→U+E023  tʂ→U+E025  tsʰ→U+E027  aʊ→U+E02A  iɛn→U+E035
      ɻ̩→U+E045  tone1→U+E046  tone2→U+E047  tone3→U+E048  tone4→U+E049  tone5→U+E04A
```

**对 P6 的含义**：本 wasm 的输出**天然带 PUA**，而 Kokoro 两个词表里**一个 PUA 都没有**。适配层必须先按这张表把 PUA 还原成多字符 token，才谈得上映射到 Kokoro 的音素集。这层还原是确定性的、可做的——但它是**必须写**的一层，不是可选的优化。

---

## 5. 中文：默认透传；补齐词典后**还需要改格式**

### 5.1 三态实测

| 状态 | `你好` 输出 | 判定 |
|---|---|---|
| **npm 包开箱**（无词典） | `你好` | ❌ 汉字透传，零音素 |
| 用上游仓库那份词典（带声调符号） | `n{tone5}xo{tone5}` | ❌ 元音丢失、声调全变轻声 |
| 用 V1 转换出的 TONE3 词典 | `ni{tone2}x{aʊ}{tone3}` | ✅ 正确（含 3+3 变调） |

### 5.2 根因：上游词典格式与解析器不匹配

`src/rust/piper-plus-g2p/src/chinese.rs` 的声调解析全文：

```rust
/// Extract tone number (1-5) from the end of a pinyin syllable.
/// Returns (base_syllable, tone). Default tone is 5 (neutral).
fn extract_tone(syllable: &str) -> (&str, u8) {
    if let Some(last) = syllable.bytes().last()
        && (b'1'..=b'5').contains(&last)
    {
        return (&syllable[..syllable.len() - 1], last - b'0');
    }
    (syllable, 5)
}
```

**只认行尾 ASCII 数字**，文件里**没有任何声调符号处理**（grep 带调元音字符 = 0 处命中）。而上游那份词典：

```
pinyin_single.json   41,923 条，其中 41,806 条带声调符号，0 条带数字
  例：{"12295": "líng,yuán,xīng"}
pinyin_phrases.json  47,111 条，形如 {"一丁不识": [["yī"],["dīng"],["bù"],["shí"]]}
```

即：数据是 pypinyin 的**默认**风格（带调符号），而解析器要的是 **TONE3** 风格（`ni3`）。`chinese.rs` 的模块注释自称「Uses **pypinyin-format** JSON dictionaries」——注释按 pypinyin 的默认风格写，代码按 TONE3 写，两者不一致。`.d.ts` 里给调用方的示例倒是 TONE3：

```js
// - `single_json` — JSON bytes for single-character pinyin dict
//   (e.g. `{"19968": "yi1", "19969": "ding1,zheng4", ...}`)
```

**所以上游的 npm 路径是「文件没发 + 格式对不上」双重问题。** V1 的 `scripts/convert-pinyin-tone3.mjs` 把 41,923 条单字与 143,863 个词组音节转成 TONE3 后，中文路径才正常。

### 5.3 转换后的中文输出质量

| 输入 | wasm（TONE3 词典） | 现有 JS 链 |
|---|---|---|
| 你好 | `ni{tone2}x{aʊ}{tone3}` | `ni↓xau↓` |
| 今天天气很好 | `tɕin{tone1}tʰiɛn{tone1}tʰiɛn{tone1}tɕʰi{tone4}xən{tone2}x{aʊ}{tone3}` | `ʨi→ntʰjɛ→ntʰjɛ→nʨʰi↘ xə↓n xau↓` |
| 中文测试 | `tʂuŋ{tone1}uən{tone2}tsʰɤ{tone4}ʂɻ̩{tone4}` | `ꭧʊ→ŋwə↗n ʦʰɤ↘ʂɻ̩↘` |
| 经营管理 | `tɕiŋ{tone1}iŋ{tone2}kuan{tone2}li{tone3}` | `ʨi→ŋi↗ŋ kwa↓nli↓` |
| 数字123 | `ʂu{tone4}tsɨ{tone4}123` | `ʂu↘ʦɹ̩↘ i↘pai↓ɚ↘ʂɻ̩↗ sa→n` |

读音本身是对的（`你好` 的 3+3 变调 → tone2+tone3 正确，`今天天气很好` 的声调串正确），而且 IPA 比 JS 链**更规范**（`tɕ`/`tʂ`/`tsʰ` 对比 JS 链的 `ʨ`/`ꭧ`/`ʦ`）。

但有三点不兼容：

1. **声调编码完全不同**：wasm 用 PUA token（`tone1..tone5`），Kokoro v1.0 用箭头 `↓→↗↘`，v1.1-zh 用数字 `1`–`5`。
2. **数字不读**：`数字123` → `123` 原样透传（JS 链读作 `i↓pai↓ɚ↘ʂɻ̩↗ sa→n`）。数字规范化（TN）这一层 wasm 里没有——而 P6 §0.2 恰恰把 TN/FST 列为迁 Rust 的首要理由。
3. **拉丁文透传**：`混合text测试` → `xuən{tone4}xɤ{tone2}texttsʰɤ{tone4}ʂɻ̩{tone4}`，`text` 原样保留。`setZhEnDispatch(false)` 实测**不改变**输出（`zh_en_loanword.json` 只覆盖缩写/借词，不覆盖任意英文词）。

---

## 6. 与 P6 spec 目标的错配（汇总）

| P6 §0.1 / §0.4 要求 | 本 wasm 的实际情况 |
|---|---|
| 输出「可直接进 Kokoro tokenizer 的音素串」 | 只出 ID，不出串；且音素体系是 piper-plus 自己的（PUA + 音高标记） |
| 输出「逐字符等于 JS 输出，或有记录的更优」 | 三语**无一**逐字符相同（en/zh 透传；ja 记法与 JS 链不同） |
| 只有**一个** `.wasm`，espeak 也在里面 | 只有一个 wasm，但里面**没有英语**，更没有 espeak；英语仍要 JS 层 |
| 冷启动 ≤ 100 ms | ✅ 实测 ~30–45 ms |
| 开箱即用，用户零下载 | 日语 ✅；中文 ❌（词典未发布，且格式不匹配） |
| TN / FST（§0.2 的第一条理由） | ❌ 没有；数字与拉丁文原样透传 |

---

## 7. 若要用它，需要自己写的东西

1. **穷举 id map 反解**（或拿到 piper-plus 模型的 `phoneme_id_map` 并反查）——否则拿不到音素串。
2. **PUA → 多字符 token 的还原**（表在 `docs/spec/pua-contract.toml` / `pua-map.js`，99 条）。
3. **语言提示必须显式传**，不能依赖 `detectLanguage`。
4. **中文拼音词典**：从上游仓库取（2.7 MB），并**转换成 TONE3**。
5. **音素体系映射**：piper-plus 音素集 → Kokoro v1.0 / v1.1-zh 音素集（含 `g`→`ɡ`、`U`/`I` 无声化元音、`[`/`]` 音高标记、`tone1..5`→箭头或数字）。
6. **英语仍得另找方案**——这个 wasm 帮不上。

---

## 8. 复现

```bash
bash tests/v1/setup.sh                                   # 装包 + 补词典 + 转格式
node tests/v1/performance-benchmark.mjs                  # 性能
npx vitest run --config tests/v1/vitest.config.ts        # 30 条对照 + 词表
```

调研期的临时探针脚本在 `tests/v1/.sandbox/probe{1..5}.mjs`（`setup.sh` 不重建它们；结论已固化进本文档与 JSON）。
