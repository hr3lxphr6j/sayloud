# SayLoud P4: 端侧模型 Provider 与通用模型管理 Spec

**日期**: 2026-09-30
**前置条件**: P3 完成（设置存储、i18n、缓存管理、界面重设计、字幕悬浮窗）
**分支**: `p4-local-models`（从 `main` 切出）
**目标版本**: 0.4.0

---

## 0. 概述

### 0.1 目标

给 SayLoud 加**端侧语音**：模型在用户机器上跑，文字不出本机、不需要自建服务器、下好之后完全离线。

这一轮做三件事：

1. **通用的模型管理器**——注册表驱动的模型列表，管理每个模型的下载源、下载、删除、进度、占用和许可。**结构上支持多个模型族，但只接 Kokoro 一个引擎。**
2. **模型标签页**——全局设置新增第三个标签页，管模型的下载和删除。
3. **中文与英文两条音素化路径**——英文走 `kokoro-js` 官方路径，
   中文走自建管线（§3.11）。**只覆盖 zh/en**，其余语言 P4 不做。

**性能预期（实测，见 §3.7.1）**：在**有 WebGPU 的机器**上，
`fp16`/`fp32` 档的合成 **RTF ≈ 0.15–0.18（比实时快 5–6 倍）**，
从点播放到出声约 **1–2 秒**（前提：模型已在设置里下好）。
**在无 WebGPU 的机器**上会退回 WASM（RTF ≈ 1.1–1.45），那里需要靠预取与缓存。

> ⚠️ 早期版本本节写的是「RTF 1.45、要等十几秒」，那是用 `q8` 档测的——
> q8 在 WebGPU 上完全无效。详见 §3.7.1 与 §3.12.1。

### 0.2 不包含

- ❌ 第二个模型族的引擎实现（Kitten / Piper / MMS 见 §10，结构已留好）
- ❌ **日 / 西 / 法 / 印地 / 意 / 葡的 18 个音色**（需要各自的 G2P，见 §3.11.6）
- ❌ 词级高亮（Kokoro 不给时间戳，见 §3.12）
- ❌ 声音克隆、微调、多说话人对话
- ❌ 云端 provider 的任何改动（P2 已完成）

---

## 1. 调研

### 1.1 端侧 TTS 模型全景

实测（HF API + npm registry，2026-09-30）：

| 模型 | 参数 | 体积 | 中文 | 英文 | 许可 | 运行时 | 形态 |
|---|---|---|---|---|---|---|---|
| **Kokoro 82M** | 82M | 92–325MB | ⚠️ 8 音色，需自建音素化 | ✅ 28 音色 | Apache-2.0 | kokoro-js + 自写中文管线 | A |
| Kitten TTS nano 0.8 | 15M | **24MB** | ❌ | ✅ 8 音色 | Apache-2.0 | 自写（StyleTTS2） | A |
| Piper zh_CN huayan x_low | — | **20.6MB** | ✅ | ✅ | MIT 系 | piper-tts-web（espeak） | B |
| Piper zh_CN huayan medium | — | 63.2MB | ✅ | ✅ | MIT 系 | piper-tts-web（espeak） | B |
| MMS-TTS (VITS) | — | 38.4MB(q8) | **❌ 无中文** | ✅ | **CC-BY-NC-4.0** ⚠️ | transformers.js **原生** | B |
| SpeechT5 | — | 342.8MB+ | ❌ | ✅ | MIT | transformers.js **原生** | A |
| Supertonic TTS | — | 262MB（3 段） | ? | ? | openrail | 自写 | C |
| Hojo TTS Light 40M | 40M | 213MB（3 段） | ? | ? | Apache-2.0 | 自写 | C |
| Qwen3-TTS 0.6B / Ming-omni 0.5B | 0.5B+ | 600MB+ | ? | ? | 各种 | transformers.js 生成式 + codec | C |

三种**形态**决定了模型管理器的抽象：

- **A：一个模型 + N 个音色向量**（Kokoro、Kitten、SpeechT5）——一次下载，多音色。有「档位」概念。
- **B：一个音色/语言一个模型**（Piper、MMS）——目录式，多个小下载。没有档位，有「音色 = 模型」。
- **C：多组件 / LLM 基座**（Supertonic、Hojo、Qwen3-TTS）——集成成本高一个量级，本轮不考虑。

**结论**：形态 A 和 B 的**文件管理**是同构的（都是「一组文件 + 体积 + 许可 + 语言」），差别只在「文件集怎么分组」。所以管理器可以通用，但 UI 要能表达两种分组方式（档位 / 音色目录）。P4 只实现形态 A（Kokoro）。

### 1.1.1 ⚠️ Kokoro 的「中文 ✅」需要修正（2026-09-30 实测）

上表的「中文 8 音色」指的是**仓库里有 8 个中文音色文件**，这没错（§1.3 已核）。
但**标准运行时路径出不了中文**，四条独立证据：

1. **`kokoro-js@1.2.1` 的 `VOICES` 元数据只有 28 个音色，全是英文**（`en-us` / `en-gb`）。
   实测 `generate()` 传 `zf_xiaobei` 直接抛：
   `Voice "zf_xiaobei" not found. Should be one of: af_heart, ...`。
   三个 dist 文件（`kokoro.js` / `kokoro.web.js` / `kokoro.cjs`）**都不含** `zf_xiaobei`。
2. **依赖的 `phonemizer@1.2.1` 是英文专用的 espeak-ng 构建**。
   实测 `phonemize('你好世界', 'cmn')` 抛
   `Invalid language identifier: "cmn". Should be one of: en, en-029, en-gb, ...`
   ——语言列表来自 wasm 模块本身，即该构建**真的只有英文语音数据**。
3. **官方模型卡声明英文专用**：`onnx-community/Kokoro-82M-v1.0-ONNX` 的 frontmatter 是 `language: [en]`。
4. **参考实现 `catm` 也是英文专用**（MIT、已上架 CWS）：`VoiceId` 只有 4 个英文音色，
   且 `const lang = voice.charAt(0) === "a" ? "en-us" : "en"` —— 非 `a` 开头也当英文处理。

**但中文是可行的**，且已实测打通（§3.11）。关键证据：**tokenizer 词表里有声调箭头 `↓→↗↘`**，
这正是 misaki（Kokoro 官方 G2P）编码声调用的符号；词表里**没有任何数字**——
因为声调用箭头而不是数字。词表同时包含中文 IPA 全部字符（`ʦ ʨ ꭧ ɕ ʂ ɻ ɥ ɤ ɚ` 等）。

**结论**：P4 分两条路 ——
- **英文 28 音色**：走 `kokoro-js` 官方 `generate()`，音质有保证。
- **中文 8 音色**：绕道 `generate_from_ids()`（它**不做音色校验**）+ 自建音素化（§3.11）。

其余 18 个音色（日/西/法/印地/意/葡，共 18 个）需要各自的 G2P，**P4 不做**，
注册表按语言过滤掉，UI 不展示。

#### 1.1.2 替代方案已排除（2026-09-30 试听实测）

曾认真评估过用 Piper 替掉 Kokoro（它快 12 倍、小 29MB）。**用户试听后否决**：

| 模型 | RTF | 声调 | 用户试听结论 |
|---|---|---|---|
| **Kokoro 82M · zf_xiaoxiao** | 1.46 | ✅ | **「只有这个最好的」** ✅ 采用 |
| Piper huayan medium | 0.13 | ✅ | 「能听懂，但发音有点怪」 |
| Piper chaowen medium | 0.12 | ✅ | **「完全无法使用」** |
| Piper xiao_ya medium | 0.12 | ✅ | **「完全无法使用」** |
| Piper huayan x_low | 0.09 | ❌ 丢失 | （无声调，实测妈/骂音素 id 完全相同） |

**结论**：RTF 0.12 的速度优势在「无法使用」面前没有意义。**中文用 Kokoro。**
实测数据留在 `2026-09-30-p4-risk-verification.md`，不再重开。

### 1.2 依赖内部的三个硬事实

读 `kokoro-js@1.2.1` 的打包产物确认，直接决定实现方式：

> **验证状态（2026-09-30）**：以下三条均已用真机/真依赖实测确认，
> 结论见 `docs/superpowers/plans/2026-09-30-p4-risk-verification.md`（V18/V19）。

**(a) transformers.js 的路径模板可配**

```js
remoteHost: "https://huggingface.co/",
remotePathTemplate: "{model}/resolve/{revision}/",
allowRemoteModels: !0, useBrowserCache: true,
```

拼接：`remoteHost + remotePathTemplate.replaceAll('{model}',…).replaceAll('{revision}',…) + file`。切源只需改这两个 env。

**(b) kokoro-js 的音色 URL 硬编码到 huggingface.co，不跟随 `env.remoteHost`**

```js
const url = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`;
try { const c = await caches.open("kokoro-voices"); const hit = await c.match(url); if (hit) return await hit.arrayBuffer(); } catch {}
const r = await fetch(url); … cache.put(url, …)
```

**后果**：模型从 ModelScope 下好了，第一个音色仍会请求 HF，国内直接失败。必须用 fetch patch 兜住（§3.5）。

**实测确认（V19）**：原文如上，缓存桶 `kokoro-voices`，key 就是那个硬编码的 HF URL。
另外：**音色是 `generate()` 时才加载的，模块顶层不发请求**，所以 fetch patch 的时机不是问题。
`generate_from_ids()` 不校验音色，可以直接用任意音色 id。

**(c) dtype 到文件名的映射**

```js
DATA_TYPES = { auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16 }
suffix: { fp32:"", fp16:"_fp16", int8:"_int8", uint8:"_uint8", q8:"_quantized", q4:"_q4", q4f16:"_q4f16", bnb4:"_bnb4" }
DEFAULT_DEVICE_DTYPE_MAPPING = { wasm: "q8" }
```

**`q8f16` 不是合法 dtype**，86MB 的 `model_q8f16.onnx` 选不到。

**实测（V18）各 dtype 实际请求的文件**：

| dtype | 请求的文件 | 仓库里存在？ |
|---|---|---|
| `q8` | `onnx/model_quantized.onnx` | ✅ 92.36 MB |
| `fp16` | `onnx/model_fp16.onnx` | ✅ 163.23 MB |
| `fp32` | `onnx/model.onnx` | ✅ 325.53 MB |
| `q4` | `onnx/model_q4.onnx` | ✅ 305.22 MB（**比 q8 还大**） |
| `q4f16` | `onnx/model_q4f16.onnx` | ✅ 154.59 MB（**比 q8 还大**） |
| `int8` | `onnx/model_int8.onnx` | ❌ 不存在，会 404 |
| `bnb4` | `onnx/model_bnb4.onnx` | ❌ 不存在，会 404 |

**所以可用档只有 `q8`(92.4MB) / `fp16`(163.2MB) / `fp32`(325.5MB)**。
`q4` / `q4f16` 虽然文件存在，但体积比 q8 大，作为「更小的档位」毫无意义，排除。
（仓库里还有个 86MB 的 `model_q8f16.onnx`，但没有任何合法 dtype 能选到它。）

### 1.3 下载源实测

**注意**：测试机走代理（所有域名解析到 `198.18.0.0/15`，fake-IP 模式），所以**本机测出的「国内可达性」不代表真实国内环境**。下表区分服务端事实与可达性。

| 源 | 结果 | 证据 |
|---|---|---|
| `huggingface.co` | 可用但本机间歇失败 | 3 次连测 `000`（TLS handshake 失败）、`307`、`307` |
| `hf-mirror.com` | **已失效** | 文件请求和 API 请求都 `308 location: https://huggingface.co/...`（`server: Caddy`），带浏览器 UA 相同 |
| `cdn-lfs.huggingface.co` | 不可达 | `code=000` |
| **`modelscope.cn`** | **完整镜像，推荐** | 见下 |

