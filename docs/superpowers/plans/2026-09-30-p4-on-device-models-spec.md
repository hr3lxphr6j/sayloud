# SayLoud P4: 端侧模型 Provider 与通用模型管理 Spec

**日期**: 2026-09-30
**前置条件**: P3 完成（设置存储、i18n、缓存管理、界面重设计、字幕悬浮窗）
**分支**: `p4-local-models`（从 `main` 切出）
**目标版本**: 0.4.0

---

## 0. 概述

### 0.1 目标

给 SayLoud 加**端侧语音**：模型在用户机器上跑，文字不出本机、不需要自建服务器、下好之后完全离线。

这一轮做两件事：

1. **通用的模型管理器**——注册表驱动的模型列表，管理每个模型的下载源、下载、删除、进度、占用和许可。**结构上支持多个模型族，但只接 Kokoro 一个引擎。**
2. **模型标签页**——全局设置新增第三个标签页，管模型的下载和删除。

### 0.2 不包含

- ❌ 第二个模型族的引擎实现（Kitten / Piper / MMS 见 §10，结构已留好）
- ❌ 词级高亮（Kokoro 不给时间戳，见 §3.12）
- ❌ 声音克隆、微调、多说话人对话
- ❌ 云端 provider 的任何改动（P2 已完成）

---

## 1. 调研

### 1.1 端侧 TTS 模型全景

实测（HF API + npm registry，2026-09-30）：

| 模型 | 参数 | 体积 | 中文 | 英文 | 许可 | 运行时 | 形态 |
|---|---|---|---|---|---|---|---|
| **Kokoro 82M** | 82M | 92–325MB | ✅ 8 音色 | ✅ | Apache-2.0 | kokoro-js（自写） | A |
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

### 1.2 依赖内部的三个硬事实

读 `kokoro-js@1.2.1` 的打包产物确认，直接决定实现方式：

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

**(c) dtype 到文件名的映射**

```js
DATA_TYPES = { auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16 }
suffix: { fp32:"", fp16:"_fp16", int8:"_int8", uint8:"_uint8", q8:"_quantized", q4:"_q4", q4f16:"_q4f16", bnb4:"_bnb4" }
DEFAULT_DEVICE_DTYPE_MAPPING = { wasm: "q8" }
```

**`q8f16` 不是合法 dtype**，86MB 的 `model_q8f16.onnx` 选不到。可选档只有 `q8`(92.4MB) / `fp16`(163.2MB) / `fp32`(325.5MB)。`int8`、`bnb4` 在该仓库没有文件，会 404。

### 1.3 下载源实测

**注意**：测试机走代理（所有域名解析到 `198.18.0.0/15`，fake-IP 模式），所以**本机测出的「国内可达性」不代表真实国内环境**。下表区分服务端事实与可达性。

| 源 | 结果 | 证据 |
|---|---|---|
| `huggingface.co` | 可用但本机间歇失败 | 3 次连测 `000`（TLS handshake 失败）、`307`、`307` |
| `hf-mirror.com` | **已失效** | 文件请求和 API 请求都 `308 location: https://huggingface.co/...`（`server: Caddy`），带浏览器 UA 相同 |
| `cdn-lfs.huggingface.co` | 不可达 | `code=000` |
| **`modelscope.cn`** | **完整镜像，推荐** | 见下 |

ModelScope 的 `onnx-community/Kokoro-82M-v1.0-ONNX` 是完整镜像，71 个条目，字节数与 HF 一致：8 个量化档全在、55 个音色 `.bin` 全在、`config.json`/`tokenizer.json`/`tokenizer_config.json` 全在，**不需要 token**。

URL 结构与 HF 只差前缀和分支名：`https://modelscope.cn/models/{model}/resolve/master/{file}`。实测 Range：

```
config.json          → 200 (44B)
model_quantized.onnx → 206 → cdn-lfs-cn-1.modelscope.cn/…  （国内 CDN）
voices/af_heart.bin  → 206 → cdn-lfs-cn-1.modelscope.cn/…
tokenizer.json       → 200 (201B)
```

CDN 稳定性：3 次连测全 `206`，0.40–0.42s。

**结论**：`hf-mirror.com` 这条常见方案在这里是错的，排除；ModelScope 作国内源。

