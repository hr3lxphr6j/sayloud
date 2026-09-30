# P4 风险项实测记录（2026-09-30）

测试环境：macOS，Node v26.10.0，kokoro-js@1.2.1，@huggingface/transformers@3.8.1，
phonemizer@1.2.1。临时目录 `/tmp/p4verify`。

---

## V18 — transformers.js 的 URL 模板 ✅ 通过

用 fetch 拦截实测（`env.remoteHost` 设为规范主机、`remotePathTemplate = '{model}/resolve/{revision}/'`），
transformers.js 请求的 URL 逐字符符合：

```
https://model-cache.sayloud.invalid/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json
https://model-cache.sayloud.invalid/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer_config.json
```

**结论**：§3.5 的 canonical 缓存键方案成立，模板无需修正。

### 各 dtype 实际请求的 ONNX 文件

| dtype | 文件 |
|---|---|
| `q8` | `onnx/model_quantized.onnx` |
| `fp16` | `onnx/model_fp16.onnx` |
| `fp32` | `onnx/model.onnx` |
| `q4` | `onnx/model_q4.onnx` |
| `q4f16` | `onnx/model_q4f16.onnx` |
| `int8` | `onnx/model_int8.onnx`（文件不存在，会 404） |
| `bnb4` | `onnx/model_bnb4.onnx`（文件不存在，会 404） |

`config.json` 只在第一次请求，之后走缓存。

---

## V19 — kokoro-js 的音色 URL 硬编码 ✅ 通过（且比 spec 写的更严重）

`dist/kokoro.js` 里的原文（去混淆）：

```js
const url = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`;
let cache;
try {
  cache = await caches.open("kokoro-voices");
  const hit = await cache.match(url);          // ← key 就是这个硬编码 URL
  if (hit) return await hit.arrayBuffer();
} catch (e) { console.warn("Unable to open cache", e) }
const r = await fetch(url);
```

**结论**：spec §1.2(b) 的描述准确。缓存桶 `kokoro-voices`，key = 硬编码的 HF URL。
换源时必须靠 fetch patch 兜住。

### 补充事实

- 打包器实际选中的入口是 **`dist/kokoro.js`（12KB，Node 版）**，不是 `kokoro.web.js`（2.0MB）。
  `package.json` 的 `exports` 只有 `node` 和 `default`，没有 `browser` 字段。
  但 `"browser": { "path": false, "fs/promises": false }` 会把这两个 Node 模块 stub 掉，
  于是 `if (i && Object.hasOwn(i, "readFile"))` 为假，走网络分支。**可行，但要实测确认打包结果。**
- `dist/kokoro.js` 的顶层 `import` 里**没有** fetch 调用 —— 音色是 `generate()` 时才加载的，
  所以 fetch patch 的时机不是问题（不必担心模块顶层就发请求）。
- `generate_from_ids()` **不做音色校验**，可以直接用任意音色 id。
- `_validate_voice` 的校验只发生在 `generate()` / `stream()`。

---

## 🔴 重大发现：kokoro-js 实际上是英文专用

### 1. `VOICES` 元数据只有 28 个音色，全是英文

实测（`new KokoroTTS({}, {})` 后调 `generate()`，`_validate_voice` 在模型工作之前执行）：

```
af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky
am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa
bf_emma bf_isabella bm_george bm_lewis bf_alice bf_lily bm_daniel bm_fable
```

**28 个，全部 `en-us` / `en-gb`。** 用 `zf_xiaobei` / `jf_alpha` / `ef_dora` 调用一律抛：

```
Voice "zf_xiaobei" not found. Should be one of: af_heart, af_alloy, ...
```

三个 dist 文件（`kokoro.js` / `kokoro.web.js` / `kokoro.cjs`）**都不含** `zf_xiaobei`。

### 2. 依赖的 phonemizer 是英文专用的 espeak-ng

`phonemizer@1.2.1`（1.32MB，wasm 内联）实测：

```
phonemize('你好世界', 'cmn') → ❌ Invalid language identifier: "cmn".
  Should be one of: en, en-029, en-gb, en-gb-scotland, en-gb-x-gbclan,
  en-gb-x-gbcwmd, en-gb-x-rp, en-us, en-us-nyc, gmw/en, ...