ModelScope 的 `onnx-community/Kokoro-82M-v1.0-ONNX` 是完整镜像，71 个条目，字节数与 HF 一致：8 个量化档全在、54 个音色 `.bin` 全在（加 1 个遗留的 `af.bin`）、`config.json`/`tokenizer.json`/`tokenizer_config.json` 全在，**不需要 token**。

URL 结构与 HF 只差前缀和分支名：`https://modelscope.cn/models/{model}/resolve/master/{file}`。实测 Range：

```
config.json          → 200 (44B)
model_quantized.onnx → 206 → cdn-lfs-cn-1.modelscope.cn/…  （国内 CDN）
voices/af_heart.bin  → 206 → cdn-lfs-cn-1.modelscope.cn/…
tokenizer.json       → 200 (201B)
```

CDN 稳定性：3 次连测全 `206`，0.40–0.42s。

**结论**：`hf-mirror.com` 这条常见方案在这里是错的，排除；ModelScope 作国内源。

**文件清单与体积的权威来源**（写档位 `bytes` 时用这个，不要手量）：

```
https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Root={dir}
```

返回 `Data.Files[].{Name, Size}`。`Root` 留空给根目录，`Root=onnx` 给档位文件，
`Root=voices` 给音色。HF 的等价接口是 `https://huggingface.co/api/models/{repo}/tree/main/{dir}`。

实测该仓库结构（2026-09-30）：

- **根目录只有 4 个必需文件**：`config.json`(44B)、`tokenizer.json`(3497B)、
  `tokenizer_config.json`(113B)，加 `onnx/`、`voices/` 两个目录。
- `onnx/` 下 8 个 `.onnx` 文件（体积见 §1.2 表）。
- `voices/` 下 **55 个条目**（**54 个音色** + 1 个遗留的合并文件 `af.bin`），合计 28.7MB。
  ⚠️ **算术要小心**：每个音色 522,240 字节，54 × 522,240 = 28,200,960 = **28.2MB**。
  28.7MB 是**55 个条目**的总和，包含了那个不是音色的 `af.bin`。
  UI 文案写「约 29MB」是向上取整，但代码里的常量要用 28.2MB。

### 1.4 体积代价

**只有 21.0MB 的 wasm 进包。** transformers.js 包里只带一个
`dist/ort-wasm-simd-threaded.jsep.wasm`（21,596,019 字节 = 21.0MB），
它**同时覆盖 WebGPU 和 WASM 两个执行后端**，不需要第二个文件。

**实测各包解包体积**（不是估计值）：

| 包 | 体积 | 说明 |
|---|---|---|
| `onnxruntime-web` 的 jsep wasm | **21.0 MB** | 单个文件，两个后端共用 |
| `@huggingface/transformers`（web 构建） | 1.78 MB | |
| `kokoro-js` | **12 KB** | 打包器实际选中的是 `dist/kokoro.js`，**不是** 2.0MB 的 `kokoro.web.js` |
| `phonemizer` | 1.32 MB | wasm 内联；**英文专用** |
| `pinyin-pro` | 1.1 MB | 中文路径需要 |
| misaki 音节表（生成物） | 7 KB | 中文路径需要 |
| **包体增量合计** | **约 25–26 MB** | 含中文路径 |

扩展包从 ~0.6MB 变成 **~26MB**。模型权重（92MB）不进包，运行时下载。

**关键陷阱**：打包器解析 `kokoro-js` 时会选中 `dist/kokoro.js`（12KB 的 Node 构建），
因为它 `package.json` 的 `exports` **只有 `node` 和 `default`，没有 `browser` 字段**。
该文件顶层 `import s from "path"; import i from "fs/promises"` ——
靠 `"browser": { "path": false, "fs/promises": false }` 把这两个模块 stub 成空对象。
空对象没有 `readFile`，于是 `if (i && Object.hasOwn(i, "readFile"))` 为假，走网络分支。

**Vite 是否遵守这个 `browser` 字段必须在 T3 实测确认**（V21，见 §6）——
若不遵守，需要显式 alias 到 stub。

（`kokoro-js` npm 包解包 30.4MB，其中约 28.7MB 是 54 个音色 `.bin`。
运行时走网络 + `kokoro-voices` 缓存，**不该打进包**——构建时要确认 Vite 没把它们当 asset 收进去。）

---

## 2. 评估

**风险已实测（2026-09-30）**：V15/V17/V18/V19 **全部通过**，V20 得到具体数字。
完整记录见 `docs/superpowers/plans/2026-09-30-p4-risk-verification.md`。

| 项 | 工作量 | 风险 |
|---|---|---|
| 通用模型注册表 + 管理器（下载/删除/进度/占用/源） | 1 天 | 低 |
| canonical 缓存键 + fetch patch（含音色硬编码） | 1 天 | **低**（V18/V19 已验，模板逐字符正确） |
| Kokoro 引擎（worker、ORT 配置、WAV、510 切分、音色表） | 1 天 | **低**（V15/V17 已验：offscreen 有 WebGPU，ORT 无需 COOP/COEP） |
| **中文音素化管线**（pinyin-pro + 音节表 + 绕道 `generate_from_ids`） | 1 天 | **中**：管线已实测打通，但**中文自然度未经试听验证** |
| 模型标签页 UI + provider 接线 | 1 天 | 低 |
| 打包（CSP、wasm 进包、体积断言） | 0.5 天 | **中**：Vite 是否遵守 `browser` 字段未验（V21） |
| 测试 + 手动验收 | 0.5 天 | 中：CI 下不了 92MB，必须靠可注入假引擎 |

合计约 **5–6 天**。

**性能已实测并修正**：在有 WebGPU 的机器上，`fp16`/`fp32` + WebGPU 的
合成 **RTF ≈ 0.15–0.18（比实时快 5–6 倍）**，从点播放到出声约 1–2 秒
（模型已在设置里下好的前提下）。无 WebGPU 的机器退回 WASM（RTF 1.1–1.45）。

**曾经的误判**：早期用 `q8` 档测得 RTF 1.45、并据此写了
「预取是必需品」「要等十几秒」——那两条结论**已经推翻**（§3.7.1、§3.12.1）。
教训：**dtype 与执行后端是耦合的，测其中一个而固定另一个会得出错误结论。**

---

## 3. 架构

### 3.1 通用模型注册表

`lib/models/registry.ts`——管理器唯一的事实来源。它**不含任何运行时依赖**（不 import ORT），所以侧边栏和 worker 都能用。

```ts
export type OnDeviceFamily = 'kokoro' | 'kitten' | 'piper' | 'vits';

/** 形态决定文件怎么分组，也决定 UI 怎么呈现。 */
export type ModelShape = 'model+voices' | 'per-voice' | 'multi-component';

/** 形态 A 的分组单位；形态 B 用 `files` 直接给。 */
export interface ModelTier {
  readonly id: string;          // 'q8' | 'fp16' | 'fp32'（族内唯一）
  readonly labelKey: MessageKey; // i18n
  /** 传给引擎的族内参数（Kokoro = transformers.js dtype）。 */
  readonly engineArg: string;
  /** 相对 model 根的路径。 */
  readonly files: readonly string[];
  readonly bytes: number;
  /**
   * 这个档在哪类设备上是**首选**（§3.7.2）。
   * 缺省 = 永不被自动选中，只能手动选。
   */
  readonly preferredFor?: readonly DeviceClass[];
}

/**
 * 设备能力分成三档。这个分类是**实测结论**（§3.7.1）：
 * - `webgpu-f16`：WebGPU + `shader-f16`，fp16 跑得动且体积只有 fp32 一半
 * - `webgpu`：有 WebGPU 但无 `shader-f16`，只能 fp32
 * - `wasm`：无 WebGPU，GPU 用不上，此时 **q8 的体积优势无代价**
 */
export type DeviceClass = 'webgpu-f16' | 'webgpu' | 'wasm';

export interface DeviceCaps {
  readonly webgpu: boolean;
  readonly shaderF16: boolean;
}

/**
 * 给定设备能力，这个模型应该用哪个档。
 *
 * **纯函数**：只看 `caps`，不看哪个档已下载——「推荐哪个」与
 * 「哪个已下好」是两件事，后者由 store 回答。UI 拿两者组合出
 * 「推荐」徽章与「去下载」按钮。
 *
 * 找不到匹配的 `preferredFor` 时退回第一个档（保证总有结果）。
 */
export function preferredTier(
  model: OnDeviceModel,
  caps: DeviceCaps,
): ModelTier | undefined {
  const tiers = model.tiers;
  if (!tiers || tiers.length === 0) return undefined;
  const cls: DeviceClass = !caps.webgpu ? 'wasm' : caps.shaderF16 ? 'webgpu-f16' : 'webgpu';
  return tiers.find((t) => t.preferredFor?.includes(cls)) ?? tiers[0];
}

export interface OnDeviceModel {
  readonly id: string;             // 'kokoro-82m'
  readonly family: OnDeviceFamily;
  readonly shape: ModelShape;
  readonly labelKey: MessageKey;
  /** HF / ModelScope 上的 repo id。两边同命名空间，所以是同一个字符串。 */
  readonly repo: string;
  readonly license: { readonly name: string; readonly url: string };
  /** BCP-47，用于 UI 展示与音色默认选择。 */
  readonly languages: readonly string[];
  readonly voiceCount: number;
  /** 形态 A 用 tiers；形态 B/C 用 files。 */
  readonly tiers?: readonly ModelTier[];
  readonly files?: readonly string[];
  /** 音色文件名模板（形态 A）。 */
  readonly voiceFile?: (voiceId: string) => string;
}
```

