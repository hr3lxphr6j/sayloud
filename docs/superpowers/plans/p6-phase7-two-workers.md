# P6 阶段 7 实施记录：双 worker 架构与 Rust 接线

**日期**: 2026-10-04
**范围**: 计划阶段 7（任务 7.1–7.4：phonemize worker、kokoro worker 去 phonemize、主线程协调、集成测试）
**状态**: **已实施**，全部检查通过（TS 1466 → 1513，`cargo test` 未受影响：本阶段没动 Rust）
**结论**: phonemize 与 ONNX 推理分居两个 worker，调度留在 offscreen 主线程；`RustPhonemizer` 首次进入生产路径，JS 链从产物里彻底消失。
计划里**三条前提与仓库实际不符**（见 §二），其中一条改变了本阶段的范围，一条改变了英文的接线方式。

计划原文：`2026-10-03-p6-rust-phonemize-spec.md` §阶段 7（2627 行起）。

---

## 一、结论

```
offscreen 主线程（main.ts → WorkerLocalEngine 调度）
  ├── phonemize worker   phonemize.worker.ts  → PhonemizeService → RustPhonemizer
  └── kokoro worker      kokoro.worker.ts      → KokoroEngine（只有 ONNX 会话）
```

一句话合成：

```
text
  → phonemize worker   text → IPA（Rust wasm + 字典）
  → kokoro worker      IPA → token 数（tokenizer）
  → 主线程             planPieces：不够小就切、切完再合并
  → kokoro worker      音素 → 音频（en: generate(text)；zh/ja: generate_from_ids）
```

`OnDeviceEngine` 接口没变，`LocalProvider`、`AudioWorker`、service worker 一行未改 —— 上层对这次拆分完全透明。

---

## 二、计划的三条前提是错的

### 1. `KokoroEngine` 并没有导入 `RustPhonemizer`（改变了本阶段的范围）

计划任务 7.2 写的是「`KokoroEngine` 不再导入 `RustPhonemizer`」「删除内部 phonemize 调用」。**实测：它从来没导入过。** 阶段 7 之前的真实情况是：

| 语言 | 今天出音素的地方 |
|---|---|
| zh / ja | JS 链（`ChinesePhonemizer` / `JapanesePhonemizer`）→ `generate_from_ids` |
| en | **`kokoro-js` 自己的 `generate()` 内部**（espeak + 它自己的数字/标点/字符替换） |

`RustPhonemizer` 全仓库只有测试在用。所以阶段 7 不只是「把 phonemize 搬出去」，它同时是**让 Rust 成为生产路径**的那次接线——而这正是阶段 8.4（删 JS 链）的前提。

### 2. 英文的接线方式需要单独决定（本阶段最重要的一个取舍）

英文有两条路，代价完全不同：

- **A. 走 `generate(text)`**：`kokoro-js` 用它自己的前端（espeak + 数字/标点/字符替换）出音素。**英文音频零变化**，代价是 kokoro worker 仍要收 `text`。
- **B. 走 `generate_from_ids(ipa)`**：英文音素由 Rust 产出。结构最干净（kokoro worker 只收 `phonemes`，也正是计划草图 `planPieces(phonemes, 512)` 的形状），但**英文音频会变**：Rust 英文是 CMU Dict，已知缺口是 `don't` → `dˈɑn'tˈiː`（撇号拆词）、OOV 词按字母拼读（`Kokoro` → K-O-K-O-R-O）。espeak 对这两种情况都处理得更好，而英文是默认语言、网页正文里缩写遍地。

**选了 A。** 理由：

1. 计划 §2.2 本来就写着 `en => Frontend::EnEspeak`——英文用 espeak 是计划的本意，只是计划打算把它编进 wasm，而阶段 4 换成了 CMU Dict。选 A 保住了本意。
2. 阶段 5 的对比文档自己写着「既有混合文本路径：保留 JS 实现」「未来统一：可考虑迁移」——即英文迁移被列为后续工作，不是阶段 7 的。
3. 本阶段的验收标准是「现有 API 不变」「三语言合成测试通过」，而英文是唯一会让**用户听得出来**变化的地方。仓库对音频质量有过教训（fp16 的 `brokenOn` 是靠人耳听出来的），不适合在这里顺手改掉。

