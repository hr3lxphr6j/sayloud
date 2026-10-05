# crates/phonemize 模块结构规格（tn / g2p / pipeline）

- 日期：2026-10-05
- 状态：待审阅
- 范围：`crates/phonemize/src/` 的内部结构。**不改** wasm 导出 API、不改 `data/` 与 `tests/` 的目录与文件名、不改任何行为（唯一例外见 §6）。

## 0. 目标与非目标

**目标**：把 `src/` 的分类轴从「哪个语言」换成「数据流的哪一段」——`tn`（文本→文本）、`g2p`（文本→音素）、`pipeline`（编排这三段），`wetext` 作为 `tn` 的子模块。`frontends/` 这个名字取消。

**非目标**：不拆 `wetext/` 内部结构（它是上游副本，重排会让以后和上游对比变难）；不新增抽象层；不改 `dictionary`/`vocab`/`text`/`kana`/`types`（留在顶层）；不改测试断言。

## 1. 问题

1. **`backends/` 是个口袋。** 它的成员是：分词器（ja/zh）、读音表（zh）、三层英文 G2P、数字读数器（三种）、WeText FST 引擎（跨语言）、英文 TN 门控（跨语言）、中文变调规则。唯一的共性是"按语言不同"，而 `wetext`/`gate` 恰恰相反——它们是跨语言共用的，被放进一个按语言切分的目录里。
2. **`frontends/` 名不副实。** 它只剩日语假名表；真正的 frontend（`Vocab::{V1_0, V1_1_ZH}`，即"这个音色用哪套词表"）住在 `vocab.rs`。同一个词指着两个东西，而目录里那个名不副实。
3. **后果**：找一个东西要先猜"它属于哪个语言"，而不是"它属于哪一段"；`tn` 这条跨语言的轴在目录里根本看不出来。

## 2. 分类轴与已定的四个选择

按数据流阶段分：

| 段 | 输入 → 输出 | 判别标准 |
|---|---|---|
| `tn` | 文本 → 文本 | 只改字符串，不知道音素 |
| `g2p` | 文本 → 音素 | 产生 IPA，不决定句子怎么念 |
| `pipeline` | 文本 → `Phonemized` | 决定顺序、参数、错误与告警 |

已定（本次讨论）：

1. `dictionary` / `vocab` / `text` / `kana` / `types` **留在顶层**——它们不属于任何一段，也不该被硬塞进一段。
2. `frontends/` **拆进 `g2p/ja/`**，`frontends/` 消失；"frontend" 一词从此只属于 `vocab.rs`。
3. tests 里的模块路径**一次性改完**，不留 `pub use` 别名。
4. 顺带清理与当前树不符的注释（清单见 §8）。

## 3. 目标结构

```
src/
  lib.rs           wasm 边界：Phonemizer + 错误码（不变）
  types.rs         （不变）
  text.rs          （不变：分段、标点、空白、全角数字）
  kana.rs          （不变：假名/汉字谓词、平假名→片假名）
  dictionary.rs    （不变：字典协议与注册表）
  vocab.rs         （不变：词表闸门；"frontend" 的唯一语义所在）
  pipeline.rs      编排：phonemize_ja/en/zh、ToneRules、Phonemized、PipelineError
  tn/              文本 → 文本
    mod.rs         语言 → 引擎/fallback/门控/后处理（见 §5）
    gate.rs        英文门控（原 backends/tn_gate.rs）
    engine.rs      WeText 接线：english()/chinese()/japanese()（原 backends/wetext_tn.rs）
    wetext/        vendored 引擎，原样搬运（含 config/error/token_parser/contractions/text_normalizer + data/）
    readers/       手写读数器：ja.rs / zh.rs / en.rs（原 numbers.rs / numbers_zh.rs / numbers_en.rs）
  g2p/             文本 → 音素
    mod.rs         共用再导出
    ja/            segmenter.rs（lindera）、ipa.rs（原 frontends/ja_ipa.rs）、table.rs（生成物，原 frontends/ja_ipa_table.rs）
    zh/            segmenter.rs（jieba）、pinyin.rs、text.rs（原 backends/zh_text.rs）、tone_sandhi/{mod,tables}.rs
    en/            mod.rs（三层 G2P，原 backends/g2p_en.rs）、headtts/{mod,engine,rules}.rs
```