P4 的注册表**只有 Kokoro 一项**（不放假条目，见 §4.4）：

```ts
export const MODELS: readonly OnDeviceModel[] = [KOKORO_82M];
export function modelById(id: string): OnDeviceModel | undefined;
```

`KOKORO_82M`：

```ts
{
  id: 'kokoro-82m',
  family: 'kokoro',
  shape: 'model+voices',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  // 只列 P4 真正能出的语言：英文走官方路径，中文走自建管线。
  // 日/西/法/印地/意/葡的 18 个音色需要各自的 G2P，P4 不做，不写在这里。
  languages: ['en-US','en-GB','zh-CN'],
  voiceCount: 36,          // 28 英文 + 8 中文
  tiers: [
    // 无 WebGPU 的设备 → q8 最小，反正 GPU 用不上。
    { id:'q8',   labelKey:'model.tier.light',    engineArg:'q8',   bytes: 92_360_000,
      preferredFor: ['wasm'],
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx'] },
    // 有 shader-f16 的 WebGPU → fp16 最优（实测 RTF 0.15，体积只有 fp32 一半）。
    { id:'fp16', labelKey:'model.tier.standard', engineArg:'fp16', bytes:163_230_000,
      preferredFor: ['webgpu-f16'],
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model_fp16.onnx'] },
    // 有 WebGPU 但无 f16 → fp32。
    { id:'fp32', labelKey:'model.tier.hifi',     engineArg:'fp32', bytes:325_530_000,
      preferredFor: ['webgpu'],
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model.onnx'] },
  ],
  voiceFile: (id) => `voices/${id}.bin`,
}
```

注意 `files` 只含**共享文件 + 该档的 onnx**；音色文件不属于任何档位，
由音色列表单独管（§3.6）。三个档的 `config.json` / `tokenizer*.json` 是同一份，
缓存 key 相同，**换档不会重下它们**。

`bytes` 用**实测值写死**（不用 `Content-Length` 探测），因为 UI 要在下载**前**显示体积。
数值来源：ModelScope 文件列表 API（§1.3），HF 的等价接口可交叉核对。
**不要手量**——写档位时直接读那个 API。

### 3.2 provider 身份：`local` + `modelId`

**不叫 `kokoro-local`**。加模型族应该是改注册表，而不是加 provider、改 provider 列表 UI、改 i18n 键。

```ts
// lib/providers/types.ts
export type ModelHostId = 'auto' | 'huggingface' | 'modelscope' | 'custom';

export interface LocalConfig {
  provider: 'local';
  /** 用哪个端侧模型。默认 'kokoro-82m'。 */
  modelId?: string;
  /** 族内档位 id。默认该模型的第一个档。 */
  tier?: string;
  /**
   * 权重下载源。
   *
   * ⚠️ **实际由 `ModelStore` 持有**（`sayloud:model-source`，见 §3.4）——
   * 这里保留只是为了让人看到「源是本地 provider 关心的事」。
   * **T4 不要在这里写第二份**：模型 tab 写 store，provider 从 store 读。
   * 两个地方各存一份，就会出现「设置里改了但播放还在用旧的」。
   */
  host?: ModelHostId;            // 默认 'auto'
  /** 仅当 host === 'custom'。到 repo 路径为止。 */
  customHostUrl?: string;
  /** 'auto' 时有 WebGPU 就用，否则 WASM。 */
  device?: 'auto' | 'webgpu' | 'wasm';
  /** BCP-47 提示，同 BrowserConfig.lang。 */
  lang?: string;
}
```

- `ProviderId` 加 `'local'`，`ProviderConfigMap` 加一项，`registry.ts` 加 `'local': new LocalProvider()`。
- 标签：`本地语音（浏览器内运行）`；摘要：`浏览器内运行，文字不出本机。首次使用需要下载模型。`
- `listVoices()` 按 `modelId` 分派到该族的音色表。
- `capabilities()` 按 `modelId` 查注册表（形态 A 的 `timings` 都是 `'none'`）。
- **`lang` 是必须的，不是可选的**：中文与英文的**音素化路径完全不同**（§3.11），
  引擎必须知道用哪条。默认值按音色 id 的前缀推导（`af`/`am`/`bf`/`bm` → 英文，
  `zf`/`zm` → 中文），而不是让用户手填。

### 3.3 运行位置

**合成在 offscreen 文档 + 它内部的 Web Worker 里跑**，不在侧边栏：

- 音频播放本来就在 offscreen（P2 架构），合成放同一上下文省掉跨上下文传音频。
- 侧边栏可能被关掉，不能让它成为播放的前提。
- ONNX 推理绝不能跑在 offscreen 文档主线程上——会阻塞 TimelinePlayer 的播放/暂停/定时器。必须用嵌套 Worker。

新增 `entrypoints/offscreen/local.worker.ts`（WXT 的 worker 打包方式实现时确认产物里有独立 chunk）。

**设备选择**：`device: 'auto'` → `'gpu' in navigator` 为真则 `webgpu`，否则 `wasm`。
实测到的设备要能上报到 UI（§4.2 的「运行设备」）。

**V15 已实测通过（2026-09-30）**：offscreen 文档里有**完整可用的 WebGPU**：

```json
{
  "hasNavigatorGpu": "object",
  "adapterAvailable": true,
  "adapterInfo": { "vendor": "apple", "architecture": "metal-3" },
  "deviceCreated": true,
  "hasShaderF16": true,
  "crossOriginIsolated": false,
  "hardwareConcurrency": 10
}
```

不需要任何特殊启动参数。

**但 V20 发现 WebGPU 与 WASM 的合成速度几乎一样**（RTF 1.44 vs 1.45）：
ORT 日志显示 WebGPU 确实是首选 EP，但「Some nodes were not assigned to the
expected execution providers」——部分算子回退到 CPU，把差距抹平了。
**在低端机器上 WASM 会明显更慢**，所以保留设备选择仍然有意义，
但不要向用户承诺「WebGPU 会快很多」。

### 3.4 下载源（用户可选）

| 值 | 行为 |
|---|---|
| `auto`（默认） | 先看 `sayloud:model-host-last-good`；没有记录就**并发探测**两个源的 `config.json`（超时 5s），用先成功的；都失败报 `model-host-unreachable`，提示手动选源 |

**探测语义要写准**：「用先成功的」不等于「用先返回的」——一个源**快速失败**
（比如立刻 403）不能算赢。实现用 `Promise.any` 加每次尝试的超时，
只有**成功**才能胜出。
| `huggingface` | 只用 `https://huggingface.co/`，分支 `main` |
| `modelscope` | 只用 `https://modelscope.cn/models/`，分支 `master` |
| `custom` | 用 `customHostUrl`，`{base}/{repo}/resolve/{revision}/{file}`，分支默认 `main` |

- 成功后把源写进 `sayloud:model-host-last-good`，下次 `auto` 直接用，不再探测。
- **用户选的源存在 `sayloud:model-source`**（`{host, customHostUrl?}`），与
  `last-good` 分开：前者是「用户想要什么」，后者是「上次什么能用」。
  **T4 必须通过 `ModelStore.setSource` 写它，不要自己再存一份**；
  provider 侧也要从 store 读解析后的源，而不是从 `LocalConfig` 里读一份副本。
  （§3.2 的 `LocalConfig.host` / `customHostUrl` 与此重复——T4 接线时
  以 store 为准，那两个字段要么删掉要么只作缓存。）
- 切到别的源再切回 `custom` 时，**保留用户填过的镜像 URL**（不要清空）。
- `custom` 的 URL 必须能解析成绝对 https URL，否则视为无效。
- **手动指定的源失败时不自动切换**，只在错误里给「改用另一个源重试」按钮——用户既然指定了，就不该偷偷换。
- `custom` 的用途：自建镜像、公司内网、用户自己放到 OSS。

### 3.5 canonical 缓存键 + fetch patch

**问题**：transformers.js 的浏览器缓存以**请求 URL** 作 key。换源 = 换 URL = 重下 92MB。

**方案**：把 `env.remoteHost` 固定成一个永不解析的规范主机，用 fetch patch 解析到真实源。

```ts
// .invalid 是 RFC 2606 保留域，永不解析。
const CANONICAL_HOST = 'https://model-cache.sayloud.invalid/';

env.remoteHost = CANONICAL_HOST;
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.useBrowserCache = true;    // 缓存 key 天然与源无关
```

worker 里安装 fetch patch，**两件事**：

```ts
// 1) 规范主机 → 真实源（含 auto 结果；仅 auto 时失败换另一个源重试一次）
// 2) kokoro-js 硬编码的 HF 音色 URL → 真实源（§1.2(b)）
globalThis.fetch = async (input, init) => {
  const url = toUrl(input);

  if (url.startsWith(CANONICAL_HOST)) {
    const real = resolveToRealHost(url, host);   // 保 {repo}/resolve/{rev}/{file} 之后的部分
    return original(real, init);
  }

  // 音色：key 是硬编码的 HF URL，所以缓存天然与源无关；
  // 只在未命中时把请求改写到真实源。
  if (isKokoroVoiceUrl(url)) {
    const real = rewriteVoiceUrl(url, host);
    return original(real, init);
  }

  return original(input, init);
};
```

- `resolveToRealHost` 里对 ModelScope 把 `main` 换成 `master`；规范键**永远用 `main`**，这样键与源无关。
- patch 必须在 transformers.js 第一次 `fetch` **之前**装好（worker 顶层，import 之前）。
- 效果：
  - **换源不重新下载**（模型和音色都成立）。
  - transformers.js 自己的 `useBrowserCache` 直接可用，不需要手写缓存层。
  - 删除/统计按 `transformers-cache` 里规范 URL 前缀过滤即可。