代价写清楚：kokoro worker 因此仍要收 `text`，于是 `synthesize` 的每条 piece 是 `{ text, ipa }`（`lib/models/worker-protocol.ts` 的 `SynthesizePiece`），而不是只有 `phonemes`。英文迁移留给阶段 8.4，前置条件是先补上英文的缩写与 OOV。

### 3. 计划把协调放在 `lib/audio-worker.ts` / `offscreen.ts`，实际落点是 `lib/models/worker-engine.ts`

计划给的文件布局（`entrypoints/offscreen/offscreen.ts` + `lib/audio-worker.ts`）在本仓库不存在同名对应物：offscreen 的入口是 `main.ts`，而 `AudioWorker` 是主线程上**管 prefetch 队列与超时**的类，它连 `OnDeviceEngine` 都看不到（中间隔着 `LocalProvider`）。

真正持有两个 worker 的地方是 `WorkerLocalEngine`——它已经是 offscreen 主线程上唯一构造 worker 的类，也是唯一实现 `OnDeviceEngine` 的地方。把协调放进去，`OnDeviceEngine` 接口就**不需要改**，上层（`LocalProvider`、`AudioWorker`、service worker、缓存）全部透明。计划想要的「调度留在上层、两个 worker 不互连」这条原则也照旧成立：调度确实在主线程，只是落点换了个文件。

---

## 三、关键实现决定

### 1. `planPieces` 必须搬到主线程（这是拆分逼出来的）

切割需要两样东西：**token 数**（只有 kokoro worker 有 tokenizer）和**音素**（只有 phonemize worker 有字典）。**没有任何一个 worker 同时具备两者**，所以切割只能发生在能同时够到两个 worker 的地方——主线程。

`lib/models/audio.ts` 的 `planPieces` 一行没改：它本来就接一个 `measure` 回调，主线程把这个回调实现成「跨两个 worker 走一趟」即可。kokoro worker 因此多了一个 `count` 消息（`{type:'count', phonemes}` → `{type:'counted', tokens}`）。

一条句子因此有 3 次往返（phonemize / count / synthesize）而不是 1 次。每次是几百字节的结构化克隆，量级 0.1 ms；对照一次合成 500 ms，以及拆分换来的 phonemize 与推理重叠，这个代价是划算的。常见情况（一句话不超限）就是这 3 次，没有额外开销——切分只在超限时发生，和阶段 4 的行为一致。

### 2. 前端（frontend）来自**模型**，不是语言也不是文本

`PhonemizeOptions` 要 `frontend`，而它「跟着音色走」。`synthesize(text, voiceId, lang, signal)` 这个签名里没有模型，但 `load(model, tier, device)` 有。所以：

- `OnDeviceModel` 增加 `frontend: FrontendId`（`lib/models/registry.ts`）；
- `WorkerLocalEngine` 在 `load` 成功时记住它，之后每条句子的 `prepare`/`phonemize` 都用它。

`FrontendId` 因此被挪进一个**没有任何 import 的**新模块 `lib/models/frontend.ts`：registry 会被 side panel 导入，而 side panel 绝不能碰到 phonemizer 的 wasm。`import type` 今天会被擦除、`import` 不会，而这个区别在 import 那一行是看不出来的——一个自己没有依赖的模块才是结构性的保证。

### 3. 谁死了都算两个都死

计划的风险清单第 4 条（「worker 回收不同步」）在这里落成一条规则：**任一 worker 死，两个一起拆**。没有值得抢救的状态（字典和会话都可重建），留一半活着只会在下一句上以更难懂的方式失败。`WorkerClient` 的 `onDead` 回调把这件事交给引擎，`LocalProvider` 靠 `WORKER_DEAD` 这个名字重建整个引擎（原有逻辑）。

### 4. `WorkerClient` 泛型化，两个协议共用一套失败处理

两个 worker 的协议只有「有哪些消息」不同，而值得写对的失败处理（不重复 terminate、死后再发消息要拒绝、错误码变成 `error.name`）完全相同。所以它被抽成一个泛型类，回复校验函数作为参数传入。重复的只有那 6 行 `typeOf`/`isId`，它们被提到 `lib/models/worker-message.ts`——「什么算一个合法 id」是个决定，两份实现迟早会漂移，而漂移的表现是一个方向接受、另一个方向拒绝。

