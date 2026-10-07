# P6：Rust 音素化 —— 选型与终态

**状态**：已落地。文本 → 音素（IPA / 注音）的**全部**预处理在 `crates/phonemize`，
编译成单个 wasm，跑在 offscreen 文档的 phonemize worker 里。

**本文只写两件事**：每个问题域**选了什么、为什么**，以及**现在树里是什么样**。
过程（谁提出、任务书怎么写的、哪条假设错了、逐阶段实测的来龙去脉）不在本文范围，
也不该再写回来——那部分随各阶段文档一起删除了。代码注释里出现的 `phase 9B` / `9E`
一类标签，用 §附录 的对照表解读。

**数字口径**：§六 的数字都是在 macOS 上、`cargo test` + `pnpm test` + `pnpm test:build`
+ `pnpm test:performance` 实测（2026-10-05）；除非写明「早先测量」，不要跨机器对比。

---

## 一、约束（决定了下面所有选型）

1. **单 wasm，三语言**（`zh-CN` / `ja-JP` / `en-US`，英语还要处理中日文句中的拉丁段）。
2. **许可证**：只能 MIT / Apache-2.0。没有 GPL，也没有需要系统库或文件系统的 C 依赖。
3. **`wasm32-unknown-unknown`**：没有文件系统、没有网络、没有 libc。大字典按名
   fetch（zstd 帧）后在模块内解压；其余数据 `include_str!` 编译进模块。
4. **未知词不能静默丢失**：读不出来要报错或给保底读法，输出还要过词表闸门。
5. **体积是产品指标**：扩展 40.5 MB，其中 21.6 MB 是 ONNX Runtime，音素化这一半约 6.1 MB。

---

## 二、选型结果

| # | 问题域 | 选择 | 为什么 | 否决掉的 |
|---|---|---|---|---|
| 1 | 计算边界 | Rust → 单个 wasm；JS 只搬字节（给**名字**不给 URL） | 一份实现三语言共用；字典格式变化不动 JS | 每语言一个模块；把 G2P 留在 JS |
| 2 | 字典协议 | 压缩帧按名 fetch，`load_dictionary(bytes)`，模块内解压 | 让 8.5 MB 的 IPADic 不进 wasm，同时保持离线可用 | 编进 wasm（>20 MB）；首次使用时联网下载（破坏离线）；git LFS |
| 3 | 日语分词 | `lindera` + IPADic（MIT） | 全上下文标注 + 假名读音，纯 Rust | kuromoji（JS，随阶段 8 删除） |
| 4 | 日语读音 | 自维护 `ja-ipa-table.json` → 生成 Rust 表 | 表驱动、无依赖、可逐条钉住 | espeak-ng 与 OpenJTalk（C、要文件系统、许可） |
| 5 | 英文读音 | CMU 词典（`piper-plus-g2p`，123,455 词，3.75 MB，**编进 wasm**） | 词典是转写而不是「读法」，命中即准 | espeak-ng 的全部路线；用 HeadTTS 的 125,829 词词典替换它（与 CMU 重复，且那 2.79 MB 资产当时无人引用） |
| 6 | 英文 OOV | HeadTTS 的 NRL Report 7948 规则表（**309 条**，MIT） | 词典没有的词给真实读音，而不是逐字母；+17,385 B | 字母拼读（`GitHub` → 六个字母）；「7948 条规则」的误解（7948 是报告编号） |
| 7 | 中文分词 | `jieba-rs`（MIT，HMM 打开） | 与 misaki 的切分对齐；词典按协议加载 | jieba-wasm；C 版 jieba |
| 8 | 中文读音 | `pinyin-pro` 静态表 + `pinyin-table.json`（pypinyin / misaki） | 静态、零依赖、可生成可校验 | g2pW（见 #12）；PaddleSpeech 的 Python G2P |
| 9 | 数字与实体 TN | **WeTextProcessing 的加权 FST**，三语言共用（vendored 源码 + 上游 FST，Apache-2.0） | 日期/时间/金额/百分比/序数/单位/缩写一次覆盖；实体上明显强于手写读数器 | 把 `wetext-rs` 当依赖（wasm 下不可用，且有两个缺陷）；git fork；只做英文；HeadTTS 自带 TN（要重写已覆盖的实体） |
| 10 | 英文 TN 门控 | 手写字节扫描（`tn_gate`，+977 B，2.8 µs / 950 字符） | 不门控就要**每句**付 33 ms / 710 字符的 tagger；正则要编译自动机且每句都跑 | 不门控；正则门控 |
| 11 | 中文音系 | PaddleSpeech 的 `ToneSandhi` + `_merge_erhua` 移植（Apache-2.0），开关 `ToneRules` | 变调/儿化是听感最明显的缺口，且零额外依赖 | 只靠 `pinyin-pro`（它内置一/不 变调，但没有三声连读之外的词层规则与儿化） |
| 12 | 中文多音字消歧 | **不做**（g2pW ONNX） | 模型 ≈5 MB + 运行时 + 首句延迟，收益只在少数词；同一份工作量在 #11 上听感更明显 | g2pW / g2pM（记录在案，不落地） |
| 13 | 合成入口 | 三语言统一 `IPA → tokenizer → generate_from_ids()`；裸模块名 `phonemizer` 别名到 throwing stub | 英文曾走 `kokoro-js` 的 `generate(text)`（内部 espeak），等于第二个前端，且 token 数按 Rust IPA 算、音频按 espeak IPA 合成 | 英文继续走 `generate(text)`（+2.5 MB espeak 数据） |
| 14 | 输出校验 | 词表闸门**报错**，并在校验前做 `ɚ → əɹ` 之类 repair | tokenizer 的正常化是空串替换：表外音素会被**静默删除**（ガ行读成ア行就是这么来的） | warning；静默通过 |
| 15 | 音素表 | v1.0 用 IPA（声调是箭头）；`v1.1-zh` 用注音 + 数字 | 两个模型两套词表，词表跟着**音色**走，不跟语言走；id 用模型名（`kokoro-v1`），Rust 侧叫 `vocab`、TS 侧叫 `VocabId` | 统一成一套 IPA |

