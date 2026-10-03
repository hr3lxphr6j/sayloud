# P6 阶段 8：验证与清理

**日期**：2026-10-04
**状态**：完成（工作区未提交，见末节）
**计划**：`docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md` 阶段 8（第 3047 行起）

---

## 结论

JS 链（`lib/models/phonemize/`、vendored kuromoji/kuroshiro、17 MB 的
`public/kuromoji-dict/`）已删除，7 个依赖移除，产物从 **57,692,840 B 降到
39,900,884 B**——**降幅 17,791,956 B，与 kuromoji 词典的字节数一位不差**。

计划里关于阶段 8 的**五处前提是错的**，其中两处会让"照计划执行"直接弄坏 CI 或
中文功能。下面先记这些，因为它们是本阶段真正的工作量所在。

---

## 计划的前提是错的

### 1. "JS 链无 import（已验证）"——对生产路径成立，对**生成器**不成立

阶段 7 验证的是"没有 entrypoint 能到达 JS 链"，这是对的。但链里有两个文件是
**已提交的 Rust 产物的数据源**，删掉它们 CI 或 Rust 生成链就断：

| JS 链里的文件 | 谁在读它 | 后果 |
|---|---|---|
| `lib/models/phonemize/pinyin-table.json` | `scripts/gen-pinyin-pro-data.mjs`（**CI 跑 `--check`**） | CI 红：找不到文件 |
| `lib/models/phonemize/japanese.ts` 的 `KATAKANA_TO_IPA` | `scripts/gen-ja-ipa-table.py` → `crates/phonemize/src/frontends/ja_ipa_table.rs` | Rust 表失去唯一来源，无法再生成 |
| `tests/unit/models/phonemize/japanese.test.ts` 的 `KOKORO_VOCABULARY` | 同上（`gen-ja-ipa-table.py` 从**测试文件**里抠出这个常量） | 同上 |

做法：**搬迁，不是删除**。

- `pinyin-table.json` → `crates/phonemize/data/pinyin-table.json`，`gen-pinyin-table.py`
  的 `OUTPUT` 与 `gen-pinyin-pro-data.mjs` 的 `SYLLABLE_SOURCE` 同步改指；两份
  NOTICE 与 `tsconfig.json` 里"运行时读它"的注释一并改掉（运行时早已不读它）。
- `KATAKANA_TO_IPA` → `crates/phonemize/data/ja-ipa-table.json`（有序的
  `[kana, ipa]` 数组，193 条），`gen-ja-ipa-table.py` 重写为读 JSON、加 `--check`。
  **搬迁后重新生成，193 条表项与搬迁前的产物逐字节相同**（比对的是表项行）。
- 顺带清掉一个阶段 3 的临时物：`ja_ipa_table.rs` 里那份重复的
  `KOKORO_V1_VOCABULARY`。它自己的注释就写着"阶段 5 的 vocabulary gate 会正式拥有
  这个集合；现在先从 JavaScript 测试里复制一份"——阶段 5 已经交付
  `src/vocab.rs`（115 字符，来自模型自己的 `tokenizer.json`），所以这份副本删掉，
  `crates/phonemize/tests/ja_g2p.rs` 改用 `validate_phonemes(ipa, Vocab::V1_0)`
  走**生产闸门**本身。这同时修掉一个真实缺口：旧副本含整个 ASCII 小写字母表
  （含 `g`），而模型词表里是 `ɡ`（U+0261）——**ガ行那个 bug 用旧副本根本查不出来**。
  它原来的注释也承认这点（"this check is a floor, not a proof"）。现在是 proof。

### 2. "`public/` 清理（kuromoji / jieba 删除）"——jieba 词典**不能删**

`public/dictionaries/jieba-zh-dict.bin.zst`（1.63 MB）不是 JS 链的，它是
**Rust 中文前端的切词词典**：阶段 6 把 `jieba-rs` 的 `default-dict` 特性关掉，
词典改走字典协议（`prepare('kokoro-v1','zh-CN')` 取它）。删了中文就废。
`lindera-ipadic-ja.bin.zst`（8.51 MB）同理。

所以可删的只有 `public/kuromoji-dict/`（17,791,956 B）——而它正好就是全部降幅。

### 3. "预期体积下降 18.5 MB"——实际 17.79 MB，而且**全部**来自那一个目录

```
删除前  57,692,840 B (55.02 MiB)
删除后  39,900,884 B (38.05 MiB)
降幅    17,791,956 B (16.97 MiB)
kuromoji-dict 在产物里的大小  17,791,956 B
```

