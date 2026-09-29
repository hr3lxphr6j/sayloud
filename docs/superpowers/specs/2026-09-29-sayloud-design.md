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
- **6 类语音服务**：阿里云百炼、火山引擎豆包语音（剪映同款音色）、OpenAI 兼容端点（含本地服务）、ElevenLabs、Azure、浏览器内置语音。
- **Chrome 原生侧边栏**：只放设置，分「朗读」「设置」两个标签页。
- **首次使用零配置**：默认用浏览器内置语音，装完就能读。
- **本地音频缓存**：内存加 IndexedDB 两层。

不包含：

- PDF / EPUB / 文件阅读
- Google Docs 和 canvas 渲染的文字、OCR
- iframe 内的内容，以及页面自身 shadow DOM 里的文字
- Listening Bar、AI 摘要/助手、语音输入、Library、账号体系
- Firefox

### 0.3 成功标准

- 在主流文章页上一键开始朗读，使用云端服务时首句 2 秒内出声。
- 句级高亮在所有服务上都必须与语音同步。服务返回逐词时间戳时，额外显示逐词高亮；不返回时只显示句级，不做估算。
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
  SidePlayer   28px 竖条：进度环 · 播放/暂停 · 上一句/下一句 · 音色 · 倍速 · 齿轮
  BubbleCard   气泡卡片：鉴权失败 / 服务未开通 / 回到当前位置 / 自动播放被拒
  ParagraphPlay（行首内嵌按钮）/ SelectionButton（纯图标圆钮）
        ▲ 进度事件 {sentenceId, charStart, charEnd}     │ 指令 start/seek/pause/...
        │                                              ▼
Service Worker
  PlaybackEngine：会话状态机 · 预取调度 · 进度推送（纯 TS，不直接依赖 chrome API）
  SessionRouter：Port 按 tab、右键菜单、快捷键、tab 生命周期、storage.session 快照
  BrowserSpeaker：chrome.tts
        ▲                                              │
        │ 单句时间事件                                  ▼ 合成/播放单句
Offscreen Document（reason: AUDIO_PLAYBACK，P2 起）
  AudioWorker：Providers（dashscope / volcengine / openai-compat / elevenlabs / azure）· 缓存 · 时间轴对齐 · <audio> 播放

Chrome Side Panel：只放设置，分「朗读」「设置」两个标签页（§3.6）。不放进度控制
```

原则：

1. **播放状态只有一份，由 SW 里的 PlaybackEngine 持有。** Side Player 只是它的视图。每次状态变化都把会话快照写进 `storage.session`；SW 被回收后从快照恢复，恢复后一律是暂停状态。offscreen 不持有会话状态，只负责合成、缓存和播放单句音频，被关掉就重建（§6 V2）。浏览器语音由 `chrome.tts` 在 SW 里直接发声，两类服务走同一个引擎。
2. **key 和网络请求只在扩展进程里处理，不进入网页。** 请求只由 offscreen 和 SW 发出，读取 key 的代码也只在这两处。这样不受页面 CORS 和 CSP 限制。
3. **变速只用 `audio.playbackRate`。** 保持 `preservesPitch = true`，不通过请求参数让服务商调速。这样已合成的音频任何倍速都能复用，时间轴也自动按倍速缩放。
4. **权限最小化。**
   - 默认只用 activeTab：用户点工具栏图标、按快捷键或用右键菜单时，才向当前页注入脚本。
   - 服务商域名都放在 `optional_host_permissions` 里，用户配置该服务时再申请。
   - 「在所有网站自动显示 Side Player / Paragraph Play / 划词按钮」需要 `<all_urls>`，用户在设置里开启时才申请。开启后，用 `scripting.registerContentScripts` 动态注册脚本。
5. **齿轮按钮打开侧边栏。** 在 content script 的点击处理函数里同步调用 `sendMessage`，SW 收到后同步调用 `chrome.sidePanel.open({tabId})`，中间不能有 await。已实测可行（见 §6 V1）。如果调用失败，比如手势已经过期，就降级为打开 options 页（和侧边栏用同一套设置 UI）。

## 2. Provider 层

### 2.1 接口

```ts
interface WordTiming { charStart: number; charEnd: number; startMs: number; endMs: number }

