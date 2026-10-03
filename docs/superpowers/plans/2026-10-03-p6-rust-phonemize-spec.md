# SayLoud P6: 预处理 Rust 化 Spec

**日期**: 2026-10-03
**前置条件**: P5 阶段 1 已交付（jieba 词边界 / 句号代替逗号 / 拉丁字符分流）
**状态**: **设计已定，尚未开工**
**目标**: 把 `lib/models/phonemize/` 整条链迁到一个 Rust 编译的 wasm 模块

> **引用约定**：本文里的 `§x.y` 指**本文**；指向 P5 时写成 `P5 §x.y`。

---

## 0. 概述

### 0.1 目标

预处理（TN + G2P）从 JS 迁到 Rust，交付**单个 wasm 模块**：

- **输入**：原始文本 + options（frontend / lang / 可选替换规则）
- **输出**：目标 Kokoro 模型可以直接进 tokenizer 的音素串

### 0.2 为什么是 Rust

**理由不是性能。** 实测（§1.1）显示预处理只占合成耗时的 0.009%–0.44%，离性能墙有三个数量级。真正的理由有两条：

1. **TN / FST 这一层，JS 生态没有可用的方案。** 业界做 TN 的共识是 FST（Google Kestrel → Sparrowhawk → NVIDIA NeMo → 阿里 WeTextProcessing），而 JS 侧没有任何等价库。Rust 侧有 `fst`（↓29.4M）和 `regex-automata`（↓1.3B）。
2. **日语汉字转换在 JS 生态里是持续的痛苦来源。** kuromoji 需要 vendor + ESM 转换才能用（`4ecb37e`），词典 17.8 MB 打包进扩展，且它的读音不做音变（P5 后续为此加了 5 条补丁）。Rust 侧有 lindera（↓2.47M，官方 wasm 支持）。

### 0.3 不包含

- **不改播放、模型加载、音色管理**——这些留在 JS
- **不改云端 provider**（dashscope / volcengine / elevenlabs / azure / openai-compat 直接发原始文本，服务端自己做前端）
- **不改句子切分**（`Intl.Segmenter` 留 JS，浏览器原生且按页面语言工作）
- **本文件不规定实现顺序**，只定接口与约束

### 0.4 成功标准

| 项 | 标准 |
|---|---|
| 输出等价 | 对照测试（§5.1）下，Rust 输出逐字符等于 JS 输出，**或有记录的更优** |
| 冷启动 | wasm + 字典就绪 ≤ 100 ms（不含模型加载），**首句首次触达某语言再 +~100 ms**，见 §4.2 |
| 单模块 | 只有**一个** `.wasm`，espeak 也在里面 |
| 开箱即用 | 用户不需要为字典做任何下载动作 |

---

## 1. 现状实测

### 1.1 预处理耗时（2026-10-03 实测）

Node 环境，20 次平均，预热后（首次调用含 jieba / kuroshiro / espeak 的初始化，已排除）：

| 语言 | 短句 | 中句 | 长句(3x) |
|---|---|---|---|
| 中文 | 0.02 ms | **0.07 ms** | 0.19 ms |
| 日语 | 0.02 ms | **0.16 ms** | 0.33 ms |
| 英文 | 1.67 ms | **3.28 ms** | 8.27 ms |

**对照合成成本**（`P4`/`P5` 记录的 WebGPU RTF：v1.0 fp32 为 0.15–0.18，v1.1-zh 为 0.10；一句 5 秒音频约 500–750 ms）：

| 语言 | 占合成 |
|---|---|
| 中文 | 0.009% |
| 日语 | 0.021% |
| 英文 | 0.44% |

**英文慢 47 倍不是跨 wasm 边界造成的**——中文的 jieba 同样是 wasm，50 字只要 0.07 ms。差距来自 espeak 自身的算法量（规则驱动的 G2P）。

### 1.2 线程位置（现状）

```
sidepanel                    独立线程（UI）
service worker               background.js
offscreen 文档（主线程）       TimelinePlayer 的计时器 + 播放
   ↓ postMessage
嵌套 worker (type: 'module')  KokoroEngine = ONNX 会话 + phonemize
```

`KokoroEngine` 全仓库只有一个实例，在 `entrypoints/offscreen/local.worker.ts:121`；`phonemize` 只从它内部调用（`lib/models/kokoro-engine.ts:93`）。隔离到 worker 的理由写在 `local.worker.ts` 开头：offscreen 主线程还要驱动 `TimelinePlayer` 的计时器，一次阻塞一秒的推理就是正在播放的音频的一次卡顿。

**因此**：Rust wasm 实例**必须建在这个 worker 里**。没有 `SharedArrayBuffer`（COOP/COEP 刻意未启用，见 `wxt.config.ts`），wasm 实例无法跨线程传递。

**注意**：预处理与模型**共享同一线程**。这是“预处理变慢”的代价所在——不是播放卡顿（那被 offscreen 主线程隔离着），而是**合成吞吐下降**、prefetch 跟不上、句间出现空隙。

P6 要把这两者**拆成两个 worker**，理由见 §2.4。

### 1.3 模型侧的两套音素集

`P5 §2.1` 已记录：v1.0 与 v1.1-zh 不是同一个模型的新权重，而是**两套前端 + 两套音素集**。2026-10-03 复核了 vocab：

| | v1.0 | v1.1-zh |
|---|---|---|
| vocab 大小 | 115 | **172** |
| 音素体系 | IPA | **注音符号（38 个）** |
| 声调 | 箭头 `↓→↗↘` | **数字 `1`–`5`** |
| 词分隔 | 空格 | **`/`** |
| 儿化 | 无 | **`R`** |
| 中文音色 | 8 个（官方评级 D） | **100 个** |
| 日语 | 有 | **无**（中文数据重训，字符在但模型没学过） |

**vocab 差异明细**（实测）：
- **v1.1-zh 独有 66 个**：`12345`、`/`、38 个注音符号、`R`、21 个 PaddleSpeech 遗留汉字
- **v1.0 独有 9 个**：`↓→↗↘` + `ꭧ ɚ ɥ ɻ ɤ`
- **共有 106 个**：完整的英文 IPA 字符集 → **英文路径两个模型共用**

**已知的字符冲突**：espeak 在英文里会产出 `ɚ`（`never` → `nˈɛvɚ`），而 v1.1-zh 的 vocab 没有它。不处理会被 tokenizer 的 normalizer **静默删除**（那是 `Replace` + 空串，不是近似替换）。需要在 Rust 侧做替换（`ɚ` → `əɹ`，两者都在 v1.1-zh 里）。

**词表闸门**：每个 frontend 一份 vocab，输出前统一校验。**一处校验覆盖两个模型三种语言**，而不是每条路径各写一遍——2026-10-03 在日语 path 上已经踩过一次同类问题（`KANA_TO_IPA` 里写了 ASCII `g`，而 vocab 只有 `ɡ` U+0261，导致整个ガ行读成ア行），spec `P5 §4.2.1` 也把它写成了硬要求。

### 1.4 lindera 加载实测（2026-10-03，V1 部分）

在 Node 里用 `lindera-wasm` 6.2.0 的 `initSync` + `loadDictionaryFromBytes` 跑通，词典用 GitHub Releases 的 `lindera-ipadic-6.2.0.zip`：

| 阶段 | 耗时 |
|---|---|
| wasm `initSync` | 2.9 ms（1.7 MB） |
| 读 9 个文件（Node 磁盘读） | 8.9 ms（45.3 MB） |
| **`loadDictionaryFromBytes`** | **9.6 ms** |
| `TokenizerBuilder.build` | 7.9 ms |
| tokenize（热，200 次平均） | 0.106 ms/句 |

**三条结论**：

1. **能从本地字节加载**，不必走它默认的 OPFS 下载流程——`loadDictionaryFromBytes` 接受 9 个 `Uint8Array`，来源不限。这是“字典打包进扩展”这条决策能落地的前提。
2. **加载不建索引**。45.3 MB 只要 9.6 ms（~4.7 GB/s），这是指针/切片设置的速度；若在构建 trie 或填充 HashMap，这个数字会是几百毫秒。**§4.3 的「解压即可用」lindera 天然满足，不需要自建格式。**
3. **体积比现在小**。zip 10 MB / 解压 45.3 MB，对比 kuromoji 的 17.8 MB（gzip）——省 44%。

读音质量与 kuromoji 同源（两者都是 `mecab-ipadic-2.7.0`，lindera 用的版本是 `-20250920`，更新）：
`経営 → 名詞,サ変接続,*,*,*,*,経営,ケイエイ,ケイエイ`。

**附**：同一个 release 里还有 `lindera-cc-cedict-6.2.0.zip` = 6.92 MB（中文分词词典）。P6 里中文分词原计划用 `jieba-rs`，现在多了一个选项，留到实现阶段决定。

**这个实测的边界**（2026-10-03 评审指出，已采纳）：它跑在 **Node**，不是 offscreen
worker。它证明的是**lindera 的 API 行为**（能从字节加载、不建索引），**没有**证明
45.3 MB 在 offscreen worker 里的内存表现，也没有证明它不会被 30 秒回收打断。
P5 §2.2 恰好提醒过同一件事（“POC 跑在普通页面里，**不是 MV3 offscreen 文档**”）。
所以 V1 降级为**部分验证**，并新增 **V8**（§7）。

---

### 1.5 语言从哪来：音色，不是网页

`lib/providers/local.ts:173`：

```ts
const lang = local.lang ?? voiceLanguage(request.voiceId) ?? 'en-US';
```

phonemize 的 `lang` 取自**音色**（必要时被设置里的 `local.lang` 覆盖），**与网页的
`<html lang>` 和文本字符集都无关**。（2026-10-03 用户纠正——spec 早先把预取时机写成
“reader 送来第一段时”，那是错的。）

这条对 P6 有两层意义：

1. **同时只有一种语言**（除非用户换音色），不是“一篇里中日英混排”。
   §2.4 的字典策略针对的正是这个形态——所以“按需”实际上就是“载那一种”。
2. **语言在用户选音色时就知道**，远早于播放。所以 §2.4 的方案 C（预取）可以在
   拿到所选音色的那一刻就 `prepare`，连“等第一段”都不用，首句惩罚可以**完全消除**。

**但它也意味着一件事值得确认**：若用户拿日语音色去读中文页面，`lang` 仍是 `ja`——
按需求走，因此不会是 bug；但错误提示的文案（§8.1）不要写成“页面语言不支持”。

---

## 2. 架构

### 2.1 链式结构

两阶段，**不可压平**（分段依赖预处理结果）：

```
text ──[preprocess: TextStep[]]──► text ──[segment]──► run
                                                        │
                                          [backends: 按 kind]
                                                        │
                                          parts ──[assemble]──► phonemes
                                                        │
                                              [vocabulary gate]
                                                        ▼
                                                    安全音素串
```

**为什么是链式而不是 `if lang == ...` 分派**：v1.0-zh 与 v1.1-zh 的中文链**只差两步**（han 后端、组装），其余（数字、标点、分词、拉丁、标点保留）完全相同。链式是表达这个差异的最小方式；二维 if 会把差异淹没。

### 2.2 按模型编排

**模型声明**，代码不判断：

```rust
/// 每种语言用哪条前端。**键就是支持的语言** —— 缺一个键就是这个模型说不了
/// 那种话，调用方必须明说，而不是合成一段听起来合理的东西。
frontends: {
    "zh" => Frontend::ZhIpa,      // v1.0
    "en" => Frontend::EnEspeak,
    "ja" => Frontend::JaIpa,
}
// v1.1-zh:
frontends: {
    "zh" => Frontend::ZhZhuyin,
    "en" => Frontend::EnEspeak,   // ← 与 v1.0 同一条
}
```

**预定义前端，不做任意组合**。真正的组合只有个位数（`zh-ipa` / `zh-zhuyin` / `ja-ipa` / `en-espeak`），"任意步骤组合"只会变成配置爆炸。

### 2.3 单 wasm 的构成

```
phonemize.wasm   (估算 ~3 MB，不含字典)
├── TN        fst + regex-automata + 各语言规则表
├── 中文      pinyin 表 + 分词（现在是独立的 jieba wasm）
├── 日语      lindera（IPADic / UniDic）
├── 英文      espeak-ng（C 源码用 cc crate 编进来）
└── 闸门      每个 frontend 一份 vocab
```

**espeak 必须编进同一个 wasm**：否则 Rust 调它的 wasm 是又一次跨界，而英文恰是当前最慢的路径。

**体积对照**：现在 = kuromoji JS + 17.8 MB 字典 + jieba wasm + espeak wasm；之后 = 一个 ~3 MB wasm + 按需的字典。

### 2.4 Worker 拓扑：拆成两个

**当前只有一个真 Worker**。`AudioWorker` 虽然叫 Worker，但它是主线程上的一个类（`lib/audio-worker.ts:131`），管着 prefetch 队列、generation 计数器、两套超时（`synthesizeTimeoutMs` / `localSynthesizeTimeoutMs`）。真正在 worker 里的只有 `local.worker.ts` 那一个，ONNX 和 phonemize 挤在一起。

**目标**：

```
offscreen 主线程（AudioWorker 调度）
  ├── phonemize worker    ← Rust wasm + 字典（CPU 密集）
  └── kokoro worker       ← ONNX Runtime（GPU 密集）
```

两个 worker 都由 offscreen 创建，跟着 offscreen 一起被回收。**不让两个 worker 直接互连**——虽然 `MessageChannel` 能把 port 传给另一个 worker，但调度应该留在上层的 `AudioWorker` 里，那是它已经在做的事。

**收益：流水线那半个数字是真的，冷启动那半个是错的**

第一版这里写“冷启动省 13%”，论证是“字典解压 ~100 ms 与模型 init 750 ms 并行”。
**这个论证站不住**：决策 #9 是按需加载，字典在“首次遇到某语言”时才载，而那
时模型早已就绪——没有并行可言。2026-10-03 的架构评审指出了这一点。

真实的收益表是这样：

| 场景 | 单 worker | 双 worker | 改善 |
|---|---|---|---|
| 每句（播放中） | phonemize 0.07 + 合成 500 = 500.07 ms | 重叠 → 500 ms | 0.07 ms（**0.014%**） |

**所以这是个显式的 trade-off，必须在两者之间选一个**：

| | 载什么 | 何时载 | 有并行吗 | 首句 |
|---|---|---|---|---|
| **A. 按需**（首句触发） | 用到的语言 | 首句 | ❌ | +~100 ms |
| **B. 预加载全部** | 所有语言 | 启动时 | ✅ | 0 |
| **C. 预取目标语言** | 用到的语言 | **选音色时**（§1.5） | ✅ | 0 |