### 1.4 体积代价

**只有 20.6MB 的 wasm 进包。** transformers.js 包里只带一个 `dist/ort-wasm-simd-threaded.jsep.wasm`（20.60MB），它**同时覆盖 WebGPU 和 WASM 两个执行后端**，不需要第二个文件。

| 项 | 体积 |
|---|---|
| `ort-wasm-simd-threaded.jsep.wasm` | 20.60MB |
| transformers.js + kokoro-js + phonemizer JS | ~4.7MB |
| **包体增量** | **~23–25MB** |

扩展包从 ~0.6MB 变成 **~25MB**。模型权重不进包，运行时下载。

（`kokoro-js` npm 包解包 30.4MB，其中约 29MB 是 55 个音色 `.bin`。运行时走网络 + `kokoro-voices` 缓存，**不该打进包**——构建时要确认 Vite 没把它们当 asset 收进去。）

---

## 2. 评估

| 项 | 工作量 | 风险 |
|---|---|---|
| 通用模型注册表 + 管理器（下载/删除/进度/占用/源） | 1 天 | 低 |
| canonical 缓存键 + fetch patch（含音色硬编码） | 1 天 | 中：必须逐字符匹配依赖实际请求的 URL（V18/V19） |
| Kokoro 引擎（worker、ORT 配置、WAV、510 切分、音色表） | 1 天 | **高**：offscreen 里有没有 WebGPU（V15） |
| 模型标签页 UI + provider 接线 | 1 天 | 低 |
| 打包（CSP、wasm 进包、体积断言） | 0.5 天 | 中：wasm 路径（V17） |
| 测试 + 手动验收 | 0.5 天 | 中：CI 下不了 92MB，必须靠可注入假引擎 |