**#9 的两个附带决定**：旧的手写读数器（`numbers.rs` / `numbers_zh.rs` / `numbers_en.rs`）
**保留**，作为 `Option<&Normalizer>` 为 `None` 时的 fallback——它等于没有 TN 的历史行为，
JS 时代的对照语料靠它才还有意义；中文的旧读数器不是「重复代码」而是**另一个答案**
（`2024` 一律当量词读，WeText 在有「年」时读年份）。同理 `ToneRules::Off` 是阶段 6 管线的
逐字复现，`lib.rs` 传 `On`，一行可回滚。

---

## 三、终态：管线

```
输入文本
  ↓
分段（Han / Kana / Latin / Other）＋标点规范化          text.rs, zh_text.rs
  ↓
数字与实体 TN：WeText 加权 FST（无 prepare 时退回手写读数器）   wetext_tn.rs, tn_gate.rs
  ↓
┌── 日语 ────────────┐ ┌── 中文 ─────────────────────┐ ┌── 英文 ──────────────────┐
│ lindera IPADic 分词 │ │ jieba-rs 分词                │ │ 不分词                    │
│ 假名 → IPA 表       │ │ pinyin-pro 读音              │ │ CMU 词典（编进 wasm）      │
│                     │ │ 变调 + 儿化（ToneRules，可关）│ │ → 词典外：NRL 7948 规则    │
│                     │ │                              │ │ → 再外：字母拼读          │
└─────────────────────┘ └──────────────────────────────┘ └───────────────────────────┘
  ↓
词表闸门（v1.0 IPA / v1.1-zh 注音），先 repair 再校验，越界即报错
  ↓
IPA / 注音 ──► phonemize worker ──► kokoro worker：tokenizer → generate_from_ids()
```

**英文 OOV 是三层、有顺序的**：词典 → 规则 → 字母。全大写 run 当缩写逐字母读
（`HTTP`），run 里没有 `A/E/I/O/U` 时不试规则（`xyz` 交给字母，规则会把 `sql` 读成 `skl`）。

---

## 四、终态：模块与数据

**Rust（`crates/phonemize`，src ≈9.9k 行 + tests ≈5.7k 行）。分三个阶段：`tn` → `g2p` → `pipeline`；不属于任何一段的基础件留在顶层**

