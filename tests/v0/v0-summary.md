# V0 验证总结：`@piper-plus/g2p` 是否适合 TTS-NG 的 Kokoro

**日期**: 2026-10-03
**包**: `@piper-plus/g2p@0.4.2`（npm，MIT）
**对照**: `lib/models/phonemize/`（当前线上链路）
**样本**: 中/日/英各 10 条，共 30 条

---

## 判定：**失败（不通过）**

按 V0 清单的四条判定标准逐条核对：

| # | 标准 | 结果 | 判定 |
|---|---|---|---|
| 1 | 安装成功 | 332 KB，零依赖，1.1 s，0 漏洞 | ✅ **通过** |
| 2 | 输出格式与 JS 链相似或更优 | 中：输出汉字而非 IPA；日：无法初始化；英：5/10 与 espeak 不同且含硬错误 | ❌ **不通过** |
| 3 | Vocab 兼容或需适配字符 < 5% | 英：0%（v1.0）/ 1 字符（v1.1-zh）；**中：93.3% / 77.8%** | ❌ **不通过** |
| 4 | 性能达标（80% 指标满足） | 名义 4/5 = 80%；但其中 1 项测的是空操作，去水分后 3/5 = 60% | ❌ **不通过** |

命中清单中「失败」的定义两条：
- **「输出格式完全不兼容」** —— 中文路径原样返回输入文本，不产出任何音素。
- **「Vocab 差异巨大」** —— 中文输出 93.3% 的字符不在 v1.0 词表中。

**部分通过的范围**：仅英文。英文可用且词表干净，但质量低于 espeak（见 §2.3）。中、日两语均不可用，因此不构成「某个语言不理想，但其他语言可用」——是**三分之二不可用**。

---

## 0. 一句话根因

上游自己写明了这个包的定位：

```js
// piper-plus@0.7.0  package/src/index.js:935-937
// Languages that REQUIRE Rust WASM (no functional JS G2P fallback):
//   ja — needs jpreprocess (no JS equivalent)
//   zh — needs pinyin dictionary (JS G2P has no pinyin conversion)
const WASM_REQUIRED_LANGUAGES = new Set(["ja", "zh"]);
```

`@piper-plus/g2p` 是 `piper-plus` 的**降级回退层**，不是完整实现。上游对 ja/zh 一律改走它自带的 57 MB Rust wasm。我们把它当成「三语现成方案」来评估，从前提上就错位了。

---

## 1. 安装（✅ 通过）

| 项 | 值 |
|---|---|
| 新增包 | 1（**零运行时依赖**） |
| 体积 | **332 KB**（23 文件，283.8 KB 源码） |
| 许可 | MIT |
| 安装耗时 | 1.1 s |
| `require` 互操作 | 可用（`typeof` = `object`） |

两条更正：

1. **包内没有任何 wasm。** 清单第 4 项要测「wasm 加载时间」、决策摘要要验「wasm 大小 < 5 MB」——这两个指标都不适用。详见 `install-report.md` §3。
2. **决策摘要里的示例 API 不存在。** `const {g2p} = require('@piper-plus/g2p')` 实际抛 `TypeError: g2p is not a function`；真实入口是异步工厂 `G2P.create()`。

---

## 2. 输出格式对比（❌ 不通过）

原始数据：`piper-comparison.json`。三个语言逐一说明。

### 2.1 中文 —— 完全没有 G2P

| 输入 | 现有 JS 链 | piper |
|---|---|---|
| 你好 | `ni↓xau↓` | `你好` |
| 今天天气很好 | `ʨi→ntʰjɛ→ntʰjɛ→nʨʰi↘ xə↓n xau↓` | `今天天气很好` |
| 经营管理 | `ʨi→ŋi↗ŋ kwa↓nli↓` | `经营管理` |

10/10 全部如此：**piper 原样返回输入汉字**。

根因在源码里，`ChineseG2P._fallbackPhonemize` 的两个分支**都** push `char`：