**倾向 C**：它同时拿到 A 的“只载用到的”与 B 的“与模型 init 并行”——代价是
若用户中途**换音色**（换成说另一种语言的音色），新语言仍要现载一次；而这发生在
**用户主动操作之后**，可以顺带提示，比首句默默卡一下好。

选 C 的话，双 worker 那 13% 就真的成立。前提（“播放前就知道语言”）**已经确认**
——语言取自音色（§1.5），用户选音色时就知道，比“等 reader 送第一段”早得多。

和 §0.2 一样写清楚，是为了防止将来有人拿一个算错的数字当拆 worker 的理由。

**三条理由**：

1. **冷启动并行**：字典解压（CPU）与模型 init（GPU/网络）真正并行。但**这只在方案 C 下成立**——用 A（首句触发）时字典落在模型就绪之后，根本没有并行。这是每次播放都要付的成本（§4.1 的 30 秒回收）。
2. **解耦**：phonemize 是纯计算、无 I/O、无 GPU；模型是 GPU + 网络。失败模式、资源画像、生命周期都不同，同线程只是历史巧合。
3. **未来弹性**：若 phonemize 之后变重（音调预测、大量用户规则），双 worker 是**唯一**能重叠的结构。现在做是设计成本，将来做是重构成本。

**成本**：

- **多一个 V8 isolate**：每个 worker 自带一份（几 MB + 几毫秒的固定开销，未实测）。
  **注意这不是“多一份 wasm”**：wasm 实例与线性内存在两种方案里**数量相同**
  （ORT 一个、phonemize 一个，各自持有），不是拆分带来的。真正多出来的只有
  isolate 本身，以及**每份线性内存要各自预留**（不能共享，预留策略得各做各的）
- 每句多一次 postMessage 往返（几百字节，~0.1 ms）
- 错误传播复杂化：`WorkerLocalEngine` 现在是一个整体，`failAll` 之类的逻辑要跟着拆
- 调试时两个 worker 的 console 分在两个上下文
- **两个 worker 独立回收带来的状态不同步**（评审补充）：两者都由 Chrome 回收，但未必同时——一个崩了另一个还活着时，谁负责重建、已合成的句子要不要丢、已 `prepare` 的字典还算不算数，都要明确。这是 `.failAll` 拆开之后新增的一类状态

**附带的好处**：`LocalProvider.synthesize` 不再是“phonemize + 合成”的黑盒，而是两步显式调用——正好与 §3.1 的 `phonemize(text, options)` 接口对上。

---

## 3. 接口

### 3.1 TypeScript 侧

```ts
export type FrontendId = 'kokoro-v1' | 'kokoro-v11-zh';

export interface PhonemizeOptions {
  readonly frontend: FrontendId;
  /** BCP-47 tag of the text. */
  readonly lang: string;
  /** 覆盖或补充内置规则。省略则只用内置。 */
  readonly lexicon?: readonly LexiconRule[];
}

/**
 * Where a run of phonemes came from, for word-level highlighting.
 * Offsets are into the *input* text. Deliberately unimplemented in v1:
 * the engine highlights per sentence today, and this is here so adding
 * word-level later does not change the signature.
 */
export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

export interface PhonemizeResult {
  /**
   * Exactly what goes into the tokenizer. Guaranteed to contain only
   * characters the target model's vocabulary keeps.
   */
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
}

export interface Phonemizer {
  /** wasm 就绪，但**还没有任何字典**。 */
  readonly ready: Promise<void>;

  /**
   * 显式预加载几种语言的字典。**异步，因为它是 fetch + 解压。**
   *
   * 之所以不把惰性加载藏在 `phonemize` 里：上层本来就知道要用哪种语言（§1.5：
   * 取自所选音色），所以加载时机由它决定，而 `phonemize` 因此可以保持同步。
   *
   * 第一版设计在这里自相矛盾（2026-10-03 架构评审发现）：既说 `phonemize`
   * 同步，又要字典按需加载——而首次遇到某语言时 fetch → 传字节 → 解压全是
   * 异步的，同步函数等不了。把异步挪到这一步解决它。
   */
  prepare(langs: readonly FrontendId[]): Promise<void>;

  /**
   * 同步：整条链在 wasm 里，没有 I/O。这是相对今天 `Phonemizer` 的变化——
   * 现在是 `async`，因为 jieba / kuroshiro / espeak 各自持有一个 promise。
   *
   * 字典缺失时**抛错**，不静默降级（调用方应先 `await prepare(...)`）；
   * `frontend` 说不了 `lang` 时抛 `UnsupportedLanguageError`。
   */
  phonemize(text: string, options: PhonemizeOptions): PhonemizeResult;
}
```

### 3.2 字典协议

**核心原则：wasm 是真相源，JS 只当搬运工。** 需要哪些字典由 wasm 声明，这样以后加语言、换格式都不用动 JS。

```rust
#[wasm_bindgen]
impl Phonemizer {
    /// 这个前端组合需要哪些字典。
    ///
    /// 返回**名字**而不是自己去加载，是因为字典格式是 Rust 侧的实现细节——
    /// 换掉一个词典不该让 JS 跟着改。
    pub fn required_dictionaries(frontends: &JsValue) -> Vec<String>;

    /// 喂一个字典：名字 + **压缩态**字节。可重复调用（并行 fetch 后逐个喂）。
    ///
    /// 名字必须来自 `required_dictionaries`；未知名字报错而不是忽略，
    /// 否则少一个字典会表现为"某些词读错"而不是启动失败。
    pub fn load_dictionary(&mut self, name: &str, compressed: &[u8]) -> Result<(), JsValue>;

    /// 全部到齐后构建索引。缺任何一个都 Err，附上缺的名字。
    pub fn finish(&mut self) -> Result<(), JsValue>;
}
```

JS 侧（一段循环，不关心有几个字典、叫什么）：

```ts
const names = Phonemizer.required_dictionaries(frontends);
const fetched = await Promise.all(
  names.map(async (name) => {
    const res = await fetch(`/dict/${name}.bin.zst`);
    return [name, new Uint8Array(await res.arrayBuffer())] as const;
  })
);
for (const [name, bytes] of fetched) engine.load_dictionary(name, bytes);
engine.finish();
```

**为什么不让 wasm 自己 fetch**：项目已有自己的资源缓存策略（音色走 Cache Storage、模型走 transformers.js 的缓存），字典应并入同一套，而不是在 wasm 里再长一套。

**单个字典内部几个文件由 Rust 决定**，JS 不需要知道。

### 3.3 替换字典（预留，v1 不做）

```rust
/// 一条替换规则：系统内置或用户自定义，同构。
#[wasm_bindgen]
pub struct LexiconRule {
    /// 匹配什么。Rust `regex` 语法。
    pub pattern: String,
    /// 换成什么。纯文本，替换后再走正常流程。
    pub replacement: String,
    pub stage: RuleStage,
}

#[wasm_bindgen]
pub enum RuleStage {
    /// TN 之前。想改"AI"读成"エーアイ"这类，放这里。
    BeforeNormalization,
    /// G2P 之前，TN 之后。想改某个已经数字化的读法，放这里。
    BeforeGraphemeToPhoneme,
}

impl Phonemizer {
    /// 用户规则。可多次调用，后加的优先级更高。
    pub fn add_lexicon_rules(&mut self, rules: &JsValue) -> Result<(), JsValue>;
    /// 系统内置规则由 wasm 自己带，不走这里，但用户可以整体禁用。
    pub fn set_builtin_lexicon(&mut self, enabled: bool);
}
```

**两条已确定的约束**：

1. **规则作用在文本层，不是音素层。** 用户不应该知道模型用什么音素——这样后续加模型不用改字典。音素层的规则还会被 IPA 符号差异绊住（v1.0 与 v1.1-zh 的音素集不同，同一条规则要写两遍）。
2. **正则引擎用 `regex`（无 lookaround）。** 用户规则是**不可信输入**，一次灾难性回溯就冻住整个扩展。`regex` 保证线性时间。用户已明确接受这个限制。

**优先级**：用户规则 > 系统规则。

---

## 4. 冷启动路径（核心约束）

### 4.1 为什么这是核心

`local.worker.ts` 写明：

> **It is recycled after ~30 seconds without audio.**

且 `offscreen-manager.ts` 明确**不主动关闭**（"Chrome reclaims it on its own"）。所以：

> **每次停止播放约 30 秒后再开始，就是一次完整冷启动**，wasm 实例和字典全部重来。

冷启动优化不是锦上添花，是**每次播放都要付的**。

### 4.2 路径拆解

| 阶段 | 估算 | 备注 |
|---|---|---|
| offscreen / worker 创建 | ~10 ms | |
| wasm 实例化（~3 MB） | ~10–30 ms | Chrome 缓存编译产物（`compileStreaming`） |
| fetch 字典（本地协议，压缩态） | ~10 ms | `chrome-extension://` 是本地读取，非网络；10 MB |
| 拷进 wasm 堆 | ~5 ms | 拷贝的是压缩态 10 MB，不是解压后 45.3 MB |
| **zstd 解压** | **~30 ms** | 45.3 MB @ ~1.5 GB/s（估算，V2 待实测） |
| **`loadDictionaryFromBytes`** | **9.6 ms** | **实测 §1.4** |
| **`TokenizerBuilder.build`** | **7.9 ms** | **实测 §1.4** |
| **合计** | **~75–105 ms** | 目标 ≤ 100 ms；原估算未计入后两项 |

**但这只是“wasm 与字典都就绪”。按需加载下首句还要再等一次**（2026-10-03 评审补充）：

```
按下播放 → wasm 就绪（~30 ms）→ 首句触达某语言 → prepare(lang)（~100 ms）→ 合成
```

即首句实际约 **~200 ms**，不是 100 ms。但这个惩罚可以直接消除：语言取自音色
（§1.5），而音色是用户**选**的——所以在拿到所选音色的那一刻就能 `prepare`，
远早于按下播放。

（取舍见 §2.4：全量预加载也能消除这次惩罚，但代价是**所有**语言的字典都要解压；
**预取目标语言**（方案 C）是更好的中间态。）

### 4.3 格式要求：**解压即可用**

> **解压后的字节，必须就是可查询的结构。不允许有"加载后建索引"这一步。**

这条要求**反向约束离线构建脚本**：索引结构在构建时排好、写进文件，运行时不重建。

- **不允许**：解压 → 填充 HashMap → 查询（那是一次全量遍历）
- **要求**：解压 → 指针指进去 → 立即可查。用排序数组 + 二分、double-array trie（本身就是可查结构）、或分块哈希（每块独立可查，按热度排序让常用词落在前面）

**中日英各自的形态**：

| 语言 | 形态 | 状态 |
|---|---|---|
| 中文 | 词表排序 + 二分；多音字差异表同理 | ✅ 可控 |
| 日语 | ✅ **已验证**：lindera 的 `loadDictionaryFromBytes` 用 9.6 ms 加载 45.3 MB（§1.4）——trie 与连接矩阵都是预构建的，加载即指针设置 | ✅ |
| 英文 | espeak 的规则表，本来就是查表 | ✅ 可控 |

### 4.4 另外三条

**1. 按需加载，别一次全载**

"打包进扩展"和"全部载入内存"是两件事。读中文文章不该付出日语词典的代价：

```
冷启动           → 只载 TN + 闸门（~3 MB wasm，无字典）
首次遇到中文句子  → 载中文词典
首次遇到日语句子  → 载日语词典
```

代价是朗读中途可能多一次停顿，但那发生在**已经出声之后**，比首句延迟好得多。

**2. 预留 wasm 内存，别让它中途 grow**

`memory.grow` 是重新分配 + 拷贝整个堆。初始化时按需要的字典总量一次要到，否则第一次解压会付一次隐藏的全堆拷贝。

**3. 和模型加载并行——但这要求“预取”，而不是“首句触发”**

字典加载（~100 ms 量级）应与模型下载/初始化**并行**，不串行排在后面。

但如 §2.4 所述，并行要求两者**同时开始**；而“首句触发”的按需加载把字典推到模型
就绪之后，并行无从谈起。

这就是 §2.4 的 **C：预取目标语言**。时机很明确：**用户选音色时**（§1.5——语言由
音色决定，不是网页），比按下播放早得多，连“等第一段”都不用。

### 4.5 OPFS 缓存（暂不做）

若实测发现解压确实拖慢冷启动，可把解压后的字典写进 OPFS，下次直接读。

Trade-off：首次多一次写盘（~50 MB）、占用户磁盘，换后续冷启动省 30–60 ms。

**先不做**——如果格式做到了"解压即可用"，这 30–60 ms 大概率不值得用磁盘换。

---

## 5. 迁移策略

### 5.1 对照组（已定）

**JS 链保留一段时间**，Rust 版并排跑：

```ts
it('matches the JavaScript chain it replaces', async () => {
  for (const sample of CORPUS) {
    expect(rust.phonemize(sample, opts)).toEqual(js.phonemize(sample, opts));
  }
});
```

现有 **1430 个测试**在锁定 JS 链的行为，这是现成的资产。Rust 输出必须**逐字符等于** JS 输出，**或有记录的更优**（差异要能解释，比如修好了一个已确认的 bug）。

**不要一次性替换**：那会把"移植 bug"和"设计改进"混在一起，出问题时无法二分。

### 5.2 边界

| 留在 JS | 理由 |
|---|---|
| `Intl.Segmenter` 的句子切分 | 浏览器原生，Rust 侧无等价物，且按页面语言工作 |
| 音色管理、模型加载、播放 | 与文本无关 |
| **TN → 音素这一段** | **只有这段进 Rust** |

---

## 6. 已确定的决策（汇总）

| # | 决策 | 来源 |
|---|---|---|
| 1 | 预处理整体 Rust 化，交付**单个** wasm | 用户 |
| 2 | **espeak 编进同一个 wasm**（不做第二个模块） | 用户（"只交付一个 wasm"）+ 跨界论证 |
| 3 | 字典**打包进扩展**，用户零下载动作 | 用户 |
| 4 | 字典**不编译进 wasm**（会让 wasm 二进制膨胀几十 MB：扩展包体积、传输、浏览器编译缓存三处都受影响） | 设计推导（评审澄清） |
| 5 | 字典经**扩展资源 fetch + 传字节**进 wasm | 设计推导 |
| 6 | 传**压缩态**，wasm 内解压 | 用户（指出 SW 生命周期） |
| 7 | 压缩算法用 **zstd** | 用户 |
| 8 | 字典格式必须**解压即可用**（零索引） | 设计推导（§4.3） |
| 9 | 字典**按语言按需加载** | 设计推导 |
| 10 | `required_dictionaries` 由 **wasm 声明**，JS 只搬运 | 设计推导 |
| 11 | `spans` **预留字段，v1 不实现** | 用户 |
| 12 | JS 链**保留做对照组** | 用户 |
| 13 | 替换字典作用在**文本层** | 用户 |
| 14 | 正则用 **`regex` crate**（无 lookaround） | 用户 |
| 15 | 用户规则 > 系统规则 | 设计推导 |
| 16 | phonemize 与模型**拆成两个 worker**，调度留在上层 | 用户（2026-10-03） |
| 17 | 预定义前端，不做任意步骤组合 | 设计推导 |
| 18 | 日语词典用 **lindera 的现成 9 文件格式**，不自建 | V1 实测（§1.4） |
| 19 | 词典自 GitHub Releases 取预构建 zip，**离线构建步骤省略** | V1 实测（§1.4） |
| 20 | 字典加载是**显式的 `prepare(langs)`**，`phonemize` 保持同步 | 评审修正（§3.1） |
| 21 | 词典版本在构建时锁定，手动更新 | 评审补充（§8.6） |
| 22 | 字典在**选音色时预取**该音色的语言——不是首句触发，也不是全量预加载 | §2.4 方案 C + §1.5 |

