# P6 阶段 3 实施记录：计划里与实际不符的地方

**日期**: 2026-10-03
**范围**: 阶段 3（日语 lindera 集成 → G2P → 对照测试）
**状态**: 已实现并验证；本文件只记录**计划与实际不符之处**和**尚未完成的部分**

计划原文是 `2026-10-03-p6-rust-phonemize-implementation.md`（该文件的内容也被追加在
`2026-10-03-p6-rust-phonemize-spec.md` 第 650 行之后，所以 spec 文件里混进了整份计划）。
下面每条都给出证据和修正方案。

---

## 一、必须修正的事实错误

### 1. `lindera = "0.33"` / `"0.34"` 这个版本不存在

Rust crate `lindera` 的最新版本是 **6.2.0**（crates.io 实测）。计划任务 3.1 步骤 1 写的
`0.33`、任务 3.2 的下载 URL 写的 `v0.34.0` 都对不上。

**修正**：`lindera = { version = "6.2", default-features = false }`。

### 2. `features = ["ipadic"]` 这个 feature 不存在

6.2.0 的 features 是 `embed-ipadic` / `embed-cc-cedict` / `embed-jieba` …，
`ipadic` 不在其中。而且 `embed-*` 是把词典 `include_bytes!` 编进产物 ——
与 spec §4.4「读中文文章不该付出日语词典的代价」直接冲突。

**修正**：不加任何词典 feature，只依赖 `lindera-dictionary`（见下条），词典仍然作为
按需加载的扩展资源。

### 3. `default-features = false` 是硬要求，不是整洁问题

`lindera` 的默认 feature 是 `mmap`。`wasm32-unknown-unknown` 上没有文件系统可供映射。

### 4. **Rust crate 没有 `load_from_bytes`**

计划任务 3.1 步骤 4/3.2 步骤 3 的注释写 `Dictionary::load_from_bytes`。这个 API 属于
**npm 包 `lindera-wasm`**（V1 在 Node 里验的就是它），不属于 Rust crate。

Rust crate 只有 `Dictionary::load_from_path`，而它第一步就 `dict_path.is_dir()` ——
wasm 上没有目录。**这是本阶段最大的一个坑。**

**已采用的修正**（可行且已验证）：`Dictionary` 的五个字段都是 `pub`、没有
`#[non_exhaustive]`，且每个组件都有接受字节的构造函数
（`PrefixDictionary::load` / `ConnectionCostMatrix::load` / `CharacterDefinition::load` /
`UnknownDictionary::load` / `Metadata::load`）。`load_from_path` 本身就是读九个文件后
调用这些构造函数。所以 `src/backends/segmenter_ja.rs` 做的是同一件事，只是把文件系统
换成字典容器。

**代价（必须知道）**：这段代码依赖另一个 crate 的结构体字面量和五个构造函数签名，
由 `Cargo.lock` 锁定。lindera 升级时这里是第一处会断的地方。

**替代方案（如果不想承担这个耦合）**：改用 npm 的 `lindera-wasm` 作为第二个 wasm
模块 —— 但那会变成两个 wasm，违反 spec §0.4「单模块」。

### 5. 任务 3.1 步骤 7（用 `zstd::decode_all` 解压）是**过时内容**，不要照做

阶段 2 已经用 `ruzstd` 实现了这件事，并且明确拒绝了 C 版 `zstd`（原因写在
`crates/phonemize/Cargo.toml` 的注释里：zstd-sys 用宿主 `ar` 归档 wasm 目标文件，
产出 96 字节的空档案）。照计划执行会把已经解决并记录过的问题重新引入。

### 6. 任务 3.2 的下载地址和格式都错了

- 计划：`.../v0.34.0/lindera-ipadic-0.34.0.tar.gz`
- 实际：`.../v6.2.0/lindera-ipadic-6.2.0.zip` —— 是 **zip**，不是 tar.gz；
  解压后是 9 个文件 + `NOTICE.txt`，共 45.4 MB。

**修正**：见 `scripts/setup-lindera-dict.sh`。

### 7. 产物体积比计划小

计划说压缩态 ~10 MB。实测 `zstd -19` 后 **8.5 MB**（比官方 zip 的 10.5 MB 还小，
因为 zip 用的是 deflate）。

---