```js
_fallbackPhonemize(text) {
  const tokens = [];
  for (const char of text) {
    if (this.phonemeIdMap && this.phonemeIdMap[char]) {
      tokens.push(char);   // 命中映射
    } else {
      tokens.push(char);   // 未命中
    }
  }
  ...
}
```

无论走哪个分支结果相同——这是个按字符切分的空操作。类内注释也写明了：*"Characters not found in the map are passed through as-is."*

**它没有拼音转换。** 这与上游注释完全一致。对 Kokoro 而言，汉字不是音素，这条路径产出的是**未预处理的文本**。

### 2.2 日语 —— 无法初始化

10/10 全部失败：

```
ja G2P.create failed: openjtalkModule is required. Pass it via
new JapaneseG2P({ openjtalkModule }) or initialize({ openjtalkModule }).
```

包不含 OpenJTalk wasm；项目里的 `wasm_open_jtalk@0.0.1` 是 Emscripten **CLI** 构建，只暴露 `allocateUTF8`/`UTF8ToString`，**没有** piper 需要的 `_openjtalk_initialize` / `_openjtalk_synthesis_labels`。词典还要运行时从 GitHub 下载约 50–55 MB（`DictLoader` 指向 `r9y9/open_jtalk` releases）。

对照：现有 JS 链 10/10 正常（`こんにちは` → `koɴniʨiha`）。

**这与 P6 spec §0.4「用户不需要为字典做任何下载动作」直接冲突。**

### 2.3 英文 —— 可用，但明显劣于 espeak

10 条中 **5 条与 espeak 逐字符相同**（`hello` `world` `test` `never` `hello world`），**5 条不同**。不同不是风格差异，而是硬错误：

| 输入 | espeak（现链） | piper | 问题 |
|---|---|---|---|
| `phoneme` | `fˈoʊniːm` | `fˈɑnˈɛmˈɛ` | 2 音节读成 3 个，且 3 个主重音 |
| `testing` | `tˈɛstɪŋ` | `tˈɛstˈɪŋ` | 一个词里 2 个主重音 |
| `The quick brown fox` | `bɹˈaʊn` | `bɹˈoʊn` | 元音错（aʊ→oʊ） |
| `synthesis` | `sˈɪnθəsˌɪs` | `sˈɪnθəsɪs` | 丢失次重音 |
| `text to speech` | `tə spˈiːtʃ` | `tuː spˈiːtʃ` | 虚词不弱化 |

客观量化（一个英文单词内出现 >1 个主重音 `ˈ` 在英语中不可能）：

| | 出现该缺陷的样本 |
|---|---|
| piper | **2 / 10** |
| espeak（现链） | **0 / 10** |

50 字长句同样：`advancing` → piper `ˈædvˈænkˈɪŋ`（一词 3 个主重音）。

**Kokoro v1.0 是用 espeak-ng 的 IPA 训练的**，所以与 espeak 的偏离就是分布外输入。英文这条路「能跑」但会退化音质——属于可用性存疑，而非等价替换。

---

## 3. Vocab 兼容性（❌ 不通过）

词表来源：两个模型 `tokenizer.json` 的 `model.vocab` 实测提取（已存 `tests/v0/kokoro-vocabs.json`，可复现）。数量与 spec §1.3 一致：**v1.0 = 115，v1.1-zh = 172**；v1.0 独有 9 个（`ꭧɚɥɻɤ↓→↗↘`），v1.1-zh 独有 66 个，共有 106 个——**与 spec 的记录逐字符吻合**。

原始数据：`vocab-check.json`。

### 3.1 中文：灾难性不兼容

| 对照 | 不在词表的字符数 | 占 piper 输出字符集 |
|---|---|---|
| vs v1.0（115） | **42** | **93.3%** |
| vs v1.1-zh（172） | **35** | **77.8%** |

piper 输出的是汉字（`中于今你句号合喜天好子字…`），它们本来就不是音素。v1.1-zh 里恰好有 21 个 PaddleSpeech 遗留汉字（`月压言十阳要阴应用又中穵外万王为文瓮我元云`），所以对 v1.1-zh 的缺失率「只有」77.8%——**那是巧合，不是兼容**。