合计约 5 天。**最大单点风险是 V15**：若 offscreen 文档里没有 WebGPU，只剩单线程 WASM（`numThreads=1` 是 MV3 硬限制），大概率慢到不可用。**这个必须先验证再动手。**

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
  languages: ['en-US','en-GB','ja-JP','zh-CN','es-ES','fr-FR','hi-IN','pt-BR'],
  voiceCount: 55,
  tiers: [
    { id:'q8',   labelKey:'model.tier.light',  engineArg:'q8',   bytes: 92_400_000,
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx'] },
    { id:'fp16', labelKey:'model.tier.standard', engineArg:'fp16', bytes:163_200_000,
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model_fp16.onnx'] },
    { id:'fp32', labelKey:'model.tier.hifi',   engineArg:'fp32', bytes:325_500_000,
      files:['config.json','tokenizer.json','tokenizer_config.json','onnx/model.onnx'] },
  ],
  voiceFile: (id) => `voices/${id}.bin`,
}
```

`bytes` 用实测值写死（不用 `Content-Length` 探测），因为 UI 要在下载**前**显示体积。

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
  /** 权重下载源。在「模型」标签页管理。 */
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

### 3.3 运行位置

**合成在 offscreen 文档 + 它内部的 Web Worker 里跑**，不在侧边栏：

- 音频播放本来就在 offscreen（P2 架构），合成放同一上下文省掉跨上下文传音频。
- 侧边栏可能被关掉，不能让它成为播放的前提。
- ONNX 推理绝不能跑在 offscreen 文档主线程上——会阻塞 TimelinePlayer 的播放/暂停/定时器。必须用嵌套 Worker。

新增 `entrypoints/offscreen/local.worker.ts`（WXT 的 worker 打包方式实现时确认产物里有独立 chunk）。

**设备选择**：`device: 'auto'` → `'gpu' in navigator` 为真则 `webgpu`，否则 `wasm`。实测到的设备要能上报到 UI（§4.2 的「运行设备」）。

### 3.4 下载源（用户可选）

| 值 | 行为 |
|---|---|
| `auto`（默认） | 先看 `sayloud:model-host-last-good`；没有记录就**并发探测**两个源的 `config.json`（超时 5s），用先成功的；都失败报 `model-host-unreachable`，提示手动选源 |
| `huggingface` | 只用 `https://huggingface.co/`，分支 `main` |
| `modelscope` | 只用 `https://modelscope.cn/models/`，分支 `master` |
| `custom` | 用 `customHostUrl`，`{base}/{repo}/resolve/{revision}/{file}`，分支默认 `main` |

- 成功后把源写进 `sayloud:model-host-last-good`，下次 `auto` 直接用，不再探测。
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

**校验点 V18/V19**：把 transformers.js 和 kokoro-js 实际请求的 URL 打日志，与我们的规范模板逐字符核对。

### 3.6 下载器

`lib/models/downloader.ts` + `lib/models/store.ts`，**跑在侧边栏**（模型 tab），**不加载 ORT**：

- 普通 `fetch` + `ReadableStream` 读进度（已下载 / 总字节），`AbortController` 取消。
- 写进 Cache Storage 的**规范 URL** key（模型）和 **HF 硬编码 URL** key（音色，写进 `kokoro-voices` bucket）。
- 音色默认**按需下载**（每个 522KB），另提供「下载全部音色（约 29MB）」和「删除全部音色」。
- 删除：按规范前缀删模型文件；按 URL 前缀删 `kokoro-voices`。
- 占用统计：两个 bucket 分别求和。

**为什么不用 transformers.js 自己的 `from_pretrained` 下载**：那会把 20.6MB 的 ORT wasm 加载进侧边栏（要建 ONNX session），而侧边栏只是设置页。手写下载器约 100 行，还顺便拿到进度和取消。

**为什么下载不放 offscreen**：offscreen 在 `AUDIO_PLAYBACK` 理由下**静音 30 秒就被 Chrome 关掉**（P2 spec V2 已记录），92MB 下载要几分钟，会被拦腰杀死。侧边栏是可见页面，下载和进度条都在那里最自然；Cache Storage 同源共享。

### 3.7 档位

| 档位 | dtype | 文件 | 体积 | 说明 |
|---|---|---|---|---|
| 轻量（默认） | `q8` | `model_quantized.onnx` | 92.4MB | WASM 和 WebGPU 都能跑；`DEFAULT_DEVICE_DTYPE_MAPPING.wasm` 就是 `q8` |
| 标准 | `fp16` | `model_fp16.onnx` | 163.2MB | WebGPU 需要 `shader-f16` 特性 |
| 高保真 | `fp32` | `model.onnx` | 325.5MB | catm 的默认值，最重 |

- **换档不删旧档**：各档是不同的缓存 key，模型 tab 按档位分别显示状态，旧档由用户自己删，避免换档时意外重下。
- `fp16` 在无 `shader-f16` 的 WebGPU 上要能自动退回 `q8` 或 `wasm`，并在 UI 说明原因。

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
  synthesize(
    text: string, voiceId: string, signal: AbortSignal
  ): Promise<{ pcm: Float32Array; sampleRate: number }>;
  dispose(): void;
}
```

- P4 只实现 `KokoroEngine`（在 worker 里，通过消息协议与 `WorkerLocalEngine` 通信）。
- 加族 = 加一个 `OnDeviceEngine` 实现 + 注册表加一项，**不改管理器、不改 UI、不改 provider**。

### 3.9 输出格式：PCM → WAV

- Kokoro 输出 Float32 PCM @ 24kHz 单声道 → 转 **16-bit PCM WAV**，让既有的 `<audio>` / TimelinePlayer 路径零改动。
- `durationMs = samples / 24000 * 1000`；`mime = 'audio/wav'`；**不返回 `timings`**。
- 10 秒句子 ≈ 480KB WAV，进 L2 音频缓存没问题。
- 不采用 catm 的 24k→48k 上采样 + AAC/HLS：那是为了流式播放和 OPFS 持久化；SayLoud 是「一句一合成、按需播放 + 缓存」，WAV 更简单。

### 3.10 510 token 上限切分

- 一句超过上限时在**子句边界**再切，分别合成后拼接 PCM（同采样率直接 concat）。
- 量长度用 `phonemize(text, lang)` + `tokenizer(phonemes).input_ids.dims.at(-1)`，与 catm 一致。
- 阈值取 catm 的值：目标 175–250 token，绝对上限 450（都低于 510）。
- 切分**不改变 SayLoud 的句子粒度**——高亮仍按引擎给的句子走，切分只在适配器内部。

### 3.11 音色表

- Kokoro 的 55 个音色静态写在 `lib/providers/kokoro-voices.ts`（照 `volcengine-voices.ts` 的做法，`listVoices()` 动态 import），**不发网络请求**。
- 语言分布（实测）：`af` 12 / `am` 9 / `bf` 4 / `bm` 4 / `jf` 4 / `jm` 1 / `zf` 4 / `zm` 4 / `ef` 1 / `em` 2 / `ff` 1 / `hf` 2 / `hm` 2 / `if` 1 / `im` 1 / `pf` 1 / `pm` 2。
- **中文 8 个**：`zf_xiaobei` / `zf_xiaoni` / `zf_xiaoxiao` / `zf_xiaoyi` / `zm_yunjian` / `zm_yunxi` / `zm_yunxia` / `zm_yunyang`。
- 默认音色按页面语言选（中文页 → 一个 `zf_*`，英文页 → `af_heart`）。
- 名称/语言/gender 从 kokoro-js 自带的 `VOICES` 元数据一次性生成到静态表，避免运行时依赖。

### 3.12 能力与高亮

```ts
capabilities() { return { timings: 'none', maxChars: 2000, concurrency: 1 }; }
```

- **只有句级高亮**。Kokoro 不返回时间戳，SayLoud 的规则是不估算，所以词层永远为空。
- `concurrency: 1`：单机推理，并发只会互相抢 CPU/GPU。预取仍有意义（缓存下一句），但要串行。
- 设置页能力标签显示「仅句级高亮」。

### 3.13 音频缓存键

`lib/cache-manager.ts` 的 `audioIdentity()` 加分支：

```ts
case 'local':
  return { model: config.modelId ?? 'kokoro-82m', tier: config.tier ?? 'q8', device: config.device ?? 'auto' };
