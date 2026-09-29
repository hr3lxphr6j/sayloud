# SayLoud 设计规格（M1）

- 日期：2026-09-29
- 状态：待审阅
- 名称：SayLoud（中文商店名「SayLoud 朗读」）

## 0. 概述

### 0.1 目标

一款交互对标 Speechify 的 Chrome 网页朗读扩展，由用户自带 API key（BYOK）调用线上或本地的语音合成服务。

- MIT 开源，完全免费，没有自建后端，发布到 Chrome 应用商店。
- 界面中英双语。

### 0.2 本期范围

包含：

- **整页朗读**：自动提取正文，在原文上做句级和词级高亮，自动滚动，点击句子可跳读。
- **Side Player 竖条**：嵌在网页里，负责全部进度控制。
- **Paragraph Play**：鼠标悬停段落时出现按钮，点击后从该段开始读。
- **划词朗读**：通过选区按钮、右键菜单或快捷键朗读选中文字。
- **5 类语音服务**：阿里云百炼、OpenAI 兼容端点（含本地服务）、ElevenLabs、Azure、浏览器内置语音。
- **Chrome 原生侧边栏**：只放设置。
- **本地音频缓存**：内存加 IndexedDB 两层。

不包含：

- PDF / EPUB / 文件阅读
- Google Docs 和 canvas 渲染的文字、OCR
- iframe 内的内容，以及页面自身 shadow DOM 里的文字
- Listening Bar、AI 摘要/助手、语音输入、Library、账号体系
- Firefox

### 0.3 成功标准

- 在主流文章页上一键开始朗读，使用云端服务时首句 2 秒内出声。
- 在支持时间戳的服务上，逐词高亮与语音同步。不支持的服务，句级高亮必须准确，逐词位置按估算显示。
- 读长文（1 万字以上）中途不断档，跳转、变速、换音色都能即时生效。
- 一次通过 Chrome 应用商店审核。

### 0.4 技术栈

- WXT + TypeScript（strict）+ Preact
- Vitest + happy-dom + MSW；Playwright 做端到端测试
- Biome 做 lint 和格式化；GitHub Actions 做 CI

选 Preact 是因为 UI 要注入到每个页面，体积很重要。

## 1. 整体架构

```
网页 tab（content script，按需注入；UI 全部在 Shadow DOM，不改页面 DOM）
  Extractor    提取正文 → Block/句子，保留字符偏移 → DOM Range 映射
  Segmenter    Intl.Segmenter 分句、分词
  Highlighter  CSS Custom Highlight API（当前句 / 当前词）
  SidePlayer   竖条：剩余时间 · 播放/暂停 · 上一句/下一句 · 音色 · 倍速 · 齿轮
  ParagraphPlay / SelectionButton
        ▲ 进度事件 {sentenceId, charStart, charEnd}     │ 指令 start/seek/pause/...
        │                                              ▼
Service Worker：会话路由（Port 按 tab）、右键菜单、快捷键、tab 生命周期、chrome.tts
        ▲                                              │
        │                                              ▼
Offscreen Document（reason: AUDIO_PLAYBACK）
  PlaybackEngine：会话状态机 · 预取 · 缓存 · 时间轴对齐 · 进度推送
  Providers：dashscope / openai-compat / elevenlabs / azure（browser 在 SW 中执行）

Chrome Side Panel：只放设置（按站点开关、音色语速、服务商与 key、主题、缓存、快捷键、帮助）
```

原则：

1. **播放状态只有一份，由 offscreen 持有。** Side Player 只是它的视图。SW 本身不保存状态，只在 `storage.session` 里存一份会话快照，SW 被回收后靠它恢复消息路由。
2. **key 和网络请求只在扩展进程里处理，不进入网页。** 请求只由 offscreen 和 SW 发出，读取 key 的代码也只在这两处。这样不受页面 CORS 和 CSP 限制。
3. **变速只用 `audio.playbackRate`。** 保持 `preservesPitch = true`，不通过请求参数让服务商调速。这样已合成的音频任何倍速都能复用，时间轴也自动按倍速缩放。
4. **权限最小化。**
   - 默认只用 activeTab：用户点工具栏图标、按快捷键或用右键菜单时，才向当前页注入脚本。
   - 服务商域名都放在 `optional_host_permissions` 里，用户配置该服务时再申请。
   - 「在所有网站自动显示 Side Player / Paragraph Play / 划词按钮」需要 `<all_urls>`，用户在设置里开启时才申请。开启后，用 `scripting.registerContentScripts` 动态注册脚本。