```

**全是英文变体。** 语言列表来自 wasm 模块本身（`oe` 返回 `identifiers`），
不是 JS 硬编码 —— 也就是说这个 wasm 构建**真的只有英文语音数据**。

### 3. 官方模型卡声明英文专用

`onnx-community/Kokoro-82M-v1.0-ONNX` 的 README frontmatter：

```yaml
language:
- en
```

### 4. 参考实现 catm 也是英文专用

`catm`（MIT，已上架 CWS，浏览器内 Kokoro 长文阅读器）：

```ts
export type VoiceId = "af_heart" | "af_bella" | "am_michael" | "am_eric";   // 只有 4 个
const lang = voice.charAt(0) === "a" ? "en-us" : "en";                      // 非 a 开头也当英文
```

它调 `tts.generate()`，所以受 `_validate_voice` 限制。

### 5. 但中文**是可行的**（实测打通）

关键：tokenizer 的词表里有**声调箭头** `↓→↗↘`，这正是 misaki（Kokoro 官方 G2P）
用来编码声调的符号。词表里没有任何数字 —— 因为声调用箭头而不是数字。

misaki 的中文 G2P（`misaki/zh.py` + `misaki/transcription.py`，MIT）
是**纯查表**，不依赖 espeak：

```python
TONE_MAPPING = {1:'˥', 2:'˧˥', 3:'˧˩˧', 4:'˥˩', 5:''}
def retone(p):
    p = p.replace('˧˩˧','↓').replace('˧˥','↗').replace('˥˩','↘').replace('˥','→')
