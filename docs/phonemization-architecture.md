# Phonemization Architecture

> **Status (2026-10-04, P6 阶段 8 完成)**: 文本预处理（TN + G2P）全部在 **Rust** 里，
> 编译成单个 wasm，跑在专用的 phonemize worker 里。**JavaScript 链已删除**：
> `lib/models/phonemize/`、vendored kuromoji/kuroshiro、`public/kuromoji-dict/`、
> 以及 `kuromoji`/`kuroshiro`/`jieba-wasm`/`phonemizer` 依赖都不在了。
>
> 本文上一版描述的是那条 JS 链，并在开头写着"迁移落地后应重写"——现在重写了。
> 选型与终态见 `docs/superpowers/plans/P6-FINAL.md`。

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

一个 wasm（`phonemize_bg.wasm`，6.09 MB），按**数据流的三个阶段**分层：

| 层 | 内容 |
|---|---|
| `tn/` | 文本 → 文本：vendored WeText 引擎（`wetext/`）、它前面的英文门控（`gate.rs`）、按语言构造的接线（`engine.rs`）、以及引擎缺席时顶上的三个手写读数器（`readers/`）。`mod.rs` 是 `normalize(text, Lang, engine)` |
| `g2p/` | 文本 → 音素，按语言分目录：`ja/`（lindera IPADic + 假名表）、`zh/`（jieba-rs 切词、pinyin-pro 读音、变调与儿化、中文标点规则）、`en/`（CMU Dict + NRL 7948 规则 + 字母） |
| `pipeline.rs` | 编排：每语言一个函数、`ToneRules`、返回的错误与告警 |
| `text.rs` / `kana.rs` | 共用原语：标点归一、脚本切分、空白处理、假名谓词 |
| `vocab.rs` | **词表闸门**：输出的每个字符必须在所选音色的词表里，否则报错而不是静默丢字。同一个文件也持有「哪个 id（`kokoro-v1` / `kokoro-v11-zh`）对应哪套词表」 |
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
| `wetext-en-tn-*.bin.zst` | 707 KB | 英文数字 | `prepare('kokoro-v1','en-US')` |
| `wetext-zh-tn-*.bin.zst` | 160 KB | 中文数字 | `prepare('kokoro-v1','zh-CN')` |
| `wetext-ja-tn-*.bin.zst` | 63 KB | 日语数字 | `prepare('kokoro-v1','ja-JP')` |

（`wetext-*-tn` 每项是两个文件：tagger 与 verbalizer，成对缺一不可——tagger 认实体，
verbalizer 说出来。英文的**发音**词典仍然是编进 wasm 的 CMU Dict，不入此表。）

全部由 `pnpm install` 的 `scripts/setup-{lindera,jieba,wetext-fsts}.sh` 生成，**不跟踪**。
首句付一次解压（实测中文 82.6 ms、日语 164.3 ms，见
`tests/performance/phonemize-benchmark.test.ts`；TN 文法另外付一次 FST 解析，英文 70 ms）。

## 语言分派：跟着**音色**走，不是跟着网页

`lib/models/language.ts` 已随阶段 10 删除（它的两个谓词 `isChinese`/`isJapanese` 再无调用者）。
现在语言只决定一件事：**哪条音素化管线**。

- **三条管线，一个渲染入口。** 中文 `zh-CN`、日语 `ja-JP`、英文 `en-US` 各自走
  `crates/phonemize` 里的一条管线，输出 IPA，经 `generate_from_ids()` 进模型。
- 音色 id 的前缀（`zf_`/`jf_`/`af_`…，见 `lib/providers/local.ts::voiceLanguage`）是
  语言从哪来的唯一信号，选错会让句子被当成另一种语言音素化，而不是报错。

### 英文两处历史例外都已收敛

1. **渲染路径**。阶段 10 之前 `KokoroEngine.render()` 按语言分叉：英文走
   `tts.generate(piece.text)`（kokoro-js 内部 espeak），中日文走 `generate_from_ids(ipa)`。
   现在三种语言都走 IPA。代价与缺口（尤其是 8 个英式音色没有自己的音素变体、
   `nˈaɪnti`→`nˈaɪndi` 这类 en-US 专属改写的缺失）见 `crates/phonemize/README.md`，
   **听感测试未做**。