interface SynthesisResult {
  audio: ArrayBuffer;
  mime: string;               // audio/mpeg | audio/ogg | audio/wav ...
  durationMs?: number;
  timings?: WordTiming[];     // 相对请求文本；缺失时只做句级高亮
}

interface Voice { id: string; name: string; lang?: string; gender?: string; supportsTimings?: boolean }

interface Provider {
  id: 'dashscope' | 'volcengine' | 'openai-compat' | 'elevenlabs' | 'azure' | 'browser';
  kind: 'audio' | 'self-speaking';          // browser 由 chrome.tts 自己发声
  capabilities(cfg): { timings: 'exact' | 'none'; maxChars: number; concurrency: number };
  validate(cfg): Promise<void>;             // 设置页「测试连接」
  listVoices(cfg): Promise<Voice[]>;
  synthesize(req: { text: string; voiceId: string; model?: string; signal: AbortSignal }, cfg): Promise<SynthesisResult>;
}
```

- **整句为单位**：每句等完整缓冲后再播。流式接口（SSE）只在适配器内部拼接，不对引擎暴露。
- **时间戳统一换算**：由共用的 `alignTimings(sentenceText, rawMarks, kind)` 把各家时间戳统一换算成相对原句的字符偏移。
  - `offset`：服务直接给出原文字符偏移（Azure `WordBoundary`、chrome.tts `charIndex`），直接换算。
  - `sequential-words`：只给词文本和词序号（CosyVoice 的 `begin_index` 是词序号，不是字符偏移；Kokoro 同理），按顺序在原句里查找（跳过空白和标点）。服务端会把数字、缩写、URL 规范化，比如 "1.27" 变成 "一点二七"，"Mr." 变成 "Mister"，对不上的词直接跳过，不插值：这几个词播放时不显示词级高亮，句级高亮不受影响。
  - `chars`：字符级时间戳，按 `Intl.Segmenter` 的分词结果合并成词。
  - 对齐失败时返回 `undefined`，该句只做句级高亮。
- **不做估算**：没有时间戳的服务（OpenAI 官方、Qwen-TTS、豆包 2.0、Kokoro 中文音色等）只显示句级高亮，不按字数推算词的位置。

### 2.2 适配器

| 适配器 | 调用 | 逐词时间 | 音色 | 配置 |
|---|---|---|---|---|
| dashscope | HTTP，`X-DashScope-SSE: enable`，拼接 base64 分片。CosyVoice / Qwen-Audio-TTS：`https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`；Qwen-TTS：`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（国际站用 `dashscope-intl`） | CosyVoice v3/v3.5 开启 `word_timestamp_enabled` 后精确，返回每个字的 `begin_index/end_index/begin_time/end_time`；只在流式模式下可用，只有部分音色支持 | 内置静态音色表，标注是否支持时间戳 | apiKey、workspaceId、region（cn-beijing / ap-southeast-1）、model |
| volcengine | `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`（HTTP chunked，逐行 JSON），请求头 `X-Api-Key` + `X-Api-Resource-Id`（`seed-tts-2.0` / `seed-tts-1.0` / `seed-icl-2.0`，同时决定模型版本和计费方式） | 仅 TTS 1.0 音色：`enable_timestamp` 返回字/词级时间戳，跟在 `TTSSentenceEnd` 事件里，只支持中英文；2.0 音色只做句级高亮 | 内置静态音色表，按 1.0 / 2.0 分组，标注是否支持时间戳 | apiKey、resourceId、speaker |
| openai-compat | `POST {baseUrl}/audio/speech` | OpenAI 官方没有。Kokoro-FastAPI 预设改走 `POST {origin}/dev/captioned_speech`（`stream:false`），返回逐词时间，单位是秒；它会规范化文本，按 `sequential-words` 对齐，对不上的词跳过。中文音色没有时间戳，只做句级高亮 | 先请求 `GET {baseUrl}/audio/voices`，失败就用用户填写的列表 | 可配置多个实例：name、baseUrl、apiKey（可空）、model、voices、timestamps 预设 |
| elevenlabs | `POST /v1/text-to-speech/{voice}/with-timestamps`，请求头 `xi-api-key`，返回 `{audio_base64, alignment}` | 字符级，精确。用 `alignment` 的三个并行数组，按 `chars` 合并成词；不传 `previous_text`/`next_text` | `GET /v1/voices` | apiKey、modelId |
| azure | Speech SDK（WebSocket），在 offscreen 里懒加载；浏览器环境下订阅 key 拼在 wss URL 的 query 里，日志不能打印完整 URL | `WordBoundary` 事件，精确 | voices/list 接口 | key、region |
| browser | `chrome.tts.speak`（在 SW 中执行） | word 事件的 `charIndex` | `chrome.tts.getVoices()` | 无 |