```

实测结论（全部在 Node 里跑通）：

1. 用 pypinyin 枚举出 **1549 个音节**，misaki 算法**零失败**转换。
2. 归一化后得到 **426 个标准音节**（去重、0 冲突），
   生成 `音节 → 带 0 占位符的 IPA 模板` 表，**JSON 只有 7,304 字节**。
3. 完整链路：`汉字 → pinyin-pro → 查表 → 声调替换 → retone → tokenizer`，
   5 个测试句全部产出合法 IPA，**声调箭头全部被 tokenizer 保留**。

样例：

| 汉字 | IPA |
|---|---|
| 你好世界。 | `ni↓ xau̯↓ ʂɻ̩↘ ʨje↘` |
| 这是一段中文测试。 | `ꭧɤ↘ ʂɻ̩↘ i↗ twa↘n ꭧʊ→ŋ wə↗n ʦʰɤ↘ ʂɻ̩↘` |
| 今天天气很好，我们去公园散步吧。 | `ʨi→n tʰjɛ→n tʰjɛ→n ʨʰi↘ xə↓n xau̯↓ wo↓ mən ʨʰy↘ kʊ→ŋ ɥɛ↗n sa↘n pu↘ pa` |

平均每句 43 tokens（远低于 510 上限）。

**依赖成本**：`pinyin-pro` 1.1MB + 7KB 表。**不需要 espeak-ng，不需要 18MB wasm。**

（对比：`espeak-ng` npm 包有完整语言数据含 `cmn`，18MB，但它的 cmn 期望**拼音输入**，
汉字会回退英文；且它的输出是数字声调，会被 tokenizer 剥掉。所以 espeak 这条路**更差**。）

### 6. 音色与语言的真实清单（ModelScope API，权威）

仓库 `voices/` 下 **55 个条目**（54 个音色 + 1 个遗留的合并文件 `af.bin`），合计 28.7MB：

| 前缀 | 数量 | 语言 |
|---|---|---|
| af | 11 | en-US 女 |
| am | 9 | en-US 男 |
| bf | 4 | en-GB 女 |
| bm | 4 | en-GB 男 |
| ef / em | 1 / 2 | es-ES |
| ff | 1 | fr-FR |
| hf / hm | 2 / 2 | hi-IN |
| if / im | 1 / 1 | it-IT |
| jf / jm | 4 / 1 | ja-JP |
| pf / pm | 1 / 2 | pt-BR |
| **zf / zm** | **4 / 4** | **zh-CN** |

中文 8 个：`zf_xiaobei` `zf_xiaoni` `zf_xiaoxiao` `zf_xiaoyi`
`zm_yunjian` `zm_yunxi` `zm_yunxia` `zm_yunyang`。

**但 kokoro-js 只认其中 28 个英文的。** 其余 26 个（含 8 个中文）必须走
`generate_from_ids()` 绕道 + 自备音素化。

### 7. 各档位文件的真实体积（ModelScope API）

| 文件 | 体积 |
|---|---|
| `model_q8f16.onnx` | 86.03 MB（**任何 dtype 都选不到**） |
| `model_quantized.onnx` (q8) | **92.36 MB** |
| `model_uint8f16.onnx` | 114.21 MB |
| `model_q4f16.onnx` | 154.59 MB |
| `model_fp16.onnx` (fp16) | **163.23 MB** |
| `model_uint8.onnx` | 177.46 MB |
| `model_q4.onnx` | 305.22 MB |
| `model.onnx` (fp32) | **325.53 MB** |

`int8` / `bnb4` 的文件**不存在**（会 404）。`q4` / `q4f16` 存在但比 q8 还大（反直觉）。

**根目录只有 4 个必需文件**：`config.json`(44B)、`tokenizer.json`(3497B)、
`tokenizer_config.json`(113B)，加 `onnx/` 和 `voices/` 两个目录。

---

## 依赖体积（实测）

| 包 | 解包体积 | 说明 |
|---|---|---|
| `onnxruntime-web` wasm（经 transformers.js 转出） | **21.0 MB** | 单个文件同时覆盖 WebGPU + WASM |
| `@huggingface/transformers` web 构建 | 1.78 MB | |
| `kokoro-js` | 12 KB（dist/kokoro.js） | 实际被打包的那个 |
| `phonemizer` | 1.32 MB | wasm 内联；**英文专用** |
| `pinyin-pro` | 1.1 MB | 中文路径需要 |
| misaki 音节表（生成物） | 7 KB | 中文路径需要 |

英文专用方案：约 +24 MB。
加中文：+1.1 MB（pinyin-pro）+ 7 KB。

---

## 待验证

- **V15**：offscreen 文档里有没有 `navigator.gpu`，WebGPU 能否真正推理
- **V17**：ORT 在 `numThreads=1` 且无交叉隔离时能否初始化；wasm 在扩展内的实际路径
- **V20**：真实模型的首次加载耗时与每句合成耗时
- **V16**：ModelScope 在国内真实网络下的速度（**测试机走代理，无法验证**）

---

## V15 — offscreen 文档里的 WebGPU ✅ 通过（结果比预期好）

最小 MV3 扩展（`chrome.offscreen.createDocument({ reasons: ['AUDIO_PLAYBACK'] })`），
在真机 Chromium 里读 offscreen 文档的探测结果：

```json
{
  "context": "offscreen",
  "hasNavigatorGpu": "object",
  "hasRequestAdapter": "function",
  "adapterAvailable": true,
  "adapterInfo": { "vendor": "apple", "architecture": "metal-3", "description": "" },
  "deviceCreated": true,
  "hasShaderF16": true,
  "crossOriginIsolated": false,
  "hasSharedArrayBuffer": "function",
  "hardwareConcurrency": 10,
  "isSecureContext": true,
  "hasChromeStorage": "undefined",
  "hasChromePermissions": "undefined",
  "hasChromeI18n": "undefined"
}
```

**结论**：offscreen 文档有**完整可用的 WebGPU**，能拿到 adapter、创建设备、支持 `shader-f16`。
不需要任何特殊启动参数。同时**再次确认** P3 的发现：offscreen 里
`chrome.storage` / `permissions` / `i18n` 全是 `undefined`。

---

## V17 — ORT 在 numThreads=1 且无交叉隔离时 ✅ 通过

同一个实验里加载 `onnxruntime-web@1.22.0-dev` 的 `ort.webgpu.min.js`，
`wasmPaths = chrome.runtime.getURL('ort/')`，`numThreads = 1`，`crossOriginIsolated: false`：

```
ortWasmInit: "ok (wasm up; model parse failed as expected)"
ortError:    "Error: Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE:
              Failed to load model because protobuf parsing failed."
