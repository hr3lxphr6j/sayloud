# Phonemization Architecture

> **Status (2026-10-04, P6 阶段 8 完成)**: 文本预处理（TN + G2P）全部在 **Rust** 里，
> 编译成单个 wasm，跑在专用的 phonemize worker 里。**JavaScript 链已删除**：
> `lib/models/phonemize/`、vendored kuromoji/kuroshiro、`public/kuromoji-dict/`、
> 以及 `kuromoji`/`kuroshiro`/`jieba-wasm`/`phonemizer` 依赖都不在了。
>
> 本文上一版描述的是那条 JS 链，并在开头写着"迁移落地后应重写"——现在重写了。
> 分阶段记录见 `docs/superpowers/plans/p6-phase*-*.md`，设计与理由见
> `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`。

## 一句话

文本 → IPA 由 `crates/phonemize` 的 wasm 完成，**在 offscreen 文档的
phonemize worker 里**；kokoro worker 只做推理。

## 谁在哪里

```
side panel / reader
        │  句子（原始文本）
        ▼
offscreen 主线程   lib/models/worker-engine.ts
        │  ① phonemize（按语言取词典）
        │  ② 数 token，切到模型上限内，再合并   ← 只能在这里做，见下
        ▼
   ┌────────────────────┐        ┌────────────────────┐
   │ phonemize.worker   │        │ kokoro.worker      │
   │ Rust wasm + 词典   │        │ ONNX Runtime + 模型 │
   └────────────────────┘        └────────────────────┘
```

- **为什么是两个 worker**（阶段 7）：两个半场本来都已经不在主线程上，但在同一个
  线程里，预取的音素化没法与"正在播放那句"的推理重叠。拆开买到的是这个重叠。
- **为什么切句在主线程**：`planPieces` 同时需要**音素**（只有 phonemize worker
  有词典）和 **token 数**（只有 kokoro worker 有 tokenizer）。任何单个 worker 都
  做不了这一步，所以它必须待在能同时够到两个 worker 的上层。kokoro 协议因此多了
  一条 `count` 请求。
- **任一 worker 死则两个都拆**：留一半活着只会在下一句以更难懂的方式失败。

## Rust crate：`crates/phonemize`

一个 wasm（`phonemize_bg.wasm`，5.08 MB），按"前端 / 后端"分层：

| 层 | 内容 |
|---|---|
| `frontends/` | 每个音素集一个：`ja_ipa`（v1.0 日语）、`zh_ipa`、`zh_zhuyin`（v1.1-zh）、`en_espeak`。最后一步，也是唯一知道模型词表的一层 |
| `backends/` | 各语言的 G2P 与切词：`segmenter_ja`（lindera IPADic）、`segmenter_zh`（jieba-rs）、`pinyin`（pinyin-pro 的移植）、`numbers`/`numbers_zh`（数字读法）、`g2p_en`（piper-plus-g2p，CMU Dict + ARPAbet→IPA） |
| `text.rs` / `zh_text.rs` | 标点归一、脚本切分、空白处理 |
| `vocab.rs` | **词表闸门**：输出的每个字符必须在所选音色的词表里，否则报错而不是静默丢字 |
| `dictionary.rs` | 字典协议：`prepare` 时按名字取 `.bin.zst`，wasm 内解压（`ruzstd`） |

### 词表闸门为什么是错误而不是警告

tokenizer 的 normalizer 是"把不认识的东西替换成空串"：**不在词表里的音素会被删掉，
而且不报错**。ガ行曾经因为写成 ASCII `g`（词表里是 `ɡ`，U+0261）整行读成 ア行，输出
是一串看起来完全正常的 IPA。所以这是闸门。`vocab.rs` 只放行两样东西：空白，和两个
会被 normalizer 剥掉的组合符（U+032F、U+0329）。

## 词典（`public/dictionaries/`，按需取，不进包）

| 文件 | 大小 | 谁用 | 何时取 |
|---|---|---|---|
| `lindera-ipadic-ja.bin.zst` | 8.51 MB | 日语切词 | `prepare('kokoro-v1','ja-JP')` |
| `jieba-zh-dict.bin.zst` | 1.63 MB | 中文切词 | `prepare('kokoro-v1','zh-CN')` |
| — | — | 英文 | **不需要**（CMU Dict 编进 wasm） |

两者都由 `pnpm install` 的 `scripts/setup-{lindera,jieba}-dict.sh` 生成，**不跟踪**。
首句付一次解压（实测中文 82.6 ms、日语 164.3 ms，见
`tests/performance/phonemize-benchmark.test.ts`）。

## 语言分派：跟着**音色**走，不是跟着网页

`lib/models/language.ts` 只有两个谓词（`isChinese`、`isJapanese`），kokoro 引擎用它们
决定怎么渲染一段：

- **中文 / 日语**：IPA 通过 `generate_from_ids()` 进模型（`generate()` 会拒绝英语以外
  的所有音色）。
- **英文（以及其它）**：走 `tts.generate(piece.text)`，即 **kokoro-js 自己内部的
  espeak**。

### 英文这个例外，以及它留下的一个不一致