远超 5% 阈值一个数量级。

### 3.2 英文：词表干净（这是唯一的好消息）

| 对照 | 缺失字符 | 占比 |
|---|---|---|
| vs v1.0（115） | **0** | **0%** |
| vs v1.1-zh（172） | **1**（`ɚ`） | 3.23% |

稳健性复核：把仓库自带英文文档切出 **400 句 / 21,630 字符**跑过 piper 英文路径：

```
missing from v1.0:     0   ""
missing from v1.1-zh:  1   "ɚ"
```

即 piper 的英文**从不产出 v1.0 词表外的字符**。唯一的 `ɚ` 正是 spec §1.3 已记录的那条已知冲突（`never` → `nˈɛvɚ`），现链同样存在——**不是 piper 引入的新问题**，按 spec 既定方案（`ɚ` → `əɹ`）处理即可。

### 3.3 日语：N/A

无输出，无从检查。

---

## 4. 性能（❌ 不通过——名义达标，去水分后不达标）

原始数据：`performance-results.json`（piper）与 `js-chain-performance.json`（现链，同机同进程重测）。

50 字符样本，20 次迭代，去掉两端 10% 取截尾均值。

### 4.1 piper

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 模块导入 | < 100 ms | **4.2 ms** | ✅ |
| 中文 | < 1 ms | **0.002 ms** | ⚠️ **空操作** |
| 日语 | < 1 ms | — | ❌ **BLOCKED** |
| 英文 | < 5 ms | **0.035 ms** | ✅ |
| 堆内存 | < 50 MB | **6.1 MB** | ✅ |

**中文那一行的 0.002 ms 是假的。** 它之所以「极快」，是因为它什么都不做——`mode: 'fallback'`，产出就是输入文本。测到的是「把字符串拆成字符」的耗时，不是 G2P。JSON 里已标 `meaningful: false` 并附注说明。

计入去水分后的统计：

```
名义     4/5 = 80%   ← 勉强够到清单的 80% 线
有意义   3/5 = 60%   ← 不达标
```

清单的 80% 线如果靠一个测空操作的指标凑过去，这条标准就失去了意义。**按 60% 判不通过。**

### 4.2 与现有 JS 链对照（同机重测）

现链的英文耗时**每次运行都会波动**，两次独立运行的截尾均值分别是 4.71 ms 与 3.83 ms（中位数 2.78 / 3.63 ms）。下表给区间，不给单点值：

| 语言 | piper | 现有 JS 链（两次运行区间） | 倍率 |
|---|---|---|---|
| 中文 | 0.002 ms（空操作） | 0.081 – 0.088 ms | 不可比 |
| 日语 | BLOCKED | 0.163 – 0.183 ms | — |
| 英文 | **0.035 ms** | **3.83 – 4.71 ms** | piper 快 **~110–130×** |

顺带验证了 spec §1.1 的既有测量（spec：中 0.07 / 日 0.16 / 英 3.28 ms；本次：中 0.08 / 日 0.16 / 英 3.8–4.7 ms）——同一量级，**说明本 V0 的量测方法是可信的**。

英文 ~100× 的速度优势是真实的，但代价就是 §2.3 的质量退化。而且如 spec §0.2 所述，**性能从来不是 P6 的理由**（预处理只占合成耗时的 0.009%–0.44%），所以这个优势在本次决策里几乎没有价值。

---

## 5. 对决策文档的更正

`docs/superpowers/plans/p6-decision-summary.md` 的核心前提需要修正：

| 文档宣称 | 实测 |
|---|---|
| 「开箱即用的三语方案，完全覆盖我们的需求」 | zh 无 G2P、ja 无法初始化 |
| 「WebAssembly 就绪，浏览器原生运行」 | **包内无 wasm**，纯 JS |
| 「日语基于 OpenJTalk，含完整韵律支持」 | 代码支持，但**包不含 wasm**，需外部模块 + ~55 MB 下载 |
| `g2p('hello','en')` | `TypeError: g2p is not a function` |
| 待验证「wasm 大小 < 5 MB」 | 不适用 |
| 「V0 验证通过的概率 70-80%」 | 实际不通过 |