## 二、任务 3.3「Kurihara 韵律标记（A1/A2/A3）」**无法实现**，已改为对照测试

这不是没做，是在当前技术选择下**做不了**，三条独立证据：

1. **IPADic 里没有音高重音数据。** 它的 schema 是
   `surface, left/right_context_id, cost, 品詞×4, 活用型, 活用形, 原形, reading, pronunciation`
   —— 没有 A1/A2/A3。那三个值来自 **OpenJTalk 的全上下文标注**
   （`piper-plus/g2p` 的 `phoneme-extract.js` 解析的就是那种字符串），
   而 OpenJTalk 用的是它自己的带重音词典。lindera + IPADic 这条路上不存在这些标注。

2. **标记字符不在 Kokoro v1.0 的词表里。** `[` `]` `#` 都不在 115 字符的词表内
   （实测：`[` `]` `#` 全为 false）。Kokoro 的 tokenizer normalizer 是
   `Replace` + 空串 —— **词表外的字符被删除，不是近似替换**。加上这些标记的结果是
   标记消失，而它两侧的音素会被错误地重新切分。

3. **N 音变同样落不到词表上。** `N_m` / `N_n` / `N_ng` / `N_uvular` 在 piper-plus 里
   映射到 PUA `U+E019`–`U+E01C`，实测不在词表内；而 `ɴ` 在词表内，且现有 JS 实现
   把 ン 无条件映射成 `ɴ`（`japanese.ts` 的 `KATAKANA_TO_IPA`）。
   改成 N 音变会**同时**破坏对照等价性和字符存活。

**已改为**：40 条样本的**双向对照语料** `crates/phonemize/tests/fixtures/ja-parity.json`，
由 JS 侧生成、两侧各自锁定（JS 测试断言 JS 输出仍等于语料，Rust 测试断言 Rust 输出
等于语料或语料里记录过的偏离）。三条已知偏离（Latin 段）逐条写明原因，并且有一条
测试会在偏离消失时失败，提醒删掉记录。

**如果以后确实要韵律标记**，需要换词典（OpenJTalk 或 UniDic 的带重音版本）+ 换前端
（把 `[` `]` `#` 加进词表，即换模型）。那是另一个项目，不是这个阶段的一项任务。

---

## 三、计划没提到、但不做就会出错的部分

### 8. `numbers_to_kanji` 必须移植，否则数字静默消失

计划把数字归一化放在 `backends/numbers.rs`，但阶段 3 的任务清单里没有它。
不做的后果是实测过的：数字被 `segment_text` 归为 `other`，再被 `keep_punctuation`
丢掉 —— 不出声，也不报错。所以移植了 `japanese-numbers.ts`
（`src/backends/numbers.rs`）。

### 9. lindera 用 `*` 填充缺失字段，kuromoji 不填

实测：IPADic 里没有词条的词（`キャンプ`、`2022`），lindera 的 `Token::get("reading")`
返回 `Some("*")`（metadata 的 `default_field_value`），而 kuromoji 返回 undefined，
于是 kuroshiro 走「没有读音 → 用表记」的兜底。

**不处理的话**：`キャンプ` 的输出会变成 `*`（一个字符），而 JS 输出 `kjaɴpu`。
修法是从 metadata 读 `default_field_value` 当作「无值」哨兵
（`SegmenterJa::absent_field`），不要硬编码 `*`。

### 10. JS 侧 `KOKORO_VOCABULARY` 与它自己的注释矛盾

`japanese.ts` 的注释和 spec §1.3 都说词表**没有** ASCII `g`（所以 ガ 行曾经读成 ア 行），
但 `japanese.test.ts` 里那份词表拷贝含 `abcdefghijklmnopqrstuvwxyz` —— 也就是说
`g` 在里面。两份东西必然有一份错。

**影响**：那份拷贝比真实词表宽松，所以「表里每个字符都在词表内」这条断言比它读起来弱。
**修正方案**：阶段 5 的 `vocab.rs` 必须从模型的 `tokenizer.json` 直接取词表，
不要用拷贝。（本次没有改 JS 侧，因为约束要求不动现有 JS。）

### 11. `segmentText` 的 CJK 扩展 B 分支是死代码