---

## 7. 待验证

| # | 问题 | 为什么重要 | 怎么验 |
|---|---|---|---|
| ~~V1~~ | ~~lindera 加载 IPADic 是否建索引、耗时多少~~ | **部分验证 2026-10-03**（§1.4）：Node 里确认不建索引（9.6 ms / 45.3 MB）、能本地加载、体积 10 MB。**未验**：offscreen worker 里的内存与回收行为（见 V8） | 已完成一半 |
| V2 | zstd 解压 50 MB 的实际耗时 | §4.2 的估算基于 1.5 GB/s，需实测 | 构造同规模的压缩块计时 |
| V3 | 单 wasm 的实际体积 | §2.3 估 ~3 MB，需要真实数字 | 编译后量 |
| V4 | OPFS 缓存是否必要 | 取决于 V1+V2 的结果 | 冷启动总时长实测 |
| V5 | v1.1-zh 的 `int8`(121.5 MB) 是否可用 | 决定两个模型能否同时在内存里（415 MB → 213 MB） | 加载并听一次，与 P5 §2.2 同法 |
| V6 | `ɚ` → `əɹ` 替换的听感 | 影响英文在 v1.1-zh 下的正确性 | 合成对比 |
| V7 | 双 worker 的冷启动实际省下多少 | §2.4：用 C（预取）则 13% 成立。**前提已确认**（§1.5：语言取自音色，选音色时就知道），不再取决于 reader | 量两个 worker 各自就绪的时间差 |
| V8 | **offscreen worker 里加载 lindera 的实际表现** | V1 只验了 Node。45.3 MB 解压后进 wasm 堆的内存、以及 30 秒回收是否会打断加载，都未验。P5 §2.2 提醒过同一类事（POC 不是 offscreen 文档） | 在真实 offscreen worker 里加载 + 分词一句话，量内存与耗时 |

**V1 部分通过**（§1.4）：lindera 不建索引、能本地加载、体积比现在小。但它跑在 Node，不是 offscreen worker——所以“阻塞已解除”这句话在评审后改成了更保守的版本：

- **设计层面可以继续**（Node 验的是 wasm 的确定性 API 行为，浏览器里一致），
- 但 **V8（offscreen 实测）列为实现早期的必做项**，而不是开工前提。

这是我与评审的一个**判断分歧**，记在这里以免将来被当成遗漏：评审认为 V1 不足以解除阻塞、必须先在 offscreen 里重验；我认同“措辞过头了”（已改），但认为把 V8 提到开工前会把一个环境验证变成设计前置，而它更自然的时机是**第一个能跑的最小实现**——那时验证才真正贴近生产形态。

V2（zstd 实测）与 V7（现只剩流水线那半）同理，都是动手后顺手量的。

---

## 8. 尚未决定（评审提出，2026-10-03）

这些不影响架构方向，但**开工前**要有答案。按实现顺序排。

### 8.1 错误分类与用户可见提示

`phonemize` 失败时用户看到什么？至少三种要分开：字典损坏 / 缺失、wasm 实例化失败、
`UnsupportedLanguageError`（选了 v1.1-zh 的音色去读日语）。各自映射到哪个
`ProviderErrorCode`，气泡里写什么，需要定。

### 8.2 用户正则规则的边界

§3.3 用 `regex` 换了线性时间保证，但没定：规则数量上限（一千条会不会让每次
phonemize 变慢）、单条规则长度上限、规则之间的优先级冲突怎么报。

### 8.3 两个模型共存的运行时切换

§1.3 说两套音素集，§2.2 说按模型编排，但没说：用户从 v1.0 音色切到 v1.1-zh 音色时，
phonemize worker 要不要重新初始化、两套 vocab 闸门（115 / 172）能否共存、
已缓存的句子要不要重新 phonemize。

### 8.4 测试语料怎么迁到 Rust 侧

§5.1 说用现有 1430 个测试做对照，但没说：Rust 侧怎么跑（`wasm-pack test`？还是单独的
对照工具？）、语料硬编码在 Rust 里还是从 JSON 读、差异的“有记录的更优”由谁审批、
记录在哪儿。

### 8.5 构建集成

wasm-pack 的产物怎么进 WXT 的构建流程：放 `public/` 还是打进 bundle？
wasm 文件的 hash 怎么处理（WXT 给资源加 hash，而 wasm 的 `import()` 路径要对上）？

### 8.6 词典版本更新

决策 #21 说构建时锁版本、手动更新。那流程是什么：谁定期看 lindera 的新 release、
更新后怎么验证（§5.1 的对照测试能不能抓住读音变化）？

---

## 9. 附：本文件之外的相关记录

- P5 spec `docs/superpowers/plans/2026-10-01-p5-chinese-g2p-v11zh-spec.md` — 中文 G2P 的现状与两套音素集的完整分析
- `docs/phonemization-architecture.md` — 当前 JS 架构的说明（Rust 化后需重写）
- 2026-10-03 的两处实测：
  - 中文也曾漏掉全角数字（`numbersToHan` 只匹配 `\d`），已修 `4ec6dc2`
  - v1.0/v1.1-zh 的 vocab 差异明细（§1.3）
# P6 Rust Phonemize 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 TTS-NG 的文本预处理（TN + G2P）从 JavaScript 迁移到 Rust，交付单个 wasm 模块，支持中日英三种语言。

**架构：** Rust 侧构建链式预处理流水线（TN → 分词 → G2P → 组装 → vocab 闸门），编译为单个 wasm 模块（含 espeak-ng），字典打包进扩展、按需加载、压缩传输、wasm 内解压。拆分为两个 worker（phonemize / kokoro）实现冷启动并行。

**技术栈：** 
- Rust: wasm-bindgen, lindera (日语分词), fst/regex-automata (TN), zstd (解压)
- 集成: WXT, pnpm workspace
- 对照: 保留现有 JS 链做回归测试

**规格：** `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`

---

## 全局约束

1. **单 wasm 模块**：phonemize.wasm 包含 TN + 中日英三种语言 + espeak-ng，估算 ~3 MB（不含字典）
2. **冷启动 ≤ 100 ms**（wasm + 字典就绪），首次触达某语言再 +~100 ms（按需加载）
3. **输出等价**：Rust 输出逐字符等于 JS 输出，或有记录的更优
4. **字典打包进扩展**：用户零下载，压缩传输（zstd），wasm 内解压
5. **按需加载**：只加载当前音色所需语言的字典
6. **双 worker**：phonemize worker 与 kokoro worker 分离，调度留在 offscreen 主线程
7. **vocab 闸门**：每个 frontend 一份 vocab，统一校验输出字符
8. **JS 链保留**：作为对照组，通过全部现有测试后再移除

---

## 审查重点（Review Focus）

1. **vocab 违规字符**：输出包含目标模型 vocab 外的字符时，tokenizer 会静默删除（如 v1.1-zh 遇到 `ɚ`），导致音频与文本不对齐。预期：vocab 闸门拦截并明确报错，指出哪个字符、来自哪个 backend。
2. **字典损坏或缺失**：fetch 失败、zstd 解压失败、文件格式不匹配时，用户看到的应是可操作的错误（"字典加载失败，请重新安装扩展"），而非神秘的音素输出错误。预期：`prepare()` 阶段失败并抛出明确的 `DictionaryLoadError`。
3. **语言不匹配**：用户选日语音色去读中文页面时（lang=ja），v1.0 能处理但 v1.1-zh 不能（无日语 frontend）。预期：`phonemize()` 抛出 `UnsupportedLanguageError`，气泡提示"所选音色不支持当前语言"。
4. **worker 回收不同步**：30 秒回收时，phonemize worker 崩了但 kokoro worker 还活着（或反之），已缓存句子的状态、已 `prepare` 的字典是否仍有效。预期：任一 worker 失败时，`AudioWorker` 调用双方的 `.failAll()`，清空所有 in-flight 请求。
5. **内存泄漏（45 MB 字典）**：offscreen worker 里 lindera 加载 IPADic（45.3 MB 解压后）若未正确释放，多次冷启动会累积。预期：每次 worker 重建时，wasm 线性内存完全重置，旧字典自动释放。

---

## 文件结构

### Rust 侧（新建 `crates/phonemize/`）

```
crates/phonemize/
├── Cargo.toml                     # workspace member, wasm-bindgen + lindera + zstd
├── src/
│   ├── lib.rs                     # wasm_bindgen 入口, Phonemizer 类型
│   ├── types.rs                   # FrontendId, PhonemizeOptions, PhonemizeResult
│   ├── pipeline.rs                # 链式执行器（TextStep → Run → assemble）
│   ├── frontends/
│   │   ├── mod.rs
│   │   ├── zh_ipa.rs              # v1.0 中文：pinyin → IPA + 声调箭头
│   │   ├── zh_zhuyin.rs           # v1.1-zh 中文：pinyin → 注音符号 + 数字声调
│   │   ├── ja_ipa.rs              # v1.0 日语：lindera → IPA
│   │   └── en_espeak.rs           # 英文：espeak-ng（C 源码用 cc 编译）
│   ├── backends/
│   │   ├── mod.rs
│   │   ├── tn.rs                  # Text Normalization (fst/regex-automata)
│   │   ├── segmenter_zh.rs        # 中文分词（jieba-rs 或 lindera-cc-cedict）
│   │   ├── segmenter_ja.rs        # 日语分词（lindera）
│   │   ├── pinyin.rs              # 中文 G2P（查表 + 多音字规则）
│   │   └── numbers.rs             # 数字归一化（中日英）
│   ├── vocab.rs                   # 每个 frontend 的 vocab 闸门
│   ├── dictionary.rs              # 字典协议：required_dictionaries, load_dictionary, finish
│   └── lexicon.rs                 # 用户替换规则（预留，v1 不实现）
└── build.rs                       # 编译 espeak-ng C 源码（cc crate）
```

### TypeScript 侧（修改现有）

```
lib/models/
├── phonemize-rust.ts              # 新建：Rust Phonemizer 的 TS wrapper
├── phonemize/                     # 保留：JS 链做对照，最后移除
│   └── ... (不动)
└── kokoro-engine.ts               # 修改：删除 phonemize 调用，改由 worker 外部传入

entrypoints/offscreen/
├── phonemize.worker.ts            # 新建：phonemize worker（Rust wasm）
├── local.worker.ts                # 修改：改名为 kokoro.worker.ts，移除 phonemize
└── offscreen.ts                   # 修改：创建两个 worker，协调调度

lib/audio-worker.ts                # 修改：phonemize 与 synthesis 分两步调用
lib/models/worker-protocol.ts     # 修改：新增 phonemize 相关消息类型
```

### 字典资源（新建）

```
public/dictionaries/
├── lindera-ipadic-ja.bin.zst      # 日语词典（10 MB 压缩态）
└── (中文词典待定：jieba 或 lindera-cc-cedict)
```

### 测试（新建）

```
crates/phonemize/tests/
├── integration.rs                 # 对照测试：Rust 输出 vs JS 输出
└── corpus.json                    # 从现有 TS 测试提取的语料

tests/unit/models/
└── phonemize-rust.test.ts         # TS 侧集成测试：wasm 加载、字典、错误
```

---


## 阶段 1：基础设施搭建

### 任务 1.1：Rust workspace 与 wasm-bindgen 脚手架

**文件：**
- 创建：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/lib.rs`
- 创建：`crates/phonemize/src/types.rs`
- 修改：`Cargo.toml`（workspace root，若不存在则创建）
- 创建：`scripts/build-phonemize-wasm.sh`

- [ ] **步骤 1：创建 Rust workspace 根目录**

若项目根目录没有 `Cargo.toml`，创建 workspace：

```toml
[workspace]
members = ["crates/phonemize"]
resolver = "2"
```

- [ ] **步骤 2：创建 phonemize crate 的 Cargo.toml**

```toml
[package]
name = "phonemize"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1.0", features = ["derive"] }
serde-wasm-bindgen = "0.6"
zstd = "0.13"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
```

- [ ] **步骤 3：创建最小 wasm-bindgen 入口**

在 `crates/phonemize/src/lib.rs`：

```rust
use wasm_bindgen::prelude::*;

mod types;

pub use types::{FrontendId, PhonemizeOptions, PhonemizeResult};

#[wasm_bindgen]
pub struct Phonemizer {
    // 字段待后续任务填充
}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {}
    }

    /// wasm 模块就绪的标记，此版本立即返回
    pub fn ready(&self) -> js_sys::Promise {
        js_sys::Promise::resolve(&JsValue::NULL)
    }
}
```

- [ ] **步骤 4：定义 TypeScript 映射的类型**

在 `crates/phonemize/src/types.rs`：

```rust
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontendId {
    KokoroV1 = "kokoro-v1",
    KokoroV11Zh = "kokoro-v11-zh",
}

#[derive(Debug, Clone, Deserialize)]
pub struct PhonemizeOptions {
    pub frontend: String,  // FrontendId 的字符串形式
    pub lang: String,      // BCP-47 tag
}