```

故意喂垃圾 buffer：错误是**模型解析失败**而不是 wasm 加载失败，证明
**wasm 后端已经成功初始化**。

**结论**：
- **不需要 COOP/COEP**，不需要 `SharedArrayBuffer` 交叉隔离。
  于是 §3.14「先不启用 COOP/COEP」的决定成立，**不需要改全局 manifest**，
  也就**不需要回归六家云端 provider**。
- `wasmPaths` 指向扩展内路径**有效**（`chrome.runtime.getURL('ort/')`）。
- MV3 CSP 需要 `'wasm-unsafe-eval'`（实验里已加，wasm 才起来）。

---

## V20 — 真实模型的加载与合成耗时 ⚠️ 可用但偏慢

真机实测（Apple M 系列，10 核，q8 档 92.36MB，从 ModelScope 下载）：

| 项 | WebGPU | WASM |
|---|---|---|
| 下载 92.36MB | （已缓存） | （已缓存） |
| **session 建立** | **12,090–12,243 ms** | **13,557 ms** |
| 稳态合成 RTF | **1.44–1.45** | **1.45** |
| 每句绝对耗时（稳态） | 4,935–5,578 ms | ~4,935 ms |

逐句明细（WebGPU）：

| 句子 | 耗时 | 音频时长 | RTF |
|---|---|---|---|
| Hello world.（首次） | 3,179 ms | 1.45 s | 2.19 |
| This is a test. | 2,102 ms | 1.27 s | 1.65 |
| Life is like a box of chocolates. | 4,183 ms | 2.85 s | 1.47 |
| You never know what you are gonna get. | 4,351 ms | 2.98 s | 1.46 |
| 长句（8.8s 音频） | 12,191 ms | 8.80 s | 1.39 |

**结论**：

1. **合成比实时慢约 1.45 倍**（RTF ≈ 1.45）。这意味着「边播边合成」会持续落后：
   10 秒的句子要 14.5 秒合成，播放只能覆盖 10 秒。**必须靠预取 + 缓存**，
   且首次听某个句子时可能等。
2. **session 建立要 12–13.5 秒**（模型已下载的情况下）。用户点播放后
   **要等十几秒才出声**，UI 必须显示进度，不能假装立刻可用。
3. **WebGPU 与 WASM 的 RTF 几乎一样**（1.44 vs 1.45）。ORT 日志显示
   WebGPU 确实是首选 EP，但「Some nodes were not assigned to the preferred
   execution providers」——部分算子回退到 CPU，所以差距被抹平。
   **在低端机器上 WASM 会明显更慢**，WebGPU 的价值主要在那些机器上。
4. 以上是 **Apple M 系列**的数字。低端 Windows 笔记本会差很多，
   首次加载与每句延迟都可能翻倍。

**对 spec 的影响**：§3.12 的 `concurrency: 1` 是对的，但需要补充
「预取是必需品而非优化」；§4 的 UI 需要「正在准备模型…（首次约十几秒）」
这类诚实提示；§6 的退路（标注很慢 / 标为实验性）要升级为**默认行为的一部分**。

---

## 🔴 需要用户决策：中文是否在 P4 范围内

实测结论：**kokoro-js 走标准路径只能出英文**。中文要么不做，要么自建管线。

| | 方案 A：只做英文 | 方案 B：英文 + 中文 |
|---|---|---|
| 音色 | 28 个（en-US / en-GB） | +8 个中文 |
| 实现 | `tts.generate()` 直接用 | 中文走 `generate_from_ids()` 绕道 |
| 额外依赖 | 无 | `pinyin-pro` 1.1MB + 7KB 音节表 |
| 额外工作量 | — | 约 1 天（已实测打通，风险低） |
| 音质 | 官方支持，有保证 | **未经试听验证**（无法在无音频输出的环境判断） |
| 风险 | 低 | 中：管线通了，但中文自然度未知 |

---

# 追加调研：其他模型的中文能力与耗时（2026-09-30）

起因：Kokoro 中文既慢（RTF 1.45）又只是「绕道打通」，值得看替代方案。
**全部为真机实测**（Apple M 系列，onnxruntime-web WASM，`numThreads=1`）。

## 结论速览

| 模型 | 中文 | 声调 | 体积 | RTF（实测） | 管线 |
|---|---|---|---|---|---|
| **Kokoro 82M** | ✅ 8 音色 | ✅ 箭头 | 92.4MB | **1.45** | 复杂：misaki 移植 + 7KB 表 + 绕道 `generate_from_ids` |
| **Piper zh_CN-chaowen-medium** | ✅ | ✅ 数字 | 63.2MB | **0.115–0.12** | **简单：拼音直接喂** |
| **Piper zh_CN-xiao_ya-medium** | ✅ | ✅ 数字 | 63.2MB | 未测（同架构） | 简单 |
| **Piper zh_CN-huayan-x_low** | ✅ | ❌ **丢失** | **20.6MB** | **0.075–0.12** | 简单 |
| **Piper zh_CN-huayan-medium** | ✅ | ❌ 丢失 | 63.2MB | 未测 | 简单 |
| **MMS-TTS (VITS)** | ❌ 无中文 | — | 38.4MB | — | transformers.js 原生；**CC-BY-NC-4.0 不可商用** |
| **Kitten TTS nano 0.8** | ❌ 英文 | — | 24MB | — | 需自写 StyleTTS2 |
| **SpeechT5** | ❌ 英文 | — | 342.8MB | — | transformers.js 原生 |
| **sherpa-onnx vits-zh-hf-fanchen-{C,wnj}** | ✅ | 未确认 | 116MB / 115MB | 未测 | ONNX 可用，但运行时是 C++ |

## 🔴 关键发现 1：Piper 的中文模型分两类，差别是**声调**

Piper 的 4 个中文模型分两组，配置里的 `espeak.voice` 不同：

| 模型 | `espeak.voice` | 音素表符号数 | 声调符号 |
|---|---|---|---|
| `huayan` x_low / medium | **`cmn`** | 130 | ❌ **无** |
| `chaowen` medium | **`zh`** | 85 | ✅ 数字 `1 2 3 4 5` |
| `xiao_ya` medium | **`zh`** | 85 | ✅ 数字 `1 2 3 4 5` |

### huayan 是无声调的（实测证据）

决定性实验——最小对立对（只有声调不同）：

```
妈(ma1) → 音素 id 1,25,0,120,0,51,0,2
骂(ma4) → 音素 id 1,25,0,120,0,51,0,2     ← 完全相同
```

**模型收到的输入一模一样，物理上不可能区分「妈」和「骂」。**

对照实验（排除「音频长度差 = 声调」的误读）：同一句跑两次，音频长度
4864 vs 7936 —— 模型带 `noise_scale: 0.667` 的随机噪声，长度本来就抖。
所以之前观察到的长度差是噪声，不是声调。

（另有 `麻(ma2)` 与 `马(ma3)` 的音素序列确实不同，那是 espeak `cmn`
对二声输出双元音 `ɑɜ` 的副作用，不是系统的声调支持。）

### chaowen / xiao_ya 是有声调的，而且**直接吃拼音**

看 chaowen 的 85 个音素符号：

```
! $ , . 1 2 3 4 5 : ; ? ^ _ a ai an ang ao b c ch d e ei en eng er f g h i
ia ian iang iao ie in ing iong iu j k l m n o ong ou p q r s sh t u ua uai
uan uang ue ueng ui un uo v van ve vn w x y z zh Ø — … 、 。 ！ ， ： ； ？
```

**这不是 IPA，是拼音声母/韵母 + 声调数字**（`v/van/ve/vn` = ü/üan/üe/ün）。
也就是说**不需要 espeak 音素化，把拼音直接映射到 id 就行**。

实测声调可区分（四个声调 id 互不相同 ✅）：

```
妈 ma1 → m a 1        麻 ma2 → m a 2
马 ma3 → m a 3        骂 ma4 → m a 4
```

复杂音节切分实测全对（贪心最长匹配）：

```
绝 jue2 → j ue 2      绿 lü4  → l v 4      云 yun2  → y un 2
水 shui3 → sh ui 3    六 liu4 → l iu 4     略 lüe4 → l ve 4
双 shuang1 → sh uang 1                熊 xiong2 → x iong 2
```

唯一缺口：轻声 `men0` 的 `0` 不在表里（表用 `5`），映射 `0 → 5` 即可。

## 🔴 关键发现 2：Piper 比 Kokoro 快一个数量级

| 句子 | Kokoro RTF | Piper chaowen RTF | 倍数 |
|---|---|---|---|
| 你好世界。 | 1.45（稳态） | **0.118** | **12×** |
| 这是一段中文测试。 | 1.45 | **0.117** | 12× |
| 今天天气很好，我们去公园散步吧。 | 1.45 | **0.120** | 12× |
| 他说：“我明天要去北京。” | — | **0.115** | — |

绝对耗时（chaowen）：210 / 402 / 621 / 399 ms。
对比 Kokoro 的 2,102–12,191 ms。**Piper 是 RTF < 1（比实时快），
Kokoro 是 RTF > 1（比实时慢）。**

Piper `huayan-x_low` 更快（RTF 0.075–0.119）且只有 20.6MB，但无声调。

## 许可

- **chaowen**：数据集是 **CC0**（`github.com/OHF-Voice/voice-datasets`），
  且是**从 xiao_ya 微调**而来 —— **许可干净**，上架友好。
- **huayan**：数据集 `PlayVoice/HuaYan_TTS`，**License: Unknown** —— 有风险。
- Piper 代码本身是 MIT。

## 对 P4 选型的影响（待用户决策）

**Piper chaowen 在中文上几乎全面优于 Kokoro**：

| | Kokoro | Piper chaowen |
|---|---|---|
| 体积 | 92.4MB | **63.2MB** |
| RTF | 1.45 | **0.115**（12× 快） |
| 声调 | ✅ | ✅ |
| 管线 | misaki 移植 + 7KB 表 + 绕道 API | **拼音直接查表** |
| 依赖 | kokoro-js + transformers.js + phonemizer | **只需 onnxruntime-web + pinyin-pro** |
| 许可 | Apache-2.0 | CC0 数据集 + MIT 代码 |
| 包体 | +21MB（ORT jsep wasm）+ 3.1MB | **+21MB（ORT）+ 1.1MB** |

**代价与未验证项**：
- **音质未知**——无法在无音频输出的环境判断（V22 类问题，必须用户听）。
- Piper 的中文只有 4 个音色（chaowen / xiao_ya / huayan×2），
  Kokoro 有 8 个。
- 英文侧：Piper 有 21 个英文音色族（low/medium 约 63MB），
  但英文需要 espeak-ng 音素化（正好就是已有的 `phonemizer` 依赖）。
  若中英文都用 Piper，则**可以完全不依赖 kokoro-js / transformers.js**。
- **不测不知道 chaowen 的实际听感**。P4 原计划的 misaki 管线已实测打通，
  作为「已知可行」的退路保留。

---

## 四个 Piper 中文模型全部实测完毕（2026-09-30）

| 模型 | espeak voice | 音素表符号 | 声调 | 输入类型 | 采样率 | 体积 | **平均 RTF** |
|---|---|---|---|---|---|---|---|
| `zh_CN-huayan-x_low` | `cmn` | 130 | ❌ **无** | espeak IPA | 16k | **20.6MB** | **0.086** |
| `zh_CN-huayan-medium` | `cmn` | 152 | ✅ | espeak IPA | 22.05k | 63.2MB | 0.132 |
| `zh_CN-chaowen-medium` | `zh` | 85 | ✅ | **拼音直喂** | 22.05k | 63.2MB | **0.118** |
| `zh_CN-xiao_ya-medium` | `zh` | 85 | ✅ | **拼音直喂** | 22.05k | 63.2MB | **0.115** |
| （对照）Kokoro 82M | — | — | ✅ 箭头 | misaki 管线 | 24k | 92.4MB | **1.463** |

**修正上一节的结论**：无声调的**只有 `huayan-x_low`**（20.6MB 那个）。
`huayan-medium` 的音素表有 152 个符号、**包含声调数字**，所以它是有声调的。
之前只检查了 x_low 就推断整组无声调，是不准确的——两者配置不同（x_low 130 符号 / medium 152 符号）。

RTF 逐句（同一组 5 句）：

| 模型 | 句1 | 句2 | 句3 | 句4 | 句5 |
|---|---|---|---|---|---|
| Kokoro | 1.485 | 1.452 | 1.469 | 1.446 | 1.461 |
| chaowen | 0.116 | 0.123 | 0.116 | 0.119 | 0.117 |
| xiao_ya | 0.119 | 0.113 | 0.115 | 0.114 | 0.113 |
| huayan-medium | 0.131 | 0.128 | 0.135 | 0.130 | 0.134 |
| huayan-x_low | 0.105 | 0.097 | 0.080 | 0.075 | 0.075 |

**全部 Piper 模型都是 RTF < 1（比实时快），Kokoro 是 RTF ≈ 1.46（比实时慢）。**

## A/B 试听包

- 位置：`~/Dev/tts-ng/.ab-listen/`（已加进 `.gitignore`）
- 本地 HTTP：`http://127.0.0.1:8899/index.html`（若已停，`python3 -m http.server 8899 --directory ~/Dev/tts-ng/.ab-listen`）
- 也可直接 `file://` 打开 `index.html`（已实测 25/25 音频可加载）
- 内容：5 个句子 × 5 个模型 = 25 个 WAV，同一段文字
  - 句 1 短句（你好，欢迎使用本地语音。）
  - **句 2 声调最小对立组（妈麻马骂，四个声调。）** ← 关键
  - 句 3 长句（连续朗读流畅度）
  - 句 4 数字（第 3 季度…15.6%）
  - 句 5 中英混排（API / PDF）