**校验点 V18/V19 已实测通过（2026-09-30）**：

- **V18 ✅**：用 fetch 拦截实测，transformers.js 请求的 URL 逐字符符合模板：
  `https://model-cache.sayloud.invalid/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json`。
  各 dtype 请求的文件名见 §1.2。**模板无需修正。**
- **V19 ✅**：音色 URL 确实硬编码，缓存桶 `kokoro-voices`，key = 那个 HF URL。
  但**音色是 `generate()` 时才加载的，模块顶层不发请求**，
  所以「patch 必须在 import 之前装好」这个担心**不成立**——
  只要在调用 `generate()` 之前装好即可。worker 顶层装就行。
- `config.json` 只在第一次请求，之后走缓存（因为 `useBrowserCache`）。

### 3.6 下载器

`lib/models/downloader.ts` + `lib/models/store.ts`，**跑在侧边栏**（模型 tab），**不加载 ORT**：

- 普通 `fetch` + `ReadableStream` 读进度（已下载 / 总字节），`AbortController` 取消。
- 写进 Cache Storage 的**规范 URL** key（模型）和 **HF 硬编码 URL** key（音色，写进 `kokoro-voices` bucket）。
- **音色的 key 必须与 kokoro-js 的硬编码 URL 逐字符一致**（V19 已抄下原文）：
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{id}.bin`。
  这个 key **故意不用规范主机**——因为 kokoro-js 读的就是它。
- 音色默认**按需下载**（每个 **522,240 字节**，实测），另提供「下载全部音色（约 29MB，实际 28.2MB）」和「删除全部音色」。
  - **已经缓存的文件不重下**，所以部分失败后重试是**续传**而不是从头来。
  - **批量下载：并发 4，单个失败不中止整批**；返回 `{downloaded, failed}`，
    失败的音色**不能**被当成已下载。取消（用户的决定）则中止整批。
  - 失败的那个音色只计入它**实际传了多少字节**，这样进度条不会倒退，
    也不会把失败算成进度。
  - 按需下载要**可被播放阻塞**：用户选了一个未下载的音色，
    第一句必须等它下完（522KB，很快），不能静默失败。
  - 下载失败要能重试，且不能把失败状态当成「已下载」。
- 删除：按规范前缀删模型文件；按 URL 前缀删 `kokoro-voices`。
- 占用统计：两个 bucket 分别求和。
- **下载器与 fetch patch 必须共用同一个 URL 生成器**（`lib/models/urls.ts` 的导出），
  不允许各自拼字符串——否则换源后缓存 key 不一致，会变成「下载了但用不到」，
  而且这种 bug 在单测里很难发现。

**为什么不用 transformers.js 自己的 `from_pretrained` 下载**：那会把 20.6MB 的 ORT wasm 加载进侧边栏（要建 ONNX session），而侧边栏只是设置页。手写下载器约 100 行，还顺便拿到进度和取消。

**进度总数要加上共享文件**：`tier.bytes` 只是 ONNX 的大小，
而一个档还要下 `config.json`(44B) / `tokenizer.json`(3,497B) / `tokenizer_config.json`(113B)。
不加这三个，进度条永远到不了 100%。实测值放在 `registry.ts` 的 `SHARED_FILE_BYTES`，
与档位体积放在一起，避免以后加模型时漏算。

**两个拒绝下载的边界情况**（都由实现发现，不是推测）：

- **HTTP 206 要当成失败**：Cache API 根本不接受部分响应，
  让 `cache.put` 抛 `TypeError` 会被误报成「磁盘坏了」而不是「源有问题」。
- **读到一半失败算 `network` 而不是 `cache`**：Node 会把流的拒绝原因包成
  `EncodingError`，Chrome 则原样透传——所以要在**读失败的地方**记录，
  而不是根据运行时抛了什么去猜。

**为什么下载不放 offscreen**：offscreen 在 `AUDIO_PLAYBACK` 理由下**静音 30 秒就被 Chrome 关掉**（P2 spec V2 已记录），92MB 下载要几分钟，会被拦腰杀死。侧边栏是可见页面，下载和进度条都在那里最自然；Cache Storage 同源共享。

### 3.7 档位

> **⚠️ 本节曾被写错，已按 GPU 实测重写。** 原推荐 q8 为默认，实测发现
> **q8 在 WebGPU 上完全无效**（反量化算子回退 CPU）。详见 §3.7.1。

#### 3.7.1 实测矩阵：dtype × 执行后端（真机，同一组 5 句）

| dtype | 后端 | 平均 RTF | 逐句耗时（ms） | 体积 |
|---|---|---|---|---|
| `q8` | wasm | 1.454 | 4251 / 3758 / 10193 / 3958 / 4294 | **92.4MB** |
| `q8` | webgpu | 1.433 | 4354 / 3924 / 12293 / 3291 / 4765 | 92.4MB |
| `fp16` | wasm | 1.136 | 3173 / 3022 / 8083 / 3162 / 3401 | 163.2MB |
| **`fp16`** | **webgpu** | **0.15–0.26** | **469 / 373 / 989 / 462 / 417** | 163.2MB |
| `fp32` | wasm | 1.138 | 3311 / 3017 / 8069 / 3085 / 3384 | 325.5MB |
| **`fp32`** | **webgpu** | **0.158–0.178** | **487 / 435 / 1061 / 382 / 498** | 325.5MB |

**offscreen 文档里复测（真实上下文）**：`webgpu/fp32` RTF **0.178**
vs `wasm/fp32` **1.119** → **快 6.3 倍**。

**三条硬结论**：

1. **`q8` + WebGPU 毫无收益**（1.433 vs wasm 1.454）。量化模型的反量化算子
   回退 CPU，把 GPU 加速全吃掉。**这是最初把 P4 性能结论搞错的原因。**
2. **WebGPU 只有在 fp16/fp32 下才有效**，效果是 **6–8 倍**。
3. **没有 WebGPU 时，三种 dtype 差不多**（1.14–1.45）——
   那才是「真的慢」，此时预取才关键（§3.12.1）。

#### 3.7.2 档位策略（按设备能力推荐）

| 设备 | 推荐档 | 理由 |
|---|---|---|
| WebGPU 且支持 `shader-f16`（实测 Apple M 系列支持） | **`fp16`（默认）** | 163MB，RTF ≈ 0.15，体积只有 fp32 的一半 |
| WebGPU 但不支持 `shader-f16` | `fp32` | 325MB，RTF ≈ 0.17 |
| 无 WebGPU | **`q8`** | 92MB 最小；反正 GPU 用不上，q8 的劣势不存在 |

**默认档必须根据实测设备动态选**，不能写死。用 §3.1 的 `preferredTier(model, caps)`：
调用方先用 `navigator.gpu` + `requestAdapter().features.has('shader-f16')`
组装出 `DeviceCaps`，再拿到档位。

**`q8` 在任何情况下都不是 WebGPU 机器的推荐档**——它在 GPU 上完全无效（§3.7.1）。

**不再提供的档**：

- `q4`(305MB) / `q4f16`(154MB)：体积比 q8 还大，无意义。
- `int8` / `bnb4`：仓库里没有这两个文件。
- 86MB 的 `model_q8f16.onnx`：没有任何合法 dtype 能选到它。

**保留三档供手动切换**（用户可能为了省磁盘而选 q8）：

| 档位 | dtype | 文件 | 体积 | UI 提示 |
|---|---|---|---|---|
| 轻量 | `q8` | `model_quantized.onnx` | 92.4MB | 体积最小；**有 WebGPU 时不推荐**（GPU 加速无效） |
| 标准（默认） | `fp16` | `model_fp16.onnx` | 163.2MB | 推荐搭配 WebGPU；需 `shader-f16` |
| 高保真 | `fp32` | `model.onnx` | 325.5MB | 最准、最兼容 WebGPU |

- **换档不删旧档**：各档是不同的缓存 key，模型 tab 按档位分别显示状态，旧档由用户自己删，避免换档时意外重下。
- `fp16` 在无 `shader-f16` 的 WebGPU 上要能自动退回 `fp32` 或 `wasm`，并在 UI 说明原因。
- **共享文件不重复算体积**：`config.json` / `tokenizer*.json` 三个档共用，
  「占用空间」只算一次。
- **档位变更要让音频缓存失效**（§3.13 的 `audioIdentity` 已包含 `tier`）。

### 3.8 引擎接口（一族一适配器）

```ts
// lib/models/engine.ts
export interface DeviceInfo {
  device: 'webgpu' | 'wasm';
  adapterName?: string;
  sessionInitMs: number;
}