#[derive(Debug, Clone, Serialize)]
pub struct PhonemizeResult {
    pub phonemes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PhonemeSpan>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PhonemeSpan {
    pub char_start: usize,
    pub char_end: usize,
    pub phoneme_start: usize,
    pub phoneme_end: usize,
}
```

- [ ] **步骤 5：创建构建脚本**

在 `scripts/build-phonemize-wasm.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v wasm-pack &> /dev/null; then
  echo "wasm-pack not found. Install: cargo install wasm-pack"
  exit 1
fi

wasm-pack build crates/phonemize \
  --target web \
  --out-dir ../../lib/models/phonemize-wasm \
  --release

echo "✓ phonemize.wasm built to lib/models/phonemize-wasm/"
```

```bash
chmod +x scripts/build-phonemize-wasm.sh
```

- [ ] **步骤 6：验证编译**

运行：`./scripts/build-phonemize-wasm.sh`

预期：输出 `lib/models/phonemize-wasm/phonemize_bg.wasm`（~几 KB，因为还是空壳）

- [ ] **步骤 7：添加到 package.json**

在 `package.json` 的 `scripts` 中添加：

```json
"build:wasm": "./scripts/build-phonemize-wasm.sh",
"prebuild": "pnpm build:wasm"
```

- [ ] **步骤 8：验证集成**

运行：`pnpm build:wasm && ls -lh lib/models/phonemize-wasm/`

预期：生成 4 个文件：`.wasm`, `.js`, `.d.ts`, `package.json`

- [ ] **步骤 9：Commit**

```bash
git add Cargo.toml crates/ scripts/build-phonemize-wasm.sh package.json
git commit -m "feat(p6): scaffold Rust phonemize crate with wasm-bindgen"
```

---

### 任务 1.2：TypeScript wrapper 与最小集成

**文件：**
- 创建：`lib/models/phonemize-rust.ts`
- 创建：`tests/unit/models/phonemize-rust.test.ts`

- [ ] **步骤 1：编写失败的加载测试**

在 `tests/unit/models/phonemize-rust.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';

describe('RustPhonemizer', () => {
  it('loads wasm module', async () => {
    const phonemizer = new RustPhonemizer();
    await phonemizer.ready;
    expect(phonemizer).toBeDefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test phonemize-rust`

预期：FAIL，"Cannot find module '~/lib/models/phonemize-rust'"

- [ ] **步骤 3：实现 RustPhonemizer wrapper**

在 `lib/models/phonemize-rust.ts`：

```typescript
import type { Phonemizer as WasmPhonemizer } from './phonemize-wasm/phonemize';
import init, { Phonemizer as WasmPhonemizerClass } from './phonemize-wasm/phonemize';

export interface PhonemizeOptions {
  readonly frontend: 'kokoro-v1' | 'kokoro-v11-zh';
  readonly lang: string;
}

export interface PhonemizeResult {
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
}

export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

/**
 * Rust-based phonemizer. Synchronous after `ready` resolves.
 */
export class RustPhonemizer {
  private instance: WasmPhonemizer | null = null;
  public readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await init();
    this.instance = new WasmPhonemizerClass();
  }

  /**
   * Preload dictionaries for the given languages.
   * In this minimal version, does nothing (dictionaries added in later tasks).
   */
  async prepare(frontends: readonly string[]): Promise<void> {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO: fetch + load dictionaries
  }

  /**
   * Text to phonemes. Synchronous once ready.
   * In this minimal version, returns empty string (real impl in later tasks).
   */
  phonemize(text: string, options: PhonemizeOptions): PhonemizeResult {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO: call wasm
    return { phonemes: '' };
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test phonemize-rust`

预期：PASS（1 passed）

- [ ] **步骤 5：Commit**

```bash
git add lib/models/phonemize-rust.ts tests/unit/models/phonemize-rust.test.ts
git commit -m "feat(p6): add TypeScript wrapper for Rust phonemizer"
```

---


## 阶段 2：字典协议与加载

### 任务 2.1：字典协议（Rust 侧）

**文件：**
- 创建：`crates/phonemize/src/dictionary.rs`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：编写字典状态测试**

在 `crates/phonemize/tests/integration.rs`（新建）：

```rust
use phonemize::Phonemizer;

#[test]
fn required_dictionaries_returns_empty_for_minimal_config() {
    let phonemizer = Phonemizer::new();
    let frontends = vec![];
    let required = phonemizer.required_dictionaries(&frontends);
    assert_eq!(required.len(), 0);
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd crates/phonemize && cargo test`

预期：FAIL，"no method named `required_dictionaries`"

- [ ] **步骤 3：实现字典协议**

在 `crates/phonemize/src/dictionary.rs`：

```rust
use std::collections::HashMap;

/// 字典状态：名字 -> 字节（压缩态）
pub struct DictionaryRegistry {
    loaded: HashMap<String, Vec<u8>>,
    required: Vec<String>,
}

impl DictionaryRegistry {
    pub fn new() -> Self {
        Self {
            loaded: HashMap::new(),
            required: Vec::new(),
        }
    }

    /// 设置前端需要哪些字典
    pub fn set_required(&mut self, frontends: &[String]) {
        self.required.clear();
        for frontend in frontends {
            match frontend.as_str() {
                "kokoro-v1" => {
                    // v1.0: 中日英三种语言
                    self.require_if_missing("lindera-ipadic-ja");
                }
                "kokoro-v11-zh" => {
                    // v1.1-zh: 只有中英
                    // 日语词典不需要
                }
                _ => {}
            }
        }
    }

    fn require_if_missing(&mut self, name: &str) {
        if !self.required.contains(&name.to_string()) {
            self.required.push(name.to_string());
        }
    }

    pub fn required(&self) -> &[String] {
        &self.required
    }

    /// 喂一个字典（名字 + 压缩态字节）
    pub fn load(&mut self, name: &str, compressed: &[u8]) -> Result<(), String> {
        if !self.required.contains(&name.to_string()) {
            return Err(format!("Unknown dictionary: {}", name));
        }
        self.loaded.insert(name.to_string(), compressed.to_vec());
        Ok(())
    }

    /// 检查是否全部到齐
    pub fn finish(&self) -> Result<(), Vec<String>> {
        let missing: Vec<String> = self.required
            .iter()
            .filter(|name| !self.loaded.contains_key(*name))
            .cloned()
            .collect();
        
        if missing.is_empty() {
            Ok(())
        } else {
            Err(missing)
        }
    }
}
```

- [ ] **步骤 4：在 Phonemizer 中集成**

在 `crates/phonemize/src/lib.rs`：

```rust
mod dictionary;

use dictionary::DictionaryRegistry;

#[wasm_bindgen]
pub struct Phonemizer {
    dictionaries: DictionaryRegistry,
}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            dictionaries: DictionaryRegistry::new(),
        }
    }

    /// 这个前端组合需要哪些字典
    pub fn required_dictionaries(&mut self, frontends: &JsValue) -> Vec<String> {
        let frontends: Vec<String> = serde_wasm_bindgen::from_value(frontends.clone())
            .unwrap_or_default();
        self.dictionaries.set_required(&frontends);
        self.dictionaries.required().to_vec()
    }

    /// 喂一个字典：名字 + 压缩态字节
    pub fn load_dictionary(&mut self, name: &str, compressed: &[u8]) -> Result<(), JsValue> {
        self.dictionaries.load(name, compressed)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// 全部到齐后构建索引
    pub fn finish(&self) -> Result<(), JsValue> {
        self.dictionaries.finish()
            .map_err(|missing| {
                let msg = format!("Missing dictionaries: {}", missing.join(", "));
                JsValue::from_str(&msg)
            })
    }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd crates/phonemize && cargo test`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add crates/phonemize/src/dictionary.rs crates/phonemize/src/lib.rs crates/phonemize/tests/
git commit -m "feat(p6): implement dictionary protocol in Rust"
```

---

### 任务 2.2：TypeScript 侧字典加载

**文件：**
- 修改：`lib/models/phonemize-rust.ts`
- 创建：`public/dictionaries/README.md`
- 修改：`tests/unit/models/phonemize-rust.test.ts`

- [ ] **步骤 1：编写字典加载测试**

在 `tests/unit/models/phonemize-rust.test.ts` 添加：

```typescript
it('prepares dictionaries for kokoro-v1', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // 此时字典文件不存在，应该抛错或跳过
  // 先测试 required_dictionaries 返回值
  await expect(phonemizer.prepare(['kokoro-v1'])).rejects.toThrow();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test phonemize-rust`

预期：FAIL，"prepare is not implemented"

- [ ] **步骤 3：实现 prepare() 方法**

在 `lib/models/phonemize-rust.ts` 修改 `prepare`：

```typescript
async prepare(frontends: readonly string[]): Promise<void> {
  if (!this.instance) throw new Error('Phonemizer not ready');
  
  // 询问需要哪些字典
  const required = this.instance.required_dictionaries(frontends);
  
  if (required.length === 0) return;
  
  // 并行 fetch
  const fetched = await Promise.all(
    required.map(async (name) => {
      const url = `/dictionaries/${name}.bin.zst`;
      const res = await fetch(chrome.runtime.getURL(url));
      if (!res.ok) {
        throw new Error(`Failed to fetch dictionary ${name}: ${res.status}`);
      }
      return [name, new Uint8Array(await res.arrayBuffer())] as const;
    })
  );
  
  // 逐个喂给 wasm
  for (const [name, bytes] of fetched) {
    this.instance.load_dictionary(name, bytes);
  }
  
  // 完成加载
  this.instance.finish();
}
```

- [ ] **步骤 4：创建字典占位文件**

在 `public/dictionaries/README.md`：

```markdown
# Phonemization Dictionaries

字典文件在后续任务中添加：

- `lindera-ipadic-ja.bin.zst` - 日语词典（10 MB）
- （中文词典待定）

每个文件都是压缩态（zstd），由 wasm 内部解压。
```

- [ ] **步骤 5：修改测试为 mock fetch**

在 `tests/unit/models/phonemize-rust.test.ts` 修改测试：

```typescript
import { vi } from 'vitest';

it('prepares dictionaries for kokoro-v1', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // Mock chrome.runtime.getURL
  global.chrome = {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://fake/${path}`)
    }
  } as any;
  
  // Mock fetch to return empty buffer (字典还没实际下载)
  global.fetch = vi.fn(() => 
    Promise.resolve({
      ok: false,
      status: 404
    } as Response)
  );
  
  await expect(phonemizer.prepare(['kokoro-v1'])).rejects.toThrow(/Failed to fetch/);
});
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm test phonemize-rust`

预期：PASS（2 passed）

- [ ] **步骤 7：Commit**

```bash
git add lib/models/phonemize-rust.ts public/dictionaries/ tests/unit/models/phonemize-rust.test.ts
git commit -m "feat(p6): implement dictionary loading protocol in TypeScript"
```

---


## 阶段 3：日语 lindera 集成

### 任务 3.1：lindera 依赖与 zstd 解压

**文件：**
- 修改：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/backends/mod.rs`
- 创建：`crates/phonemize/src/backends/segmenter_ja.rs`

- [ ] **步骤 1：添加 lindera 依赖**

在 `crates/phonemize/Cargo.toml` 的 `[dependencies]` 添加：

```toml
lindera = { version = "0.34", default-features = false, features = ["ipadic"] }
```

- [ ] **步骤 2：编写日语分词测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn japanese_segmenter_tokenizes_simple_sentence() {
    use phonemize::backends::JapaneseSegmenter;
    
    let segmenter = JapaneseSegmenter::new();
    // 暂时不加载字典，测试结构
    let result = segmenter.tokenize("テスト");
    // 此时应该返回空或错误（字典未加载）
    assert!(result.is_empty() || result.len() > 0);
}
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd crates/phonemize && cargo test`

预期：FAIL，"no module named `backends`"

- [ ] **步骤 4：实现日语分词器骨架**

在 `crates/phonemize/src/backends/mod.rs`：

```rust
pub mod segmenter_ja;

pub use segmenter_ja::JapaneseSegmenter;
```

在 `crates/phonemize/src/backends/segmenter_ja.rs`：

```rust
use lindera::tokenizer::{Tokenizer, TokenizerConfig};
use std::sync::Arc;

/// 日语分词器，使用 lindera + IPADic
pub struct JapaneseSegmenter {
    tokenizer: Option<Arc<Tokenizer>>,
}

impl JapaneseSegmenter {
    pub fn new() -> Self {
        Self { tokenizer: None }
    }

    /// 从解压后的字典字节构建 tokenizer
    pub fn load_dictionary(&mut self, dict_bytes: &[u8]) -> Result<(), String> {
        // TODO: lindera 的加载逻辑
        // 暂时返回 Ok 让测试通过
        Ok(())
    }