`backends/mod.rs` 与 `frontends/mod.rs` 删除；前者的两段模块文档（"backend 是某语言需要而另一个不需要的东西"、"四种 backend 的清单"）改写进 `tn/mod.rs` 与 `g2p/mod.rs`。

## 4. 逐文件映射

| 现状 | 目标 | 备注 |
|---|---|---|
| `backends/numbers.rs` | `tn/readers/ja.rs` | 函数名 `numbers_to_kanji`/`int_to_kanji` 不变 |
| `backends/numbers_zh.rs` | `tn/readers/zh.rs` | `numbers_to_han` |
| `backends/numbers_en.rs` | `tn/readers/en.rs` | `numbers_to_english` |
| `backends/tn_gate.rs` | `tn/gate.rs` | |
| `backends/wetext_tn.rs` | `tn/engine.rs` | 三个 `english/chinese/japanese` 构造器不变 |
| `backends/wetext/**` | `tn/wetext/**` | 逐文件搬，内部结构不变 |
| `pipeline.rs::numerals` / `fix_one_thousand_bug` | `tn/mod.rs`（私有） | 见 §5 |
| `backends/segmenter_ja.rs` | `g2p/ja/segmenter.rs` | |
| `frontends/ja_ipa.rs` | `g2p/ja/ipa.rs` | |
| `frontends/ja_ipa_table.rs` | `g2p/ja/table.rs` | 生成物：脚本输出路径要改（§7.2） |
| `backends/segmenter_zh.rs` | `g2p/zh/segmenter.rs` | `include_str!` 深度要改（§7.3） |
| `backends/pinyin.rs` | `g2p/zh/pinyin.rs` | 同上 |
| `backends/zh_text.rs` | `g2p/zh/text.rs` | |
| `backends/tone_sandhi/**` | `g2p/zh/tone_sandhi/**` | `tables.rs` 与 `NOTICE` 一起搬 |
| `backends/g2p_en.rs` | `g2p/en/mod.rs` | |
| `backends/headtts_en/**` | `g2p/en/headtts/**` | `rules.rs` 是生成物（§7.2），`LICENSE`/`NOTICE` 一起搬 |
| `backends/mod.rs`、`frontends/mod.rs` | 删除 | 内容并入 `tn/mod.rs`、`g2p/mod.rs` |

再导出（让 tests 的路径短且稳）：

- `tn`：`pub use engine::{chinese, english, japanese};`、`pub use wetext::{Normalizer, WeTextError, FstTextNormalizer};`、`pub use readers::{int_to_kanji, numbers_to_kanji, numbers_to_han, numbers_to_english};`、`pub use gate::needs_normalization;`
- `g2p`：`pub use {ja::SegmenterJa, zh::SegmenterZh, zh::ChinesePinyin, zh::PinyinError, en::{EnglishG2p, EnglishError}};`（`tone_sandhi`、`zh::text`、`ja::{kana_to_ipa, KATAKANA_TO_IPA, fix_numeral_sound_changes}` 保持全路径可用）

## 5. `tn` 的接口（本次定死，实现者不再选）

pipeline 现在这样调用：`numerals(&text, tn, Gate::EngineDecides, numbers_to_kanji)` —— 门控选择、fallback 选择、以及"英文那个 1,NNN 修复"都散在调用点，而它们全都是**语言的属性**。新接口把它收进去：