- 生成脚本：`/tmp/p4verify/piper/gen-piper.mjs`、`/tmp/p4verify/gen-kokoro.mjs`

**待用户听完后决定选型。**

---

# 🔴 重大修正：WebGPU 加速完全可用，V20 的结论是错的（2026-10-01）

## 起因

用户问「webgl webgpu 加速不能用吗」。回查 catm 的 CI 注释发现：

> `macos-14` … the only free-tier runner where Chromium's Metal-via-ANGLE WebGPU path
> actually works — synth completes in ~10s here. Ubuntu + Mesa lavapipe … too slow.
> **Without real GPU, Kokoro falls back to WASM which is 10-30× slower than WebGPU.**

catm 实测 WebGPU 比 WASM 快 10–30 倍，而我测出 1.44 vs 1.45（几乎相同）——
说明我的测试有问题。

## 根因：我用了 `q8`，而 catm 默认 `fp32`

`q8` 量化模型在 ORT WebGPU 上需要反量化算子，那些算子**回退 CPU**，
把 GPU 加速全部吃掉。ORT 的日志一直在提示这件事：
`Some nodes were not assigned to the preferred execution providers`。

## 实测矩阵（真机 Apple M 系列，同一组 5 句）

| dtype | 后端 | 平均 RTF | 逐句耗时（ms） | 体积 |
|---|---|---|---|---|
| `q8` | wasm | 1.454 | 4251 / 3758 / 10193 / 3958 / 4294 | 92.4MB |
| `q8` | webgpu | 1.433 | 4354 / 3924 / 12293 / 3291 / 4765 | 92.4MB |
| `fp16` | wasm | 1.136 | 3173 / 3022 / 8083 / 3162 / 3401 | 163.2MB |
| **`fp16`** | **webgpu** | **0.15–0.26** | **469 / 373 / 989 / 462 / 417** | 163.2MB |
| `fp32` | wasm | 1.138 | 3311 / 3017 / 8069 / 3085 / 3384 | 325.5MB |
| **`fp32`** | **webgpu** | **0.158–0.178** | **487 / 435 / 1061 / 382 / 498** | 325.5MB |