```

档位或模型变了 → 音频缓存自动失效。

### 3.14 打包、CSP、ORT 配置

- `wxt.config.ts`：`content_security_policy.extension_pages` 加 `'wasm-unsafe-eval'`（现有值保留）。
- **先不启用 COOP/COEP**。catm 加它是为了 SharedArrayBuffer，但 `numThreads = 1` 时不需要 SAB。不加就避免一次全局 manifest 改动，也就避免对六家云端 provider 的 CORS 请求、content script 注入、侧边栏的未知影响。若实测 ORT 在无交叉隔离时报错，再加（V17）。
- ORT 的 `wasmPaths` 指向扩展内的绝对路径（`chrome.runtime.getURL('ort/')`），**不能用 jsDelivr**（默认值指向 CDN，且 MV3 挡远程脚本）。
- `onnxruntime-web`、`kokoro-js`、`@huggingface/transformers`、`phonemizer` **只能出现在 offscreen worker 的 chunk 里**：
  - 不能进 SW bundle（`background.js` 现在 24.7kB，加进来会爆）。
  - 不能进侧边栏 bundle（下载器不需要 ORT）。
  - 用动态 `import()` 包住，并加构建产物体积断言测试。
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

CI 不可能下 92MB 模型，引擎必须可替换：

- 真实：`WorkerLocalEngine`（与 `local.worker.ts` 通信）。
- 测试：`FakeLocalEngine`（按文本长度生成可解码的静音 PCM）。
- 注入沿用 `createApp` 的既有模式（`AudioWorker` 的 providers 映射已经可注入，P4 再加一个引擎注入点）。
- e2e 用假引擎跑通**整条链路**：provider → WAV → TimelinePlayer → 播放 → 句级高亮 → 音频缓存命中。真实引擎留给手动验收。

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
│ │ 中/英/日等 8 语言 · 55 音色 · 句级高亮│ │
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

### 4.4 多模型的呈现（结构上要支持，P4 只渲染一项）

- 模型列表按注册表遍历渲染，**不写死 Kokoro**。
- 注册表只有一项时，UI 不显示「添加模型」「即将支持」之类的占位——P3 spec 的原则是不放空开关。加第二个模型族时列表自然变成两项。
- 形态 B（`per-voice`）的呈现方式留到那时再定（大概是「音色目录 + 每个音色一个下载按钮」），P4 不实现也不预留空 UI。

### 4.5 与「设置」标签页的分工

- **设置 → 缓存卡片**：音频缓存（L2 IndexedDB）。不含模型。
- **模型 tab**：模型权重 + 音色（Cache Storage 两个 bucket）。
- 两处「已用空间」各自显示自己那部分，不合并，避免用户以为清音频缓存能腾出模型空间。

---

## 5. 对 P3 spec 的改动

P3 的 T4（界面重设计）**还没执行**，现在改成本最低：

1. `SidePanel.tsx` 的标签列表改成**数据驱动**，视图切换支持任意数量标签（加一项不改渲染逻辑）。
2. P3 spec §8.1 线框图加一句：标签为「朗读 / 设置」，第三个「模型」标签在 P4 加入。
3. P3 spec §8.4 的 smoke 断言写成「遍历标签」的形式，而不是写死两个标签。
4. P3 spec §3.3 的缓存卡片文案明确写「音频缓存」，避免与模型管理混淆。

---

## 6. 验证点

| 编号 | 待验证 | 影响 | 退路 |
|---|---|---|---|
| **V15** | **offscreen 文档里 `navigator.gpu` 是否存在、WebGPU 能否真正推理** | 决定这个 provider 是否可用（无 WebGPU 只剩单线程 WASM） | 若 WASM 太慢：UI 标注「这台机器上本地语音会很慢」，或把 provider 标为实验性 |
| **V16** | ModelScope 在国内真实网络下的速度与稳定性（关掉代理测） | 国内用户能否用 | 已保留 `custom` 源 + 本地导入 |
| **V17** | ORT 在 `numThreads=1` 且**无交叉隔离**时能否初始化；wasm 二进制在扩展内的实际路径 | 能否避免 COOP/COEP 全局改动 | 必须加 COOP/COEP，并回归六家云端 provider |
| **V18** | transformers.js 实际请求的 URL 与 canonical 模板逐字符一致 | 缓存命中 | 用请求日志核对后修正模板 |
| **V19** | `kokoro-voices` 的 key 与 kokoro-js 硬编码 URL 一致 | 音色离线 | 不一致就靠 fetch patch 兜底 |
| **V20** | 首次加载耗时（92MB + session 建立）与每句合成耗时 | 体验 | 调整档位建议或加载提示 |

**V15 是动手前必须先做的实验。**

---

## 7. 测试计划

| 层 | 覆盖 |
|---|---|
| 单元 | 注册表：每个模型必填 license/repo/tiers；档位 `bytes` 与 `files` 一致；dtype↔文件名映射（防止再出现 `q8f16` 这种不存在的 dtype） |
| 单元 | canonical URL 生成与解析（HF/ModelScope/custom × main/master 互换）；音色 URL 改写；非规范 URL 放行 |
| 单元 | 下载器：进度计算、取消、失败、源选择（auto 探测、last-good、手动不自动切换）；删除只删自己那档；占用统计只算模型与音色 |
| 单元 | PCM→WAV（头字段、字节长度、时长）；510 切分（超长句、中文、无标点）；音色表（55 个、8 个中文、BCP-47）；`capabilities()`；`audioIdentity()` 含模型与档位；错误码映射 |
| E2E | 假引擎整链路：配置 → 播放 → 句级高亮 → 音频缓存命中 |
| E2E | 模型未下载 → `model-missing` → 错误卡片 → 跳模型 tab；模型 tab 三态渲染、下载进度、取消、删除确认 |
| E2E | 构建产物断言：`background.js` 不含 ORT；侧边栏 chunk 不含 ORT；`.wasm` 在包里；包体积在预期范围 |
| 手动 | 真实模型：V15/V20 的设备与耗时；断网后继续朗读；换源后不重新下载 |

---

## 8. 任务分解

### T1 — 先验 V15（实验，不做功能）

在 offscreen 文档里放一个最小 ONNX 推理（几 KB 的小模型即可），验证 `navigator.gpu` 是否存在、WebGPU 能否推理、WASM 回退能否初始化、耗时多少。**把实测结论写回本文件 §6 与 commit message。** 产出是结论，不是功能。

**若结论是「无 WebGPU 且 WASM 慢到不可用」，停下来报告，不要继续后面的任务。**

### T2 — 通用模型注册表 + 管理器

- `lib/models/registry.ts`（`OnDeviceModel`、`KOKORO_82M`、`modelById`）。
- `lib/models/urls.ts`（canonical 键、HF/ModelScope/custom 解析、音色 URL 改写）。
- `lib/models/downloader.ts`（清单、进度、取消、失败）。
- `lib/models/store.ts`（下载/删除/占用统计/音色/源选择/last-good）。
- 全套单测。

### T3 — Kokoro 引擎 + fetch patch

- `lib/models/engine.ts`（接口）+ `FakeLocalEngine` + `WorkerLocalEngine`。
- `entrypoints/offscreen/local.worker.ts`（ORT 配置、dtype、510 切分、PCM）。
- fetch patch（worker 侧，规范主机 + 音色 URL）。
- `lib/providers/kokoro-voices.ts`（静态音色表）+ `lib/providers/local.ts`（适配器）。
- PCM→WAV、`capabilities`、`audioIdentity`、错误码。
- 单测；V18/V19 的 URL 核对结论写回 §6。

### T4 — 模型标签页 + provider 接线 + 打包

- `SidePanel.tsx` 标签数据驱动（顺带完成 §5 对 P3 的改动）。
- 模型 tab 全部 UI（§4）。
- `config-schema.ts` 的 `local` 字段 + `FieldSpec.hidden`（模型相关的字段由模型 tab 渲染，不在通用表单里重复）。
- `wxt.config.ts`：CSP、wasm 进包、ORT 路径。
- 构建产物体积断言。
- e2e：模型 tab 三态、下载/取消/删除、`model-missing` 路径、假引擎整链路。

### T5 — 收尾

- 版本号 0.3.0 → 0.4.0。
- 回填 V16/V17/V20 的实测结论。
- 用户手动验收（§9）。

---

## 9. 用户手动验收清单

1. 关掉代理、真实国内网络：模型 tab 选「自动」→ 下载成功（走 ModelScope）；进度正常；断网后仍能朗读。
2. 手动切到 Hugging Face → 看到失败提示与「改用另一个源重试」。
3. **换源后不重新下载**（验证 §3.5 的 canonical 缓存）。
4. 删除当前档位 → 播放报「模型未下载」→ 跳模型 tab；重下后恢复。
5. 下载全部音色 → 断网 → 切换音色仍能朗读（验证 §3.5 的音色改写）。
6. 英文页 + 中文页各读一段：音色自动选择合理；高亮是句级且正确。
7. 「运行设备」显示实际是 WebGPU 还是 WASM；记录首次加载耗时和每句延迟。
8. 设置 → 缓存卡片清空音频缓存，不影响模型；模型 tab 删模型，不影响音频缓存。
9. 六家云端 provider 全部回归一遍（确认 CSP/wasm 改动没破坏它们）。

---

## 10. 以后加模型族要做什么

留档，说明这套抽象是否真的够用（P4 之后验证）：

1. 注册表加一项（`family`、`shape`、`repo`、`license`、`languages`、`files` 或 `tiers`）。
2. 加一个 `OnDeviceEngine` 实现 + 在 worker 里注册。
3. 若是形态 B（per-voice），补一个「音色目录」的 UI 呈现。
4. 若是新形态（C，多组件 / LLM 基座），需要新的 `shape` 分支——**这一档的成本不可低估**，Qwen3-TTS 这类要 LLM + audio codec 两段推理，不是加个适配器的事。

具体候选的成本（调研结论）：

- **Kitten TTS nano（24MB，Apache-2.0，英文）**：形态 A，但 StyleTTS2 不在 transformers.js 原生支持里（`vits` 有、StyleTTS2 没有），要自写推理。模型只有一个 onnx + `voices.npz`，代码量不大。
- **Piper（中文 20.6MB 起）**：形态 B。模型是 VITS，transformers.js 认，但**文本前端要 espeak-ng 的对应语言数据**；且音色许可不一，要逐个核。
- **MMS-TTS**：transformers.js 原生，代码最少，但**没有中文**且是 **CC-BY-NC-4.0**。
- **SpeechT5**：transformers.js 原生，但 340MB+ 且只有英文。