`common.ts` 判断 `code >= 0x20000 && code <= 0x2ebef`，但 `charCodeAt(0)` 对 BMP 外
字符返回的是**代理项**（0xD800–0xDFFF），永远不落在这个区间。所以扩展 B 的汉字
（如 𠮟）被归为 `other`，随后被 `keep_punctuation` 丢掉。

Rust 侧**刻意复现可达行为**（不加这个分支），因为对照等价优先；修法在 JS 侧，
而阶段 8.4 会把 JS 链整个删掉。已有一条测试锁住这个行为，并在注释里写明原因。

---

## 四、内存：一个已知代价，需要在阶段 8.2 解决

日语**稳态约 91 MB**，而 spec 预算的是 45.3 MB：

| 部分 | 大小 |
|---|---|
| 注册表持有的解压后 tar | 45.4 MB |
| lindera `Dictionary` 持有的九份组件 | 45.4 MB |

**本次已消除的是瞬时峰值**：`unpack` 之后用 `take()` 把文件**移**进 lindera
（`files.remove(index).1`），不再 clone，所以峰值不再是 3 份。

**剩下的稳态 2 份是刻意留下的**，两个修法各有代价，都不该在阶段 3 悄悄做：

1. **建完就释放容器**：给注册表加「已构建」状态，让 `finish` 认为已构建的字典算到位，
   然后 `take` 掉解压后的字节。改动会触及阶段 2 的契约
   （现有三条测试锁住「字节留在注册表里」：`feeding_the_same_dictionary_twice_keeps_the_first_copy`、
   `switching_language_back_does_not_demand_the_dictionary_again`、
   `a_dictionary_stays_loadable_after_the_required_set_moved_on`）。
2. **泄漏一个对齐缓冲**，让九个组件都变成 `Data::Static` 切片，零拷贝。
   只有 45.4 MB，但**依赖 worker 一定会被回收** —— 而 spec §7 的 V8
   明确写着「offscreen worker 里的内存与回收行为**未验**」。在没验之前泄漏是猜。

阶段 8.2 的验收项就是内存，从这里开始。

---

## 五、阶段 3 实际交付与验证

**新增**：`src/kana.rs`、`src/text.rs`、`src/pipeline.rs`、`src/backends/{mod,segmenter_ja,numbers}.rs`、
`src/frontends/{mod,ja_ipa,ja_ipa_table}.rs`、`scripts/setup-lindera-dict.sh`、
`scripts/gen-ja-ipa-table.py`、`tests/ja_g2p.rs`、`tests/ja_pipeline.rs`、`tests/common/mod.rs`、
`tests/unit/models/phonemize/ja-parity.test.ts`、`ja-table-parity.test.ts`

**验证结果**：

| 项 | 结果 |
|---|---|
| `cargo test --workspace` | **58 passed**（17 协议 + 32 G2P + 9 流水线），无 warning |
| `cargo fmt --all --check` / `cargo clippy -p phonemize --all-targets` | 干净 / **零 warning** |
| `pnpm test` | **1457 passed / 68 files** |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` / `check:manifest` | 全绿 |
| 对照语料 | **40 条，37 条逐字符等于 JS 输出，3 条为已记录的 Latin 偏离** |
| 变异测试 | **10/10 被抓** |
| 冷启动实测（release wasm，Node） | init 11 ms + 解压 186 ms + 建字典 5 ms = **202 ms**；phonemize **0.02 ms/句** |
| wasm 体积 | **330 KB**（词典仍是独立资源） |
| `pnpm smoke:sidepanel` | 62/64 —— 失败的 2 条与阶段 2 记录的同名同因（provider 顺序、模型卡 licence），**与本次改动无关** |

**尚未完成（按计划属于后续阶段）**：

- Latin 段走 espeak（阶段 4）—— 当前是**原样透传**，不是丢弃（丢弃是静默失败，
  而且对首字母缩略词来说透传的字母本来就在词表里，更接近 JS 的输出）
- 中文拼音表 / v1.1-zh 注音（阶段 5）；vocab 闸门（阶段 5）
- `zh` / `en` 调用 `phonemize` 会抛 `pipeline-not-implemented`，**不是**返回空串
- worker 接线（阶段 7）：TS wrapper 的 `phonemize` 已经接通 wasm，但还没有人调用它
- 字典缺失时测试**失败**（不是跳过），除非显式设 `PHONEMIZE_SKIP_DICT_TESTS=1`