**一分不差**，因为死的 JS 代码从来没有被打进产物——只有 `public/` 里的字节会
跟着目录走。这正是阶段 7 写下的 [[public-assets-survive-dead-imports]] 的第二次
印证：这次"删依赖省体积"的预测是**对的**，但对的理由是"删的是 public 目录"，
不是"删的是代码"。（1.6 MB 的 jieba 词表按计划本应一起省掉，它不能省，见第 2 条。）

一个反直觉的细节：phonemize wasm 的哈希变了（`CHzXXSaZ` → `B7nzefMl`，因为删掉了
那个常量），但**字节数一位没变**（5,081,554）。约 400 字节的静态串落在 section
padding 里。所以"产物没变小"不能用来证明"代码没删掉"——这次两件事同时发生了。

### 4. "所有测试通过（1513 个）"——删掉 120 个用例，因为它们在测已删除的代码

| | 之前 | 之后 |
|---|---|---|
| 单元测试文件 | 74 | 65 |
| vitest 用例 | 1513 | **1393** |
| Rust 用例 | 169 | **170** |

`1513 − 118（9 个 JS 实现测试文件，其中 `numbersToHan` 的 `it.each` 占 16 条）
− 2（`phonemize-rust.test.ts` 里两条**活 JS 对照**）= 1393`，账目对得上。

被删的两条活 JS 对照是 `'agrees with the JavaScript pipeline on the corpus'` 与
`'differs from JavaScript only where the Latin engine does'`；它们断言的性质由
`crates/phonemize/tests/zh_pipeline.rs` 的 `matches_the_javascript_pipeline_on_the_corpus`
与 `a_latin_run_leaves_the_han_around_it_alone` 在 Rust 侧覆盖，**语料是同一份**。

Rust 169 是"阶段 6 记录的 168 + 工作区里未提交的 `zh_pipeline.rs` 用例 1 条"；
本阶段 +1（新的 `ja_ipa_table_parity.rs`）。

### 5. 英文：删掉 `english.ts` **不影响**生产英文

计划把英文列为"待定"，但没说清生产英文走的是哪条路。实际是
`lib/models/kokoro-engine.ts` 的 `render()`：英文走 `tts.generate(piece.text)`，
即 **kokoro-js 自己内部的 espeak**（它自己的 `phonemizer` 依赖），不是链里的
`english.ts`。`english.ts`（`import { phonemize } from 'phonemizer'`）在生产里
没有任何调用者。所以：

- 删 `english.ts` + 直接依赖 `phonemizer` **不改变英文音频**；
- 英文的 AB oracle 依然可达（kokoro-js 内部路径还在），P6.1 拍板时不必先恢复仓库代码；
- 协议里的 `{ text, ipa }` 双份载荷照旧——那是"按语言分派"的代价，与本阶段无关。

---

## 做了什么

### 8.4 删除 JS 链

- 删除 `lib/models/phonemize/`（9 个文件）、`lib/vendor/kuromoji/`、
  `lib/vendor/kuroshiro-analyzer-kuromoji/`、`public/kuromoji-dict/`、
  `scripts/setup-kuromoji-dict.mjs`（并摘掉 `postinstall` 里的那一步）。
- `pnpm remove doublearray jieba-wasm kana2ipa kuromoji kuroshiro phonemizer
  wasm_open_jtalk`（7 个直接依赖，连传递共 −14 包）。后两个
  （`kana2ipa`、`wasm_open_jtalk`）不是链的，是更早就没人引用的死依赖，一并清掉。
- 删除 9 个 JS 实现测试文件 + `tests/v0|v1/comparison.test.ts` 与它们各自的
  vitest 配置。**保留** `tests/v0/kokoro-vocabs.json`——它是
  `crates/phonemize/data/vocab-v1.txt` 与 `vocab-v11-zh.txt` 的数据源，CI 跑
  `gen-kokoro-vocab.mjs --check`；也保留 v0/v1 的 summary 与结果 JSON 作为记录。
- 删除 `types/kuroshiro.d.ts`：它是给一个已不再是依赖、且已无人 import 的包写的
  手写声明。这条是收尾扫一遍引用时发现的，不在计划清单里。
- 保留 `public/dictionaries/` 与 `scripts/setup-{jieba,lindera}-dict.sh`（见前提 2）。
- 保留 `crates/phonemize/tests/fixtures/*.json` 三份对照语料：JS 生成器没了，语料
  变成**冻结的黄金文件**，Rust 侧继续被它钉住。