5. **齿轮按钮打开侧边栏。** 做法是在 content script 的点击事件里发消息给 SW，由 SW 调用 `chrome.sidePanel.open({tabId})`。这一步能否保留用户手势需要验证（见 §6 V1）。如果不能，齿轮改为打开 options 页（和侧边栏用同一套设置 UI）。

## 2. Provider 层

### 2.1 接口

```ts
interface WordTiming { charStart: number; charEnd: number; startMs: number; endMs: number }

interface SynthesisResult {
  audio: ArrayBuffer;
  mime: string;               // audio/mpeg | audio/ogg | audio/wav ...
  durationMs?: number;
  timings?: WordTiming[];     // 相对请求文本；缺失时由引擎估算
}

interface Voice { id: string; name: string; lang?: string; gender?: string; supportsTimings?: boolean }

interface Provider {
  id: 'dashscope' | 'openai-compat' | 'elevenlabs' | 'azure' | 'browser';
  kind: 'audio' | 'self-speaking';          // browser 由 chrome.tts 自己发声
  capabilities(cfg): { timings: 'exact' | 'none'; maxChars: number; concurrency: number };
  validate(cfg): Promise<void>;             // 设置页「测试连接」
  listVoices(cfg): Promise<Voice[]>;
  synthesize(req: { text: string; voiceId: string; model?: string; signal: AbortSignal }, cfg): Promise<SynthesisResult>;
}
```

- **整句为单位**：每句等完整缓冲后再播。流式接口（SSE）只在适配器内部拼接，不对引擎暴露。
- **时间戳统一换算**：由共用的 `alignTimings(sentenceText, rawMarks, kind)` 把各家时间戳统一换算成相对原句的字符偏移。
  - `offset`：服务直接给出偏移量，直接换算。
  - `sequential-words`：只给词文本，按顺序在原句里查找（跳过空白和标点）。
  - `chars`：字符级时间戳，按 `Intl.Segmenter` 的分词结果合并成词。
  - 对齐失败时返回 `undefined`，交给估算。
- **估算**：没有时间轴时，按每个词的字符数占整句的比例，分配整句时长。

### 2.2 适配器