2. **token 数与音频不一致**。`worker-engine.ts` 对所有语言都调 phonemize worker，
   英文也不例外——于是英文那句的 token 数按 Rust IPA 算、音频按 espeak IPA 合成，
   两者长度不同，切句估算因此对英文略偏。阶段 10 之后两者是同一串 IPA，这条不一致消失。

## 云服务商不做音素化

OpenAI / DashScope / Volcengine / Azure / ElevenLabs / OpenAI-compat 收原始文本，
自己做 G2P。发 IPA 过去会破坏它们的管线。只有 on-device（`local`）走上面这条链。

## 从旧文档保留下来的决定

这些是听感/工程验证出来的，和实现语言无关，仍然成立；细节在括号里的地方：

- **中文全角逗号 → 句号**（比逗号停顿更明显）。7 个变体由用户试听后选定。
  （`crates/phonemize/src/g2p/zh/text.rs`、P5 spec）
- **顿号 → ASCII 逗号**，全角句号 → ASCII 句号，`「」《》` → ASCII 引号。
- **拉丁段：全大写 = 逐字母拼读，混合大小写 = 当一个词**（`g2p_en` 与 kokoro-js
  内部路径都这么做）。
- **按脚本切分**（Han / Kana / Latin / Other），每种走不同处理，段间不插分隔符。
- **中文词边界由 jieba 提供**（`hmm` 打开，与 misaki 的切分对齐）；日语不需要，
  假名已经切好了。
- **中文声调是箭头**（↗↘），不是变音符号；v1.1-zh 用注音 + 声调数字。
- **中文变调与儿化音是阶段 9D 加的，而且可关**（`pipeline::ToneRules`）：
  P5 §1.5 的论证是 v1.0 音色训练时不做这两件事，所以 `Off` 保留为阶段 6 管线的逐字
  复现，冻结语料一直跑 `Off`。两边的证据在 `crates/phonemize/src/g2p/zh/tone_sandhi/mod.rs`。

## 对照语料：两份冻结的黄金文件 + 一份参考语料

`crates/phonemize/tests/fixtures/{zh-parity,zh-frontend-parity}.json`。**它们过去是"两侧互钉"的**
（JS 侧测试断言 JS 产出，Rust 侧测试断言 Rust 产出同一条），阶段 8 删掉 JS 侧之后，生成器
不存在了，它们变成**冻结的黄金文件**：Rust 被钉在 JS 当年产出上。

日语的 `ja-reference.json` **不是**这一类。JS 链路当年把词典按脚本 run 分段读，钉在它上面
等于钉住错误的读法（`語る` → カタリル、助词 `は` → ハ），而且那个错误在词汇闸门出现之前
是静默的。它现在的锚点是**参考实现**——pyopenjtalk 的発音字段，即 OpenJTalk 那条链，也就是
Kokoro 日语训练时用的那一代 misaki 的读法——并且**可以重新生成**：
`scripts/check/check-ja-reference.py --write`（需 `pip install pyopenjtalk`）。每个样本同时记录
`kana`（参考读法）与 `expected`（本 crate 渲染出的音素）；两者不一致的样本必须带 `gap` 说明，
目前只有 `経営`（IPADic 的 pronunciation 字段收合ウ段长音、不收合エ段）。

## 再生成的数据（都在 `crates/phonemize/data/`）

| 文件 | 生成脚本 | CI |
|---|---|---|
| `pinyin-{chars,phrases,special,syllables}.txt` | `scripts/generate/gen-pinyin-pro-data.mjs` | `--check` ✅ |
| `pinyin-table.json`（**源**） | `scripts/generate/gen-pinyin-table.py` | 有 `--check` |
| `vocab-v1.txt`、`vocab-v11-zh.txt` | `scripts/generate/gen-kokoro-vocab.mjs`（源 `tests/v0/kokoro-vocabs.json`） | `--check` ✅ |
| `ja-ipa-table.json`（**源**） | 手工维护 | — |
| `ja_ipa_table.rs` | `scripts/generate/gen-ja-ipa-table.py` | 有 `--check`；`cargo test` 的 `ja_ipa_table_parity.rs` 会读 JSON 回比 |

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

- 选型与终态：`docs/superpowers/plans/P6-FINAL.md`
- crate 说明：`crates/phonemize/README.md`
- 中文 G2P 的听感验证：`docs/superpowers/plans/2026-10-01-p5-chinese-g2p-v11zh-spec.md`
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)、[misaki](https://github.com/hexgrad/misaki)