各家限制与约定：

- **单次长度上限**：百炼的 CosyVoice 单次最多 600 字符，Qwen-TTS 最多 512 token。引擎按 `maxChars` 把长句切到上限以内，优先在逗号、分号处切分。dashscope 的 `maxChars` 取 200，低于服务端自行切句的长度（§6 V4）。适配器仍要能合并多个 `sentence.index`，以防万一。
- **服务未开通**：豆包返回 `45000030 requested resource not granted`、百炼返回模型未开通一类错误时，归为「服务未开通」，和「key 无效」分开提示，并附上控制台链接。
- **豆包的鉴权方式**：只支持新版控制台的 `X-Api-Key` 鉴权；旧版控制台的 AppId + Access Token 本期不支持。
- **豆包的句间上下文**：2.0 的 `section_id`（跨请求关联上下文）本期不用。原因是它会让同一段文本在不同上下文里生成不同音频，与按内容寻址的缓存冲突。
- **百炼的地域差异**：官方文档写明 CosyVoice 和 Qwen-Audio-TTS 的 HTTP 接口只开放北京地域。设置页选新加坡地域时，要提示哪些模型可用。
- **浏览器语音**：`chrome.tts` 在 offscreen 里调不到，所以放在 SW 里执行。引擎把它当成自己发声的 provider：指令经 SW 转发，word 事件回传后走同一套进度事件。

### 2.3 配置表单由 schema 驱动

六家服务商的配置字段各不相同，界面统一由数据描述渲染。新增一家服务商只写数据，不写界面代码。

```ts
interface ProviderField {
  key: string;
  type: 'password' | 'text' | 'url' | 'select' | 'tags' | 'switch';
  label: string;                    // i18n 键
  required?: boolean;
  secret?: boolean;                 // 只存 storage.local；content script 永不读取
  placeholder?: string;
  hint?: string;                    // 字段下方的灰色说明
  options?: { value: string; label: string }[];
  layout?: 'full' | 'segmented';    // segmented 用于 2–3 个选项
  pattern?: string;                 // 格式校验，如 Azure region
  defaultValue?: string | boolean;
}

interface ProviderDescriptor {
  id: 'dashscope' | 'volcengine' | 'openai-compat' | 'elevenlabs' | 'azure' | 'browser';
  name: string;                     // i18n 键
  fields: ProviderField[];          // browser 为 []
  capabilities: { timings: 'exact' | 'sentence-only'; maxChars: number; concurrency: number };
  voices: { source: 'static' | 'remote'; endpoint?: string };
  help: { keyUrl: string; docsUrl: string };
}
```

- 界面元素（密码框的显示/隐藏、必填星号、分段控件、占位符、测试连接按钮）全部由 `type` 和 `layout` 决定。
- `secret: true` 是「绝不能出扩展进程」的标记。评审时据此检查 content script 不读取密钥（§4.6）。
- `capabilities.timings` 决定音色列表里标不标「支持逐词时间戳」（§3.6）。
- 错误码到错误类型的映射（鉴权 / 未开通 / 音色不匹配 / 限流）也在描述里声明，见 §4.5。
- 六种 `type` 覆盖当前六家服务商的全部字段。以后需要更特殊的控件（OAuth 授权按钮、文件上传）再加 `type`，老的服务商不受影响。

## 3. 正文提取、分句与界面

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

**高亮分层**：句级是基准，词级是可选增强。

- 用 CSS Custom Highlight API 建两个 Highlight：`sayloud-sentence` 和 `sayloud-word`。
- `::highlight()` 的样式通过 `chrome.scripting.insertCSS` 注入，颜色可以在设置里调。
- 句级高亮由「当前播到第几句」驱动，所有服务商都有。词级只在适配器返回了时间戳时叠加（§2.1）。
- **已读淡化**：读过的句子颜色变浅，一眼看出读到哪了。设置项 `dimRead` **默认关闭**；开启时只淡化最近 N 句（默认 5），避免读完后整页变灰。
- **深色页面**：同一套配色在深色页面上会刺眼。默认提供两套值（浅色页面句底 0.34、深色页面 0.24，词色分别用橙和暗金），设置项 `highlightAdaptive` 默认开启，按 `matchMedia('(prefers-color-scheme)')` 加页面背景亮度判断；关闭时用固定值。
- 对页面 DOM 唯一的改动，是挂 Side Player 用的那一个 shadow host。