| 适配器 | 调用 | 逐词时间 | 音色 | 配置 |
|---|---|---|---|---|
| dashscope | HTTP，`X-DashScope-SSE: enable`，拼接 base64 分片。CosyVoice / Qwen-Audio-TTS：`https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`；Qwen-TTS：`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（国际站用 `dashscope-intl`） | CosyVoice v3/v3.5 开启 `word_timestamp_enabled` 后精确，返回每个字的 `begin_index/end_index/begin_time/end_time`；只在流式模式下可用，只有部分音色支持 | 内置静态音色表，标注是否支持时间戳 | apiKey、workspaceId、region（cn-beijing / ap-southeast-1）、model |
| openai-compat | `POST {baseUrl}/audio/speech` | OpenAI 官方没有。Kokoro-FastAPI 预设改走它的带字幕接口 | 先请求 `GET {baseUrl}/audio/voices`，失败就用用户填写的列表 | 可配置多个实例：name、baseUrl、apiKey（可空）、model、voices、timestamps 预设 |
| elevenlabs | `POST /v1/text-to-speech/{voice}/with-timestamps` | 字符级，精确 | `GET /v1/voices` | apiKey、modelId |
| azure | Speech SDK（WebSocket），在 offscreen 里懒加载 | `WordBoundary` 事件，精确 | voices/list 接口 | key、region |
| browser | `chrome.tts.speak`（在 SW 中执行） | word 事件的 `charIndex` | `chrome.tts.getVoices()` | 无 |

各家限制与约定：

- **单次长度上限**：百炼的 CosyVoice 单次最多 600 字符，Qwen-TTS 最多 512 token。引擎按 `maxChars` 把长句切到上限以内，优先在逗号、分号处切分。
- **百炼的地域差异**：官方文档写明 CosyVoice 和 Qwen-Audio-TTS 的 HTTP 接口只开放北京地域。设置页选新加坡地域时，要提示哪些模型可用。
- **浏览器语音**：`chrome.tts` 在 offscreen 里调不到，所以放在 SW 里执行。引擎把它当成自己发声的 provider：指令经 SW 转发，word 事件回传后走同一套进度事件。

## 3. 正文提取、分句与高亮

### 3.1 提取

1. `document.cloneNode(true)` 克隆文档，同步遍历原文档和克隆文档，建立「克隆文本节点 → 原文本节点」的 WeakMap。
2. 在克隆上运行 Mozilla Readability，参数 `serializer: el => el`，让它直接返回节点。
3. 遍历结果里的文本节点，通过 WeakMap 找回原节点；找不到的跳过。
4. 按最近的块级祖先分组，每组算一个 Block（p、li、h1–h6、blockquote、td、figcaption、dd）。Block 保存：
   - 拼接后的文本
   - 「字符偏移 → (文本节点, 节点内偏移)」对照表，用来生成任意字符区间的 DOM Range
5. 默认跳过 `pre/code`（设置项 `skipCode`）、隐藏元素和脚注角标。
6. **兜底**：`isProbablyReaderable` 判为否时，从用户点击的段落（或视口里的第一个块）开始，按文档顺序收集块级元素。Paragraph Play 和划词在任何页面都能用。

### 3.2 分句与分词

- **分句分词**：用 `Intl.Segmenter`（granularity 分别为 sentence 和 word）。
- **语言判定**：取页面的 `lang` 属性，没有时用 `chrome.i18n.detectLanguage` 检测。
- **空白处理**：合并空白，同时保留偏移对照。
- **句子 id**：`docId:blockIndex:sentenceIndex`，只用于定位和进度，不用作缓存键。

### 3.3 高亮与交互

- **高亮实现**：
  - 用 CSS Custom Highlight API 建两个 Highlight：`sayloud-sentence` 和 `sayloud-word`。
  - `::highlight()` 的样式通过 `chrome.scripting.insertCSS` 注入，颜色可以在设置里调。
  - 对页面 DOM 唯一的改动，是挂 Side Player 用的那一个 shadow host。
- **自动滚动**：当前句离开视口时平滑滚回来。用户手动滚动后，自动滚动暂停 5 秒，竖条上显示「回到当前位置」。
- **点击跳读**：朗读期间单击正文里的句子，就从那句开始读（`caretPositionFromPoint` 定位）。
  - 点击链接、按钮、输入框、contenteditable，或者正在选中文字时不触发。
  - 设置项 `clickToSeek` 可以关闭。
- **动态页面**：高亮前检查 `node.isConnected`。节点已经断开时，按块文本在原位置附近重新定位一次；还是失败，就只停止这一块的高亮，音频照常播放。

### 3.4 Side Player 竖条

- **形态**：宽约 28px 的竖条，默认贴在视口右边缘，可拖动，靠近边缘时吸附，可收起成圆钮。位置按站点记住。
- **控件（自上而下）**：剩余时间、播放/暂停、上一句、下一句、音色（头像或国旗，点击弹出快速切换）、倍速（0.5×–3×，步长 0.1，同时显示 wpm 或「字/分」）、齿轮。
- **剩余时间**：先按「字符数 ÷ 该音色的基准语速」估算，每句实际播完后，用真实时长校正该音色的语速系数。
- **键盘与无障碍**：竖条获得焦点时，← / → 切换上一句/下一句，空格播放/暂停。所有控件都有 aria-label，可以用键盘操作。

### 3.5 Paragraph Play 与划词按钮

- **Paragraph Play**：鼠标悬停在正文块上 300ms 后，在块的左侧显示一个播放按钮。点击后从该块开始读，之后按正文顺序继续。
- **划词按钮**：选区稳定后显示在选区末端。点击只读选中部分，高亮照常显示。
- **右键菜单与快捷键**：「朗读选中文字」不依赖划词按钮，没开启自动显示时也能用。

## 4. 播放引擎、缓存、出错降级与设置存储

### 4.1 会话状态机

```
idle ──start(doc, cursor)──► loading ──首句就绪──► playing ⇄ paused
                               ▲                     │ 缓冲耗尽
                               └──── buffering ◄─────┘