**三条结论**：

1. **`q8` + WebGPU 毫无收益**（1.433 vs wasm 1.454）。这是最初搞错的原因。
2. **WebGPU 只在 fp16/fp32 下有效**，效果 **6–8 倍**，且**比实时快 5–6 倍**。
3. **没有 WebGPU 时三种 dtype 差不多**（1.14–1.45）——那才是真的慢。

**首句没有冷启动惩罚**：webgpu/fp32 首句 487ms、稳态 382–498ms（shader 编译
在 session 建立时完成）。对比 wasm 首句 3,311ms —— **快 6.8 倍**。

## offscreen 文档里复测（真实上下文）

用扩展 + offscreen 文档（`reasons: ['AUDIO_PLAYBACK']`）+ 本地 HTTP 喂模型：

```json
{
  "context": "offscreen",
  "adapter": "apple/metal-3",
  "shaderF16": true,
  "crossOriginIsolated": false,
  "wasm/fp32":   { "rtf": 1.119, "runs": [3260, 2977] },
  "webgpu/fp32": { "rtf": 0.178, "runs": [594, 403] }
}
```

**WebGPU 在 offscreen 里快 6.3 倍。** 所以修正后的结论在真实上下文成立。

## ⚠️ 附带发现：offscreen 文档 30 秒被回收