### 5. `prepare` 在首句懒加载，不是选音色时预取（**偏离计划 §2.4 的方案 C**）

计划倾向方案 C（选音色时就 `prepare`），前提「播放前就知道语言」也已确认。但**当前架构里没有这条通道**：offscreen 文档是随每条句子收到 `voiceId` 的，没有任何消息告诉它「音色变了」。加这条通道要动 offscreen 协议 + service worker + 面板，超出阶段 7 的范围。

所以实现是方案 A（首句触发），按 `(frontend, lang)` 缓存，缓存的是 **promise** 而不是结果——这样「prefetch」和「正在听的那句」不会各付一次 8 MB 解压。失败会从缓存里删掉，下一句重试。

代价：首句多付一次字典解压（zh 1.6 MB / ja 8.1 MB，都是扩展本地文件，不联网）；英文不需要字典，所以默认音色一分钱不花。**这一条也是「冷启动并行」那个收益目前拿不到的原因**：字典落在模型就绪之后，没有并行可言。

### 6. 拆出来一个 `PhonemizeService`

仓库的规矩是「埋在 worker 模块里的类没法测」。kokoro 侧有 `KokoroEngine`，phonemize 侧于是有 `PhonemizeService`：持有实例、`init` 幂等且失败可重试、`prepare`、`phonemize`、`dispose`。`phonemize.worker.ts` 只剩消息 switch 和「失败该报哪个 code」这一条判断，和 `kokoro.worker.ts` 对称。

---

## 四、测试

TS 1466 → **1513**（+47），新增 4 个测试文件、改写 2 个。

| 文件 | 覆盖 |
|---|---|
| `tests/unit/models/worker-engine.test.ts`（改写） | 两个 fake worker 驱动调度：顺序（init/load/count/synthesize）、前端来自模型、`(frontend,lang)` 只 prepare 一次（**并发**两次也算一次）、prepare 失败后重试、超限切分再合并、abort 发 cancel、任一 worker 死则两个都拆、第二次崩溃不重复 terminate、dispose 通知两个 worker |
| `tests/unit/models/worker-engine-phonemize.test.ts`（新） | **真 phonemizer** 接在协调器上：英文 `həlˈoʊ wˈɜːld`、日文 `keiei`、中文 `ni↓xau↓` 逐字到达 kokoro worker；切分后句子逐字保全；缺字典报 `model-load-failed` |
| `tests/unit/models/phonemize-service.test.ts`（新） | 真 wasm：`init` 只实例化一次、未 init / dispose 后拒绝、英文不需要字典、日/中 `prepare` 后可用、`kokoro-v11-zh` 说不了日语报 `unsupported-language` |
| `tests/unit/models/phonemize-worker-protocol.test.ts`（新） | 两个方向的校验 + `phonemizeErrorCode` 映射 |
| `tests/unit/models/worker-protocol.test.ts`（新） | 新消息的校验；**明确拒绝旧版 `synthesize`（带 `text` 不带 `pieces`）** |
| `tests/unit/models/kokoro-engine.test.ts`（改写） | 新签名：多 piece 拼接、英文走 `generate(text)`、zh/ja 走 `generate_from_ids`、cancel 后不再渲染后续 piece、`countTokens` 不带 truncation |

**「三语言合成测试」怎么算通过**：`worker-engine-phonemize.test.ts` 用真 wasm + 真字典，把 `PhonemizeService` 包成 worker 形状（只少一个 isolate），断言的是**到达 kokoro worker 的音素串**。断的是 Rust 测试钉过的同一个字符串（`en_g2p.rs` / `ja_pipeline.rs` / `zh_pipeline.rs`），所以这条链上任何一侧漂移都会红。

**没测到的**：`phonemize.worker.ts` 自己的消息 switch（十几行直线代码，与 `kokoro.worker.ts` 同样处理——逻辑在已测的类里）；两个 worker 的**真实线程边界**（vitest 里没有 Worker；这是 `pnpm test:e2e` 的地盘，而 e2e 构建用的是 `FakeLocalEngine`，所以真机验证仍然只有手动）。