playing ──最后一句结束──► ended
任意状态 ──stop / tab 关闭 / 页面跳转──► idle
任意状态 ──不可恢复错误──► error（保留 cursor，可重试）
```

- **单会话**：同一时间只有一个会话。在别的 tab 开始朗读，会先停掉当前会话。
- **会话内容**：`{tabId, docId, sentences[], cursor, voice, rate}`。句子列表由 content script 提取后一次性发送过来。
- **跳转**：上一句/下一句、Paragraph Play、点击跳读都直接设置 cursor。换音色时丢弃当前句的音频，从当前句重新开始读。变速只改 `playbackRate`。
- **结束会话**：页面跳转（`tabs.onUpdated` 的 url 变化）或 tab 关闭时，结束会话。

### 4.2 进度推送

- **推送方式**：offscreen 根据 `audio.currentTime` 和时间轴，用 `setTimeout` 定时到下一个词的开始时间，只在词切换时推送一次。offscreen 是隐藏页面，rAF 不会触发，所以不用 rAF。
- **消息链路**：content script 和 SW 之间每个 tab 一个长连接 Port，SW 再转发给 offscreen。
- **浏览器语音**：由 word 事件驱动，走同一个事件格式。

### 4.3 预取

- **合成速度**：每个音色记录合成速度 `rtf = 合成耗时 / 音频时长`，用指数加权平均，存到 `rtfStats`。
- **目标缓冲**：`12 × (1 + rate × rtf)` 秒，至少提前 2 句，最多 30 句。
- **并发数**：云端服务 2 路；baseUrl 是 localhost 或 127.0.0.1 时 1 路。
- **首句加速**：首句超过 100 字符时，先在第一个逗号处切出一小段，以缩短首次出声时间。
- **取消请求**：跳转到缓冲窗口之外，或者换音色时，用 `AbortController` 取消已失效的请求。

### 4.4 缓存

- **键**：`SHA-256(providerId, model, voiceId, 影响音色的参数, normalize(text))`。
  - `normalize` 做 Unicode NFC 加空白合并，不改标点，因为标点会影响语调。
  - 倍速不放进键里。
- **值**：`{audio: Blob, mime, timings?, durationMs, lastAccess}`。
- **L1**：offscreen 内存 LRU，约 50 句。
- **L2**：IndexedDB（扩展源下）。
  - 默认开启，上限 200MB。
  - 按 lastAccess 淘汰，超过 30 天未访问自动清理。
- **写入条件**：只缓存完整、成功的结果。
- **隐身窗口**：只用 L1。判断依据是发起请求的 tab 的 `incognito` 属性。
- **设置项**：持久缓存开关、占用空间显示、清除按钮，都写进隐私说明。

与 Speechify 的区别：Speechify 的缓存按「文档内位置 + generation」做键，只放在内存里，并且依赖句间上下文 token。我们接入的服务都是无状态的，所以按内容做键是安全的：重读、回跳、跨页面的相同段落都能命中。

### 4.5 出错与降级

| 类型 | 判定 | 处理 |
|---|---|---|
| 鉴权 | 401/403、key 为空 | 立即暂停。竖条提示「API key 无效」，附带打开设置的按钮 |
| 限流/额度 | 429、服务商的额度错误码 | 指数退避重试 2 次，仍失败就暂停并说明原因 |
| 网络/服务端 | 5xx、15 秒超时、断网 | 重试 2 次。断网时暂停，监听 `online` 事件后提示可以继续 |
| 单句被拒 | 400、内容审核 | 跳过该句并标记，继续读下一句 |
| 时间戳异常 | 缺失或对不齐 | 该句改用估算，不打断播放 |
| 高亮失效 | DOM 节点被替换 | 按 §3.3 处理 |

临时改用浏览器语音由 `fallbackToBrowser` 控制，默认值 `ask`：连续出错时提示框里提供「用浏览器语音继续」按钮。可以改为 `auto` 或 `never`。

### 4.6 设置存储

```ts
// chrome.storage.local（不同步；密钥只在这里）
providers: {
  dashscope?:   { apiKey: string; workspaceId?: string; region: 'cn-beijing' | 'ap-southeast-1' };
  openaiCompat: Array<{ id: string; name: string; baseUrl: string; apiKey?: string; model: string;
                        voices?: string[]; timestamps?: 'kokoro' }>;
  elevenlabs?:  { apiKey: string; modelId: string };
  azure?:       { key: string; region: string };
};
sites: Record<string /* host */, { sidePlayer?: boolean; paragraphPlay?: boolean;
                                   selectionButton?: boolean; playerPos?: { edge: 'left' | 'right'; top: number } }>;