| 路径 | 职责 |
|---|---|
| `src/lib.rs` | wasm 边界：`Phonemizer::{new, required_dictionaries, load_dictionary, finish_loading, ready, phonemize, phonemize_with}` 与错误码 |
| `src/pipeline.rs` | 编排：`phonemize_{ja,en,zh}`、`ToneRules`、`Phonemized`、`PipelineError` |
| `src/dictionary.rs` | 字典协议：注册表与 per-`(vocab, lang)` 需求表 |
| `src/vocab.rs` | 词表闸门（`Vocab::for_id`：模型名 → 词表） |
| `src/text.rs` / `src/kana.rs` / `src/types.rs` | 共用原语：分段与标点、假名谓词、跨界形状 |
| `src/tn/mod.rs` | `normalize(text, Lang, engine)`：语言自带的 fallback、门控与后处理 |
| `src/tn/engine.rs` + `src/tn/wetext/` | WeText 接线与 vendored 引擎（`NOTICE` 列 7 处改动） |
| `src/tn/gate.rs` | 英文 TN 门控 |
| `src/tn/readers/{ja,zh,en}.rs` | 三个手写读数器（引擎缺席时的答案） |
| `src/g2p/ja/{segmenter,ipa,table}.rs` | lindera 分词、假名 → IPA、生成的假名表 |
| `src/g2p/zh/{segmenter,pinyin,text}.rs` | jieba 分词、读音与音节表、中文标点与分行 |
| `src/g2p/zh/tone_sandhi/` | 中文变调与儿化（4 张词表，509 条） |
| `src/g2p/en/mod.rs` + `headtts/` | 英文三层 G2P（词典 → 309 条规则 → 字母） |

**资产（`public/dictionaries/`，按需 fetch，全部 zstd）**

| 资产 | 大小 | 何时来 |
|---|---|---|
| `lindera-ipadic-ja.bin.zst` | 8,507,015 B（内存里 ≈45.3 MB，解压 9.6 ms） | `prepare(ja-JP)` |
| `jieba-zh-dict.bin.zst` | 1,632,261 B | `prepare(zh-CN)` |
| `wetext-en-tn-{tagger,verbalizer}.bin.zst` | 161,322 + 545,550 B | `prepare(en-US)` |
| `wetext-ja-tn-{…}.bin.zst` | 29,657 + 33,486 B | `prepare(ja-JP)` |
| `wetext-zh-tn-{…}.bin.zst` | 53,826 + 105,929 B | `prepare(zh-CN)` |

**编译进 wasm（`include_str!`，不 fetch）**：CMU 词典（3.75 MB）、NRL 7948 规则（309 条，
+17,385 B）、pinyin 表（21,132 字符读音 + 4,184 词组 + 426 音节 + 23 条一/不/了 规则）、
词表（v1.0 115 字符 / v1.1-zh 172 字符）、假名 IPA 表。

**TypeScript 侧**：`lib/models/phonemize-rust.ts`（`ready` / `prepare` / `phonemize`，
拥有 URL 与 Cache Storage）、`phonemize-service.ts`、`phonemize.worker.ts`（offline worker）、
`worker-engine.ts`（协调器）、`kokoro-engine.ts`（只做推理）、`phonemizer-stub.ts`（别名目标）。

---

## 五、终态：对外接口与不变量

- **名字不是 URL**：wasm 说「我需要 `lindera-ipadic-ja`」，JS 决定从哪来。
- **`prepare` 是显式的一步**：第一句之前完成；`phonemize` 之后是同步的（模块内无 I/O）。
- **三条不变量**（测试钉住）：skip 蕴含 TN 无事可做；词表外音素一定报错；
  没有 `prepare` 时是历史行为而不是崩溃。

---

## 六、实测数字（2026-10-05）

| 指标 | 值 |
|---|---|
| `phonemize_bg.wasm` | **6,091,677 B** |
| 扩展总计 | **40,522,918 B**（ORT 21,596,019 + IPADic 8.5 MB + wasm 6.1 MB + …） |
| kokoro worker chunk | 904,612 B（阶段 10 前 2,225,156 B） |
| Rust 测试 | **299 passed / 0 failed**（+2 个 ignored doc-test） |
| TS 测试 | **1397 passed**（66 文件） |
| 构建测试 | 14/14（含 wasm 尺寸、espeak 痕迹、ORT 单例） |
| 热路径（每句） | 中文 0.082 ms / 32 字；日语 0.031 ms / 35 字；英文 **0.055 ms**（门控跳过的句子；首次调用 29.8 ms 是 CMU 哈希表） |
| 冷启动 | 中文 91.4 ms；日语 169.1 ms；英文 68.7 ms（含 0.7 MB TN 文法） |
| `cargo fmt --check` / `clippy -D warnings` / `typecheck` / `biome` | 全绿 |

---

## 七、已知缺口与未做的事