- **自动滚动**：当前句离开视口时平滑滚回来。用户手动滚动后，自动滚动暂停 5 秒，竖条上显示「回到当前位置」。
- **点击跳读**：朗读期间单击正文里的句子，就从那句开始读（`caretPositionFromPoint` 定位）。
  - 点击链接、按钮、输入框、contenteditable，或者正在选中文字时不触发。
  - 设置项 `clickToSeek` 可以关闭。
- **动态页面**：高亮前检查 `node.isConnected`。节点已经断开时，按块文本在原位置附近重新定位一次；还是失败，就只停止这一块的高亮，音频照常播放。

### 3.4 Side Player 竖条

- **形态**：宽 28px 的单列竖条，默认贴在视口右边缘，可拖动，靠近边缘时吸附，可收起成圆钮。位置按站点记住。
- **控件（自上而下）**：剩余时间、播放/暂停、上一句、下一句、音色、倍速、齿轮。只有当前可用的控件是全不透明，其余降到 0.4。
- **剩余时间**：用进度环表示整页读到哪了，不额外占宽度；悬停或点击时用气泡卡片显示「还剩 12 分 30 秒」。时间先按「字符数 ÷ 该音色的基准语速」估算，每句实际播完后用真实时长校正该音色的语速系数。
- **状态**：播放中 / 暂停 / 首句加载中（播放键转圈）/ 出错（顶部换成红色感叹号）。28px 宽放不下文字，状态只靠图标变化表达。
- **提示用气泡卡片**：需要文字的地方（鉴权失败、服务未开通、音色与模型不匹配、回到当前位置、自动播放被拒）统一用气泡卡片，从竖条左侧弹出。卡片可放标题、说明和最多两个按钮；普通提示 6 秒后淡出、鼠标移上去停住，带按钮的提示不自动消失。
- **键盘与无障碍**：竖条获得焦点时，← / → 切换上一句/下一句，空格播放/暂停。所有控件都有 aria-label，可以用键盘操作。

### 3.5 Paragraph Play 与划词按钮

- **Paragraph Play**：鼠标悬停在正文块上 300ms 后，在该块第一行的行首插入一个 19px 的圆形播放按钮，同时该块轻微变色。点击后从该块开始读，之后按正文顺序继续。
  - 按钮嵌在文字流里（`inline-flex` 的 span，`user-select: none`），永远不会盖住别的内容。
  - 插入节点会改变文本流，所以插入前先记下该块的 `Range` 边界；如果插入后块的高度增加超过 1 行，就撤回按钮并改用浮层方式（`position: absolute` 压在行首）。
  - 鼠标移出或朗读结束后移除按钮。
- **划词按钮**：选区稳定后，在选区末端显示一个 22px 的纯图标圆钮（只有播放三角）。第一次出现时用气泡卡片提示一次「点这里朗读选中文字」，之后不再提示。点击只读选中部分，高亮照常显示。
- **右键菜单与快捷键**：「朗读选中文字」不依赖划词按钮，没开启自动显示时也能用。

### 3.6 设置面板（Chrome 侧边栏）

侧边栏只放设置，不放进度控制。进度控制始终只在页面上的竖条里，避免两处状态需要同步。

面板分两个标签页：

- **朗读**：日常要调的东西。
  - 当前音色卡片（头像、音色名、服务商、语速），点击进入音色选择页。
  - 语速滑块（0.5×–3×，步长 0.1，同时显示 wpm 或「字/分」）。
  - 本网站设置：显示竖条、段落播放按钮、划词朗读按钮三个开关，标题带当前域名。
  - 朗读偏好：点击正文跳读、自动滚回当前句、跳过代码块、已读淡化、出错时改用浏览器语音（先问我 / 自动 / 从不）。
- **设置**：配好就不动的东西。
  - 服务商与密钥（见下）。
  - 外观：主题（跟随系统 / 浅色 / 深色）、高亮颜色（自适应开关 + 句色 / 词色）。
  - 缓存：是否持久化、上限（默认 200MB）、当前占用、清除。
  - 快捷键、帮助与关于。