同一文档「风险」表里低估的项：*vocab 不兼容* 被标为「中/高」——实际对中文是**必然发生且无法用适配层修复**（汉字不是音素，没有可映射的目标）。

---

## 6. 建议

1. **不要采用 `@piper-plus/g2p` 替换现有链路。** 它在中文上不产出音素，在日语上无法初始化；只有英文可用，且劣于现链。

2. **调研漏掉的那个包值得重新评估**：上游 `piper-plus@0.7.0` 自带 Rust wasm（`piper_plus_wasm_bg.wasm`，**57.3 MB**，**内置 NAIST-JDIC 词典**，零下载）。它的形态（单个 wasm、词典内置、Rust 编写、8 语言）**恰好命中 P6 spec 的目标**，比自建 Rust crate 更接近终点。代价是 57 MB 体积——这是个真实的产品权衡，但和「2–3 周自建」相比值得先花半天实测。**本次 V0 未对它做实测**，那是一个独立的验证任务。

3. **espeak GPL 的问题与本次结论无关，仍然独立存在。** 现链的英文路径继续依赖 `phonemizer`（espeak-ng wasm），这条许可风险不因 V0 失败而消失，也不因 V0 失败而加剧。

4. **若只想要英文**：piper 的英文路径词表 100% 干净、快 ~100×，但 50% 样本与 espeak 有差异且含硬错误。仅当接受音质退化时才考虑；考虑到 Kokoro v1.0 是按 espeak 训练的，**不建议**。

---

## 7. 交付物

| 文件 | 内容 |
|---|---|
| `tests/v0/install-report.md` | 安装报告（含 wasm 缺失、API 更正、上游自述） |
| `tests/v0/piper-comparison.json` | 30 条样本的双链输出逐条对照 |
| `tests/v0/vocab-check.json` | 双词表兼容性（含每个语言的实际字符集） |
| `tests/v0/performance-results.json` | 性能基准（含 `meaningful` 去水分标记） |
| `tests/v0/js-chain-performance.json` | 现链同机基线（用于对照，非清单要求） |
| `tests/v0/v0-summary.md` | 本文档 |
| `tests/v0/kokoro-vocabs.json` | 两个模型词表的实测提取（可复现的对照基准） |
| `tests/v0/comparison.test.ts` | 对比与基线量测脚本 |
| `tests/v0/performance-benchmark.mjs` | 性能基准脚本（清单要求，可独立运行） |
| `tests/v0/vitest.config.ts` | 独立 vitest 配置（主配置只收集 `tests/unit/**`） |
| `tests/v0/piper-plus-g2p.d.ts` | 本包的本地类型垫片（上游 `exports` 缺 `types` 条件，见下） |

### 附带发现：上游包的类型入口不可达

该包的 `package.json` 同时写了顶层 `"types": "types/index.d.ts"`（30 KB，内容准确）**和**一个不含 `types` 条件的 `exports` 映射：

```json
"exports": { ".": "./src/index.js", ... }
```

在 `moduleResolution: "Bundler"` 下 `exports` 优先，顶层 `types` 字段永远不会被读取，于是 TypeScript 报 **TS7016**、导入退化为 `any`。这是上游包的缺陷，不是本仓库的——正确修法在上游给 `exports` 加 `types` 条件。本 V0 用一个窄垫片（`piper-plus-g2p.d.ts`）绕开，而没有改项目的 `tsconfig.json`。

复现：

```bash
node tests/v0/performance-benchmark.mjs
npx vitest run --config tests/v0/vitest.config.ts
```

> 注：`kokoro-vocabs.json` 的两个词表提取自本机 `/tmp/kokoro-v10/tokenizer.json` 与
> `/tmp/kokoro-poc-models/tokenizer.json`。`/tmp` 重启即失效，但词表本身已固化进
> `tests/v0/kokoro-vocabs.json`，后续无需模型文件即可复核。