### 8.5 构建产物验证

新增一条构建断言 `carries no trace of the JavaScript phonemize chain`：产物里
不得有 `kuromoji-dict/` 目录，也不得有 chunk 提到 `kuromoji` / `kuroshiro` /
`jieba-wasm`。体积上限从 55–59 MB 改成 **38–42 MB**，并把上面第 3 条的账写进注释。

人工核对（全部通过）：wasm 恰好 2 个（ORT 21,596,019 + phonemize 5,081,554）；
`dictionaries/` 只有 jieba 与 lindera 两套；worker chunk 两个
（`kokoro.worker-*`、`phonemize.worker-*`）；产物内 grep 三个标记 **CLEAN**。

### 8.2 性能与冷启动（`tests/performance/phonemize-benchmark.test.ts`）

新增 `vitest.performance.config.ts` + `pnpm test:performance`（**不进 `pnpm test`、
不进 CI**：共享 runner 的噪声会让阈值要么没用要么飘）。用真 wasm、真词典测中位数：

| 项 | 实测（Apple Silicon，2026-10-04） | 阈值 |
|---|---|---|
| 中文 32 字 | **0.050 ms** | < 1 ms（约 20×） |
| 日语 35 字 | **0.039 ms** | < 1 ms |
| 英文首句（建 13 MB CMU 哈希表） | **18.0 ms** | < 150 ms |
| 英文热 | 0.037 ms | < 1 ms |
| 冷启动 + 中文词典（1.6 MB 解压） | **82.6 ms** | < 1000 ms |
| 冷启动 + 日语词典（8.5 MB 解压） | **164.3 ms** | < 1000 ms |
| 冷启动，英文（无词典） | 1.2 ms | < 1000 ms |

计划给的 `冷启动 < 100 ms` 是做不到的：日语 8.5 MB 在 wasm 里解压就要 164 ms。
计划给的 `中文 50 字 < 1 ms` 反而太松（实测 0.05 ms）。两者都按实测改了，
并在注释里写明"实测值 + 倍数"。

注意英文冷启动只有 1.2 ms：wasm 模块编译被 glue 缓存了，所以中日那两个数**几乎
全是词典解压**——这恰好是计划风险清单关心的那一项（"首句付一次字典解压"），
现在它有数字了。

### 8.6 文档

- 本文件。
- `docs/phonemization-architecture.md` 重写为 Rust 架构（旧文档自己写着"迁移落地后
  应重写"）。
- 新增 `crates/phonemize/README.md`：crate 的边界、API、数据文件与再生成方式。
- 修掉被删除动作变成假话的注释：三份语料测试的"两侧互钉、谁也不能单独漂移"
  （现在是"冻结语料"）、`ja_ipa.rs` 的"与 japanese.ts 逐字符对比"、
  `ja_g2p.rs` 的"期望值抄自 JS 测试"、`lib/models/language.ts` 与 `tsconfig.json`。
- `.gitignore` 去掉 kuromoji 词典那一节。

---

## 状态（全部实跑）

```
cargo test --workspace        170 passed
cargo fmt --check             clean
cargo clippy --all-targets    0 warning
pnpm typecheck                clean
pnpm lint                     190 files, no fixes（阶段 7 是 212）
pnpm test                     1393 passed / 65 files
pnpm build                    ok
pnpm test:build               13 passed（阶段 7 是 12）
pnpm check:manifest           passed
pnpm build:e2e                ok
pnpm test:e2e                 37 passed
pnpm smoke:sidepanel          62/64 —— 见下，与本次改动无关
pnpm test:performance         6 passed（数字见上表）
node scripts/gen-pinyin-pro-data.mjs --check   up to date
node scripts/gen-kokoro-vocab.mjs --check      up to date
python3 scripts/gen-ja-ipa-table.py --check    up to date
python3 scripts/gen-pinyin-table.py --check    up to date
```

### `smoke:sidepanel` 的两条失败是既有的（有证据）

失败项：`every provider is listed, in the schema order`（实际顺序把 `local` 放在
第二位）与 `the model card names the licence and what the model speaks`。