**服务商与密钥**：列表里每行是一个可用的语音服务，点一行在原地展开表单（不跳页、也不用抽屉），配好的收起并在右侧显示摘要。已配置绿点，未配置灰点，出错红点。摘要示例：「已配置 · 5 个音色」「服务未开通」。

OpenAI 兼容可以同时配多个实例（本地 Kokoro 一个、LocalAI 一个），**每个实例占一行**，和服务商同级平铺，行副标题标「OpenAI 兼容 · 127.0.0.1:8880」。列表底部是「+ 添加服务」。

**音色选择页**：点「更换」后面板整体切到列表页，带返回箭头（不是抽屉，也不是页面内浮层）。顶部是搜索框和语言筛选，每行显示头像、音色名、特征说明，以及「支持逐词时间戳 / 仅句级高亮」标签（由 `capabilities.timings` 决定），行尾是试听按钮。

### 3.7 首次使用

BYOK 的门槛在于用户装完手里没有 key，所以默认状态必须能直接朗读。

- **默认语音服务是浏览器内置语音**（`chrome.tts`）。装完点一下就能读，零配置。
- 侧边栏「朗读」标签页顶部显示一条提示条：「现在用的是浏览器自带语音，可以立即朗读。想要更自然的声音？配置云端服务。」右侧「配置 ›」跳到「设置」标签页的服务商列表。用户配好任一云端服务后，提示条消失。
- **申请 key 的步骤不写进扩展。** 服务商描述里只保留 `help.keyUrl` 和 `help.docsUrl`，界面上显示「去哪里找这些？↗」。分步指引写在仓库文档里（§5.5），因为各家控制台 UI 一直在变，写进扩展会在下次审核前就过期，而文档可以随时更新。
- 鉴权或开通失败时，气泡卡片按类型分流：key 无效 → 「打开设置」；服务未开通 → 「去控制台开通」外链；音色与模型不匹配 → 「更换音色」。

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
- **SW 被回收**：引擎每次状态变化都把 `{tabId, sentences, cursor, resumeOffset, voice, rate}` 写进 `storage.session`。SW 重启后从快照恢复为 paused；content script 发现 Port 断开后重连，SW 回一条当前状态，竖条随之恢复。
- **offscreen 被回收**（P2）：实测暂停约 35 秒后 offscreen 会被关闭（§6 V2）。offscreen 只放音频，没有会话状态。恢复播放时如果 `offscreen.hasDocument()` 为 false，就重建 offscreen，当前句优先从 L2 缓存取，再跳到暂停时的句内 currentTime。
- **自动播放被拒**：`audio.play()` 报 NotAllowedError（企业策略或用户改过自动播放设置）时，进入 paused，气泡卡片提示「点击继续」。用户点击后由引擎重试。

### 4.2 进度推送

- **推送方式**：offscreen 根据 `audio.currentTime` 和时间轴，用 `setTimeout` 定时到下一个词的开始时间，只在词切换时向 SW 报一次。offscreen 是隐藏页面，rAF 不会触发，所以不用 rAF。
- **消息链路**：content script 和 SW 之间每个 tab 一个长连接 Port；引擎在 SW 里，offscreen 的时间事件先到 SW，再由引擎转成统一的进度事件发给 content script。
- **浏览器语音**：由 SW 里的 `chrome.tts` word 事件直接驱动，走同一个事件格式。

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
| 鉴权 | 401/403、key 为空 | 立即暂停。气泡卡片提示「API key 无效」，按钮「打开设置」/「用浏览器语音」 |
| 服务未开通 | 豆包 `45000030`、百炼模型未开通 | 立即暂停。气泡卡片提示「服务未开通」，按钮「去控制台开通」外链 |
| 音色不匹配 | 豆包 `55000000` | 立即暂停。气泡卡片提示「音色与模型版本不匹配」，按钮「更换音色」 |
| 限流/额度 | 429、服务商的额度错误码 | 指数退避重试 2 次，仍失败就暂停并说明原因 |
| 网络/服务端 | 5xx、15 秒超时、断网 | 重试 2 次。断网时暂停，监听 `online` 事件后提示可以继续 |
| 单句被拒 | 400、内容审核 | 跳过该句并标记，继续读下一句 |
| 时间戳异常 | 缺失或对不齐 | 该句只做句级高亮，不打断播放 |
| 高亮失效 | DOM 节点被替换 | 按 §3.3 处理 |
| 自动播放被拒 | `play()` 报 NotAllowedError | 进入暂停，气泡卡片提示「点击继续」，由引擎重试 |