```rust
// tn/mod.rs
pub enum Lang { Ja, Zh, En }

impl Lang {
    /// 手写读数器；引擎缺席时用它（阶段 6 的行为）。
    fn fallback(self, text: &str) -> String;
    /// WeText 引擎要不要先过 gate：英文 CheapSkip，中日文由引擎自己判断。
    fn gate(self) -> Gate;
    /// 引擎输出之后语言自己的修正：英文修 1,000–1,999 丢 "one"。
    /// **只在引擎跑过之后调用**（fallback 路径不调），与现状一致。
    fn postprocess(self, normalized: String) -> String;
}

/// 文本 → 规范化后的文本。`engine` 为 `None` 时退回 `Lang::fallback`。
pub fn normalize<'a>(text: &'a str, lang: Lang, engine: Option<&Normalizer>) -> Cow<'a, str>;
```

`Gate` 降为 `tn` 私有；`pipeline` 只说一次语言（它本来就在 `match primary_language(..)` 里分辨）。三条管线各删一行参数。

## 6. 唯一的行为修复

`fix_one_thousand_bug` 现在挂在**三语言共用**的 `numerals()` 上，靠"中日文里不会出现字面 ` thousand`"才安全。按 §5 它成为 `Lang::En::postprocess`——这是结构性修复，不是加 `if`。

- 影响：中日文 TN 输出不再被英文修正触碰（例：日文句子里带英文词 `thousand` 时不再被插 `one `）。
- 证据：新增一条测试——日文（或中文）输入经 TN 后输出与引擎原样输出逐字相同；英文的 `1,234` 用例保持不变。
- 这是本规格中**唯一**允许改变输出行为的一处。

## 7. 必须一起改的次生影响

**7.1 体积常数（会被抓住的地方）**
panic 的 `Location` 字符串进了 wasm：实测 `phonemize_bg.wasm` 里有 **10 处** `crates/phonemize/src/backends/…`。搬动文件就会改这些字符串，因此模块体积**必然变化**。收场任务必须重测并更新：

- `tests/build/build-output.test.ts` 的 `expect(...).toBe(6_091_829)`（编译产物里同一文件还有 ORT 的 21,596,019，不变）
- `crates/phonemize/README.md`、`docs/superpowers/plans/P6-FINAL.md` §六 里的 wasm 6,091,829 B / 扩展 40,523,112 B

**7.2 生成器的输出路径**
两个脚本写死了旧路径，不同步则 CI 第一步就红：

- `scripts/generate/gen-ja-ipa-table.py:44` → `src/g2p/ja/table.rs`
- `scripts/generate/gen-headtts-rules.mjs:30` → `src/g2p/en/headtts/rules.rs`

（两个生成物的**文件内容**不含自身路径，所以不需要它们自己改；改的是脚本里的 `OUT`。）

**7.3 `include_str!` 是文件相对路径**
深度变化的地方：

- `g2p/zh/pinyin.rs`：`../../data/pinyin-*.txt` → `../../../data/…`（4 处）
- `g2p/zh/segmenter.rs`：`../../tests/fixtures/zh-frontend-parity.json` → `../../../tests/…`
- 不变：`vocab.rs`（顶层不动）、`tn/wetext/contractions.rs` 的 `data/*.json`（`data/` 跟着 `wetext/` 走）

**7.4 引用面**（实测）

- `backends::` / `frontends::` 共 **83 处**：`src/` 55、`tests/` 28
- 含 `backends`/`frontends` 字样的行共 105 处（其余是散文里的词）
- `super::` 29 处：`wetext/`、`headtts_en/`、`tone_sandhi/` 三个整目录搬运，**它们内部的引用不变**；要改的是跨模块的那些（确切数量由编译器给出，`cargo test` 就是判据，本规格不预估）
- rustdoc 的 intra-doc 链接：`cargo doc` 不在 CI 里，链接错了没人拦 → 验证步骤显式跑 `cargo doc --no-deps`（见 §10）