    /// 分词并返回读音
    pub fn tokenize(&self, text: &str) -> Vec<Token> {
        if self.tokenizer.is_none() {
            return vec![];
        }
        
        // TODO: 实际分词
        vec![]
    }
}

#[derive(Debug, Clone)]
pub struct Token {
    pub surface: String,
    pub reading: Option<String>,
}
```

- [ ] **步骤 5：在 lib.rs 中暴露 backends**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
pub mod backends;
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd crates/phonemize && cargo test`

预期：PASS（骨架测试通过）

- [ ] **步骤 7：实现 zstd 解压逻辑**

在 `crates/phonemize/src/dictionary.rs` 修改 `load` 方法：

```rust
use zstd;

impl DictionaryRegistry {
    /// 喂一个字典（名字 + 压缩态字节），立即解压
    pub fn load(&mut self, name: &str, compressed: &[u8]) -> Result<(), String> {
        if !self.required.contains(&name.to_string()) {
            return Err(format!("Unknown dictionary: {}", name));
        }
        
        // zstd 解压
        let decompressed = zstd::decode_all(compressed)
            .map_err(|e| format!("Failed to decompress {}: {}", name, e))?;
        
        self.loaded.insert(name.to_string(), decompressed);
        Ok(())
    }
    
    /// 获取已解压的字典字节
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.loaded.get(name).map(|v| v.as_slice())
    }
}
```

- [ ] **步骤 8：Commit**

```bash
git add crates/phonemize/Cargo.toml crates/phonemize/src/backends/ crates/phonemize/src/dictionary.rs
git commit -m "feat(p6): add lindera dependency and zstd decompression"
```

---

### 任务 3.2：下载并集成 lindera IPADic

**文件：**
- 创建：`scripts/download-lindera-dict.sh`
- 修改：`public/dictionaries/`（添加实际字典文件）
- 修改：`crates/phonemize/src/backends/segmenter_ja.rs`

- [ ] **步骤 1：创建字典下载脚本**

在 `scripts/download-lindera-dict.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

DICT_DIR="public/dictionaries"
DICT_URL="https://github.com/lindera/lindera/releases/download/v0.34.0/lindera-ipadic-0.34.0.tar.gz"
DICT_NAME="lindera-ipadic-ja"

mkdir -p "$DICT_DIR"
cd "$DICT_DIR"

if [ -f "${DICT_NAME}.bin.zst" ]; then
  echo "✓ Dictionary already exists: ${DICT_NAME}.bin.zst"
  exit 0
fi

echo "Downloading IPADic..."
curl -L "$DICT_URL" -o ipadic.tar.gz

echo "Extracting..."
tar xzf ipadic.tar.gz

echo "Compressing with zstd..."
# lindera 的 tar 包解压后是多个文件，需要打包成一个
tar cf - ipadic/ | zstd -19 -o "${DICT_NAME}.bin.zst"

echo "Cleaning up..."
rm -rf ipadic/ ipadic.tar.gz

SIZE=$(ls -lh "${DICT_NAME}.bin.zst" | awk '{print $5}')
echo "✓ Dictionary ready: ${DICT_NAME}.bin.zst ($SIZE)"
```

```bash
chmod +x scripts/download-lindera-dict.sh
```

- [ ] **步骤 2：运行下载脚本**

运行：`./scripts/download-lindera-dict.sh`

预期：生成 `public/dictionaries/lindera-ipadic-ja.bin.zst`（约 10 MB）

- [ ] **步骤 3：实现 lindera 加载逻辑**

在 `crates/phonemize/src/backends/segmenter_ja.rs` 修改：

```rust
use lindera::tokenizer::{Tokenizer, TokenizerConfig};
use std::io::Cursor;

impl JapaneseSegmenter {
    /// 从 tar 格式的字典字节构建 tokenizer
    pub fn load_dictionary(&mut self, compressed_tar: &[u8]) -> Result<(), String> {
        // compressed_tar 是 zstd 解压后的 tar 流
        let mut archive = tar::Archive::new(Cursor::new(compressed_tar));
        
        // lindera 需要多个文件：char.def, matrix.def, unk.def, sys.dic
        // 从 tar 中提取并构建 TokenizerConfig
        
        // 简化版：先用默认配置，后续优化
        let config = TokenizerConfig::default();
        let tokenizer = Tokenizer::with_config(config)
            .map_err(|e| format!("Failed to build tokenizer: {}", e))?;
        
        self.tokenizer = Some(Arc::new(tokenizer));
        Ok(())
    }

    /// 分词并返回读音
    pub fn tokenize(&self, text: &str) -> Vec<Token> {
        let Some(ref tokenizer) = self.tokenizer else {
            return vec![];
        };
        
        tokenizer
            .tokenize(text)
            .map(|tokens| {
                tokens.into_iter().map(|t| {
                    let surface = t.text.to_string();
                    let reading = t.details().get(7).map(|s| s.to_string());
                    Token { surface, reading }
                }).collect()
            })
            .unwrap_or_default()
    }
}
```

- [ ] **步骤 4：添加 tar 依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
tar = "0.4"
```

- [ ] **步骤 5：编写端到端测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn japanese_segmenter_with_real_dictionary() {
    use phonemize::backends::JapaneseSegmenter;
    use std::fs;
    
    // 跳过如果字典不存在（CI 环境）
    let dict_path = "../../public/dictionaries/lindera-ipadic-ja.bin.zst";
    if !std::path::Path::new(dict_path).exists() {
        eprintln!("Skipping: dictionary not found");
        return;
    }
    
    let compressed = fs::read(dict_path).unwrap();
    let decompressed = zstd::decode_all(&compressed[..]).unwrap();
    
    let mut segmenter = JapaneseSegmenter::new();
    segmenter.load_dictionary(&decompressed).unwrap();
    
    let tokens = segmenter.tokenize("経営");
    assert!(tokens.len() > 0);
    assert_eq!(tokens[0].surface, "経営");
    assert_eq!(tokens[0].reading, Some("ケイエイ".to_string()));
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test`

预期：PASS（如果字典存在）或 SKIP（如果不存在）

- [ ] **步骤 7：将下载添加到 postinstall**

在 `package.json` 的 `postinstall` 脚本中添加：

```json
"postinstall": "wxt prepare && node scripts/setup-kuromoji-dict.mjs && ./scripts/download-lindera-dict.sh"
```

- [ ] **步骤 8：Commit**

```bash
git add scripts/download-lindera-dict.sh crates/phonemize/ public/dictionaries/ package.json
git commit -m "feat(p6): integrate lindera IPADic for Japanese segmentation"
```

---


## 阶段 4：英文 G2P 集成

> ⚠️ **本节已作废（2026-10-03）**：下面写的 espeak-ng C 源码编译路线经实测不可行
> （`espeak-ng-sys` 在 crates.io 不存在；wasm32 没有 libc、宿主 `ar` 写不出可链接的归档；
> espeak 需要文件系统读自己的数据；纯 Rust 移植是 GPL-3.0）。
> **实际落地的是 piper-plus-g2p（MIT，CMU Dict）**，见
> `p6-phase4-corrections.md` §六（实施记录）与 `p6-espeak-alternatives-final.md`（评估）。
> 下面保留原文只为记录当时的设计，不要照着做。

### 任务 4.1：espeak-ng C 源码编译

**文件：**
- 创建：`crates/phonemize/build.rs`
- 创建：`crates/phonemize/espeak-ng/`（submodule 或子目录）
- 修改：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/backends/espeak.rs`

- [ ] **步骤 1：添加 espeak-ng 作为 git submodule**

```bash
cd crates/phonemize
git submodule add https://github.com/espeak-ng/espeak-ng.git espeak-ng
cd espeak-ng
git checkout 1.51.1  # 或最新稳定版
cd ../../..
```

- [ ] **步骤 2：添加 cc 依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
[build-dependencies]
cc = "1.0"
```

- [ ] **步骤 3：创建 build.rs**

在 `crates/phonemize/build.rs`：

```rust
use std::env;
use std::path::PathBuf;

fn main() {
    let espeak_src = PathBuf::from("espeak-ng/src");
    
    // 编译 espeak-ng 的核心文件
    cc::Build::new()
        .files(&[
            espeak_src.join("libespeak-ng/compiledict.c"),
            espeak_src.join("libespeak-ng/dictionary.c"),
            espeak_src.join("libespeak-ng/intonation.c"),
            espeak_src.join("libespeak-ng/phonemelist.c"),
            espeak_src.join("libespeak-ng/synthesize.c"),
            espeak_src.join("libespeak-ng/translate.c"),
            espeak_src.join("libespeak-ng/tr_languages.c"),
            espeak_src.join("libespeak-ng/voices.c"),
            espeak_src.join("libespeak-ng/wavegen.c"),
        ])
        .include(&espeak_src)
        .include(espeak_src.join("include"))
        .include(espeak_src.join("libespeak-ng"))
        .flag("-DUSE_ASYNC=0")
        .flag("-DPATH_ESPEAK_DATA=\"/espeak-ng-data\"")
        .warnings(false)
        .compile("espeak-ng");
    
    println!("cargo:rerun-if-changed=espeak-ng/");
}
```

- [ ] **步骤 4：验证编译**

运行：`cd crates/phonemize && cargo build --release`

预期：成功编译，输出包含 "Compiling espeak-ng"

- [ ] **步骤 5：创建 Rust FFI 绑定**

在 `crates/phonemize/src/backends/espeak.rs`：

```rust
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

// FFI 声明
extern "C" {
    fn espeak_Initialize(
        output: c_int,
        buflength: c_int,
        path: *const c_char,
        options: c_int,
    ) -> c_int;
    
    fn espeak_TextToPhonemes(
        textptr: *const c_char,
        textmode: c_int,
        phonememode: c_int,
    ) -> *const c_char;
    
    fn espeak_Terminate() -> c_int;
}

pub struct EspeakBackend {
    initialized: bool,
}

impl EspeakBackend {
    pub fn new() -> Self {
        Self { initialized: false }
    }
    
    pub fn initialize(&mut self) -> Result<(), String> {
        let result = unsafe {
            espeak_Initialize(
                0,  // AUDIO_OUTPUT_SYNCHRONOUS
                0,  // buflength (use default)
                std::ptr::null(),  // use default path
                0,  // options
            )
        };
        
        if result < 0 {
            return Err("Failed to initialize espeak-ng".to_string());
        }
        
        self.initialized = true;
        Ok(())
    }
    
    pub fn text_to_phonemes(&self, text: &str) -> Result<String, String> {
        if !self.initialized {
            return Err("espeak not initialized".to_string());
        }
        
        let c_text = CString::new(text)
            .map_err(|_| "Invalid text (contains null byte)")?;
        
        let phonemes_ptr = unsafe {
            espeak_TextToPhonemes(
                c_text.as_ptr(),
                0,   // textmode: auto
                0x02 // phonememode: IPA
            )
        };
        
        if phonemes_ptr.is_null() {
            return Err("espeak returned null".to_string());
        }
        
        let c_str = unsafe { CStr::from_ptr(phonemes_ptr) };
        Ok(c_str.to_string_lossy().to_string())
    }
}

impl Drop for EspeakBackend {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { espeak_Terminate(); }
        }
    }
}
```

- [ ] **步骤 6：在 backends/mod.rs 中暴露**

在 `crates/phonemize/src/backends/mod.rs` 添加：

```rust
pub mod espeak;
pub use espeak::EspeakBackend;
```

- [ ] **步骤 7：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn espeak_basic_phonemization() {
    use phonemize::backends::EspeakBackend;
    
    let mut espeak = EspeakBackend::new();
    espeak.initialize().unwrap();
    
    let phonemes = espeak.text_to_phonemes("hello").unwrap();
    assert!(phonemes.contains("h"));
    assert!(phonemes.contains("ɛ") || phonemes.contains("e"));
}
```

- [ ] **步骤 8：运行测试验证**

运行：`cd crates/phonemize && cargo test espeak_basic`

预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add crates/phonemize/build.rs crates/phonemize/espeak-ng crates/phonemize/src/backends/espeak.rs
git commit -m "feat(p6): integrate espeak-ng C library via FFI"
```

---

### 任务 4.2：espeak 数据文件处理

**文件：**
- 创建：`scripts/bundle-espeak-data.sh`
- 修改：`public/dictionaries/`（添加 espeak 数据）
- 修改：`crates/phonemize/src/backends/espeak.rs`

- [ ] **步骤 1：提取 espeak 数据文件**

在 `scripts/bundle-espeak-data.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

ESPEAK_SRC="crates/phonemize/espeak-ng"
DATA_DIR="public/espeak-data"

if [ ! -d "$ESPEAK_SRC" ]; then
  echo "Error: espeak-ng submodule not found"
  exit 1
fi

mkdir -p "$DATA_DIR"

# 复制必需的数据文件
cp -r "$ESPEAK_SRC/espeak-ng-data/"{lang,phondata,phonindex,phontab,intonations} "$DATA_DIR/"

# 压缩为单个 tar.zst
tar cf - -C public espeak-data/ | zstd -19 -o "public/dictionaries/espeak-data.tar.zst"

SIZE=$(ls -lh public/dictionaries/espeak-data.tar.zst | awk '{print $5}')
echo "✓ espeak data bundled: espeak-data.tar.zst ($SIZE)"
```

```bash
chmod +x scripts/bundle-espeak-data.sh
```

- [ ] **步骤 2：运行打包脚本**

运行：`./scripts/bundle-espeak-data.sh`

预期：生成 `public/dictionaries/espeak-data.tar.zst`

- [ ] **步骤 3：修改字典注册逻辑**

在 `crates/phonemize/src/dictionary.rs` 的 `set_required` 中添加：

```rust
match frontend.as_str() {
    "kokoro-v1" => {
        self.require_if_missing("lindera-ipadic-ja");
        self.require_if_missing("espeak-data");  // 英文需要
    }
    "kokoro-v11-zh" => {
        self.require_if_missing("espeak-data");  // v1.1-zh 也支持英文
    }
    _ => {}
}
```

- [ ] **步骤 4：实现 espeak 数据加载**

在 `crates/phonemize/src/backends/espeak.rs` 修改：

```rust
pub struct EspeakBackend {
    initialized: bool,
    data_path: Option<String>,
}

impl EspeakBackend {
    pub fn load_data(&mut self, tar_bytes: &[u8]) -> Result<(), String> {
        // 将 tar 解压到内存中的虚拟文件系统
        // 或写入临时目录（wasm 环境下需要特殊处理）
        
        // 简化：假设 espeak 可以从内存读取
        // 实际可能需要使用 emscripten 的虚拟文件系统
        
        self.data_path = Some("/espeak-ng-data".to_string());
        Ok(())
    }
    
    pub fn initialize(&mut self) -> Result<(), String> {
        let path = self.data_path.as_ref()
            .ok_or("espeak data not loaded")?;
        
        let c_path = CString::new(path.as_str())
            .map_err(|_| "Invalid path")?;
        
        let result = unsafe {
            espeak_Initialize(0, 0, c_path.as_ptr(), 0)
        };
        
        if result < 0 {
            return Err("Failed to initialize espeak-ng".to_string());
        }
        
        self.initialized = true;
        Ok(())
    }
}
```

- [ ] **步骤 5：Commit**

```bash
git add scripts/bundle-espeak-data.sh public/dictionaries/ crates/phonemize/src/
git commit -m "feat(p6): bundle and load espeak-ng data files"
```

---


## 阶段 5：中文 G2P 与 vocab 闸门

### 任务 5.1：中文拼音表与多音字

**文件：**
- 创建：`crates/phonemize/src/backends/pinyin.rs`
- 创建：`crates/phonemize/data/pinyin-table.json`（从 JS 迁移）
- 修改：`crates/phonemize/Cargo.toml`

- [ ] **步骤 1：复制现有拼音表**

```bash
cp lib/models/phonemize/pinyin-table.json crates/phonemize/data/
```

- [ ] **步骤 2：添加编译时嵌入依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
[dependencies]
serde_json = "1.0"
lazy_static = "1.4"
```

- [ ] **步骤 3：创建拼音后端骨架**

在 `crates/phonemize/src/backends/pinyin.rs`：

```rust
use lazy_static::lazy_static;
use serde_json::Value;
use std::collections::HashMap;

lazy_static! {
    static ref PINYIN_TABLE: HashMap<char, Vec<String>> = {
        let json_str = include_str!("../../data/pinyin-table.json");
        let data: Value = serde_json::from_str(json_str).unwrap();
        
        let mut table = HashMap::new();
        if let Some(obj) = data.as_object() {
            for (k, v) in obj {
                if let Some(ch) = k.chars().next() {
                    if let Some(arr) = v.as_array() {
                        let readings: Vec<String> = arr
                            .iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect();
                        table.insert(ch, readings);
                    }
                }
            }
        }
        table
    };
}

pub struct ChinesePinyinBackend {
    // 多音字规则待实现
}

impl ChinesePinyinBackend {
    pub fn new() -> Self {
        Self {}
    }
    
    /// 汉字 -> 拼音（不含声调标记）
    pub fn char_to_pinyin(&self, ch: char) -> Option<&str> {
        PINYIN_TABLE.get(&ch).and_then(|v| v.first().map(|s| s.as_str()))
    }
    