export interface OnDeviceEngine {
  readonly family: OnDeviceFamily;
  /** 加载某个档位；重复调用同一个档位应复用 session。 */
  load(model: OnDeviceModel, tier: ModelTier, device: 'webgpu' | 'wasm'): Promise<DeviceInfo>;
  /**
   * `lang` 是 BCP-47，**不是可选的**：中文与英文走完全不同的音素化路径
   * （§3.11）。调用方从 `LocalConfig.lang` 传下来，
   * 缺省时按音色 id 前缀推导（`zf_`/`zm_` → `zh-CN`，其余 → `en-US`）。
   */
  synthesize(
    text: string, voiceId: string, lang: string, signal: AbortSignal
  ): Promise<{ pcm: Float32Array; sampleRate: number }>;
  dispose(): void;
}
```

- P4 只实现 `KokoroEngine`（在 worker 里，通过消息协议与 `WorkerLocalEngine` 通信）。
- 加族 = 加一个 `OnDeviceEngine` 实现 + 注册表加一项，**不改管理器、不改 UI、不改 provider**。

### 3.8.1 音素化接缝（必须可注入）

音素化是两条路，必须分开且可注入，否则 CI 测不了：

```ts
export interface Phonemizer {
  /** 文本 → IPA 字符串（已含声调标记）。 */
  phonemize(text: string, lang: string): string;
}
```

- 英文：用 `phonemizer` 包（espeak-ng 英文），与 `kokoro-js` 内部一致。
- 中文：用自建的 `ChinesePhonemizer`（§3.11）。
- 测试：`FakePhonemizer`（返回固定 IPA），让单测与 e2e 不需要真 wasm。
- **注入点与 `FakeLocalEngine` 一致**（§3.16）。

### 3.9 输出格式：PCM → WAV

- Kokoro 输出 Float32 PCM @ 24kHz 单声道 → 转 **16-bit PCM WAV**，让既有的 `<audio>` / TimelinePlayer 路径零改动。
- `durationMs = samples / 24000 * 1000`；`mime = 'audio/wav'`；**不返回 `timings`**。
- 10 秒句子 ≈ 480KB WAV，进 L2 音频缓存没问题。
- 不采用 catm 的 24k→48k 上采样 + AAC/HLS：那是为了流式播放和 OPFS 持久化；SayLoud 是「一句一合成、按需播放 + 缓存」，WAV 更简单。
- **两条音素化路径产出同一形状**：`generate()`（英文）与 `generate_from_ids()`（中文）
  都返回 `RawAudio`，`audio` 是 `Float32Array`、`sampling_rate` 是 24000。
  所以 PCM→WAV 这一步**只需一份实现**，与语言无关。

### 3.10 510 token 上限切分

- 一句超过上限时在**子句边界**再切，分别合成后拼接 PCM（同采样率直接 concat）。
- 量长度用音素化结果 + `tokenizer(phonemes).input_ids.dims.at(-1)`，与 catm 一致。
- 阈值取 catm 的值：目标 175–250 token，绝对上限 450（都低于 510）。
- 切分**不改变 SayLoud 的句子粒度**：高亮按 `text-utils.ts` 的 `segmentSentences`
  切出的句子走（那是 SayLoud 自己的句子定义，与引擎无关），
  510 切分只在适配器内部，对高亮层完全透明。
- 实测参考：中文每句约 43 tokens（§3.11），英文短句 15–40 tokens，
  所以 510 上限**日常很少触发**，主要在超长段落上。

### 3.11 音素化：两条完全不同的路

这是 P4 **技术含量最高、也最容易搞错**的一节。

#### 3.11.1 为什么必须分两条路

`kokoro-js` 的公开 API 只能出英文（§1.1.1）。它的 `generate()` 内部是：

```
generate(text, {voice}) → _validate_voice(voice)   // 只认 28 个英文音色，否则抛错
                        → phonemize(text, voice[0] === 'a' ? 'en-us' : 'en')   // 永远是英文
                        → tokenizer → generate_from_ids
```

所以：

- **英文**：直接用 `tts.generate(text, { voice })`。省事且与官方行为一致。
- **中文**：必须**绕开 `generate()`**，自己做前三步，然后调 `tts.generate_from_ids()`
  （它**不做音色校验**，接受任意音色 id）。

#### 3.11.2 中文管线（已实测打通）

```
汉字文本
  → pinyin-pro（toneType:'num'）
  → 查音节表（426 条，带声调占位符）
  → 声调替换 + retone（声调曲线 → 箭头 ↓↗↘→）
  → IPA 字符串
  → tts.tokenizer(ipa)
  → tts.generate_from_ids(input_ids, { voice })
```

**为什么是这套**：这是 misaki（Kokoro 官方 G2P，`hexgrad/misaki`）的中文做法。
`misaki/zh.py` + `misaki/transcription.py`（MIT，改编自 `stefantaubert/pinyin-to-ipa`）
是**纯查表**，不依赖 espeak：

```python
TONE_MAPPING = {1:'˥', 2:'˧˥', 3:'˧˩˧', 4:'˥˩', 5:''}
def retone(p):
    p = p.replace('˧˩˧','↓').replace('˧˥','↗').replace('˥˩','↘').replace('˥','→')
```

**关键证据：tokenizer 词表里有 `↓→↗↘`**，且**没有任何数字**。
声调就是靠箭头编码的——这也解释了为什么 espeak 的数字声调会被剥掉。
词表同时包含中文 IPA 全部字符（`ʦ ʨ ꭧ ɕ ʂ ɻ ɥ ɤ ɚ ɹ ʐ` 等）。

#### 3.11.3 音节表怎么生成（不要手写）

生成一次，把产物当静态数据提交：

1. 用 pypinyin 枚举出所有合法音节（实测 **1549 个**）。
2. 用**真正的 misaki 算法**（直接 import 官方的 `transcription.py`）转换，实测 **零失败**。
3. 归一化去重后得到 **426 个标准音节**（实测 **0 冲突**）。
4. 输出 `音节 → 带 0 占位符的 IPA 模板`，**JSON 实测只有 7,304 字节**。

样例（实测）：

| 音节 | 模板 | 说明 |
|---|---|---|
| `ni` | `ni0` | |
| `hao` | `xau̯0` | h → x |
| `shi` | `ʂɻ̩0` | sh 后的 i 是 ɻ̩ |
| `qu` | `ʨʰy0` | ü → y |
| `yue` | `ɥe0` | |
| `liu` | `ljou̯0` | iu → iou |
| `shui` | `ʂwei̯0` | ui → uei |
| `wen` | `wə0n` | uen |
| `er` | `ɚ0` | |

**不要自己写声母/韵母切分**：pypinyin 的 `to_finals(strict=True)` 做了大量归一化
（y/w 非严格声母、`iu`→`iou`、`ui`→`uei`、`un`→`uen`/`ün`），
手写必错。实测 `pinyin-pro` 的 `pattern:'final'` **不直接可用**：
它给 `wen`→`en`（丢了介音 w）、`yue`→`ue`（应为 `üe`）、`liu`→`iu`（应为 `iou`）。
所以**表用 pypinyin 生成**，运行时只用 `pinyin-pro` 拿音节与声调。

#### 3.11.4 实测验证结果（5 句全过）

| 汉字 | IPA | tokens |
|---|---|---|
| 你好世界。 | `ni↓ xau̯↓ ʂɻ̩↘ ʨje↘` | 19 |
| 这是一段中文测试。 | `ꭧɤ↘ ʂɻ̩↘ i↗ twa↘n ꭧʊ→ŋ wə↗n ʦʰɤ↘ ʂɻ̩↘` | 37 |
| 今天天气很好，我们去公园散步吧。 | `ʨi→n tʰjɛ→n tʰjɛ→n ʨʰi↘ xə↓n xau̯↓ wo↓ mən ʨʰy↘ kʊ→ŋ ɥɛ↗n sa↘n pu↘ pa` | 70 |
| 他说：“我明天要去北京。” | `tʰa→ ʂwo→ wo↓ mi↗ŋ tʰjɛ→n jau̯↘ ʨʰy↘ pei̯↓ ʨi→ŋ` | 47 |

平均每句 **43 tokens**，**声调箭头全部被 tokenizer 保留**。

**已知缺口**：
- 两个组合符号（`̯` U+032F、`̩` U+0329）不在词表里，会被 normalizer 剥掉，
  得到 `au↓` 而非 `au̯↓`。因为训练用的也是同一个 tokenizer，**这应该无害**，
  但无法在无音频输出的环境证实。
- 数字会被 `pinyin-pro` 的 `nonZh:'removed'` 丢掉，必须靠 SayLoud 既有的
  文本归一化（把数字读成词）在**上游**处理。
- **中文自然度未经试听验证**——这是 P4 唯一无法靠单测确认的假设，
  必须列入 §9 手动验收。

#### 3.11.5 依赖

- `pinyin-pro` 1.1MB（运行时拿音节 + 声调）
- 生成的音节表 7KB（静态数据）
- **不需要 espeak-ng，不需要 18MB 的 wasm**

（曾考虑用 `espeak-ng` npm 包，它有完整语言数据含 `cmn`，18MB。
实测**更差**：它的 `cmn` 期望**拼音输入**，汉字会回退英文；
而且它输出的是**数字声调**，会被 tokenizer 剥掉。放弃。）

#### 3.11.6 音色表

- Kokoro 的**可用音色**静态写在 `lib/providers/kokoro-voices.ts`
  （照 `volcengine-voices.ts` 的做法，`listVoices()` 动态 import），**不发网络请求**。
- **只写 P4 能真正出声的 36 个**（28 英文 + 8 中文）。
  仓库里另外 18 个（日/西/法/印地/意/葡）需要各自的 G2P，
  **不写进表**——写了也只会抛错。
- **中文 8 个**：`zf_xiaobei` / `zf_xiaoni` / `zf_xiaoxiao` / `zf_xiaoyi` /
  `zm_yunjian` / `zm_yunxi` / `zm_yunxia` / `zm_yunyang`。
- **英文 28 个**：从 kokoro-js 的 `VOICES` 元数据生成（`af` 11 / `am` 9 / `bf` 4 / `bm` 4）。
  这份元数据自带 name / language / gender，一次生成到静态表，避免运行时依赖。
- 中文音色的 name / gender 需要自己填（kokoro-js 的元数据里没有它们）。
- **默认音色按语言选**：中文页 → 一个 `zf_*`（如 `zf_xiaoxiao`），
  英文页 → `af_heart`（catm 也用这个）。
- 音色 id 前缀就是语言的可靠标志（`af/am/bf/bm` = 英文，`zf/zm` = 中文），
  所以 `LocalConfig.lang` 可以缺省推导（§3.8）。

#### 3.11.7 完整文本管线（试听发现的新需求）

**用户试听时发现两个真问题**：数字没念、英文字符没点出来。
根因不是模型，是管线里少了两步——当时的实验脚本用 `nonZh: 'removed'`
把非汉字字符**直接删了**。修正后的完整管线：

```
原始文本
  1. 数字 → 中文读法      15.6% → 百分之十五点六
  2. 标点 → ASCII         。→'. '  ，→', '  ！→'! '  ……
  3. 汉字段 → misaki 表   → IPA（含声调箭头）
  4. 拉丁段 → espeak en-us → IPA（逐字母：API → ɐ pˈiː ˈaɪ）
  5. 拼接 → tokenizer → generate_from_ids()