rtfStats: Record<string /* provider:model:voice */, number>;
voiceListCache: Record<string /* providerId */, { voices: Voice[]; fetchedAt: number }>;

// chrome.storage.sync（跨设备同步，不含任何密钥）
prefs: {
  voice: { providerId: string; voiceId: string; model?: string };
  rate: number;
  theme: 'auto' | 'light' | 'dark';
  uiLang: 'auto' | 'zh-CN' | 'en';
  highlight: { sentence: string; word: string };
  autoScroll: boolean; clickToSeek: boolean; skipCode: boolean;
  autoShowEverywhere: boolean;
  cache: { persist: boolean; limitMB: number };
  fallbackToBrowser: 'ask' | 'auto' | 'never';
  schemaVersion: number;
};
```

- **key 的存储**：key 以明文存在 `storage.local`，本机加密没有实际意义，因为解密密钥也只能放在本机。网页读不到这里的数据。
- **content script 也能访问**：content script 在技术上也能访问 `storage.local`，所以我们的 content script 代码约定从不读取 `providers`。评审时要检查这一点。
- **版本迁移**：用 `schemaVersion` 做迁移。

## 5. 测试、国际化、快捷键与上架

### 5.1 测试

| 层 | 工具 | 覆盖内容 |
|---|---|---|
| 单元 | Vitest + happy-dom | 分句/分词；`alignTimings`（以各家的原始返回样本为 fixture）；偏移到 Range 的映射；缓存键规范化；预取计算；设置迁移 |
| Provider 契约 | Vitest + MSW | 每个适配器跑同一套用例：成功、401、429、5xx、超时、中途 abort、SSE 分片拼接、时间戳缺失 |
| 引擎状态机 | Vitest，注入假播放器和假时钟 | 按操作序列测：播放→跳转→换音色→暂停→恢复；预取中 abort；缓存淘汰后回跳；错误后重试 |
| 端到端 | Playwright 加载构建产物 | 本地静态页（中文、英文、混排、SPA 动态替换）+ 模拟 TTS 服务：一键朗读、逐词高亮推进、Paragraph Play、划词、点击跳读、设置持久化 |
| 真实服务冒烟 | 手动脚本，用环境变量里的 key | 每个 provider 合成一句并校验时间戳；不进 CI，发版前手动跑 |

CI（GitHub Actions）依次跑：typecheck → Biome → 单元测试 → e2e → 打包 zip。

### 5.2 国际化

- 用 WXT i18n（`_locales/zh_CN`、`_locales/en`），`uiLang` 设为 `auto` 时跟随浏览器语言。
- 商店标题、描述、截图各准备中英两套。
- 语速单位：英文等用 wpm，中日韩用「字/分」。

### 5.3 快捷键（`commands`）

| 命令 | 默认 |
|---|---|
| 朗读此页 / 播放暂停 | Alt+A |
| 朗读选中文字 | Alt+S |
| 打开设置 | 不设默认键 |

竖条获得焦点时，← / → 切换上一句/下一句，空格播放/暂停。这几个按键不占用 `commands` 的名额。

### 5.4 上架合规

- **权限**：`activeTab`、`scripting`、`offscreen`、`storage`、`unlimitedStorage`、`contextMenus`、`sidePanel`、`tts`。
- **可选权限**：`optional_host_permissions` 包含：
  - 各服务商域名：`*.aliyuncs.com`、`api.openai.com`、`api.elevenlabs.io`、`*.tts.speech.microsoft.com` 等
  - 用户自定义的 baseUrl，申请时按其 origin 动态请求
  - `<all_urls>`，用于「在所有网站自动显示」
- **单一用途**：朗读网页文字。
- **隐私说明**（GitHub Pages 中英版）：
  - 不收集数据，没有自建后端，没有统计分析。
  - 页面文本只发送给用户选择的服务商。
  - key 和音频缓存只保存在本机，可以随时清除。
- **不加载远程代码**：所有依赖打包进扩展。Azure Speech SDK 只在 offscreen 里懒加载。

### 5.5 交付物

- 扩展源码（MIT）。
- README（中英），包含各服务商 key 的获取方式和本地 Kokoro-FastAPI 的配置示例。
- 隐私说明页。
- 商店素材（中英）。

## 6. 实现前需要验证的点

以下都用一次性脚本验证，结论写回本文档。验证代码不保留。

| # | 问题 | 不成立时的退路 |
|---|---|---|
| V1 | content script 点击 → SW 调用 `sidePanel.open()`，用户手势能否保留 | 齿轮改为打开 options 页 |
| V2 | offscreen（AUDIO_PLAYBACK）不需要用户手势能否直接播放；暂停超过约 30 秒后是否会被关闭 | 恢复播放时重建 offscreen，并从 cursor 所在句重新开始 |
| V3 | `chrome.tts` 在 SW 里连续朗读时，SW 会不会被回收，导致 word 事件丢失 | 朗读期间用 Port 让 SW 保持活跃 |
| V4 | CosyVoice SSE 的 `words` 与传入的一句文本能否稳定对齐；服务端是否会再切句（`sentence.index` 大于 0） | 引擎合并多个 sentence，并按累计偏移换算 |
| V5 | workspace 专属域名在 `chrome-extension://` 源下的 CORS 或 host 权限行为 | 退回 `dashscope.aliyuncs.com` 通用域名 |
| V6 | Azure Speech SDK 在 MV3 offscreen 里用订阅 key 能否连接（浏览器 WebSocket 不能设置请求头，需要确认 SDK 走 query 参数还是先换取 token） | 先请求 `issueToken` 换取 token，再连接 |
| V7 | Kokoro-FastAPI 带字幕接口的路径和返回格式 | 按 OpenAI 兼容方式处理，逐词位置用估算 |
| V8 | ElevenLabs `with-timestamps` 的请求和返回字段 | 以官方文档为准，调整适配器 |