证据：**改动前后 10 个 e2e chunk 的哈希逐一相同**（`sidepanel-dn8MvSso.js`、
`registry-eHzwzMBb.js`、`options-xDDghvLr.js` …），即本次改动**没有碰过** smoke
观察的那几个 chunk。而 smoke 脚本最后更新是 2026-10-01，`ProviderConfig.tsx`
（provider 顺序与模型卡片所在文件）最后更新是 **2026-10-03** 的 `03dfe98`——
期望值是在那之后变陈旧的。不属于本阶段，未修（修它要改别人的 UI 断言，应由
那个改动的作者决定期望值）。

---

## 未做 / 遗留

- **8.1 对照测试全量通过**：无需新做。三份语料在 Rust 侧全绿，且本阶段把它们从
  "两侧互钉"改成了"冻结黄金文件"——JS 生成器已不存在，`PHONEMIZE_UPDATE_PARITY`
  那条再生成路径不再可用（三份测试的注释已改成这样说）。
- **8.3 结构化错误码**：未做。现在字典失败仍折进 `model-load-failed`、音色与语言
  不符折进 `voice-mismatch`/`vocabulary-mismatch`。计划里的方案（Rust 侧返回
  `PhonemeError{code,detail}`）与现有 `vocab.rs` 的 `VocabError` 有重叠，值得单独
  一个阶段想清楚，不宜塞进清理阶段。
- **Rust docstring 里对已删文件的引用**：`crates/phonemize/src/backends/*.rs` 与
  若干测试仍以 `chinese.ts` / `japanese-numbers.ts` / kuroshiro / kuromoji 作为
  行为的**出处**引用。这些是"为什么这么写"的记录，不是"去哪读"的指路，故保留；
  真正会误导人的那些（声称"两侧仍在逐字符对比"）已改。若下一个阶段要清，这是一次
  机械替换。
- **`tests/v0`、`tests/v1` 只删了 harness 代码**：`comparison.test.ts` 与
  `vitest.config.ts` 没了，数据与 summary 留着。想在 P6.1 重做英文对照的话，
  v0 的 `performance-benchmark.mjs` 与 `@piper-plus/g2p` 依赖仍在（未删）。
- **`scripts/compare-en-phonemize.mjs`（未跟踪，本次会话开始前刚创建）**：它
  `import { phonemizeEnglish } from '../lib/models/phonemize/english.js'`，
  现在跑不起来了。**没有删它**（不是我创建的），也没改它。要留就把它指向
  kokoro-js 内部路径，要丢就删掉。
- **依赖分区**：`pinyin-pro` 只被 `scripts/gen-pinyin-pro-data.mjs` 用、`@piper-plus/g2p`
  只被 `tests/v0` 用，两者都在 `dependencies` 里，按职责应移到 `devDependencies`。
  没动：改分区要动 lockfile，而本阶段已经在动 lockfile（7 个依赖），混在一起不利于
  复核。
- **README.md 未改**：通读后确认它对 phonemize / kuromoji / jieba 只字未提（它仍是
  P1 的范围，讲 service worker 与 content script）。没有可改的陈旧内容；但仓库已经
  长到 P6，"README 只讲 P1"本身是欠账，值得单独处理，不该在清理阶段顺手扩写。
- **真机验证仍未做**（阶段 7 记的 V8）：两个 worker 的冷启动差、8.5 MB 词典在
  offscreen worker 里的内存与 30 秒回收。本阶段只把**单句与冷启动的墙钟**测了，
  内存那半仍要 DevTools 手动录。

---

## 提交状态（重要）

**本次改动未提交**，全部留在工作区。原因是工作区里同时有本次会话之前就存在的
未提交改动（`crates/phonemize/tests/zh_pipeline.rs`、`zh-frontend-parity.json`、
`docs/issues/2026-10-04.md`、`docs/superpowers/plans/p6-zh-frontend.md`、
`scripts/compare-en-phonemize.mjs`），其中 **`zh_pipeline.rs` 与本次改动重叠**：
按路径提交会把它未提交的那个用例一起卷进来。交错状态下由改动者自己决定怎么切
更合适。

一处需要知道的数据损失：被删的
`tests/unit/models/phonemize/zh-frontend-parity.test.ts` 里有未提交的改动
（把 `'你好世界123'` 加进 `INPUTS`）。**语料与 Rust 断言都还在**（
`zh-frontend-parity.json` 的对应样本、`zh_pipeline.rs` 的
`handles_the_acceptance_examples_the_task_names`），丢掉的只是那个 JS 侧生成器
条目——而生成器本身已经不存在了。

---

#tts-ng #p6 #phase8 #cleanup #build-size #lesson #decision