```

**每一步都是必需的，缺一个就静默出错**（听不到数字，而不是报错）：

**(1) 数字 → 中文**

必须自己实现，`pinyin-pro` 不管这个。规则：

| 输入 | 输出 | 说明 |
|---|---|---|
| `3` | 三 | |
| `15` | 十五 | 不是「一十五」 |
| `100` | 一百 | |
| `15.6` | 十五点六 | 小数逐位读 |
| `15.6%` | 百分之十五点六 | 百分号前置 |
| `2024` | 二千零二十四 | ⚠️ 年份更自然的读法是「二零二四」，后续可做上下文判断 |

注意**先做数字转换，再做汉字音素化**——否则转换出来的汉字不会被音素化。

**(2) 标点 → ASCII（misaki 的 `map_punctuation`）**

**Kokoro 的 tokenizer 词表里没有全角中文标点**（实测：`，。！？、：；（）`
全部不在词表，只有 `“ ”` 在）。misaki 的做法是把它们换成 ASCII：

```python
text = text.replace('、', ', ').replace('，', ', ')
text = text.replace('。', '. ').replace('！', '! ').replace('？', '? ')
# …… 以及 《》「」【】（） → 引号/括号
```

**不做这一步，句读会完全丢失**（逗号处的停顿没了），长句听起来会很赶。

**(3) 汉字段** → misaki 表（§3.11.2），**保留标点**。

**(4) 拉丁段 → 英文音素化**

`API` → `ɐ pˈiː ˈaɪ`（逐字母读 A-P-I），`PDF` → `pˈiː dˈiː ˈɛf`。
用已有的 `phonemizer`（英文 espeak）就行。

**关键洞察：中英 IPA 可以直接拼在同一串里**——因为 Kokoro 的 tokenizer
是共用的，中英音素共用一套符号。所以不需要把句子拆成两个请求。

**(5) 拼接后一次 tokenize、一次推理。**

**实测验证**（5 句全过，含数字/中英混排）：

| 句子 | IPA |
|---|---|
| 第 3 季度营收增长了 15.6%。 | `ti↘ sa→n ʨi↘ tu↘ i↗ŋ ʂou̯→ ʦə→ŋ ꭧa↓ŋ lɤ pai̯↓ fə→n ꭧɻ̩→ ʂɻ̩↗ u↓ tjɛ↓n ljou̯↘ .` |
| 这里有个 API 接口，还有 PDF 文件。 | `ꭧɤ↘ li↓ jou̯↓ kɤ↘ ɐ pˈiː ˈaɪ ʨje→ kʰou̯↓ , xai̯↗ jou̯↓ pˈiː dˈiː ˈɛf wə↗n ʨjɛ↘n .` |

**这一步对云端 provider 可能已经存在**：需要先查 `lib/text-utils.ts`
现有的归一化做了什么（当前只有空白 + NFC），再决定是复用还是新增。
**不要把数字归一化只加在本地 provider 里**——那是文本层的事。

### 3.12 能力与高亮

```ts
capabilities() { return { timings: 'none', maxChars: 2000, concurrency: 1 }; }
```

- **只有句级高亮**。Kokoro 不返回时间戳，SayLoud 的规则是不估算，所以词层永远为空。
- `concurrency: 1`：单机推理，并发只会互相抢 CPU/GPU。
- 设置页能力标签显示「仅句级高亮」。

#### 3.12.1 预取是优化，不是必需品（V20 已修正）

> **⚠️ 本节结论曾被写错，已修正。** 早期测得 RTF ≈ 1.45 并据此断定
> 「预取是必需品」，但那个数字是用 **`q8` + WebGPU** 测的——
> 量化算子的反量化回退 CPU，把 GPU 加速全吃掉了。
> 详见 §3.7.1。**正确数字是 RTF ≈ 0.15–0.18（fp32/fp16 + WebGPU）。**

实测 RTF ≈ 0.15–0.18（比实时快 5–6 倍）。这意味着：

- 10 秒的句子只需 **1.5–1.8 秒**合成，播放完全追得上。
- **预取仍然是好的**（提前备好下一句、降低首次停顿），
  但**不再是「不做就不能用」**。
- `concurrency: 1` 仍然成立（单机推理），但队列压力比想象的小得多。
- **音频缓存（L2）** 仍然值得做：重听已缓存的句子是瞬时的。

**只有一种情况需要担心**：机器没有 WebGPU，退回 WASM（RTF ≈ 1.1–1.45）。
那时预取就真的重要了——所以引擎应该**按实测到的 RTF 自适应**，
而不是无条件开启或关闭。

#### 3.12.2 启动耗时（V20 已修正）

**前提：模型已经下载好**（下载是「模型」标签页里的独立步骤，不计入启动）。

| 阶段 | 实测（Apple M 系列，fp32 + WebGPU） |
|---|---|
| 从缓存读模型 + 建 session | 约 0.5–1 秒 |
| 首句合成（含 shader 编译） | **594 ms**（无额外冷启动惩罚，后续 403 ms） |
| 稳态每句 | 400–1100 ms（取决于句长） |
| （对照）WASM 首句 | 3,260 ms |

**所以启动到出声约 1–2 秒**，不是早期误测的「十几秒」。
UI 仍然应该显示准备状态（不能假设瞬时），但不需要为「等十几秒」做特殊设计。

#### 3.12.3 ⚠️ offscreen 文档 30 秒会被回收（实测）

实测：`chrome.offscreen.createDocument({ reasons: ['AUDIO_PLAYBACK'] })` 创建的文档
**在无音频播放 30 秒后整被回收**（实测时间线：9s 创建 → 30s 消失）。

**为什么这条对 P4 很重要**：

- 真实设计里，offscreen 只负责「从缓存读模型 + 建 session + 合成」——
  实测这些加起来 **1–2 秒**，远低于 30 秒，安全。
- **但如果模型没下好**，offscreen 就会去下载（几分钟）→ **中途被杀**。
  这正是 §3.6「下载器跑在侧边栏」的实测依据。
- 推论：**播放前必须确保模型已缓存**（`model-missing` 错误码就是这个作用），
  不能指望 offscreen 自己下。
- 实验里保活的手法：在 offscreen 里跑一个 `gain = 0.0001` 的振荡器
  （几乎无声，但 Chrome 认为在播放）。**真实应用靠正常播放保活，不需要这个。**

**新增验证点 V23**：真实模型下，从「点播放」到「出声」的端到端延迟，
且中途不被回收（需在 T3 验证）。

### 3.13 音频缓存键

`lib/cache-manager.ts` 的 `audioIdentity()` 加分支：

```ts
case 'local':
  return { model: config.modelId ?? 'kokoro-82m', tier: config.tier ?? 'q8', device: config.device ?? 'auto' };