## 附录 A：调研摘要

### A.1 现有开源项目

没有一个同时满足「Speechify 交互 + BYOK + 支持百炼」：

- **ken107/read-aloud**（MIT，1.7k star）：支持 OpenAI 兼容端点，但没有页面内竖条和原文逐词高亮。
- **gastonche/read-aloud**（MIT）：交互最接近 Speechify，但 key 放在 Cloudflare Worker 后端。
- **Read-It-Out**：没有 LICENSE。
- **cloud-speech**：source-available，不是开源许可；只支持划词朗读。

### A.2 Speechify 14.10.0 的实现

以下来自对本机安装包的静态阅读，只借鉴思路，不复制代码。

- **音频**：请求自家的 `audio.api.speechify.com/v3/synthesis/{get,stream}`，返回 protobuf。每个词带字符偏移和毫秒时间标记；请求中带上一句的 context_token 和下一句的文本，让句间语调连贯。
- **播放**：在 offscreen 里用 `<audio>` 或 `MediaSource` 播放，用 `playbackRate` 变速。
- **缓存**：内存 LRU，键为 `playableId::generation`，容量 5–30 条，不做持久化。
- **预取**：按音色实测 RTF 计算缓冲目标：`12 × (rate / rtf + 1)` 秒，最多 30 句。
- **高亮**：body 下放一个全高覆盖层，配合 `mix-blend-mode` 画矩形；部分页面用 Houdini paint worklet。
- **正文提取**：在 offscreen 里跑 ONNX 模型。
- **PDF**：检测到 PDF 后，把页面换成扩展自带的 pdf.js 阅读器页面。
- **Google Docs**：在 MAIN world 注入 `_docs_annotate_canvas_by_ext` 标记，Docs 会额外输出带文字的标注节点。据称这个标记只对白名单扩展生效（未验证）。
- **其他 canvas 或图片**：截图后上传到云端 OCR。

### A.3 百炼接入要点

- **接入形态**：HTTP 非流式返回音频 URL（24 小时有效）；HTTP SSE 返回 base64 分片；另有 WebSocket 接口。
- **鉴权**：`Authorization: Bearer <API Key>`。浏览器原生 WebSocket 不能设置请求头，所以本期只走 HTTP。
- **CORS**：实测 `dashscope.aliyuncs.com` 的 CORS 预检会回显 `chrome-extension://` 源。
- **协议**：不兼容 OpenAI 的 `/audio/speech`，需要单独写适配器。
