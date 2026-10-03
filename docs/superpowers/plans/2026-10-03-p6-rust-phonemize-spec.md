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
| 冷启动 | 字典就绪 ≤ 100 ms（不含模型加载），见 §4.2 |
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

### 1.4 lindera 加载实测（2026-10-03，V1）

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

**收益不在吞吐，在冷启动**：

| 场景 | 单 worker | 双 worker | 改善 |
|---|---|---|---|
| 每句（播放中） | phonemize 0.07 + 合成 500 = 500.07 ms | 重叠 → 500 ms | 0.07 ms（**0.014%**） |
| 冷启动 | 字典解压 ~100 ms **串在**模型 init 750 ms 之前 | `max(100, 750)` = 750 ms | **~100 ms（13%）** |

流水线省下的就是 phonemize 本身的时间，而它只占 0.014%——所以**这次拆分的理由是冷启动、解耦与弹性，不是流水线吞吐**。和 §0.2 一样，写清楚是为了防止将来被误读成性能收益。

**三条理由**：

1. **冷启动并行**：字典解压（CPU）与模型 init（GPU/网络）真正并行。这是每次播放都要付的成本（§4.1 的 30 秒回收）。
2. **解耦**：phonemize 是纯计算、无 I/O、无 GPU；模型是 GPU + 网络。失败模式、资源画像、生命周期都不同，同线程只是历史巧合。
3. **未来弹性**：若 phonemize 之后变重（音调预测、大量用户规则），双 worker 是**唯一**能重叠的结构。现在做是设计成本，将来做是重构成本。

**成本**：

- 多一份 wasm 实例化（~30 ms）与一份 worker 堆
- 每句多一次 postMessage 往返（几百字节，~0.1 ms）
- 错误传播复杂化：`WorkerLocalEngine` 现在是一个整体，`failAll` 之类的逻辑要跟着拆
- 调试时两个 worker 的 console 分在两个上下文

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
  /** Resolves once dictionaries are in wasm memory and `finish` succeeded. */
  readonly ready: Promise<void>;

  /**
   * Synchronous: the whole chain is inside wasm and nothing is I/O-bound.
   * This is a change from today's `Phonemizer`, which is `async` because
   * jieba / kuroshiro / espeak each own a promise.
   *
   * Throws `UnsupportedLanguageError` when `frontend` cannot speak `lang`.
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

**3. 和模型加载并行**

字典加载（~100 ms 量级）应与模型下载/初始化**并行**，不串行排在后面。并行的前提正是上面那条按需加载——反正不同语言。

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
| 4 | 字典**不编译进 wasm**（`include_bytes!` 会让实例化慢） | 设计推导 |
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

---

## 7. 待验证

| # | 问题 | 为什么重要 | 怎么验 |
|---|---|---|---|
| ~~V1~~ | ~~lindera 加载 IPADic 是否建索引、耗时多少~~ | **已验证 2026-10-03**（§1.4）：不建索引（9.6 ms / 45.3 MB）、能本地加载、体积 10 MB 反比现在小 | 已完成 |
| V2 | zstd 解压 50 MB 的实际耗时 | §4.2 的估算基于 1.5 GB/s，需实测 | 构造同规模的压缩块计时 |
| V3 | 单 wasm 的实际体积 | §2.3 估 ~3 MB，需要真实数字 | 编译后量 |
| V4 | OPFS 缓存是否必要 | 取决于 V1+V2 的结果 | 冷启动总时长实测 |
| V5 | v1.1-zh 的 `int8`(121.5 MB) 是否可用 | 决定两个模型能否同时在内存里（415 MB → 213 MB） | 加载并听一次，与 P5 §2.2 同法 |
| V6 | `ɚ` → `əɹ` 替换的听感 | 影响英文在 v1.1-zh 下的正确性 | 合成对比 |
| V7 | 双 worker 的冷启动实际省下多少 | §2.4 的收益表基于估算（字典解压 ~100 ms 与模型 init 750 ms 串行） | 量两个 worker 各自就绪的时间差 |

**V1 已通过**（§1.4）：lindera 不建索引、能本地加载、体积比现在小。开工的阻塞项已解除——剩下的 V2（zstd 实测）与 V7（双 worker 冷启动）都是动手后顺手能量的，不再是前提。

---

## 8. 附：本文件之外的相关记录

- P5 spec `docs/superpowers/plans/2026-10-01-p5-chinese-g2p-v11zh-spec.md` — 中文 G2P 的现状与两套音素集的完整分析
- `docs/phonemization-architecture.md` — 当前 JS 架构的说明（Rust 化后需重写）
- 2026-10-03 的两处实测：
  - 中文也曾漏掉全角数字（`numbersToHan` 只匹配 `\d`），已修 `4ec6dc2`
  - v1.0/v1.1-zh 的 vocab 差异明细（§1.3）