    /// 整句 -> 拼音序列
    pub fn text_to_pinyin(&self, text: &str) -> Vec<String> {
        text.chars()
            .filter_map(|ch| self.char_to_pinyin(ch).map(|s| s.to_string()))
            .collect()
    }
}
```

- [ ] **步骤 4：在 backends/mod.rs 中暴露**

在 `crates/phonemize/src/backends/mod.rs` 添加：

```rust
pub mod pinyin;
pub use pinyin::ChinesePinyinBackend;
```

- [ ] **步骤 5：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn chinese_pinyin_basic() {
    use phonemize::backends::ChinesePinyinBackend;
    
    let pinyin = ChinesePinyinBackend::new();
    assert_eq!(pinyin.char_to_pinyin('你'), Some("ni"));
    assert_eq!(pinyin.char_to_pinyin('好'), Some("hao"));
    
    let result = pinyin.text_to_pinyin("你好");
    assert_eq!(result, vec!["ni", "hao"]);
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test chinese_pinyin`

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/data/ crates/phonemize/src/backends/pinyin.rs crates/phonemize/Cargo.toml
git commit -m "feat(p6): add Chinese pinyin lookup table"
```

---

### 任务 5.2：vocab 闸门实现

**文件：**
- 创建：`crates/phonemize/src/vocab.rs`
- 创建：`crates/phonemize/data/vocab-v1.txt`
- 创建：`crates/phonemize/data/vocab-v11-zh.txt`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：提取现有 vocab**

从 spec §1.3 的实测数据创建两个文件：

在 `crates/phonemize/data/vocab-v1.txt`（v1.0 的 115 个字符）：

```
# 一行一个字符，注释行以 # 开头
# v1.0 vocab (115 chars)
a
b
...
ɚ
...
```

在 `crates/phonemize/data/vocab-v11-zh.txt`（v1.1-zh 的 172 个字符）。

- [ ] **步骤 2：编写 vocab 加载与检查**

在 `crates/phonemize/src/vocab.rs`：

```rust
use lazy_static::lazy_static;
use std::collections::HashSet;

lazy_static! {
    static ref VOCAB_V1: HashSet<char> = load_vocab(include_str!("../data/vocab-v1.txt"));
    static ref VOCAB_V11_ZH: HashSet<char> = load_vocab(include_str!("../data/vocab-v11-zh.txt"));
}

fn load_vocab(content: &str) -> HashSet<char> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .flat_map(|line| line.chars())
        .collect()
}

pub struct VocabGate {
    vocab: &'static HashSet<char>,
}

impl VocabGate {
    pub fn for_frontend(frontend: &str) -> Result<Self, String> {
        let vocab = match frontend {
            "kokoro-v1" => &*VOCAB_V1,
            "kokoro-v11-zh" => &*VOCAB_V11_ZH,
            _ => return Err(format!("Unknown frontend: {}", frontend)),
        };
        Ok(Self { vocab })
    }
    