错误类型由 `ProviderDescriptor` 里的错误码映射得出（§2.3），不同服务商返回的码不一样，但界面上只有这几种提示。临时改用浏览器语音由 `fallbackToBrowser` 控制，默认 `ask`：连续出错时气泡卡片里多一个「用浏览器语音继续」按钮。可以改为 `auto` 或 `never`。

### 4.6 设置存储

```ts
// chrome.storage.local（不同步；密钥只在这里）
// 统一成实例列表，与「每个实例占一行」的界面一致；单例服务商只是列表里只有一个实例
providerInstances: Array<{
  instanceId: string;          // 随机 id
  providerId: 'dashscope' | 'volcengine' | 'openai-compat' | 'elevenlabs' | 'azure' | 'browser';
  label: string;               // 显示名，如「本地 Kokoro」「阿里云百炼」
  config: Record<string, string | boolean | string[]>;   // 按 ProviderDescriptor.fields 渲染和校验
  status?: { ok: boolean; checkedAt: number; error?: string };
}>;
sites: Record<string /* host */, { sidePlayer?: boolean; paragraphPlay?: boolean;
                                   selectionButton?: boolean; playerPos?: { edge: 'left' | 'right'; top: number } }>;
rtfStats: Record<string /* provider:model:voice */, number>;
voiceListCache: Record<string /* providerId */, { voices: Voice[]; fetchedAt: number }>;

// chrome.storage.sync（跨设备同步，不含任何密钥）
prefs: {
  // instanceId 指向 storage.local 里的实例。换设备后指向不存在时，回落到 browser 实例
  voice: { instanceId?: string; providerId: string; voiceId: string; model?: string };
  rate: number;
  theme: 'auto' | 'light' | 'dark';
  uiLang: 'auto' | 'zh-CN' | 'en';
  highlight: { sentence: string; word: string; adaptive: boolean; dimRead: boolean; dimReadCount: number };
  autoScroll: boolean; clickToSeek: boolean; skipCode: boolean;
  seenSelectionHint: boolean;   // 划词按钮的一次性提示只显示一次
  autoShowEverywhere: boolean;
  cache: { persist: boolean; limitMB: number };
  fallbackToBrowser: 'ask' | 'auto' | 'never';
  schemaVersion: number;
};
```

- **key 的存储**：key 以明文存在 `storage.local`，本机加密没有实际意义，因为解密密钥也只能放在本机。网页读不到这里的数据。
- **content script 也能访问**：content script 在技术上也能访问 `storage.local`，所以我们的 content script 代码约定从不读取 `providerInstances`。`secret: true` 的字段就存在这里。评审时要检查这一点。
- **单例服务商的唯一性**：`dashscope`、`volcengine`、`elevenlabs`、`azure`、`browser` 在列表里各只能有一个实例（`browser` 实例在首次启动时自动建好）；`openai-compat` 可以有任意多个。
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
  - 各服务商域名：`*.aliyuncs.com`、`openspeech.bytedance.com`、`api.openai.com`、`api.elevenlabs.io`、`*.tts.speech.microsoft.com` 等
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
- README（中英），包含本地 Kokoro-FastAPI 的配置示例。
- `docs/providers/*.md`（中英）：每个服务商「怎么申请 key」的分步说明。这部分**刻意不写进扩展**——各家控制台 UI 一直在变，写进扩展会在下次审核前就过期，而文档可以随时改。扩展里只放 `help.keyUrl` / `help.docsUrl` 链接。
- 隐私说明页。
- 商店素材（中英）。

## 6. 实现前需要验证的点

以下都用一次性脚本验证，结论写回本文档。验证代码不保留。

2026-09-29 实测环境：Chrome for Testing 149（macOS arm64），用 Playwright 加载未打包扩展；V3 的长朗读另外用独立启动的 Chrome 跑了一遍，没有挂 DevTools。