---

## 五、体积：预期的大幅下降没有发生，原因值得记住

计划与阶段 6 的记录都预期「阶段 7 接线后体积显著下降（kuromoji 16.9 MB + jieba-wasm 3.8 MB 可去掉）」。实测：

| | 阶段 6 后 | 阶段 7 后 |
|---|---|---|
| 产物总计 | 56,983,122 B | **57,692,840 B（+0.71 MB）** |
| `assets/*.wasm` | ORT 21.6 MB + jieba 4.0 MB | ORT 21.6 MB + **phonemize 5.08 MB** |
| worker chunk | `local.worker` 2.5 MB | `kokoro.worker` 2.23 MB + `phonemize.worker` 12 KB |

**JS 链确实从产物里消失了**：整个 `.output` 里没有任何 `.js` 提到 `kuromoji` / `kuroshiro` / `jieba`（`tests/build/build-output.test.ts` 断言 wasm 恰好 2 个来钉住这件事）。

但体积没降，因为 **kuromoji 的 16.9 MB 和 jieba 的 1.6 MB 词表在 `public/` 里**——打包器照抄不误，跟有没有人 import 无关。去掉 jieba wasm（4.0 MB）与它的胶水，加上 phonemize wasm（5.08 MB），净 +0.71 MB。**那 16.9 MB 要等阶段 8 删目录，不是等 import 消失。** 已把这段写进 `build-output.test.ts` 的常量注释，免得下一个人再按错的前提推算。

---

## 六、状态

- TS **1513** 测试全绿（`pnpm test`）；`cargo test` 未跑——本阶段没动 Rust。
- `pnpm typecheck`、`pnpm lint`（biome 212 文件，0 warning）、`pnpm check:manifest` 全绿。
- `pnpm build` + `pnpm test:build` **12 条断言全绿**（worker 名、两个 worker 的 URL 都被 offscreen 指向、wasm 恰好 2 个、phonemize 只出现在 phonemize worker chunk、体积上下界）。
- `pnpm build:e2e` 通过。
- 体积上限 `MIN_BYTES`/`MAX_BYTES` 仍是 55–59 MB，实测 57.69 MB 在区间内；常量注释已按实测改写。

## 七、未做（留给阶段 8）

1. **英文迁移到 Rust**（`generate_from_ids`）。前置：英文的缩写拆词（`don't`）与 OOV 字母拼读要先解决，否则是听得出来的退步。见 §二.2。
2. **删 JS 链**（`lib/models/phonemize/`）与 `public/kuromoji-dict/`（16.9 MB）。目录一删，体积才会真的降。注意 `lib/models/phonemize/types.ts` 现在只是 `lib/models/language.ts` 的转发层，删的时候顺手把 `isChinese`/`isJapanese` 的引用改成新路径。
3. **结构化错误码**（计划 §8.3）。本阶段把字典失败折进 `model-load-failed`、把「音色说不了这门语言」折进 `voice-mismatch`（`phonemizeErrorCode`），够用但不够准；阶段 8 给它自己的 code。
4. **方案 C 的预取通道**（选音色即 `prepare`）。需要 offscreen 协议新增一条命令。
5. **真机验证**：两个 worker 的实际冷启动差、8 MB 字典在 offscreen worker 里的内存与 30 秒回收行为（计划 §7 的 V8 仍未验）。unit 测试证明不了 isolate 里的事。
6. **并发推理的表现未实测**：`prefetchConcurrency` 给 `local` 的是 2（`capabilities().concurrency = 1` 只被声明，没有任何地方强制），所以「1 条播放 + 2 条 prefetch」同时压到 kokoro worker 上是可能的——**这一点在阶段 7 之前就存在**，拆分没有改变请求数；但以前三条请求的 phonemize 都在 kokoro worker 的同一线程上，等于顺带串行化了起跑，现在音素化挪走了，三条推理可能真的同时开始。wasm/WebGPU 下 `numThreads = 1`，预期只是分摊吞吐而不是出错，但没量过。
7. **警告透传**：`phonemize` 的 `warnings`（拉丁段无读音）现在只 `console.warn`，没有进入 UI。

#tts-ng #p6 #worker #phase7 #decision #lesson