    /// 检查输出字符串，返回第一个非法字符
    pub fn validate(&self, phonemes: &str) -> Result<(), VocabError> {
        for (idx, ch) in phonemes.char_indices() {
            if !self.vocab.contains(&ch) && !ch.is_whitespace() {
                return Err(VocabError {
                    char: ch,
                    position: idx,
                    phonemes: phonemes.to_string(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct VocabError {
    pub char: char,
    pub position: usize,
    pub phonemes: String,
}

impl std::fmt::Display for VocabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Invalid character '{}' at position {} in phonemes: {}",
            self.char, self.position, self.phonemes
        )
    }
}
```

- [ ] **步骤 3：在 lib.rs 中集成**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
mod vocab;
use vocab::VocabGate;
```

- [ ] **步骤 4：在 phonemize 方法中应用闸门**

在 `crates/phonemize/src/lib.rs` 的 `Phonemizer` impl 中添加：

```rust
pub fn phonemize(&self, text: &str, options: &JsValue) -> Result<JsValue, JsValue> {
    let opts: PhonemizeOptions = serde_wasm_bindgen::from_value(options.clone())
        .map_err(|e| JsValue::from_str(&format!("Invalid options: {}", e)))?;
    
    // TODO: 实际的 phonemize 流程（后续任务）
    let phonemes = String::new();
    
    // vocab 闸门
    let gate = VocabGate::for_frontend(&opts.frontend)
        .map_err(|e| JsValue::from_str(&e))?;
    
    gate.validate(&phonemes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let result = PhonemizeResult {
        phonemes,
        spans: None,
    };
    
    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}
```

- [ ] **步骤 5：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn vocab_gate_rejects_invalid_char() {
    use phonemize::vocab::VocabGate;
    
    let gate = VocabGate::for_frontend("kokoro-v11-zh").unwrap();
    
    // ɚ 在 v1.0 里有，但 v1.1-zh 没有
    let result = gate.validate("həˈloʊ");
    assert!(result.is_ok());
    
    let result = gate.validate("nˈɛvɚ");  // 含 ɚ
    assert!(result.is_err());
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test vocab_gate`

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/vocab.rs crates/phonemize/data/vocab-*.txt
git commit -m "feat(p6): implement vocabulary gate for two frontends"
```

---


## 阶段 6：前端组装与对照测试

### 任务 6.1：中文前端（v1.0 IPA）

**文件：**
- 创建：`crates/phonemize/src/frontends/mod.rs`
- 创建：`crates/phonemize/src/frontends/zh_ipa.rs`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：编写中文 IPA 输出测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn chinese_v1_frontend_basic() {
    use phonemize::frontends::ChineseIpaFrontend;
    
    let frontend = ChineseIpaFrontend::new();
    let result = frontend.process("你好");
    
    // v1.0: 拼音 -> IPA + 声调箭头
    assert!(result.contains("n"));
    assert!(result.contains("i"));
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd crates/phonemize && cargo test chinese_v1_frontend`

预期：FAIL，"no module named `frontends`"

- [ ] **步骤 3：实现中文 v1.0 前端**

在 `crates/phonemize/src/frontends/mod.rs`：

```rust
pub mod zh_ipa;
pub mod zh_zhuyin;
pub mod ja_ipa;
pub mod en_espeak;

pub use zh_ipa::ChineseIpaFrontend;
pub use zh_zhuyin::ChineseZhuyinFrontend;
pub use ja_ipa::JapaneseIpaFrontend;
pub use en_espeak::EnglishEspeakFrontend;
```

在 `crates/phonemize/src/frontends/zh_ipa.rs`：

```rust
use crate::backends::ChinesePinyinBackend;

/// v1.0 中文前端：拼音 -> IPA + 声调箭头（↓→↗↘）
pub struct ChineseIpaFrontend {
    pinyin: ChinesePinyinBackend,
}

impl ChineseIpaFrontend {
    pub fn new() -> Self {
        Self {
            pinyin: ChinesePinyinBackend::new(),
        }
    }
    
    /// 拼音 -> IPA 的映射规则（从 JS 链迁移）
    fn pinyin_to_ipa(&self, pinyin: &str) -> String {
        // TODO: 实现完整的拼音->IPA映射表
        // 这里先返回简化版本
        match pinyin {
            "ni" => "ni↗".to_string(),
            "hao" => "xɑʊ↘".to_string(),
            _ => pinyin.to_string(),
        }
    }
    
    pub fn process(&self, text: &str) -> String {
        let pinyins = self.pinyin.text_to_pinyin(text);
        pinyins
            .iter()
            .map(|p| self.pinyin_to_ipa(p))
            .collect::<Vec<_>>()
            .join(" ")
    }
}
```

- [ ] **步骤 4：在 lib.rs 中暴露**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
pub mod frontends;
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd crates/phonemize && cargo test chinese_v1_frontend`

预期：PASS

- [ ] **步骤 6：实现完整的拼音->IPA映射**

从 `lib/models/phonemize/chinese.ts` 提取映射规则，补充到 `zh_ipa.rs`。

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/frontends/
git commit -m "feat(p6): implement Chinese v1.0 IPA frontend"
```

---

### 任务 6.2：提取 JS 测试语料

**文件：**
- 创建：`tests/corpus/phonemize-corpus.json`
- 创建：`scripts/extract-test-corpus.mjs`

- [ ] **步骤 1：编写语料提取脚本**

在 `scripts/extract-test-corpus.mjs`：

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'glob';

const testFiles = glob.sync('tests/unit/models/phonemize/**/*.test.ts');
const corpus = [];

for (const file of testFiles) {
  const content = readFileSync(file, 'utf-8');
  
  // 提取测试用例中的文本样本
  const regex = /phonemize\(['"](.+?)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    corpus.push({
      text: match[1],
      source: file,
    });
  }
}

// 去重
const unique = [...new Map(corpus.map(item => [item.text, item])).values()];

writeFileSync(
  'tests/corpus/phonemize-corpus.json',
  JSON.stringify(unique, null, 2)
);

console.log(`✓ Extracted ${unique.length} unique samples`);
```

```bash
chmod +x scripts/extract-test-corpus.mjs
```

- [ ] **步骤 2：运行提取**

运行：`node scripts/extract-test-corpus.mjs`

预期：生成 `tests/corpus/phonemize-corpus.json`

- [ ] **步骤 3：创建对照测试**

在 `tests/unit/models/phonemize-rust-parity.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { ChinesePhonemizer } from '~/lib/models/phonemize/chinese';
import { JapanesePhonemizer } from '~/lib/models/phonemize/japanese';
import { EnglishPhonemizer } from '~/lib/models/phonemize/english';

interface CorpusSample {
  text: string;
  source: string;
  lang?: string;
}

const corpus: CorpusSample[] = JSON.parse(
  readFileSync('tests/corpus/phonemize-corpus.json', 'utf-8')
);

describe('Rust vs JS parity', () => {
  let rustPhon: RustPhonemizer;
  let jsChinesePhon: ChinesePhonemizer;
  let jsJapanesePhon: JapanesePhonemizer;
  let jsEnglishPhon: EnglishPhonemizer;
  
  beforeAll(async () => {
    rustPhon = new RustPhonemizer();
    await rustPhon.ready;
    await rustPhon.prepare(['kokoro-v1']);
    
    // JS phonemizers 初始化
    jsChinesePhon = new ChinesePhonemizer();
    // ... 其他初始化
  });
  
  it('matches JS output for Chinese samples', async () => {
    const chineseSamples = corpus.filter(s => 
      /[\u4e00-\u9fa5]/.test(s.text)
    );
    
    for (const sample of chineseSamples.slice(0, 10)) {
      const rustResult = rustPhon.phonemize(sample.text, {
        frontend: 'kokoro-v1',
        lang: 'zh',
      });
      
      const jsResult = await jsChinesePhon.phonemize(sample.text, 'zh');
      
      expect(rustResult.phonemes).toBe(jsResult);
    }
  });
});
```

- [ ] **步骤 4：运行对照测试**

运行：`pnpm test phonemize-rust-parity`

预期：FAIL（Rust 实现还不完整）

- [ ] **步骤 5：Commit**

```bash
git add scripts/extract-test-corpus.mjs tests/corpus/ tests/unit/models/phonemize-rust-parity.test.ts
git commit -m "feat(p6): add JS vs Rust parity test infrastructure"
```

---

### 任务 6.3：完成其余三个前端

**文件：**
- 创建：`crates/phonemize/src/frontends/zh_zhuyin.rs`
- 创建：`crates/phonemize/src/frontends/ja_ipa.rs`
- 创建：`crates/phonemize/src/frontends/en_espeak.rs`

- [ ] **步骤 1：实现中文 v1.1-zh 前端**

在 `crates/phonemize/src/frontends/zh_zhuyin.rs`：

```rust
use crate::backends::ChinesePinyinBackend;

/// v1.1-zh 中文前端：拼音 -> 注音符号 + 数字声调 + `/` 分隔
pub struct ChineseZhuyinFrontend {
    pinyin: ChinesePinyinBackend,
}

impl ChineseZhuyinFrontend {
    pub fn new() -> Self {
        Self {
            pinyin: ChinesePinyinBackend::new(),
        }
    }
    
    /// 拼音 -> 注音符号的映射（从 P5 spec §3 提取）
    fn pinyin_to_zhuyin(&self, pinyin: &str) -> String {
        // TODO: 实现完整的拼音->注音映射表
        match pinyin {
            "ni" => "ㄋㄧ3".to_string(),
            "hao" => "ㄏㄠ3".to_string(),
            _ => pinyin.to_string(),
        }
    }
    
    pub fn process(&self, text: &str) -> String {
        let pinyins = self.pinyin.text_to_pinyin(text);
        pinyins
            .iter()
            .map(|p| self.pinyin_to_zhuyin(p))
            .collect::<Vec<_>>()
            .join("/")
    }
}
```

- [ ] **步骤 2：实现日语前端**

在 `crates/phonemize/src/frontends/ja_ipa.rs`：

```rust
use crate::backends::JapaneseSegmenter;

/// v1.0 日语前端：假名 -> IPA
pub struct JapaneseIpaFrontend {
    segmenter: JapaneseSegmenter,
}

impl JapaneseIpaFrontend {
    pub fn new() -> Self {
        Self {
            segmenter: JapaneseSegmenter::new(),
        }
    }
    
    pub fn load_dictionary(&mut self, dict_bytes: &[u8]) -> Result<(), String> {
        self.segmenter.load_dictionary(dict_bytes)
    }
    
    /// 假名读音 -> IPA（从 P5 spec §4.2 KANA_TO_IPA 提取）
    fn kana_to_ipa(&self, kana: &str) -> String {
        // TODO: 实现完整的假名->IPA映射表
        match kana {
            "ア" => "a",
            "イ" => "i",
            "ケイエイ" => "keːeː",
            _ => kana,
        }.to_string()
    }
    
    pub fn process(&self, text: &str) -> String {
        let tokens = self.segmenter.tokenize(text);
        tokens
            .iter()
            .filter_map(|t| t.reading.as_ref())
            .map(|r| self.kana_to_ipa(r))
            .collect::<Vec<_>>()
            .join(" ")
    }
}
```

- [ ] **步骤 3：实现英文前端**

在 `crates/phonemize/src/frontends/en_espeak.rs`：

```rust
use crate::backends::EspeakBackend;

/// 英文前端：espeak-ng IPA（v1.0 与 v1.1-zh 共用）
pub struct EnglishEspeakFrontend {
    espeak: EspeakBackend,
}

impl EnglishEspeakFrontend {
    pub fn new() -> Self {
        Self {
            espeak: EspeakBackend::new(),
        }
    }
    
    pub fn load_data(&mut self, tar_bytes: &[u8]) -> Result<(), String> {
        self.espeak.load_data(tar_bytes)?;
        self.espeak.initialize()
    }
    
    pub fn process(&self, text: &str) -> Result<String, String> {
        self.espeak.text_to_phonemes(text)
    }
}
```

- [ ] **步骤 4：为每个前端编写测试**

在 `crates/phonemize/tests/integration.rs` 添加三组测试。

- [ ] **步骤 5：运行测试验证**

运行：`cd crates/phonemize && cargo test`

预期：PASS（基础测试）

- [ ] **步骤 6：Commit**

```bash
git add crates/phonemize/src/frontends/
git commit -m "feat(p6): implement all four frontends (zh-ipa, zh-zhuyin, ja-ipa, en-espeak)"
```

---


## 阶段 7：双 worker 架构与最终集成

### 任务 7.1：phonemize worker 创建

**文件：**
- 创建：`entrypoints/offscreen/phonemize.worker.ts`
- 创建：`lib/models/phonemize-worker-protocol.ts`
- 修改：`lib/models/worker-protocol.ts`

- [ ] **步骤 1：定义 phonemize worker 协议**

在 `lib/models/phonemize-worker-protocol.ts`：

```typescript
export type PhonemeWorkerRequest =
  | { type: 'init' }
  | { type: 'prepare'; frontends: readonly string[] }
  | { type: 'phonemize'; id: number; text: string; options: PhonemizeOptions };

export type PhonemeWorkerReply =
  | { type: 'ready' }
  | { type: 'prepared' }
  | { type: 'phonemized'; id: number; result: PhonemizeResult }
  | { type: 'error'; id?: number; code: string; message: string };

export interface PhonemizeOptions {
  readonly frontend: 'kokoro-v1' | 'kokoro-v11-zh';
  readonly lang: string;
}

export interface PhonemizeResult {
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
}

export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

export function isPhonemeWorkerRequest(msg: unknown): msg is PhonemeWorkerRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof msg.type === 'string'
  );
}
```

- [ ] **步骤 2：实现 phonemize worker**

在 `entrypoints/offscreen/phonemize.worker.ts`：

```typescript
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import {
  isPhonemeWorkerRequest,
  type PhonemeWorkerReply,
  type PhonemeWorkerRequest,
} from '~/lib/models/phonemize-worker-protocol';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

let phonemizer: RustPhonemizer | null = null;

function reply(msg: PhonemeWorkerReply): void {
  scope.postMessage(msg);
}

async function handleMessage(req: PhonemeWorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'init': {
        phonemizer = new RustPhonemizer();
        await phonemizer.ready;
        reply({ type: 'ready' });
        break;
      }

      case 'prepare': {
        if (!phonemizer) throw new Error('Phonemizer not initialized');
        await phonemizer.prepare(req.frontends);
        reply({ type: 'prepared' });
        break;
      }

      case 'phonemize': {
        if (!phonemizer) throw new Error('Phonemizer not initialized');
        const result = phonemizer.phonemize(req.text, req.options);
        reply({ type: 'phonemized', id: req.id, result });
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply({
      type: 'error',
      id: 'id' in req ? req.id : undefined,
      code: 'phonemize_failed',
      message,
    });
  }
}

scope.addEventListener('message', (event: MessageEvent) => {
  if (isPhonemeWorkerRequest(event.data)) {
    void handleMessage(event.data);
  }
});
```

- [ ] **步骤 3：修改 WXT 配置以识别新 worker**

在 `wxt.config.ts` 添加新 worker 的构建配置（如需要）。

- [ ] **步骤 4：编写 worker 通信测试**

在 `tests/unit/workers/phonemize-worker.test.ts`（新建）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('PhonemeWorker', () => {
  let worker: Worker;

  beforeAll(() => {
    // 在测试环境中创建 worker
    worker = new Worker(
      new URL('../../../entrypoints/offscreen/phonemize.worker.ts', import.meta.url),
      { type: 'module' }
    );
  });

  afterAll(() => {
    worker.terminate();
  });

  it('initializes and becomes ready', async () => {
    const ready = new Promise<void>((resolve) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') resolve();
      };
    });

    worker.postMessage({ type: 'init' });
    await ready;
  });
});
```

- [ ] **步骤 5：运行测试验证**

运行：`pnpm test phonemize-worker`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/offscreen/phonemize.worker.ts lib/models/phonemize-worker-protocol.ts tests/unit/workers/
git commit -m "feat(p6): create dedicated phonemize worker"
```

---

### 任务 7.2：重构 kokoro worker 移除 phonemize

**文件：**
- 修改：`entrypoints/offscreen/local.worker.ts` -> `kokoro.worker.ts`
- 修改：`lib/models/kokoro-engine.ts`
- 修改：`lib/models/worker-protocol.ts`

- [ ] **步骤 1：重命名并清理 kokoro worker**

```bash
git mv entrypoints/offscreen/local.worker.ts entrypoints/offscreen/kokoro.worker.ts
```

在 `entrypoints/offscreen/kokoro.worker.ts` 中：

- 删除 `ChinesePhonemizer` / `JapanesePhonemizer` / `EnglishPhonemizer` 的导入
- 删除 `KokoroEngine` 中的 phonemize 逻辑

- [ ] **步骤 2：修改 synthesize 协议接受 phonemes**

在 `lib/models/worker-protocol.ts` 修改 `SynthesizeRequest`：

```typescript
export interface SynthesizeRequest {
  type: 'synthesize';
  id: number;
  phonemes: string;  // 新增：预处理好的音素串
  voiceId: string;
  signal: AbortSignal;
}
```

- [ ] **步骤 3：简化 KokoroEngine.synthesize**

在 `lib/models/kokoro-engine.ts` 修改 `synthesize` 方法：

```typescript
async synthesize(
  phonemes: string,  // 直接接受音素，不再接受原始 text
  voiceId: string,
  signal: AbortSignal
): Promise<RawPcm> {
  // 移除 phonemize 调用
  // 直接用传入的 phonemes
  
  const pieces = planPieces(phonemes, 512);
  const pcms: Int16Array[] = [];

  for (const piece of pieces) {
    if (signal.aborted) throw abortError();
    
    const result = await this.tts!.generate(piece, {
      voiceId: voiceId as GenerateOptions['voiceId'],
    });
    
    pcms.push(result.audio);
  }

  return {
    pcm: concatPcm(pcms),
    sampleRate: KOKORO_SAMPLE_RATE,
  };
}
```

- [ ] **步骤 4：更新 kokoro worker 消息处理**

在 `entrypoints/offscreen/kokoro.worker.ts` 修改 `synthesize` case：

```typescript
case 'synthesize': {
  const controller = new AbortController();
  inFlight.set(req.id, { controller });

  try {
    const pcm = await engine.synthesize(
      req.phonemes,  // 使用传入的 phonemes
      req.voiceId,
      controller.signal
    );
    
    reply({
      type: 'synthesized',
      id: req.id,
      pcm: pcm.pcm.buffer,
      sampleRate: pcm.sampleRate,
    }, [pcm.pcm.buffer]);
  } catch (error) {
    // ... 错误处理
  } finally {
    inFlight.delete(req.id);
  }
  break;
}
```

- [ ] **步骤 5：运行测试验证**

运行：`pnpm test kokoro-engine`

预期：需要修改测试以传入 phonemes

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/offscreen/kokoro.worker.ts lib/models/kokoro-engine.ts lib/models/worker-protocol.ts
git commit -m "refactor(p6): remove phonemize from kokoro worker"
```

---

### 任务 7.3：offscreen 主线程协调两个 worker

**文件：**
- 修改：`entrypoints/offscreen/offscreen.ts`
- 修改：`lib/audio-worker.ts`

- [ ] **步骤 1：在 offscreen.ts 中创建两个 worker**

在 `entrypoints/offscreen/offscreen.ts` 修改：

```typescript
import PhonemeWorker from './phonemize.worker?worker';
import KokoroWorker from './kokoro.worker?worker';

let phonemeWorker: Worker | null = null;
let kokoroWorker: Worker | null = null;

export function initWorkers(): void {
  phonemeWorker = new PhonemeWorker();
  kokoroWorker = new KokoroWorker();
  
  // 初始化 phoneme worker
  phonemeWorker.postMessage({ type: 'init' });
  
  // 初始化 kokoro worker（现有逻辑）
  kokoroWorker.postMessage({
    type: 'init',
    source: modelSource,
  });
}
```

- [ ] **步骤 2：修改 AudioWorker 的两步调用**

在 `lib/audio-worker.ts` 修改 `LocalProvider.synthesize`：

```typescript
async synthesize(request: SynthesizeRequest): Promise<RawPcm> {
  // 步骤 1：phonemize
  const phonemeResult = await this.phonemize(request.text, {
    frontend: this.getFrontendId(request.modelId),
    lang: this.lang ?? voiceLanguage(request.voiceId) ?? 'en-US',
  });
  
  // 步骤 2：synthesize
  const pcm = await this.kokoroSynthesize(
    phonemeResult.phonemes,
    request.voiceId,
    request.signal
  );
  
  return pcm;
}

private async phonemize(
  text: string,
  options: PhonemizeOptions
): Promise<PhonemizeResult> {
  return new Promise((resolve, reject) => {
    const id = this.nextId++;
    
    const timeout = setTimeout(() => {
      reject(new Error('Phonemize timeout'));
    }, 5000);
    
    const handler = (event: MessageEvent) => {
      if (event.data.type === 'phonemized' && event.data.id === id) {
        clearTimeout(timeout);
        phonemeWorker!.removeEventListener('message', handler);
        resolve(event.data.result);
      }
    };
    
    phonemeWorker!.addEventListener('message', handler);
    phonemeWorker!.postMessage({ type: 'phonemize', id, text, options });
  });
}

private async kokoroSynthesize(
  phonemes: string,
  voiceId: string,
  signal: AbortSignal
): Promise<RawPcm> {
  // 现有的 synthesize 逻辑，但传 phonemes 而非 text
  // ...
}
```

- [ ] **步骤 3：实现 prepare() 的调用时机**

在 `lib/audio-worker.ts` 添加音色切换监听：

```typescript
export class AudioWorker {
  private preparedFrontends = new Set<string>();
  
  async ensurePrepared(frontend: string): Promise<void> {
    if (this.preparedFrontends.has(frontend)) return;
    
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Prepare timeout')), 10000);
      
      const handler = (event: MessageEvent) => {
        if (event.data.type === 'prepared') {
          clearTimeout(timeout);
          phonemeWorker!.removeEventListener('message', handler);
          this.preparedFrontends.add(frontend);
          resolve();
        }
      };
      
      phonemeWorker!.addEventListener('message', handler);
      phonemeWorker!.postMessage({ type: 'prepare', frontends: [frontend] });
    });
  }
}
```

在用户选择音色时调用 `ensurePrepared`。

- [ ] **步骤 4：运行端到端测试**

运行：`pnpm test:e2e`

预期：播放流程正常工作

- [ ] **步骤 5：Commit**

```bash
git add entrypoints/offscreen/offscreen.ts lib/audio-worker.ts
git commit -m "feat(p6): coordinate phonemize and kokoro workers"
```

---


## 阶段 8：验证与清理

### 任务 8.1：对照测试全量通过

**文件：**
- 修改：`tests/unit/models/phonemize-rust-parity.test.ts`
- 修改：各个前端实现（根据测试失败修复）

- [ ] **步骤 1：运行全量对照测试**

运行：`pnpm test phonemize-rust-parity`

预期：识别所有不匹配的样本

- [ ] **步骤 2：对于每个失败样本，确定原因**

对于每个失败，记录：
- 输入文本
- JS 输出
- Rust 输出
- 差异类型（映射错误 / 声调错误 / 分词差异）

- [ ] **步骤 3：修复映射表**

根据失败分析，补充完整的：
- 拼音 -> IPA 映射
- 拼音 -> 注音符号映射
- 假名 -> IPA 映射

- [ ] **步骤 4：处理已知改进**

对于"有记录的更优"（spec §5.1），在对照测试中标记为 `expected_improvement`：

```typescript
const EXPECTED_IMPROVEMENTS = [
  {
    text: '経営',
    reason: 'Fixed: ガ行 now maps to ɡ (U+0261) not ASCII g',
    jsOutput: 'keːeː',  // 错误的映射
    rustOutput: 'keːeː', // 正确的映射
  },
];
```

- [ ] **步骤 5：再次运行测试**

运行：`pnpm test phonemize-rust-parity`

预期：PASS（所有样本匹配或在 expected_improvements 中）

- [ ] **步骤 6：记录所有改进**

在 `docs/superpowers/plans/p6-improvements.md` 记录所有"更优"的案例。

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/frontends/ tests/unit/models/phonemize-rust-parity.test.ts docs/
git commit -m "fix(p6): achieve full parity with JS phonemize chain"
```

---

### 任务 8.2：性能与内存验证

**文件：**
- 创建：`tests/performance/phonemize-benchmark.test.ts`
- 创建：`tests/performance/offscreen-memory.test.ts`

- [ ] **步骤 1：编写性能基准测试**

在 `tests/performance/phonemize-benchmark.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';

describe('Performance benchmark', () => {
  let phonemizer: RustPhonemizer;

  beforeAll(async () => {
    phonemizer = new RustPhonemizer();
    await phonemizer.ready;
    await phonemizer.prepare(['kokoro-v1']);
  });

  it('phonemizes 50-char Chinese in < 1ms', () => {
    const text = '这是一段测试文本用于验证音素化的性能表现是否符合预期目标需要达到'.repeat(1);
    const iterations = 20;
    
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      phonemizer.phonemize(text, { frontend: 'kokoro-v1', lang: 'zh' });
    }
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    
    console.log(`Average: ${avg.toFixed(3)} ms`);
    expect(avg).toBeLessThan(1.0);  // spec §1.1: 0.07 ms for 50 chars
  });

  it('cold start < 100ms', async () => {
    const start = performance.now();
    const p = new RustPhonemizer();
    await p.ready;
    await p.prepare(['kokoro-v1']);
    const elapsed = performance.now() - start;
    
    console.log(`Cold start: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(100);  // spec §4.2
  });
});
```

- [ ] **步骤 2：运行基准测试**

运行：`pnpm test:performance`

预期：所有指标在目标范围内

- [ ] **步骤 3：验证 offscreen worker 内存行为（V8）**

在 `tests/e2e/offscreen-worker-memory.spec.ts`：

```typescript
import { test, expect } from '@playwright/test';