生产英文**不走** Rust 的 `g2p_en`。`lib/models/phonemize/english.ts` 已在阶段 8 删除，
而它本来也没有调用者；真正发声的是 kokoro-js 内部的 espeak，那是模型训练时的对齐目标。
原因是质量：espeak 处理缩写、缩略词、专名比 CMU Dict 好（阶段 4 的决定，P6.1 仍未拍板
是否迁移）。

需要知道的一个**现存小不一致**：`worker-engine.ts` 对**所有**语言都调 phonemize
worker，英文也不例外。于是英文那句的 **token 数**是按 Rust 的 IPA 算的，而**音频**
是按 kokoro-js 的 espeak IPA 合成的。两者长度不同，切句的估算因此对英文略偏。
不是 bug（`planPieces` 只需要一个上限内的切分），但它是 P6.1 的输入之一：要么让英文
真的走 Rust IPA，要么对英文别再算那份用不上的 IPA。

## 云服务商不做音素化

OpenAI / DashScope / Volcengine / Azure / ElevenLabs / OpenAI-compat 收原始文本，
自己做 G2P。发 IPA 过去会破坏它们的管线。只有 on-device（`local`）走上面这条链。

## 从旧文档保留下来的决定

这些是听感/工程验证出来的，和实现语言无关，仍然成立；细节在括号里的地方：

- **中文全角逗号 → 句号**（比逗号停顿更明显）。7 个变体由用户试听后选定。
  （`crates/phonemize/src/backends/zh_text.rs`、P5 spec）
- **顿号 → ASCII 逗号**，全角句号 → ASCII 句号，`「」《》` → ASCII 引号。
- **拉丁段：全大写 = 逐字母拼读，混合大小写 = 当一个词**（`g2p_en` 与 kokoro-js
  内部路径都这么做）。
- **按脚本切分**（Han / Kana / Latin / Other），每种走不同处理，段间不插分隔符。
- **中文词边界由 jieba 提供**（`hmm` 打开，与 misaki 的切分对齐）；日语不需要，
  假名已经切好了。
- **中文声调是箭头**（↗↘），不是变音符号；v1.1-zh 用注音 + 声调数字。

## 对照语料：三份冻结的黄金文件

`crates/phonemize/tests/fixtures/{zh-parity,zh-frontend-parity,ja-parity}.json`。
**它们过去是"两侧互钉"的**（JS 侧测试断言 JS 产出，Rust 侧测试断言 Rust 产出同一条），
阶段 8 删掉 JS 侧之后，生成器不存在了，它们变成**冻结的黄金文件**：Rust 被钉在
JS 当年产出上，谁也不能再改语料。三份测试的注释都改成了这么说。

重新生成**已经不可能**（`PHONEMIZE_UPDATE_PARITY=1 …` 那条路径随生成器一起消失）。
要扩展语料只能手工编辑 JSON，并接受它不再是"JS 的产出"。

## 再生成的数据（都在 `crates/phonemize/data/`）

| 文件 | 生成脚本 | CI |
|---|---|---|
| `pinyin-{chars,phrases,special,syllables}.txt` | `scripts/gen-pinyin-pro-data.mjs` | `--check` ✅ |
| `pinyin-table.json`（**源**） | `scripts/gen-pinyin-table.py` | 有 `--check` |
| `vocab-v1.txt`、`vocab-v11-zh.txt` | `scripts/gen-kokoro-vocab.mjs`（源 `tests/v0/kokoro-vocabs.json`） | `--check` ✅ |
| `ja-ipa-table.json`（**源**） | 手工维护 | — |
| `ja_ipa_table.rs` | `scripts/gen-ja-ipa-table.py` | 有 `--check`；`cargo test` 的 `ja_ipa_table_parity.rs` 会读 JSON 回比 |

阶段 8 把两个"源"从已删除的 JS 链里搬了过来（`pinyin-table.json` 来自
`lib/models/phonemize/`，`ja-ipa-table.json` 来自 `japanese.ts` 的
`KATAKANA_TO_IPA`）——它们不是链的运行时部分，而是这两张表的唯一出处。

## 测试策略

- **Rust**：`cargo test --workspace`（170 条）。三份语料、字典协议、各后端、
  词表闸门、ja 表的 JSON↔产物一致性。
- **TypeScript**：`pnpm test`（1393 条）。wasm wrapper、字典加载与缓存、两个 worker
  的协议与调度（`worker-engine-phonemize.test.ts` 用**真** `PhonemizeService` 接在
  协调器上，断言到达 kokoro worker 的音素串）。
- **性能**：`pnpm test:performance`（不进 CI，见该配置的注释）。
- **未测**：真实线程边界（vitest 无 Worker，e2e 用 `FakeLocalEngine`）、真机内存
  （阶段 7 的 V8 仍未验）、音频听感（要人耳）。

## 参考

- 设计与理由：`docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`
- 分阶段记录：`p6-zh-frontend.md`、`p6-phase7-two-workers.md`、`p6-phase8-cleanup.md`
- crate 说明：`crates/phonemize/README.md`
- 中文 G2P 的听感验证：`docs/superpowers/plans/2026-10-01-p5-chinese-g2p-v11zh-spec.md`
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)、[misaki](https://github.com/hexgrad/misaki)