1. **日语冷启动 164.9 ms** 未达「<100 ms」的目标；**日语内存 ≈91 MB**（lindera 的容器
   与自建副本各持一份 45.3 MB），没有测试也没有优化。
2. **8 个英式音色（`bf_*` / `bm_*`）走美式音素**，没有 en-GB 路由；espeak 在另一侧更好的
   几类也因此丢失或保留：缩写按词念（NASA/FAQ）、`to` 的弱读、`$10.50` 的 cents。
   **听感 A/B 一次都没做过**（模型 163 MB，本机无缓存）。
3. **`FAQ` → `ˈɛf ə kjˈuː`**：拼出的单个 `A` 走了 CMU 词典里的单词 a。这是刻意保留的旧行为
   （26 个字母的名字表能修，但会改到中日文里的拉丁段）。
4. **`1000 → ten hundred`**：这是文法自己的等代价平局（Python 参考也一样），不是缺陷；
   `1,000–1,999` 丢 `one` 是缺陷，已由 `fix_one_thousand_bug` 后处理修掉（+1,568 B）。
5. **TN 门控的白名单洞**：3,050 个无形状键里 **1,127** 个被跳过，其中 **182** 个会改变
   音素（真实散文 127 句上 0 漏报）。要关掉这个洞，门控需要把白名单当输入。
6. **中文多音字没有上下文消歧**（`重要` vs `重复`），见 §二 #12 的决定。
7. **中文 TN 让两处读法变差**：`０１２３` 与单独的 `０`（手写读数器更好），已用测试钉住。
8. **extractor 的两项改进未实施**（`docs/extractor-improvements.md`）：per-site 选择器，
   以及纯文本引用标记 `[54]` 的清洗。当前只有 DOM 层的 `<sup>` 跳过，正文里的 `[54]`
   会让整句 TN 放弃。
9. **`ninety` 的 en-US 改写缺失**（`kokoro-js` 有 `nˈaɪnti → nˈaɪndi`），`render()` 留着
   `lang` 参数不读，就是为了以后再补这一条。

---

## 八、怎么构建与验证

```bash
pnpm build:wasm              # wasm-pack → lib/models/phonemize-wasm/（pnpm build 会先跑）
cargo test --workspace       # 297，原生，无浏览器
cargo clippy --all-targets -- -D warnings
cargo fmt --check
pnpm typecheck && pnpm lint && pnpm test        # TS 1397
pnpm test:build              # 构建产物断言（尺寸、espeak 痕迹、ORT 单例…）
pnpm test:performance        # 不在 CI：数字只在同一台机器上有意义
./scripts/setup/setup-dictionaries.sh           # 建 public/dictionaries/（幂等）
node scripts/generate/gen-pinyin-pro-data.mjs --check   # 与 pnpm check:* 都在 CI 里跑
```

CI（`.github/workflows/ci.yml`）跑：三个生成器的 `--check`、`cargo test`、`typecheck`、
`lint`、`pnpm test`、e2e、`pnpm build`、`check:manifest`、side-panel smoke。
**不跑** `cargo fmt` / `cargo clippy` / `test:build` / `test:performance`。

**维护约定**：本文是 P6 的唯一文档。改动落地后更新 §二/§四/§六，缺口进 §七；
不要把过程写回来——要留证据就写进代码注释或测试。

---

## 附录：阶段编号对照

代码注释里的 `phase N` 指的是落地顺序，不是文档：

| 标签 | 落地内容 |
|---|---|
| 1–2 | workspace 与字典协议 |
| 3 | 日语 G2P（lindera + IPADic + 假名 IPA 表） |
| 4 / 4.5 / 5 | 英文 G2P（CMU）；三语言手写读数器；中文 G2P（jieba + pinyin-pro） |
| 6 | 中文前端组装（标点、分行、变体） |
| 7 | 拆成 phonemize / kokoro 两个 worker |
| 8 | 删除 JS 链（kuromoji + kuroshiro + jieba + espeak + pinyin-pro，−17.8 MB） |
| 9A | 英文 OOV：HeadTTS / NRL 7948 规则（309 条） |
| 9B | 英文 TN：vendored WeText FST + 最小路径修复 + 门控 |
| 9C | 中文多音字消歧 —— **决定不做**（§二 #12） |
| 9D | 中文变调与儿化（可开关） |
| 9E | 中日文 TN：同一个 WeText 引擎 + 全角数字修复 |
| 10 | 三语言统一 IPA 渲染，移除 espeak 依赖 |