test('lindera loads in offscreen worker without memory leak', async ({ page }) => {
  // 加载扩展并打开 sidepanel
  await page.goto('chrome-extension://...');
  
  // 触发播放（日语文本）
  await page.locator('[data-testid="play-button"]').click();
  
  // 等待首句合成完成
  await page.waitForSelector('[data-testid="playing"]');
  
  // 检查内存使用（需要 Chrome DevTools Protocol）
  const metrics = await page.evaluate(() => {
    return (performance as any).memory;
  });
  
  console.log('Memory after first synthesis:', metrics);
  
  // 等待 30 秒让 worker 回收
  await page.waitForTimeout(31000);
  
  // 再次播放
  await page.locator('[data-testid="play-button"]').click();
  await page.waitForSelector('[data-testid="playing"]');
  
  const metricsAfterRecycle = await page.evaluate(() => {
    return (performance as any).memory;
  });
  
  console.log('Memory after recycle:', metricsAfterRecycle);
  
  // 内存应该重置，不应累积
  expect(metricsAfterRecycle.usedJSHeapSize).toBeLessThan(
    metrics.usedJSHeapSize * 1.5  // 允许 50% 浮动
  );
});
```

- [ ] **步骤 4：运行 e2e 内存测试**

运行：`pnpm test:e2e offscreen-worker-memory`

预期：PASS（内存不累积）

- [ ] **步骤 5：记录性能数据**

在 `docs/superpowers/plans/p6-performance.md` 记录实测数据。

- [ ] **步骤 6：Commit**

```bash
git add tests/performance/ tests/e2e/offscreen-worker-memory.spec.ts docs/
git commit -m "test(p6): verify performance and memory behavior"
```

---

### 任务 8.3：错误处理完善

**文件：**
- 修改：`lib/models/phonemize-rust.ts`
- 修改：`lib/providers/errors.ts`
- 修改：`entrypoints/offscreen/phonemize.worker.ts`

- [ ] **步骤 1：定义错误码**

在 `lib/providers/errors.ts` 添加：

```typescript
export type ProviderErrorCode =
  | 'dictionary_load_failed'
  | 'dictionary_corrupt'
  | 'unsupported_language'
  | 'vocab_violation'
  | 'phonemize_timeout'
  | ... // 现有错误码

export interface DictionaryError {
  code: 'dictionary_load_failed' | 'dictionary_corrupt';
  dictionaryName: string;
  detail: string;
}

export interface VocabError {
  code: 'vocab_violation';
  char: string;
  position: number;
  phonemes: string;
}
```

- [ ] **步骤 2：在 Rust 侧返回结构化错误**

在 `crates/phonemize/src/lib.rs` 修改错误处理：

```rust
#[wasm_bindgen]
#[derive(Serialize)]
pub struct PhonemeError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

impl Phonemizer {
    pub fn phonemize(&self, text: &str, options: &JsValue) -> Result<JsValue, JsValue> {
        // ... 处理逻辑
        
        // vocab 闸门失败
        if let Err(e) = gate.validate(&phonemes) {
            let error = PhonemeError {
                code: "vocab_violation".to_string(),
                message: e.to_string(),
                detail: Some(serde_json::json!({
                    "char": e.char.to_string(),
                    "position": e.position,
                })),
            };
            return Err(serde_wasm_bindgen::to_value(&error)?);
        }
        
        // ...
    }
}
```

- [ ] **步骤 3：在 TypeScript 侧解析错误**

在 `lib/models/phonemize-rust.ts` 修改：

```typescript
phonemize(text: string, options: PhonemizeOptions): PhonemizeResult {
  if (!this.instance) throw new Error('Phonemizer not ready');
  
  try {
    return this.instance.phonemize(text, options);
  } catch (error) {
    // 解析 Rust 结构化错误
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const structured = error as { code: string; message: string; detail?: unknown };
      
      if (structured.code === 'vocab_violation') {
        const detail = structured.detail as { char: string; position: number };
        throw new PhonemeVocabError(detail.char, detail.position, structured.message);
      }
      
      if (structured.code === 'unsupported_language') {
        throw new UnsupportedLanguageError(structured.message);
      }
    }
    
    throw error;
  }
}
```

- [ ] **步骤 4：编写错误场景测试**

在 `tests/unit/models/phonemize-rust.test.ts` 添加：

```typescript
it('throws vocab error with char details', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // 模拟产生非法字符的情况
  expect(() => {
    phonemizer.phonemize('test', { frontend: 'kokoro-v11-zh', lang: 'en' });
  }).toThrow(PhonemeVocabError);
});

it('throws unsupported language error', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  expect(() => {
    phonemizer.phonemize('テスト', { frontend: 'kokoro-v11-zh', lang: 'ja' });
  }).toThrow(UnsupportedLanguageError);
});
```

- [ ] **步骤 5：运行错误测试**

运行：`pnpm test phonemize-rust`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add lib/models/phonemize-rust.ts lib/providers/errors.ts crates/phonemize/src/lib.rs tests/
git commit -m "feat(p6): implement structured error handling"
```

---

### 任务 8.4：移除 JS 链

**文件：**
- 删除：`lib/models/phonemize/` 整个目录
- 修改：所有引用 JS phonemizer 的测试

- [ ] **步骤 1：确认对照测试全绿**

运行：`pnpm test phonemize-rust-parity`

预期：PASS（100% 覆盖）

- [ ] **步骤 2：grep 查找所有引用**

```bash
rg "from '~/lib/models/phonemize/(chinese|japanese|english)'" --type ts
```

记录所有引用位置。

- [ ] **步骤 3：删除 JS phonemize 目录**

```bash
git rm -r lib/models/phonemize/
```

- [ ] **步骤 4：修改或删除依赖 JS 链的测试**

对于每个引用：
- 如果是对照测试：保留为历史记录
- 如果是单元测试：迁移到 Rust 侧或删除
- 如果是集成测试：改用 RustPhonemizer

- [ ] **步骤 5：运行全量测试**

运行：`pnpm test`

预期：PASS（所有 1430+ 测试通过）

- [ ] **步骤 6：验证构建**

运行：`pnpm build && pnpm build:e2e`

预期：成功构建，wasm 被打包进扩展

- [ ] **步骤 7：Commit**

```bash
git add lib/models/ tests/
git commit -m "refactor(p6): remove legacy JS phonemize chain"
```

---

### 任务 8.5：文档更新

**文件：**
- 修改：`docs/phonemization-architecture.md`
- 修改：`README.md`
- 创建：`crates/phonemize/README.md`

- [ ] **步骤 1：重写架构文档**

在 `docs/phonemization-architecture.md` 完全重写：

```markdown
# Phonemization Architecture (Rust)

**状态**: P6 完成，JS 链已移除

## 概览

文本预处理（TN + G2P）在 Rust 中实现，编译为单个 wasm 模块，运行在专用的 phonemize worker 中。

## 架构

offscreen 主线程
  ├── phonemize.worker (Rust wasm)
  └── kokoro.worker (ONNX Runtime)

phonemize worker 持有：
- Rust wasm 实例
- 字典（按需加载，zstd 压缩）
- vocab 闸门

kokoro worker 持有：
- ONNX 会话
- 模型权重

调度由 AudioWorker 协调：
1. phonemize(text) -> phonemes
2. synthesize(phonemes) -> pcm

## 支持的语言

| Frontend | 语言 | 模型 |
|----------|------|------|
| kokoro-v1 | 中日英 | v1.0 |
| kokoro-v11-zh | 中英 | v1.1-zh |

...
```

- [ ] **步骤 2：更新 README**

在 `README.md` 添加 Rust 工具链要求：

```markdown
## 开发环境

- Node.js 18+
- pnpm 8+
- **Rust 1.75+ 和 wasm-pack**（用于构建 phonemize wasm）

### 安装 Rust 工具链

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
```

### 构建

```bash
pnpm install    # 会自动运行 build:wasm
pnpm build
```
```

- [ ] **步骤 3：编写 Rust crate 文档**

在 `crates/phonemize/README.md`：

```markdown
# phonemize

Rust-based text preprocessing for Kokoro TTS.

## Features

- Text Normalization (TN)
- Grapheme-to-Phoneme (G2P) for Chinese, Japanese, English
- Vocabulary validation
- Dictionary loading with zstd decompression

## Usage

This crate compiles to wasm and is consumed by the TypeScript side. See `lib/models/phonemize-rust.ts`.

## Testing

```bash
cargo test
```

## Dictionaries

Dictionaries are fetched at runtime as zstd-compressed tarballs. See `public/dictionaries/`.
```

- [ ] **步骤 4：Commit**

```bash
git add docs/ README.md crates/phonemize/README.md
git commit -m "docs(p6): update architecture docs for Rust phonemize"
```

---

### 任务 8.6：最终验收

**文件：**
- 创建：`docs/superpowers/plans/p6-acceptance.md`

- [ ] **步骤 1：运行完整测试套件**

```bash
pnpm biome check .
pnpm typecheck
pnpm test
pnpm test:build
pnpm test:e2e
```

预期：全部通过

- [ ] **步骤 2：验证成功标准（spec §0.4）**

| 项 | 标准 | 实测 | 状态 |
|---|---|---|---|
| 输出等价 | Rust 输出 = JS 输出或更优 | ✓ 对照测试全绿 | ✅ |
| 冷启动 | wasm + 字典 ≤ 100 ms | [填入实测值] ms | ✅/❌ |
| 单模块 | 只有一个 .wasm | ✓ phonemize_bg.wasm | ✅ |
| 开箱即用 | 用户零下载 | ✓ 字典打包进扩展 | ✅ |

- [ ] **步骤 3：手动测试三种语言**

打开扩展，分别测试：
1. 中文页面（两个模型）
2. 日语页面（v1.0）
3. 英文页面（两个模型）

验证音频正常播放、无报错、词级高亮（若实现 spans）。

- [ ] **步骤 4：记录验收结果**

在 `docs/superpowers/plans/p6-acceptance.md` 记录所有指标。

- [ ] **步骤 5：最终 Commit**

```bash
git add docs/superpowers/plans/p6-acceptance.md
git commit -m "test(p6): complete acceptance testing"
```

---


---

## 实施顺序建议

### 最小可验证路径（MVP）

1. **任务 1.1–1.2**：Rust 脚手架 + TS wrapper（验证编译与加载）
2. **任务 2.1–2.2**：字典协议（验证资源传输）
3. **任务 3.1–3.2**：lindera 集成（验证 V8：offscreen worker 里的 45 MB 字典）
4. **任务 5.2**：vocab 闸门（验证输出校验逻辑）
5. **任务 6.1**：一个前端（中文 v1.0）+ 对照测试骨架
6. **任务 7.1–7.3**：双 worker 架构（验证冷启动并行与调度）

此时可以跑通完整流程：选中文音色 → 播放 → 听到声音。

### 后续扩展

7. **任务 4.1–4.2**：espeak 集成（英文支持）
8. **任务 6.2–6.3**：其余前端（日语、中文 v1.1-zh）
9. **任务 8.1–8.6**：对照测试、性能验证、错误处理、清理

---

## 依赖与风险

### 外部依赖

| 依赖 | 用途 | 风险 | 缓解 |
|---|---|---|---|
| lindera 0.34+ | 日语分词 | 版本不兼容 | 锁定版本，测试覆盖 |
| espeak-ng | 英文 G2P | C 编译复杂 | 预先验证 build.rs |
| wasm-bindgen | Rust↔JS 桥接 | API 变更 | 锁定版本 |
| zstd | 字典解压 | 性能不达标 | V2 实测（spec §7） |

### 技术风险

1. **espeak 在 wasm 中的文件系统访问**（任务 4.2）
   - espeak 需要读取数据文件，wasm 没有真实文件系统
   - 缓解：使用 emscripten 虚拟 FS 或内存映射
   
2. **lindera 在 offscreen worker 的内存行为**（V8，任务 8.2）
   - 45.3 MB 字典可能触发内存限制或影响回收
   - 缓解：早期验证，监控内存指标

3. **对照测试的覆盖率**（任务 8.1）
   - 现有 1430 测试可能遗漏边缘用例
   - 缓解：补充 corpus，记录所有"更优"案例

4. **双 worker 的错误同步**（任务 7.3）
   - 一个 worker 崩溃时另一个的状态处理
   - 缓解：spec §8.1 的错误分类 + 审查重点 #4

---

## 待决项（开工前必须解决）

spec §8 列出的 6 个待决项：

1. **错误分类与气泡文案**（任务 8.3 中解决）
2. **用户正则规则的边界**（暂不实现，预留接口）
3. **两个模型共存的运行时切换**（任务 7.3 中解决：frontend 参数动态选择）
4. **测试语料迁移方式**（任务 6.2：提取为 JSON + Rust 集成测试读取）
5. **wasm 构建集成**（任务 1.1：scripts/build-phonemize-wasm.sh + prebuild hook）
6. **词典版本更新流程**（决策 #21：构建时锁定，手动更新，记录在 Cargo.toml）

---

## 验收清单

任务 8.6 最终验收时检查：

- [ ] 单元测试 PASS（Rust 侧 + TS 侧）
- [ ] 对照测试 100% 通过（或记录所有改进）
- [ ] 性能测试达标（冷启动 ≤ 100 ms，中文 ≤ 0.1 ms/句）
- [ ] E2E 测试通过（三种语言 × 两个模型）
- [ ] 构建产物检查（只有一个 .wasm，字典在 public/）
- [ ] 文档完整（架构、README、Rust crate）
- [ ] Biome / TypeScript 无警告
- [ ] 内存验证通过（V8：offscreen worker 不泄漏）

---

## 附录：关键文件清单

### Rust 侧

```
crates/phonemize/
├── Cargo.toml              # 依赖：wasm-bindgen, lindera, zstd
├── build.rs                # 编译 espeak-ng C 源码
├── src/
│   ├── lib.rs              # wasm_bindgen 入口
│   ├── types.rs            # TS 映射类型
│   ├── dictionary.rs       # 字典加载与 zstd 解压
│   ├── vocab.rs            # vocab 闸门
│   ├── backends/           # TN, 分词, pinyin, espeak
│   └── frontends/          # 4 个前端组装
├── data/
│   ├── pinyin-table.json
│   ├── vocab-v1.txt
│   └── vocab-v11-zh.txt
└── tests/
    └── integration.rs
```

### TypeScript 侧

```
lib/models/
├── phonemize-rust.ts       # Rust wrapper
├── phonemize-wasm/         # wasm-pack 输出（构建产物）
└── phonemize-worker-protocol.ts

entrypoints/offscreen/
├── phonemize.worker.ts     # phonemize worker
├── kokoro.worker.ts        # kokoro worker（重命名自 local.worker.ts）
└── offscreen.ts            # 双 worker 协调

tests/
├── corpus/
│   └── phonemize-corpus.json
├── unit/models/
│   ├── phonemize-rust.test.ts
│   └── phonemize-rust-parity.test.ts
└── performance/
    └── phonemize-benchmark.test.ts
```

### 资源

```
public/
├── dictionaries/
│   ├── lindera-ipadic-ja.bin.zst    # 10 MB
│   └── espeak-data.tar.zst
└── ...

scripts/
├── build-phonemize-wasm.sh
├── download-lindera-dict.sh
├── bundle-espeak-data.sh
└── extract-test-corpus.mjs
```

---