| # | 问题 | 状态 | 结论 / 设计影响 |
|---|---|---|---|
| V1 | content script 点击 → SW 调用 `sidePanel.open()`，用户手势能否保留 | ✅ 成立（有条件） | 可信点击后立即发消息能打开；点击后延迟 1.5 秒也能打开；延迟 6 秒、页面加载时自动发送、SW 直接调用，这三种都报 "may only be called in response to a user gesture"。Chrome 按约 5 秒的手势窗口判断（transient activation）。脚本合成的 click 在这窗口内也能打开，所以网页可以借用户的一次点击触发，但只会打开我们自己的设置页，风险可以接受。**设计**：齿轮的点击处理函数必须同步调用 `sendMessage`，SW 收到后也必须同步调用 `sidePanel.open`，中间不能有 await。 |
| V2 | offscreen（AUDIO_PLAYBACK）不需要用户手势能否直接播放；暂停后是否会被关闭 | ✅ 成立，需要重建逻辑 | 默认自动播放策略下可以直接播放。加上 `--autoplay-policy=user-gesture-required` 时会报 NotAllowedError，说明企业策略或用户改过设置时可能失败。连续播放 48 秒没有被关闭；**暂停约 35 秒后 offscreen 被关闭**，重建后不需要手势就能继续播放。**设计**：引擎的暂停状态（cursor 和句内播放位置）要镜像到 SW 的 `storage.session`；恢复播放时如果 `hasDocument()` 为 false，就重建 offscreen，从缓存取出当前句，并跳到原来的播放位置。L1 内存缓存随之丢失，L2 仍在。`play()` 报 NotAllowedError 时，气泡卡片提示「点击继续」。 |
| V3 | `chrome.tts` 在 SW 里连续朗读时，SW 会不会被回收，导致 word 事件丢失 | ✅ 成立 | 独立启动的 Chrome 里，SW 发起一次 146 秒的朗读，期间 SW 不做任何事：339 个 word 事件全部收到，最后收到 `end` 事件，没有被回收。macOS 本地音色 180 个，全部支持 word 事件，`charIndex`/`length` 正确，中文音色婷婷按词返回。Port 保活作为保险仍然保留（竖条本来就有 Port）。 |
| V4 | CosyVoice SSE 的 `words` 与传入的一句文本能否稳定对齐；服务端是否会再切句 | ✅ 成立（有注意事项） | 用 cosyvoice-v3-flash/longanyang、v3-plus 和 qwen-audio-3.0-tts-flash 实测，workspace 域名和通用域名都能用，首包约 0.35–0.7 秒。SSE 按标准格式分帧（`id:`/`event:`/`:HTTP_STATUS`/`data:`，空行结束一帧），事件类型为 `sentence-begin`/`sentence-synthesis`/`sentence-end`。**① `begin_index/end_index` 是「词的序号」，不是字符偏移**：中文按字切，英文按词切（`' quick'` 带前导空格）。**② 服务端会把数字和 URL 规范化**："1.27" 读作 "一点二七"，"35%" 读作 "百分之三十五"，URL 读作 "H T T P S"，但 `original_text` 和 `normalized_text` 显示的仍是原文，所以要用 `sequential-words` 对齐，对不上的词跳过，和 Kokoro 用同一套逻辑。**③ 服务端会自行切句**：310 字的请求被切成 index 0/1 两句，words 在帧之间是增量下发的，要按 `(sentence.index, begin_index)` 去重后拼接，时间是整段音频的绝对时间。引擎的 `maxChars` 取 **200**，保证一次请求只产生一句。**④** `cosyvoice-v3.5-flash` 加上系统音色会报 400（"Engine return error code: 418"），和文档说的「v3.5 不支持系统音色」一致，音色表要按模型过滤。Qwen-TTS（qwen3-tts-flash）的流式返回是 WAV 分片，最后一帧带 url，没有时间戳。 |
| V5 | workspace 专属域名在 `chrome-extension://` 源下的 CORS / host 权限行为 | ✅ 成立 | 这条验证不需要 key。SW 带 `Authorization` 和 `X-DashScope-SSE` 头请求通用域名和 workspace 域名，都返回业务层的 401 InvalidApiKey，说明请求到达了服务端，没有被网络或 CORS 拦截。 |
| V6 | Azure Speech SDK 在 MV3 扩展页里用订阅 key 能否连接 | ✅ 成立 | SDK 1.47 的浏览器打包文件在扩展页里直接连通（region japaneast），wss URL 带 `?Ocp-Apim-Subscription-Key=`，和读源码的结论一致。中英文的 `WordBoundary` 的 `textOffset/wordLength` 都**直接对应原文字符偏移，0 处不一致**，数字和 "Mr." 按原文返回，所以用 `offset` 对齐即可；标点以 `PunctuationBoundary` 单独返回，合并时过滤掉。1 句约 1.1 秒完成。`speakTextAsync` 第二个参数传 `null`，只拿音频数据，由引擎统一播放。 |
| V7 | Kokoro-FastAPI 带字幕接口的路径和返回格式 | ✅ 成立（有限制） | 版本 v0.9.0（CPU 镜像）。接口是 `POST /dev/captioned_speech`，请求体同 OpenAI，另加 `stream:false`；返回 `{audio(base64), audio_format, timestamps:[{word,start_time,end_time}]}`，单位是秒，标点单独算一项。**文本会被规范化**："Mr." 变成 "Mister"，"3" 变成 "three"，所以按顺序找词时，对不上的词直接跳过，这几个词不显示词级高亮。**中文（zf_*/zm_*）的 timestamps 是空数组**，只做句级高亮。CORS 返回 `*`。`GET /v1/audio/voices` 返回对象数组（id/name）。 |
| V8 | ElevenLabs `with-timestamps` 的请求和返回字段 | ✅ 成立 | 已用真 key 实测（21 个音色）。`alignment.characters` 拼起来**和原文逐字一致**，中英文都是（60/60、22/22），数字和 "Mr." 保持原样，按 `chars` 合并成词即可。**`normalized_alignment` 不能用**：中文会被转成拼音（"Wo Jia De…"），首尾还多了空格。耗时：multilingual_v2 约 2.5–4.3 秒一句，flash_v2_5 约 1.4 秒，明显慢于其他几家，预取策略要靠 RTF 自适应来弥补。 |
| V9 | 豆包：扩展环境下能否带上 `X-Api-Key`；返回格式；1.0 时间戳能否对齐 | ✅ 成立 | 请求头的结论同前（不需要 declarativeNetRequest）。返回格式是 **HTTP chunked 逐行 JSON**，不是带 `data:` 前缀的 SSE：每行 `{code, message, data(base64 音频)}`，结束帧是 `code:20000000`。**1.0**（`seed-tts-1.0` 字符版，爽快思思、温暖阿虎）首包约 0.5 秒。开启 `enable_timestamp` 后会多出一帧 `{sentence:{text, words:[{word, startTime, endTime, confidence}]}}`，时间单位是**秒**，没有字符偏移。词的文本和 CosyVoice、Kokoro 一样是**规范化后的**："1.27" 变成 "一 点 二 七"，"35%" 变成 "百分之三十五"，"Mr." 变成 "mister"；标点会粘在前一个词上（"园。"、"fox,"）；URL 被拆成 "https:" 和 "//go.dev。" 两段，时间几乎为零。所以用 `sequential-words` 对齐，比较前要去掉标点，对不上的跳过。一个请求里有两句时，也只返回一个 sentence 帧。**2.0** 能合成，但 `words` 是空的，只做句级高亮。音色必须和资源匹配，否则返回 `55000000 resource ID is mismatched with speaker related resource`，界面要单独提示「音色与模型版本不匹配」。`seed-tts-1.0-concurr` 这个 key 没开通，这是正常的，不要求。 |

残留风险：V1 和 V2 的结论来自 Chrome for Testing 149，其他版本的 Chrome 可能调整手势窗口或 offscreen 的回收时间。实现时按上述退路处理，不依赖具体数值。

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

### A.4 火山引擎豆包语音

- 剪映自己不对外开放 AI 配音 API；它的配音用的是火山引擎的豆包语音模型，火山引擎的产品页称剪映为「深度合作伙伴」。
- 接口类型：HTTP Chunked/SSE 单向流式，另有 WebSocket 单向和双向流式。
- 鉴权：新版控制台用 `X-Api-Key`；旧版控制台用 AppId + Access Token。
- 时间戳：`enable_timestamp` 只有 TTS 1.0 支持，只支持中英文。
- 2026-09-29 实测 CORS 预检：`allow-origin: *`，但 `allow-headers` 里没有 `X-Api-Key`。
- 非官方的剪映逆向接口没有授权，本项目不采用。