**7.5 文档**
`docs/phonemization-architecture.md` 的模块表（46–47 行）与 107/117 行的路径引用要改。`lib/models/phonemize-wasm/README.md` 是 `crates/phonemize/README.md` 的构建产物副本，改源 + 重建即可，不手改。

## 8. 顺带清理清单（同一批改动里做）

**8.1 我上一轮 sed 留下的破损**

| 位置 | 现状 | 改成 | 归属 |
|---|---|---|---|
| `src/dictionary.rs:117` | 行首 `///, and only the parts…` | 重新断行 | 任务 1 |
| `src/frontends/mod.rs:2` | `//!.` | 不单独修：该文件在任务 2 被删除，正文改写进 `g2p/mod.rs` | 任务 2 |

**8.2 与当前树不符的注释**

| 位置 | 现状 | 事实 |
|---|---|---|
| `src/lib.rs:6` | "Japanese is the language that works end to end today" | 三种语言都已完整；1–15 行整段重写：**一段说清三段分工（tn/g2p/pipeline）、一段说清三种语言都已落地、一句说清 TN 引擎与词表闸门**；删掉"迁移进行中"的语气与所有阶段编号 |
| `src/lib.rs:7` | "the dictionary protocol (§3.2)" | 指向已删 spec 的节号 |
| `src/lib.rs:175-176` | "(spec §3.1)"（跨行） | 同上 |
| `src/frontends/mod.rs:5-6` | "Today only the v1.0 Japanese one exists; `zh_ipa`, `zh_zhuyin`, `en_espeak` arrive in phases 4-6" | 该文件删除；`frontend` 的语义改写进 `g2p/mod.rs` / `vocab.rs` |
| `src/text.rs:22` | `Latin` 变体 "Spelled out through espeak (phase 4)" | 现在是 CMU → NRL 7948 → 字母 |
| `src/text.rs:88-91` | "the fix belongs on the JavaScript side, and phase 8.4 removes that side entirely" | JS 侧阶段 8 已删除 |
| `src/backends/segmenter_ja.rs:31` | 字典由 `scripts/setup-lindera-dict.mjs` 构建 | 该文件不存在；是 `scripts/setup/setup-lindera-dict.sh` |
| `src/backends/segmenter_ja.rs:166` | "(spec §4.3)" | 指向已删 spec |
| `src/dictionary.rs:38` | "keeps 4.8 MB out of a wasm that is otherwise 4.2 MB" | wasm 现为 6.09 MB |
| `src/dictionary.rs:50` | "(spec decision #4)" | 同上，改成自包含表述 |
| `src/dictionary.rs:343` | `finish()`："today the bytes *are* the index" | segmenter 与三个 normalizer 现在都在 `finish_loading` 里构建 |
| `src/backends/wetext/mod.rs:33` | "modification 2 of the four in `NOTICE`" | `NOTICE` 是 7 处改动 |
| `src/pipeline.rs:8` | "A later phase turns this into a dispatch over the frontends" | 没有这个阶段 |
| `src/vocab.rs:28` | "espeak reads `never` as `nˈɛvɚ`" | `ɚ` 现在来自 CMU 路径（`piper-plus-g2p` 把非重读 `ER` 映射为 `ɚ`）；替换本身仍必要 |
| `src/types.rs:5` | "The plan's two halves disagreed on that" | "the plan" 已不存在 |
| `crates/phonemize/README.md` | 8 处旧脚本路径（`./scripts/build-phonemize-wasm.sh`、`scripts/gen-*.mjs`、`scripts/gen-*.py`、`scripts/headtts-parity.mjs`）＋ "cargo test --workspace # 280 tests" | `scripts/{build,generate,check,setup}/…`；测试数 297 |
| `src/backends/headtts_en/NOTICE:44,46` | `scripts/headtts-parity.mjs` | `scripts/generate/headtts-parity.mjs` |
| `tests/headtts_en.rs:19,128` | 同上 | 同上 |
| `tests/ja_pipeline.rs:8`、`tests/wetext_en.rs:191,197`、`tests/tn_gate.rs:404`、`tests/ja_g2p.rs:382`、`tests/zh_pipeline.rs:24,325` | 指向已删文档/计划的措辞（"§0.4"、"the plan's table"、"phase 8.4"、"a later phase"） | 改成自包含表述 |

