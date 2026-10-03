# P6 阶段 4 实施记录：espeak 集成被阻断 + 可行方案评估

**日期**: 2026-10-03
**范围**: 阶段 4（英文 espeak-ng 集成，任务 4.1–4.3）
**状态**: **未实施**。计划 4.1 的路线经实测不可行；本文件记录证据、修正与待拍板选项。
**结论**: 阶段 4 无法按计划执行，需要先做一个架构决策（见 §四）。

计划原文：`2026-10-03-p6-rust-phonemize-implementation.md` §阶段 4（983 行起），
同一份内容也被追加在 spec 文件 1632 行起。

---

## 一、计划里的依赖不存在

计划任务 4.1 的依赖 `espeak-ng-sys = "0.1"`（以及任务描述里的 `espeak-ng-sys`）**在 crates.io 上不存在**：

```
$ cargo info espeak-ng-sys
error: could not find `espeak-ng-sys` in registry `https://github.com/rust-lang/crates.io-index`
```

实际存在的同名候选，以及为什么都不能用：

| crate | 版本 | 性质 | wasm32 是否可用 |
|---|---|---|---|
| `espeakng-sys` | 0.3.0 | **仅 bindgen**：build.rs 只做两件事——`println!("cargo:rustc-link-lib=espeak-ng")` + 生成绑定 | ❌ 要求链接**系统已装的** libespeak-ng；wasm 上没有 |
| `dengjen-espeak-rs-sys` | 0.2.7 | 自带 `bundled/espeak-ng.tar.xz`，用 **CMake** 编译 | ❌ CMake + `wasm32-unknown-unknown` 不成立 |
| `espeak-sys` | 0.0.2 | libespeak（不是 espeak-ng），2015 年后未更新 | ❌ |
| `espeak-ng` | 0.2.0 | **纯 Rust 移植**（eugenehp/espeak-ng-rs） | ⚠️ 可编译，但有运行时阻断，见 §三 |

即：计划选的路线不是「编译复杂」，而是**依赖名就是错的**，且没有可直接替代的 C 绑定。

---

## 二、C 源码编译路线有三个硬阻断（任务是「cc 编译 C 源码」）

### 1. `wasm32-unknown-unknown` 没有 libc，espeak 的 C 源码第一步就编不过

```
$ cargo build --target wasm32-unknown-unknown --release   # probe.c: #include <stdio.h> …
  cargo:warning=src/probe.c:1:10: fatal error: 'stdio.h' file not found
```

espeak-ng 的 C 源码大量使用 `stdio.h` / `stdlib.h` / `string.h` / `math.h`，
而 `wasm32-unknown-unknown` **没有任何 C 头文件**（Rust std 里的 `liblibc` 是 Rust 的 libc crate，不是 C 的 libc）。
要用就得引入 wasi-sdk 并改目标为 `wasm32-wasip1`，那样产物会带 WASI imports，
浏览器 MV3 环境不提供 → 需要自写 WASI shim（见 §四 选项 C）。

### 2. 即使编过，归档器也是坏的（本项目已经踩过同一个坑）

```
$ cargo build --target wasm32-unknown-unknown --release
warning: ccprobe@0.1.0: ranlib: warning: archive member '…-probe.o' not a mach-o file
error: linking with `rust-lld` failed
  = note: rust-lld: error: …: undefined symbol: probe_add