实测时间线：`9s 创建 → 18s 存活 → 27s 存活 → 30s 消失`。

`AUDIO_PLAYBACK` 理由下，**无音频播放 30 秒整被回收**（与 P3 记录一致）。
第一版探测要拉 325MB 再跑 20 次推理，被杀在途中，所以一直拿不到结果。

**对 P4 的含义**：
- 真实设计里 offscreen 只做「从缓存读模型 + 建 session + 合成」= 1–2 秒，安全。
- **但若模型没下好，offscreen 会去下载（几分钟）→ 中途被杀。**
  这是 §3.6「下载器跑在侧边栏」的实测依据。
- 实验里保活手法：offscreen 里跑一个 `gain = 0.0001` 的振荡器（几乎无声）。

## 用户界定的范围

**模型下载不计入启动时间**——下载是「模型」标签页里的独立步骤，
用户先做好。播放路径可以假设模型已就绪。
（我早期把下载与启动混在一起叙述，框架是错的。）

## 教训

**dtype 与执行后端是耦合的，固定一个测另一个会得出错误结论。**
只测了 `q8`（唯一一个 WebGPU 无效的档）就写下了「WebGPU 与 WASM 几乎同速」
和「预取是必需品」——两条都错了。
**性能结论必须把「体积/精度档位」当作测试变量，不能当常数。**