**不动**：`src/vocab.rs:34`、`src/pipeline.rs:495-496`、`src/backends/segmenter_zh.rs:9` 里的 `P5 spec §…`——那份规格还在。

## 9. 迁移顺序

三个任务，每个一次 commit、可独立验证、可独立 revert。

**任务 1：`tn/` 落地**
搬 §4 的 `tn` 六项 + §5 的接口改造 + §6 的行为修复 + §8.1 的 `dictionary.rs` 破损 + `pipeline.rs` 的调用点 + tests 里 `backends::wetext*`/`tn_gate`/`numbers*` 的路径。
验收：`cargo test` 297 全绿；除 `pipeline.rs`/`tn/**`/`dictionary.rs`/tests 的 `use` 行外，无其他 diff。

**任务 2：`g2p/` 落地**
搬 §4 的 `g2p` 八项 + 删 `frontends/`（含 §8.1 那一处 `//!.`，随文件消失）+ §7.2 两个生成器 + §7.3 的 `include_str!` + 两个 `mod.rs` 的文档改写 + tests 里 g2p 各路径。
验收：`cargo test` 全绿；两个生成器 `--check` 通过（`gen-ja-ipa-table.py --check`、`pnpm check:headtts`）。

**任务 3：收场**
删残留空目录、`lib.rs` 模块文档重写、§8.2 全部注释、rustdoc 链接、`docs/phonemization-architecture.md` 与 crate `README.md` 的模块表、§7.1 重测体积并更新常数。
验收：§10 全部命令；体积常数与实测一致。

## 10. 验证策略

| 命令 | 预期 |
|---|---|
| `cargo fmt --check` | 绿 |
| `cargo clippy --all-targets -- -D warnings` | 绿 |
| `cargo test --workspace` | 297 passed / 0 failed（测试名集合与重构前逐条相同） |
| `cargo doc --no-deps` | 无 `unresolved link` / `broken intra-doc link` 警告（这是唯一能抓住 83 处路径里文档链接的手段） |
| `pnpm typecheck`、`pnpm lint` | 绿 |
| `pnpm test` | 1397 passed |
| `pnpm test:build` | 14 passed，且**新的** wasm 常数与之相符 |
| `pnpm test:performance` | 6 passed（数值允许漂移，只是本机基准） |
| 生成器与其他检查 | `gen-pinyin-pro-data.mjs --check`、`gen-kokoro-vocab.mjs --check`、`pnpm check:headtts`、`pnpm check:manifest` 绿 |
| 行为不变量：`git diff` | `tests/` 里**只应有 `use` 行的改动**；`crates/phonemize/data/` 零改动 |

## 11. 风险与回滚

- **风险最高的一条**：漏测体积常数（§7.1）——`pnpm test:build` 会红，且是"改了 30 个文件"里最容易忘的一步，写进任务 3 的验收。
- **风险次高**：生成器 `OUT` 路径不同步（§7.2）——CI 第一步就红，任务 2 的验收里。
- **一次性大 diff**：靠 `cargo test` + `cargo doc` 兜底；三个 commit 分开，结构变化不涉及数据迁移，各自 `git revert` 即可。
- 不改变 wasm 导出 API ⇒ `lib/models/phonemize-rust.ts` 与 TS 侧零改动。

## 12. 明确不做

- 不重排 `tn/wetext/` 内部（上游副本），不改它的 `NOTICE`/`README` 结构
- 不合并/拆分任何函数，不改任何测试断言（§6 那条新测试除外）
- 不引入 `core/` 之类的新层级
- 不动 `data/`、`tests/` 的目录结构、`Cargo.toml` 的依赖