```

宿主 `ar` 只认 Mach-O，静默写出一个**没有成员的归档**。这与
`crates/phonemize/Cargo.toml` 里记录的 `zstd-sys` 失败是**同一个原因**
（本机没有 `llvm-ar`：`xcrun -f llvm-ar` / `/opt/homebrew/opt/llvm/bin/llvm-ar` 都不存在）。

### 3. espeak 必须有文件系统才能读它自己的数据 —— 这是最根本的一条

`espeak_Initialize(path)` 要读 `espeak-ng-data/`（`phontab` / `phonindex` / `phondata` /
`intonations` / `lang/*`）。`wasm32-unknown-unknown` 上 `std::fs` 与 `std::env` **全部失败**，
实测（`/tmp/wasmfs`）：

```
probe() = 0   (0 means every fs/env op failed)
```

探测内容：`Path::exists()` / `read_dir` / `read` / `env::var` / `current_exe()`，全部失败。

**这解释了为什么 JS 侧能跑**：`phonemizer`（npm）是 **emscripten** 构建，
用 emscripten 的**虚拟 FS** + 把 wasm 与数据 base64 内联进 `dist/phonemizer.js`（1.32 MB）。
那是 emscripten 运行时提供的 FS，不是 `wasm32-unknown-unknown` 的能力。
emscripten 产物**不能**链接进 wasm-pack 产出的 Rust 模块（需要 emscripten 自己的 JS glue）。

---

## 三、替代方案：`espeak-ng` 0.2.0（纯 Rust 移植）

这是唯一结构上可能满足「espeak 编进同一个 wasm」的候选。实测结果：

### 3.1 能编译到 wasm32-unknown-unknown，体积很好

```
$ cargo build --target wasm32-unknown-unknown --release     # opt-level="z" + lto
ENGINE+DATA: 1205474 bytes      # 引擎 ~130 KB + 英文数据 1075859 B
data_bytes(): 1075859
```

- 引擎（仅 text→IPA 路径，合成/klatt/mbrola/soundicon 被 LTO 消除）：**~130 KB**
- 英文 espeak 数据（`phontab`/`phonindex`/`phondata`/`intonations`/`lang/*` + `en_dict`）：**1.03 MB**
- 合计 **~1.15 MB**，好于 spec §2.3 的 ~3 MB 估算

注意：这与「决策 #4 字典不编进 wasm」冲突 —— 数据应作为扩展资源 fetch，
但那要求引擎能从**字节**读数据（见 3.3）。

### 3.2 对照结果：**阶段 3 的 3 条 Latin 偏离全部消失**

`EspeakNg::with_data_dir("en-us", …)` + `text_to_phonemes_phonemizer()`
（该方法的名字与 docstring 明说就是为 phonemizer 系管线对齐的）：

| 输入 | JS（`phonemizer`） | espeak-ng-rs (en-us) | |
|---|---|---|---|
| `A P I` | `ɐ pˈiː ˈaɪ` | `ɐ pˈiː ˈaɪ` | ✅ |
| `Chat` | `tʃˈæt` | `tʃˈæt` | ✅ |
| `Q` | `kjˈuː` | `kjˈuː` | ✅ |
| `API` | `ˌeɪpˌiːˈaɪ` | `ˌeɪpˌiːˈaɪ` | ✅ |
| `Agent` | `ˈeɪdʒənt` | `ˈeɪdʒənt` | ✅ |
| `hello world` | `həlˈoʊ wˈɜːld` | `həlˈoʊ wˈɜːld` | ✅ |
| `Kokoro` | `kəkˈoːɹoʊ` | `kəkˈɔːɹoʊ` | ❌ |

- 3 条对照偏离（`APIを使う` / `Chatを使う` / `あQい`）对应的 3 个输入**逐字符相同** →
  「40/40 匹配」这条验收标准在本方案下**可达**。
- 唯一不符是 `Kokoro` 的 `oː` vs `ɔː` —— 属**数据版本漂移**（phonemizer.js 内联的 espeak 版本
  与移植版 1.52.0/master 数据不同），不在语料内，但说明长期会有零散漂移。
- 注意 voice 必须选 `en-us`：`en` 会解析成 en-GB（`Chat` → `tʃˈat`、`Kokoro` → `kəkˈɔːɹəʊ`）。

### 3.3 阻断点：它**只**能从文件系统读数据，wasm 上跑不起来

构造入口只有 fs 版，没有 bytes 版：

```rust
PhonemeData::load(data_dir: &Path) -> Result<Self>     // load.rs:67，唯一构造函数
Translator::new(lang: &str, data_dir: Option<&Path>)   // translate/mod.rs:7184
default_data_dir()  // env::var / current_exe() / cwd —— wasm 上全是空
```

`EspeakNg::new()` / `with_data_dir()` 第一步就是 `data_dir.exists()` → wasm 上恒为 false → 报错。
`install_bundled_language(dir, "en")` 也是**写文件**（`std::fs::write`）。

生产路径上约 15–20 处 fs 调用，集中在 `default_data_dir` / `Translator::new`（dict + phontab）/
`PhonemeData::load` / `voices::list_voices` / `voice_pitch` / `load_variant`。

**好消息**：底层解析器**已经是 bytes 的**（`Dictionary::from_bytes(&stem, &[u8])`、
`parse_phontab(&[u8])`），数据 crate 也导出 `pub static ALL_FILES: &[(&str, &[u8])]`。
所以「从字节读数据」在实现上是可行的，但**需要 fork 上游**（或上游加一个数据源抽象）。

### 3.4 阻断点二：**许可证是 GPL-3.0-or-later**

`espeak-ng` 0.2.0 与 `dengjen-espeak-rs-sys` 都是 `GPL-3.0-or-later`。

这一点必须单独说清楚：**换成纯 Rust 移植并不能解决 GPL 问题**。
`p6-final-decision.md` 把 GPL 列为待法务确认的风险（「espeak GPL → 需法务确认（已知风险）」），
而把 GPL 代码**静态链接进我们自己的 wasm**，比现在「消费一个独立的 npm 包」在派生作品认定上
**更直接**，不是更轻。

---

## 四、三个选项与代价

| | A. fork espeak-ng-rs 改内存数据源 | B. espeak 留在 JS（现状） | C. emscripten/wasi 自建虚拟 FS |
|---|---|---|---|
| 满足「单 wasm」（决策 #2） | ✅ | ❌（多一个 wasm 模块） | ✅ |
| 阶段 3 三条偏离消失 | ✅ 已验证 | ✅（就是现在 JS 用的同一个 espeak，必然一致） | ✅ |
| 许可证 | ❌ GPL-3.0（且是静态链接，更直接） | 维持现状（npm 包，Apache-2.0 声明） | ❌ 仍是 GPL |
| 新增维护面 | fork 一个 0.2.0 的 GPL crate，上游一动就要跟 | 无 | 自写 WASI shim + 虚拟 FS + 工具链 |
| 数据加载 | 需要给 fork 加 bytes 数据源（决策 #4 要求数据不编进 wasm） | 数据已内联在 phonemizer.js 里 | 需要把 espeak-ng-data 灌进虚拟 FS |
| 版本漂移风险 | 有（已观测到 `Kokoro` 的 `ɔː`/`oː`） | 无（同一份构建） | 无 |
| 工作量 | 中（~15–20 处 fs 调用 + 数据源抽象 + 长期跟上游） | **小**（改造 Rust 返回值形状，见下） | 大 |

**选项 B 的具体形状**（如果选它）：Rust 侧 `phonemize` 不再返回单个字符串，
而是返回分段结果（`[{script, phonemes} | {script: "latin", text}]`），
Latin 段由 TS 侧用现有的 `phonemizer` 填好再拼。
分段逻辑仍全在 Rust（`segment_text` 已实现），所以不是把逻辑搬回 JS。
代价是 `phonemize` 变成需要组装的两阶段调用。

**关于「单 wasm」这条决策的再评估**：spec §1.1 自己的实测结论是
「英文慢 47 倍**不是**跨 wasm 边界造成的……差距来自 espeak 自身的算法量」，
而 JS 侧**今天就已经**是「async 跨 wasm 边界调 espeak」。
所以选项 B 不是性能回归，而是维持现状；决策 #2 的收益需要重新称量。

---

## 五、建议与待拍板

**建议**：默认走 **选项 B**，理由是
1. 计划的 C 路线不可行（§二），而唯一的单 wasm 替代（A）**并没有解决**当初记下来要法务确认的 GPL 风险；
2. 选项 B 的对照结果是**必然逐字符相同**（就是同一份 espeak 构建），而 A 已经观测到数据版本漂移；
3. `p6-final-decision.md` 已经把「保留现有 espeak wasm（不改变现状）」写成最坏情况下的可接受方案。

**若「单 wasm」不可让步** → 选项 A，但需要先确认两件事：
(a) GPL-3.0 静态链接进产品 wasm 是否可接受（法务）；
(b) 是否接受长期 fork 维护 + 给上游提 bytes 数据源的 PR。

**需要用户决定**：A 还是 B（或先做法务确认再定）。

---

## 附：复现命令

```bash
# 1. 依赖不存在
cargo info espeak-ng-sys                      # error: could not find

# 2. 无 libc（/tmp/libcprobe）
cargo build --target wasm32-unknown-unknown --release
#   fatal error: 'stdio.h' file not found

# 3. 归档器损坏（/tmp/ccprobe）
cargo build --target wasm32-unknown-unknown --release
#   undefined symbol: probe_add

# 4. wasm 上没有文件系统（/tmp/wasmfs）
node run.mjs                                  # probe() = 0

# 5. 纯 Rust 移植的对照与体积（/tmp/rspeak）
cargo run --release                           # host：打印各 voice 的 IPA
cargo build --target wasm32-unknown-unknown --release && ls -la …/rspeak.wasm
```

上述探针目录都在 `/tmp`（重启即失效，按需重建；步骤都很短）。

**工作区状态**：本次**未改动仓库任何代码**（`git status` 干净，HEAD 仍是 `fa0be2c`）。

---

## 六、实施记录：piper-plus-g2p（2026-10-03，阶段 4 已完成）

用户拍板：**方案 B 的替代 —— piper-plus-g2p（MIT）**，接受 OOV 词静默跳过。
本节记录落地时的实测数字、改动点、以及**两条与任务书不符的事实**。

### 6.1 任务书里两处不成立的前提（已实测）

| 任务书写的 | 实测 | 证据 |
|---|---|---|
| 用 `piper-plus-g2p = "0.4"` | 0.4.0 **没有** `bundled-dicts` 特性，也**没有** `data/` 目录 | 解包 `.crate` 后 `data/` 不存在；`cargo info` 特性表无 `bundled-dicts` |
| `EnglishPhonemizer::new()` 会用 `include_str!` 加载 | `new()` 走**文件系统**（`CMUDICT_PATH` / `./cmudict_data.json` / `/usr/share/piper/...`），wasm 上必然失败；`include_str!` 的 `new_bundled()` 只在**未发布的 master（0.5.0）**上 | 0.4.0 源码 `find_dictionary()`；master 的 `new_bundled()` 是 `#[cfg(feature = "bundled-dicts")]` |

0.4.0 与 master 的 `english.rs` **逻辑逐行相同**（`diff` 只有 31 行：`new_bundled`、一段 doc、一处路径字符串），
所以调研文档里那些输出（`A P I` → `ə pˈiː aɪ` 等）在两条路线上都成立。

**采取的路线**：git 依赖 + `bundled-dicts`，pin 到 rev
`82ee4e7a9b7aded42e0d0d5fd8298b42bfa51a16`（远端 `refs/heads/dev` = 当时的 HEAD）。
理由：任务书的约束 3（数据自动嵌入）与约束 1（不修改上游）只有这条路线能同时满足；
spec §2.3 本来就把英文数据算在 wasm 里（"英文 espeak-ng（C 源码用 cc crate 编进来）"），
`dictionary.rs` 的注释也写着"中文拼音表和英文数据编译进 wasm，所以这两种语言今天不 fetch 任何字典"——
即「决策 #4 字典不编进 wasm」指的是 IPADic 那类大字典，不是英文 G2P 数据。

### 6.2 体积与代价（实测）

| 指标 | 值 | 怎么测的 |
|---|---|---|
| wasm | **330 KB → 3.92 MB**（4,112,077 B） | `./scripts/build-phonemize-wasm.sh` |
| wasm（gzip） | 1.02 MB | `gzip -c … \| wc -c` |
| 词典原始 JSON | 3.75 MB / 123,455 词 | `du` / `json.load` |
| 引擎（除词典） | ~100 KB | 3.85 MB − 3.75 MB（探针） |
| 首次构建 backend（解析词典） | **27 ms**（wasm）/ 14 ms（host） | 探针 `build_ms()` |
| 常驻内存 | 词典字符串 3.75 MB（wasm data 段，恒常驻）+ HashMap ~13 MB | 探针 RSS delta 16.9 MB（wasm）/ 34 MB（host） |
| 单词查表 | ~1.3 µs | 探针 100 次 131 µs |

wasm 涨到 3.92 MB **在 spec §2.3 的 ~3 MB 预算之外**，但正是任务书写的"~4 MB，这是预期的"。
注意它**还没有进入产物**：`lib/models/phonemize-rust.ts` 目前只被测试引用，worker 仍是 JS 链（阶段 7 接线），
所以 `pnpm build` 的产物（55.35 MB）和 CRX 体积**这次没有变化**。

HashMap 是懒建的（`lib.rs` 的 `OnceLock`，第一次遇到 Latin 段才建）：没有拉丁文的日语句子一分钱不花。
代价是第一次遇到 Latin 段会在**同步**的 `phonemize` 里多花 27 ms。

### 6.3 改动点

| 文件 | 改动 |
|---|---|
| `crates/phonemize/Cargo.toml` | git 依赖（pin rev），`default-features = false` + `["english","bundled-dicts"]` |
| `crates/phonemize/src/backends/g2p_en.rs` | **新增**：`EnglishG2p`、`is_initialism`、`spelled_out`，+ 8 条单测 |
| `crates/phonemize/src/backends/mod.rs` | 导出 |
| `crates/phonemize/src/pipeline.rs` | Latin 段 → `EnglishG2p`；返回 `Phonemized { phonemes, warnings }` |
| `crates/phonemize/src/lib.rs` | `OnceLock<Option<EnglishG2p>>` 懒加载；warnings 进结果 |
| `crates/phonemize/src/types.rs` | `PhonemizeResult.warnings`（空则不出现在线上） |
| `lib/models/phonemize-rust.ts` | `warnings?: readonly string[]` |
| `crates/phonemize/tests/fixtures/ja-parity.json` | 见 §6.4 |
| `crates/phonemize/tests/ja_pipeline.rs` | +5 条集成测试；修正 `every_recorded_divergence_is_still_a_divergence` 的注释 |
| `tests/unit/models/phonemize-rust.test.ts` | +2 条跨边界测试 |

### 6.4 对照结果（40 条语料）

| 样本 | JS（espeak） | Rust（piper） | |
|---|---|---|---|
| `Chatを使う` | `tʃˈætoɕiu` | `tʃˈætoɕiu` | ✅ 偏离**消失**，note 已删 |
| `あQい` | `akjˈuːi` | `akjˈuːi` | ✅ 偏离**消失**，note 已删 |
| `APIを使う` | `ɐ pˈiː ˈaɪoɕiu` | `ə pˈiː aɪoɕiu` | ⚠️ 仍偏离，但**性质变了**：不再是"原样透传"，而是两台引擎的音素细节（`ə`/`ɐ`、次要重音符号） |

即 **38/40 逐字符相同，2 条（含 API 那条）见上**。`APIを使う` 的 note 已改写成上面这个理由，
两条守卫测试（`the_pipeline_matches_the_javascript_one`、`every_recorded_divergence_is_still_a_divergence`）
正是逼出这次改写的机制——它们在我改代码后立刻红了。

### 6.5 首字母缩略词：这一阶段真正的关键

`API` 在 CMU Dict 里**没有**（`api` 查不到），所以如果直接把整段 Latin 交给 piper，`APIを使う` 会变成 `oɕiu`——
缩写**静默消失**。是 JS 侧那条 `isInitialism` 规则（全大写 → 逐字母拼读）救的场：
`API` → 交给 piper 的文本是 `A P I` → `ə pˈiː aɪ`。
Rust 侧复刻了同一条规则（`/^[A-Z]+$/`），并有一条测试锁住"26 个字母全都有读音"——
否则拼读路径内部丢一个字母，整段检查是看不见的。

### 6.6 OOV 的代价（按用户拍板执行，但必须写下来）

按任务书"OOV 静默跳过、不要修复"实现：查不到就返回空 + 记 warning，不猜。
后果是**混合大小写的专有名词会静默变没**（只有 warning，没有声音）：

```
Kokoroを使う  →  oɕiu      （JS 是 kəkˈoːɹoʊoɕiu）
OpenAI / GitHub / ChatGPT 同样
```

全大写缩写不受影响（走拼读路径）。这与阶段 3 写下的原则相反——
`pipeline.rs` 原注释说"错的音比没有音更容易被发现"，而 espeak 也确实是"猜"（把 `RAG` 读成单词 rag）。
改法是一行：`pipeline.rs` 里 `phonemized.is_empty()` 时把 `run_text` 推进 `parts` 而不是只记 warning。
**留待用户确认**：如果 Kokoro/OpenAI/GitHub 这些词在日文文本里出现得够多，这行就该改。

### 6.7 测试

| | 之前 | 现在 |
|---|---|---|
| `cargo test --workspace` | 58 | **71**（+8 g2p_en 单测、+5 pipeline 集成） |
| `pnpm test` | 1457 | **1459**（+2 跨 wasm 边界） |

另外全绿：`cargo fmt --check`、`pnpm typecheck`、`pnpm lint`（biome，200 文件）、
`pnpm build`、`pnpm check:manifest`。e2e / sidepanel smoke 未跑：本次没有改动应用代码路径
（`phonemize-rust.ts` 只加了一个可选字段，且无人 import）。

### 6.8 未做与风险

- **`lang="en"` 整句仍未接**（仍是 `pipeline-not-implemented`，有测试锁住）。原因：piper **跳过数字**
  （实测 `I have 3 cats` → `aɪ hæv kˈæts`），接上会相对 espeak 回归；缺的是 spec 里 `numbers.rs` 的
  "中日英"数字读法。日文句子里的 Latin 段没有这个问题——数字永远不属于 Latin 段。
- **git 依赖的代价**：CI 每次要 clone 上游仓库（`.git` 97 MB）。已 pin rev 保证可重现；
  若日后上游发布带 `bundled-dicts` 的版本，换回 crates.io 版本即可。
- 上游若 force-push 掉该 rev，构建会失败——pin rev 的固有权重。