```

档位或模型变了 → 音频缓存自动失效。

### 3.14 打包、CSP、ORT 配置

- `wxt.config.ts`：`content_security_policy.extension_pages` 加 `'wasm-unsafe-eval'`（现有值保留）。
  **实验已证实必需**：不加 wasm 起不来。
- **不启用 COOP/COEP** —— V17 已实测确认：ORT wasm 在
  `crossOriginIsolated: false` + `numThreads = 1` 下**能正常初始化**
  （故意喂垃圾 buffer，错误是「protobuf 解析失败」而不是 wasm 加载失败，
  证明 wasm 已起来）。
  于是**不需要改全局 manifest，也就不需要回归六家云端 provider** ——
  这是本轮省下的最大一块风险。
- ORT 的 `wasmPaths` 指向扩展内的绝对路径（`chrome.runtime.getURL('ort/')`），**不能用 jsDelivr**（默认值指向 CDN，且 MV3 挡远程脚本）。
  **实测有效**。
- **打包器必须正确解析 `kokoro-js` 的 `browser` 字段**（把 `path` / `fs/promises` stub 成空对象）。
  Vite 是否遵守**未验**（V21）——实验里是靠 import map 手动 stub 的。
  若不遵守，需要显式 alias。**这是 T3 的第一个要验的点**，
  因为失败症状很隐蔽（运行时才报 `Failed to resolve module specifier "path"`）。
- `onnxruntime-web`、`kokoro-js`、`@huggingface/transformers`、`phonemizer` **只能出现在 offscreen worker 的 chunk 里**：
  - 不能进 SW bundle（`background.js` 现在 24.7kB，加进来会爆）。
  - 不能进侧边栏 bundle（下载器不需要 ORT）。
  - 用动态 `import()` 包住，并加构建产物体积断言测试。
  - `pinyin-pro`（1.1MB）也在这一侧，但**不需要 ORT**，
    所以如果将来把它挪到侧边栏也能工作。
- **确认 54 个音色 `.bin` 没被打进包**：`kokoro-js` 包里有 28.7MB 的
  `voices/*.bin`，它们是**运行时下载的**，不是 asset。
  构建后断言产物里没有 `.bin`。
- `host_permissions` 保持为空（HF 和 ModelScope 都是 CORS `*`）。`check-manifest.mjs` 必须继续通过。

### 3.15 错误码

复用 `ProviderErrorCode`，新增：

| code | 触发 | UI 方向 |
|---|---|---|
| `model-missing` | 该档位没下载 | 「模型还没下载」+「打开模型设置」 |
| `model-host-unreachable` | `auto` 两个源都探测失败 | 「连不上下载源」+ 源下拉 |
| `model-download-failed` | 下载中断/失败 | 「下载失败」+ 重试 |
| `model-load-failed` | ORT 加载失败（文件损坏、wasm 缺失） | 「模型加载失败」+ 建议删除重下 |
| `device-unavailable` | 指定的 device 不可用（强制 webgpu 但无 `navigator.gpu`） | 「这台机器没有 WebGPU」+「改用 WASM」 |

### 3.16 可注入的引擎接缝（测试用）

CI 不可能下 92MB 模型，引擎与音素化**都必须可替换**：

- 引擎：真实 `WorkerLocalEngine`（与 `local.worker.ts` 通信）；
  测试 `FakeLocalEngine`（按文本长度生成可解码的静音 PCM）。
- 音素化：真实 `EnglishPhonemizer` / `ChinesePhonemizer`；
  测试 `FakePhonemizer`（返回固定 IPA）。
- 注入沿用 `createApp` 的既有模式（`AudioWorker` 的 providers 映射已经可注入，P4 再加两个注入点）。
- e2e 用假引擎 + 假音素化跑通**整条链路**：provider → WAV → TimelinePlayer → 播放 → 句级高亮 → 音频缓存命中。
- 真实引擎与真中文管线留给手动验收（§9）。

### 3.17 本地导入（兜底）

网络完全受限的用户需要一条不依赖任何源的路：

- 模型 tab 提供「从本地文件导入模型…」，用户选 `.onnx` 文件，写进规范 key（档位由文件大小或用户选择决定）。
- 这是唯一能绕开所有 CDN 的路径，实现成本低，保留。

### 3.18 许可展示

- 模型 tab 每个模型卡片显示 `license.name`，可点击打开 `license.url`。
- 理由：Kokoro 是 Apache-2.0，但后续候选里 **MMS-TTS 是 CC-BY-NC-4.0**、Piper 各音色许可不一（有 CC-BY 也有 NC）。上架审核会问，用户也有权知道。
- 注册表的 `license` 字段是必填的，没有许可信息的模型不准进注册表。

---

## 4. UI：模型标签页

### 4.1 位置

全局设置从两个标签变成三个：**朗读 / 设置 / 模型**。

P3 spec §8.1 把标签写死在 `SidePanel.tsx` 里，**要改成数据驱动的标签列表**，P4 只加一项（对 P3 spec 的唯一结构性改动，见 §5）。

### 4.2 线框图

```
┌────────────────────────────────────────┐
│ SayLoud      [朗读][设置][模型]          │
├────────────────────────────────────────┤
│ 下载源                                  │
│ [自动（推荐）                        ▾] │
│ 自动会选一个连得上的源，并记住它。          │
├────────────────────────────────────────┤
│ ┌────────────────────────────────────┐ │
│ │ Kokoro 82M              使用中      │ │
│ │ 中/英 2 语言 · 36 音色 · 句级高亮  │ │
│ │ Apache-2.0                          │ │
│ ├────────────────────────────────────┤ │
│ │ 轻量 q8 · 92 MB          已下载      │ │
│ │                        [删除]      │ │
│ │ 标准 fp16 · 163 MB       未下载      │ │
│ │ 建议配合 WebGPU          [下载]      │ │
│ │ 高保真 fp32 · 325 MB     未下载      │ │
│ │ 建议配合 WebGPU          [下载]      │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 下载中  轻量 q8                 42%     │  ← 仅下载时出现
│ [██████████░░░░░░░░░░░░░░]  [取消]     │
├────────────────────────────────────────┤
│ 音色        已下载 3 / 55（1.5 MB）      │
│ [下载全部音色（约 29 MB）]                │
├────────────────────────────────────────┤
│ 运行设备      WebGPU · Apple M3 Pro     │
│ 占用空间      92.4 MB                   │
│ [从本地文件导入模型…]                     │
└────────────────────────────────────────┘
```

### 4.3 交互规则

- **档位三态**：未下载（体积 + 「下载」）/ 下载中（进度 + 「取消」）/ 已下载（「使用中」徽章或「设为使用中」+ 「删除」）。
- 「使用中」= `config.tier`。点未使用档位的「设为使用中」写 config（该档必须已下载）。
- **删除当前使用档位**：先警告「删除后需要重新下载才能朗读」，确认后删除并把 `tier` 回退到该模型第一个档；若那个也不存在，provider 视为未就绪，播放时报 `model-missing`。
- 下载中切走标签页不中断；关掉侧边栏会中断，此时提示「下载已取消」。
- 「运行设备」在模型未加载时显示「未加载」；加载后显示实际用的 `webgpu`/`wasm` 和适配器名。
- 「占用空间」= 模型文件 + `kokoro-voices` 音色，**不含**音频缓存。
- 源选 `custom` 时下方出现 URL 输入框（`placeholder: https://example.com/models`）+ 校验（必须 https、必须完整 URL）。
- 模型未下载时，provider 行（设置标签页）显示「模型未下载 · 去模型标签页 ›」，点了跳过去。

#### 4.3.1 播放侧的状态提示（GPU 实测驱动）

实测（有 WebGPU + fp16/fp32）：从点播放到出声约 **1–2 秒**，稳态 RTF ≈ 0.15–0.18。
所以 UI 的原则是**简短诚实，不夸大等待**：

- **模型未下载**：直接说「模型还没下载」+「去模型设置」，不要让播放器转圈。
- **首次准备**（模型已下、session 未建）：显示「正在准备本地模型…」（约 1 秒，一闪而过很正常）。
- **合成中**：当前句还没好时显示「正在生成…」，不要假装在缓冲。
- **不要为等待做过度设计**：不需要进度条、不需要「首次约十几秒」这类文案——
  那是在错误性能数据下写的。
- **无 WebGPU 的机器**才是例外：那里 RTF ≈ 1.1–1.45，确实会等。
  可以检测到（`device === 'wasm'`）时额外提示「这台机器没有 GPU 加速，本地语音会比较慢」，
  并建议改用云端服务或浏览器语音。
- **不要承诺速度**：文案不写「秒级」「实时」之类。

### 4.4 多模型的呈现（结构上要支持，P4 只渲染一项）

- 模型列表按注册表遍历渲染，**不写死 Kokoro**。
- 注册表只有一项时，UI 不显示「添加模型」「即将支持」之类的占位——P3 spec 的原则是不放空开关。加第二个模型族时列表自然变成两项。
- 形态 B（`per-voice`）的呈现方式留到那时再定（大概是「音色目录 + 每个音色一个下载按钮」），P4 不实现也不预留空 UI。

### 4.5 与「设置」标签页的分工

- **设置 → 缓存卡片**：音频缓存（L2 IndexedDB）。不含模型。
- **模型 tab**：模型权重 + 音色（Cache Storage 两个 bucket）。
- 两处「已用空间」各自显示自己那部分，不合并，避免用户以为清音频缓存能腾出模型空间。

---

## 5. P3 已完成的铺垫（原 spec 的前提已过时）

> **修正（2026-09-30）**：本节原文写「P3 的 T4 还没执行」，
> 但 **P3 已全部完成**，四项铺垫**已经就位**。下面是核对后的实际状态。

| 原计划要改的 | 实际状态 |
|---|---|
| 1. `SidePanel.tsx` 标签列表改成数据驱动 | ✅ **已做**。`TABS` 是个 `readonly {id, labelKey}[]`，渲染时 `TABS.map()`，注释里明写「加一个标签只需加一行 `TABS` + 一个组件，没有 `if`」 |
| 2. 线框图标注第三个标签来自 P4 | ✅ 已补进 P3 spec |
| 3. smoke 断言改成「遍历标签」 | ✅ **已做**。smoke 用 `getByRole('tab')` 全取 + 逐个点击 + `#panel-${tab.id}` 校验，subagent 当时还**临时加了第三个标签跑过全绿**才撤回 |
| 4. 缓存卡片文案写明「音频缓存」 | ✅ **已做**。文案是 `Audio only. On-device models are stored separately.`，smoke 有断言 |

**所以 P4 在标签上只需做三件事**：

1. `TABS` 加一项 `{ id: 'models', labelKey: 'panel.tab-models' }`。
2. 写 `ModelsTab.tsx`。
3. 两个字典各加对应键（`messages.zh.ts` 的类型约束会在漏翻译时让 `typecheck` 报错）。

**smoke 不用改** —— 它已经是遍历式的。但要注意：smoke 会断言标签数量与
`#panel-*` 容器存在，所以 `ModelsTab` 必须真的渲染出 `id="panel-models"`。

---

## 6. 验证点

**已全部实测（2026-09-30），完整记录见
`docs/superpowers/plans/2026-09-30-p4-risk-verification.md`。**

| 编号 | 结论 | 结果 |
|---|---|---|
| **V15** | offscreen 文档里有**完整可用的 WebGPU**（Apple/metal-3、`shader-f16` ✓、设备创建成功） | ✅ **通过** |
| **V16** | ModelScope 在国内真实网络下的速度与稳定性（关掉代理测） | ⏳ **未能验证**（测试机走代理，fake-IP 模式）——留给用户手动验收 §9 |
| **V17** | ORT 在 `numThreads=1` 且无交叉隔离时**能初始化**；`wasmPaths` 指向扩展内路径有效 | ✅ **通过** |
| **V18** | transformers.js 实际请求的 URL 与 canonical 模板**逐字符一致** | ✅ **通过** |
| **V19** | 音色 URL 硬编码已抄下原文；缓存桶 `kokoro-voices`，key = 该 URL；**模块顶层不发请求** | ✅ **通过** |
| **V20** | ~~RTF ≈ 1.45，WebGPU 与 WASM 几乎同速~~ → **已修正**：那是 `q8` 的数字。真实情况是 **fp16/fp32 + WebGPU 的 RTF ≈ 0.15–0.18（快 6–8 倍）**；`q8` + WebGPU 确实无收益 | ✅ **通过（结论已修正）** |

### 新增验证点

| 编号 | 待验证 | 影响 | 退路 |
|---|---|---|---|
| **V21** | **Vite 是否遵守 `kokoro-js` 的 `browser` 字段**（把 `path`/`fs/promises` stub 成空对象） | 决定打包能不能直接跑；失败症状隐蔽（运行时才报 `Failed to resolve module specifier "path"`） | 显式 alias 到 stub |
| **V22** | **中文音频实际听感**（自然度、声调是否正确、无杂音） | 决定中文能不能对外宣称可用 | ✅ **已验**（用户试听：Kokoro 中文可用，Piper 中文否决，见 §1.1.2） |
| **V23** | 真实模型下「点播放 → 出声」的端到端延迟，且中途不被 offscreen 回收 | 决定首句体验与 30 秒回收风险（§3.12.3） | 若超 30 秒：播放前先做一次保活，或改变 offscreen 理由 |

**V21 必须在 T3 的第一个小时就验**（它决定整个打包路径）。
**V22 只能由用户听**（无音频输出的环境无法判断）。

---

## 7. 测试计划

| 层 | 覆盖 |
|---|---|
| 单元 | 注册表：每个模型必填 license/repo/tiers；档位 `bytes` 与 `files` 一致；dtype↔文件名映射（防止再出现 `q8f16` 这种不存在的 dtype） |
| 单元 | canonical URL 生成与解析（HF/ModelScope/custom × main/master 互换）；音色 URL 改写；非规范 URL 放行 |
| 单元 | 下载器：进度计算、取消、失败、源选择（auto 探测、last-good、手动不自动切换）；删除只删自己那档；占用统计只算模型与音色（**共享文件只算一次**） |
| 单元 | **音色按需下载**：首次用某音色会触发下载；下载失败可重试且不被当成已下载；删除后再次使用会重下 |
| 单元 | **中文音素化**（新增，重点）：426 个音节能全部命中表；声调 1–4 + 轻声都能映射到箭头；标点/数字被剥掉；未知音节报明确错误而不是静默产出空串；音节表与 tokenizer 词表的兼容性断言（表里出现的字符必须在词表里或属于已知被剥的组合符） |
| 单元 | **两条路径的分派**：英文音色走 `generate()`，中文音色走 `generate_from_ids()`；音色 id 前缀 → `lang` 的推导 |
| 单元 | PCM→WAV（头字段、字节长度、时长）；510 切分（超长句、中文、无标点）；音色表（**36 个**、8 个中文、BCP-47）；`capabilities()`；`audioIdentity()` 含模型与档位；错误码映射 |
| E2E | 假引擎 + 假音素化整链路：配置 → 播放 → 句级高亮 → 音频缓存命中 |
| E2E | 模型未下载 → `model-missing` → 错误卡片 → 跳模型 tab；模型 tab 三态渲染、下载进度、取消、删除确认 |
| E2E | **「准备中」提示真的会出现**（用一个慢的假引擎，断言文案出现后消失），而不是只在快路径下测通过 |
| E2E | 构建产物断言：`background.js` 不含 ORT；侧边栏 chunk 不含 ORT；`.wasm` 在包里；**产物里没有 `.bin` 音色文件**；包体积在预期范围 |
| 手动 | 真实模型：V16（国内网络）/ V22（中文听感）；断网后继续朗读；换源后不重新下载 |

---

## 8. 任务分解

> **T1 已完成**（2026-09-30）：V15/V17/V18/V19 全部通过，V20 拿到具体数字，
> 并额外发现「kokoro-js 只能出英文」这个阻塞性问题。
> 结论已写回 §1.1.1 / §3.11 / §6 与 `2026-09-30-p4-risk-verification.md`。
> 原 T1 的产出（结论）已交付，**从 T2 开始**。

### T2 — 通用模型注册表 + 管理器

- `lib/models/registry.ts`（`OnDeviceModel`、`ModelTier`、`DeviceCaps`、
  `KOKORO_82M`、`modelById`、**`preferredTier(model, caps)`**）。
  **不含任何运行时依赖**（不 import ORT），侧边栏与 worker 都能用。
- `lib/models/urls.ts`（canonical 键、HF/ModelScope/custom 解析、音色 URL 改写）。
  **下载器与 fetch patch 必须共用它。**
- `lib/models/downloader.ts`（清单、进度、取消、失败）。
- `lib/models/store.ts`（下载/删除/占用统计、音色按需下载、源选择、last-good）。
- 全套单测（含音色按需下载）。

**档位选择属于 T2**，不能留到 T4：T4 的模型 tab 要显示「推荐」徽章，
T3 的引擎要知道 `auto` 解析成哪个 dtype。留到后面会变成在 UI 层硬编码。
`preferredTier` 是**纯函数**（只看 `caps`），「哪个档已下载」由 store 回答，
两者分开以便各自单测。

**T2 不碰**：UI、推理、音素化。产出是可在 Node 下单测的数据层。

**T2 已完成（2026-10-01）**，产出：

- `lib/models/registry.ts`（零运行时依赖，只 import 一个 `type`）
- `lib/models/urls.ts`（零 import）
- `lib/models/downloader.ts`、`lib/models/store.ts`
- 81 个新单测（1117 → 1198；修复后 1200）

**实现过程中发现并已回写本 spec 的问题**（都已修正）：

1. **音色体积算错了**：54 × 522,240 = 28.2MB，而 28.7MB 是 55 个条目
   （含非音色的 `af.bin`）的总和。
2. **`KOKORO_82M` 示例漏了 `labelKey`**，而接口要求必填（`MessageKey`）→
   已补 4 个 i18n 键到两个字典。
3. **源的存放位置在 spec 里没有归宿**（§3.6 说 store 管，§3.2 又放进 `LocalConfig`）
   → 定为 `sayloud:model-source`，§3.4 已写明 T4 不得重复。
4. **进度总数漏算共享文件** → `registry.ts` 新增 `SHARED_FILE_BYTES`。
5. **`usage()` 无法统计 `files` 形态的模型**（形态 B/C）——已在代码里注明，
   以后加 Piper/MMS 时要给那个形态补体积字段。
6. **§3.4 的 `auto` 探测有竞态**：「先成功的」不等于「先返回的」，
   快速失败不能算赢 → 已改成 `Promise.any` + 每次尝试超时。

**我自己复核时发现并修掉的一个真 bug**（`0842123`）：
`isOurs()` 只认 canonical 模型键 + `voices/*.bin`，但 `resolveUrl()`
会改写**任何** HF URL——fetch patch 会把别的项目的 HF 请求劫持到镜像。
实现里那条「幂等」测试正好把这个不安全行为固化了（它断言跨源重解析，
而 patch 根本不需要那个能力）。已加 `isOurs` 守卫，并把测试改成断言安全契约。
**新测试经验证会在旧代码上变红。**

### T3 — 音素化 + Kokoro 引擎 + fetch patch

**顺序很重要**：先把 V21（Vite 的 `browser` 字段）验了再写正式逻辑，
因为它决定打包路径能不能跑。

- **`lib/models/phonemize/`**（新增，两条路 + 接缝）：
  - `types.ts`（`Phonemizer` 接口）+ `FakePhonemizer`。
  - `english.ts`（包 `phonemizer`）。
  - `chinese.ts`（`pinyin-pro` + 音节表）。
  - `pinyin-table.json`（**426 条，7KB，生成物**）——
    生成脚本放 `scripts/gen-pinyin-table.py`，用 pypinyin + **官方 misaki 的
    `transcription.py`**（两者都固定版本，写进脚本注释）。
  - 单测：每个音节能命中；四种声调 + 轻声 → 箭头；标点/数字被剥；未知音节报错。
- `lib/models/engine.ts`（接口）+ `FakeLocalEngine` + `WorkerLocalEngine`。
- `entrypoints/offscreen/local.worker.ts`（ORT 配置、dtype、510 切分、PCM、
  **两条合成路径的分派**）。
- fetch patch（worker 侧，规范主机 + 音色 URL）。
- `lib/providers/kokoro-voices.ts`（**36 个音色的静态表**）+ `lib/providers/local.ts`（适配器）。
- PCM→WAV、`capabilities`、`audioIdentity`、错误码。

### T4 — 模型标签页 + provider 接线 + 打包

- `SidePanel.tsx` 的 `TABS` 加一项（§5 已确认其余铺垫已就位）。
- 模型 tab 全部 UI（§4，含 §4.3.1 的诚实提示）。
- `config-schema.ts` 的 `local` 字段 + `FieldSpec.hidden`（模型相关的字段由模型 tab 渲染，不在通用表单里重复）。
- `wxt.config.ts`：CSP（`wasm-unsafe-eval`）、wasm 进包、ORT 路径。
- 构建产物体积断言（含「产物里没有 `.bin`」）。
- e2e：模型 tab 三态、下载/取消/删除、`model-missing` 路径、
  假引擎 + 假音素化整链路、「准备中」提示真的会出现。

### T5 — 收尾

- 版本号 0.3.0 → 0.4.0。
- 回填 V16/V21/V22 的结论。
- 用户手动验收（§9）。

---

## 9. 用户手动验收清单

> V15/V17/V18/V19 已自动验过，不在清单里。
> **V16（国内网络）与 V22（中文听感）只能由你在真机上做**，是最关键的两项。

1. **V16**：关掉代理、真实国内网络：模型 tab 选「自动」→ 下载成功（走 ModelScope）；
   进度正常；断网后仍能朗读。**记下实际下载速度。**
2. **V22（最重要）**：中文页读三段不同类型的中文
   （短句 / 长句 / 含数字与英文混排），**听**：
   - 声调是否正确（不是平淡的机器人调）
   - 是否漏字、多字、串行
   - 是否可接受（以你愿意日常用为准）
   若明显不对，告诉我，我们把中文改成实验性或暂不提供。
3. 手动切到 Hugging Face → 看到失败提示与「改用另一个源重试」。
4. **换源后不重新下载**（验证 §3.5 的 canonical 缓存）。
5. 删除当前档位 → 播放报「模型未下载」→ 跳模型 tab；重下后恢复。
6. 下载全部音色 → 断网 → 切换音色仍能朗读（验证 §3.5 的音色改写）。
7. 英文页读一段：音色自动选择合理；高亮是句级且正确。
8. 「运行设备」显示实际是 WebGPU 还是 WASM；
   **对照我在 Apple M 系列上的数字（session 12–13.5s、RTF ≈ 1.45）**，
   看你这台机器差多少。
9. **首次播放的等待体验**：点播放到出声实际等多久？提示是否诚实、可取消？
10. 设置 → 缓存卡片清空音频缓存，不影响模型；模型 tab 删模型，不影响音频缓存。
11. 六家云端 provider 全部回归一遍（确认 CSP 改动没破坏它们）。

---

## 10. 以后加模型族要做什么

留档，说明这套抽象是否真的够用（P4 之后验证）：

1. 注册表加一项（`family`、`shape`、`repo`、`license`、`languages`、`files` 或 `tiers`）。
2. 加一个 `OnDeviceEngine` 实现 + 在 worker 里注册。
3. 若是形态 B（per-voice），补一个「音色目录」的 UI 呈现。
4. 若是新形态（C，多组件 / LLM 基座），需要新的 `shape` 分支——**这一档的成本不可低估**，Qwen3-TTS 这类要 LLM + audio codec 两段推理，不是加个适配器的事。

具体候选的成本（调研结论）：

- **Kitten TTS nano（24MB，Apache-2.0，英文）**：形态 A，但 StyleTTS2 不在 transformers.js 原生支持里（`vits` 有、StyleTTS2 没有），要自写推理。模型只有一个 onnx + `voices.npz`，代码量不大。
- **Piper（中文 20.6MB 起）**：形态 B。模型是 VITS，transformers.js 认，但**文本前端要 espeak-ng 的对应语言数据**。
  **P4 实测的教训**：这里的坑比想象深——espeak-ng 的 `cmn` 期望**拼音输入**，
  汉字会回退英文；而且它输出**数字声调**，会被 Kokoro 的 tokenizer 剥掉。
  所以「用 espeak-ng 解决多语言」这条路要先实测再估工作量。
  音色许可也不一，要逐个核。
- **MMS-TTS**：transformers.js 原生，代码最少，但**没有中文**且是 **CC-BY-NC-4.0**。
- **SpeechT5**：transformers.js 原生，但 340MB+ 且只有英文。
