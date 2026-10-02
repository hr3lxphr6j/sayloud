# AGENT.md - 项目架构指南

本文档为 AI 助手提供快速理解 SayLoud 项目的架构和约定。

## 项目概述

**SayLoud** 是一个 Chrome 扩展，用于朗读网页内容并高亮当前句子和单词。

- **P1**: 使用浏览器内置 TTS (`chrome.tts`)，无需账号或 API key
- **P2**: 支持云端 TTS 服务商（OpenAI、Azure、ElevenLabs、火山引擎等）
- **P3**: 本地 TTS 模型（Kokoro，在 offscreen document 中运行）

## 核心架构

### 1. 三层结构

```
Content Script (reader)  ←→  Service Worker (background)  ←→  Side Panel (UI)
     ↓                              ↓                              ↓
 ReaderController              PlaybackEngine                 ReadingTab
 提取句子并高亮               控制播放逻辑                   显示进度和控制
```

#### Content Script (`entrypoints/reader.content/`)
- **ReaderController.ts**: 提取页面句子、发送 `load` 命令、处理 `sync`
- **CaptionWindow.ts**: 浮动字幕窗口（P4 功能）
- 通过 `chrome.runtime.sendMessage` 与 background 通信

#### Service Worker (`entrypoints/background.ts`)
- **PlaybackEngine** (`lib/playback-engine.ts`): 核心播放引擎
  - 管理句子数组、当前索引、播放状态
  - 发送 `word` 和 `status` 事件
- **SessionRouter** (`lib/router.ts`): 消息路由
  - 分发 `EngineCommand` 到 engine
  - 管理多 tab 会话
- **SnapshotStore** (`lib/snapshot-store.ts`): 持久化
  - 双层存储：`chrome.storage.session` + `chrome.storage.local`
  - **重要优化 (2026-10-02)**: snapshot 只保存统计信息（`sentenceCount`, `charsTotal`），不保存完整句子数组

#### Side Panel (`entrypoints/sidepanel/`)
- **ReadingTab.tsx**: 播放控制和进度显示
- **SettingsTab.tsx**: 服务商配置
- **VoicePicker.tsx**: 音色选择
- 通过 `SessionWatch` 监听 storage 变化获取实时状态

### 2. 关键数据流

#### 加载文档
```
1. ReaderController 提取句子 → 发送 { type: 'load', sentences, startIndex }
2. PlaybackEngine.load() 保存句子、重置状态
3. Engine 发送 { type: 'status' } 事件
4. ReaderController 收到 status → 更新 UI
```

#### 播放
```
1. 用户点击播放 → 发送 { type: 'play' }
2. PlaybackEngine.play() → Speaker.speak()
3. Speaker 发送 'word' 事件 → Engine 转发给 content script
4. ReaderController 收到 word → Highlighter 高亮当前词
```

#### Service Worker 重启恢复
```
1. SW 重启 → SessionRouter.start() 从 storage 加载 snapshot
2. PlaybackEngine.restore() 恢复状态（但 sentences = []，等待重新加载）
3. Content script 重连 → 发送 { type: 'sync', docId }
4. Engine 检测到 sentences.length === 0 → 发送 { type: 'session-lost' }
5. Content script 收到 session-lost → 重新发送 { type: 'load' }
```

### 3. Speaker 架构（三种实现）

#### BrowserSpeaker (`lib/speaker.ts`)
- 使用 `chrome.tts.speak()`
- 提供 `word` 事件（来自浏览器）
- 无法中途恢复（`resumeTimeMs` 被忽略）

#### OffscreenSpeaker (`lib/offscreen-speaker.ts`)
- 在 offscreen document 中运行本地模型（Kokoro）
- 通过 `chrome.runtime.sendMessage` 与 OffscreenManager 通信
- 支持 `pause`/`resume`，保存 `lastPausedTimeMs`
- **重要修复 (2026-10-02)**: 使用事件驱动架构获取播放位置，避免竞态

#### CloudSpeaker (未来)
- 调用云端 API（OpenAI、Azure 等）
- 返回音频 + 时间戳对齐数据
- 交给 TimelinePlayer 播放

#### SpeakerRouter (`lib/speaker-router.ts`)
- 根据 voice ID 路由到不同 speaker
- **重要修复 (2026-10-02)**: 添加 `pause()` 和 `getCurrentTimeMs()` 转发

### 4. 协议定义 (`lib/protocol.ts`)

#### EngineCommand（content script → background）
```typescript
{ type: 'load', sentences, startIndex, rate }
{ type: 'play' | 'pause' | 'toggle' | 'next' | 'prev' }
{ type: 'seek', index }
{ type: 'setRate', rate }
{ type: 'sync', docId }  // 重连时同步状态
```

#### EngineEvent（background → content script）
```typescript
{ type: 'status', status: EngineStatus }
{ type: 'word', index, charStart, charEnd }
{ type: 'session-lost' }  // 触发重新发送 load
```

#### SessionSnapshot（持久化）
```typescript
{
  tabId: number;
  docId: string;
  sentenceCount: number;    // 替代 sentences.length
  charsTotal: number;        // 替代遍历计算
  index: number;
  resumeOffset: number;
  voice: string;
  rate: number;
  charsRead: number;
  resumeTimeMs?: number;     // 云端/本地 TTS 恢复位置
}
```

**注意**: 从 2026-10-02 开始，snapshot **不再保存完整句子数组**，大幅减少存储开销（613 句文档从 ~30KB 降到 ~100 字节）。

## 目录结构

```
lib/                          # 核心业务逻辑
  ├── playback-engine.ts      # 播放引擎（状态机）
  ├── router.ts               # 消息路由
  ├── speaker.ts              # Browser TTS
  ├── speaker-router.ts       # Speaker 路由器
  ├── offscreen-speaker.ts    # 本地 TTS
  ├── snapshot-store.ts       # 持久化
  ├── session-watch.ts        # Side panel 监听状态
  ├── highlighter.ts          # CSS Highlight API 封装
  ├── autoscroll.ts           # 自动滚动逻辑
  ├── protocol.ts             # 类型定义
  └── providers/              # 云端 TTS 服务商
      ├── registry.ts         # 服务商注册表
      ├── openai-compat.ts    # OpenAI 兼容接口
      ├── azure.ts            # Azure TTS
      ├── elevenlabs.ts       # ElevenLabs
      ├── volcengine.ts       # 火山引擎
      ├── local.ts            # Kokoro 本地模型
      └── align-timings.ts    # 时间戳对齐算法

entrypoints/                  # 扩展入口
  ├── background.ts           # Service worker
  ├── reader.content/         # Content script
  │   ├── ReaderController.ts
  │   └── CaptionWindow.ts
  ├── sidepanel/              # Side panel UI
  │   ├── main.tsx
  │   ├── ReadingTab.tsx
  │   ├── SettingsTab.tsx
  │   └── VoicePicker.tsx
  └── offscreen/              # Offscreen document
      ├── main.ts             # Offscreen manager
      └── local.worker.ts     # Kokoro worker

tests/
  ├── unit/                   # 单元测试（Vitest + happy-dom）
  └── e2e/                    # E2E 测试（Playwright + 真实 Chrome）
```

## 开发约定

### 代码规范
- **TypeScript**: 严格模式，所有类型必须显式声明
- **Linter**: Biome（`npm run lint`）
- **格式化**: Biome（`npm run format`）
- **测试**: Vitest + Playwright（`npm test` / `npm run test:e2e`）

### 事件驱动架构
- **禁止同步轮询**: 使用事件监听器（`EventEmitter`）
- **例子**: `OffscreenSpeaker` 的 `paused` 事件而非轮询 `getCurrentTimeMs()`

### 错误处理
- **Service worker 随时可能被回收**: 所有状态必须可持久化
- **Content script 可能断线**: 使用 `sync` 命令重连
- **Offscreen document 30 秒后回收**: 播放前创建，结束后销毁

### 测试要求
- **单元测试**: 覆盖所有核心逻辑（`lib/`）
- **E2E 测试**: 覆盖真实 TTS 播放和高亮
- **Mock 策略**: 使用 `vi.fn()` 模拟浏览器 API
- **断言**: 优先使用 `toEqual()` 而非 `toBe()`（对象比较）

### Git 提交规范
```
feat: 新功能
fix: Bug 修复
perf: 性能优化
refactor: 重构
test: 测试
docs: 文档
chore: 构建/工具
```

## 常见任务指南

### 添加新的 TTS 服务商
1. 在 `lib/providers/` 创建新文件（参考 `openai-compat.ts`）
2. 实现 `Provider` 接口（`speak()`, `listVoices()`）
3. 在 `lib/providers/registry.ts` 注册
4. 在 `entrypoints/sidepanel/ProviderConfig.tsx` 添加 UI
5. 添加单元测试（`tests/unit/providers/`）

### 修复播放相关 Bug
1. **先读**: `lib/playback-engine.ts`（状态机逻辑）
2. **再读**: `lib/speaker*.ts`（具体实现）
3. **检查事件流**: 在 `PlaybackEngine.bindSpeakerEvents()` 打日志
4. **检查状态持久化**: `lib/snapshot-store.ts`

### 修复高亮相关 Bug
1. **先读**: `lib/highlighter.ts`（CSS Highlight API）
2. **再读**: `entrypoints/reader.content/ReaderController.ts`（事件处理）
3. **检查 DOM**: 确保句子有 `data-sayloud-sentence` 属性

### 添加新功能
1. **定义协议**: 在 `lib/protocol.ts` 添加新的 `EngineCommand` 或 `EngineEvent`
2. **实现逻辑**: 在 `lib/playback-engine.ts` 添加处理函数
3. **更新 UI**: 在 `entrypoints/sidepanel/` 添加控制
4. **添加测试**: 在 `tests/unit/` 添加覆盖

## 已知问题和限制

### P1 (Browser TTS)
- ❌ 无法中途恢复（`chrome.tts` 限制）
- ❌ 音色质量依赖系统
- ✅ 无需网络，完全离线

### P2 (Cloud TTS)
- ⏳ 需要 API key 配置
- ⏳ 网络延迟影响首句延迟
- ⏳ 成本（按字符计费）

### P3 (Local TTS)
- ✅ 离线可用，音质好
- ❌ 首次加载模型慢（~100MB）
- ❌ 30 秒静音后 offscreen 被回收

### 架构限制
- **Service Worker 内存限制**: 不能缓存大量音频数据
- **Offscreen 生命周期**: 30 秒静音后自动回收
- **Content Script 沙箱**: 不能访问扩展的 storage API

## 最近的重要修复（2026-10-02）

### 1. Pause/Resume 四层嵌套 Bug
**问题**: 暂停后无法从正确位置恢复

**修复**:
1. `SpeakerRouter` 添加 `pause()` 和 `getCurrentTimeMs()` 转发
2. 改用事件驱动架构（`paused` 事件）避免竞态
3. `isOffscreenEvent()` 特殊处理 `paused` 事件（不需要 `id`）
4. `EVENT_TYPES` 集合添加 `'paused'`

**提交**: `063d056`, `c0a3c35`

### 2. Snapshot 存储优化
**问题**: 长文档（613 句）占用 ~30KB 存储

**修复**:
- 移除 `sentences: EngineSentence[]`
- 添加 `sentenceCount` 和 `charsTotal` 统计字段
- Service worker 重启后通过 `sync` 流程重新获取句子
- 向后兼容：自动迁移旧格式

**效果**: 存储开销减少 99.7%（~30KB → ~100 字节）

**提交**: `77bcbf6`

## 调试技巧

### 查看 Service Worker 日志
1. 打开 `chrome://extensions`
2. 找到 SayLoud → 点击 "Service Worker"
3. 查看控制台输出（带 `[SayLoud]` 前缀）

### 查看 Content Script 日志
1. 在页面上右键 → "检查"
2. 切换到 "Console" 标签
3. 过滤 `[SayLoud]`

### 查看 Storage
1. Service Worker 控制台 → "Application" 标签
2. 展开 "Storage" → "Session Storage" / "Local Storage"
3. 查找 `sayloud-session` 和 `sayloud-session-backup`

### 本地运行
```bash
npm install
npm run dev        # 开发模式（热重载）
npm run build      # 生产构建
npm test           # 单元测试
npm run test:e2e   # E2E 测试（需要安装语音包）
```

### 加载到 Chrome
1. 构建: `npm run build`
2. 打开 `chrome://extensions`
3. 开启 "开发者模式"
4. 点击 "加载已解压的扩展程序"
5. 选择 `.output/chrome-mv3` 目录

## 重要文件速查

| 文件 | 用途 | 何时阅读 |
|------|------|----------|
| `lib/protocol.ts` | 类型定义 | **优先阅读**，理解数据结构 |
| `lib/playback-engine.ts` | 播放引擎 | 修复播放逻辑 Bug |
| `lib/router.ts` | 消息路由 | 修复通信问题 |
| `lib/speaker-router.ts` | Speaker 路由 | 添加新 speaker 或修复路由 Bug |
| `lib/snapshot-store.ts` | 持久化 | 修复恢复/存储问题 |
| `entrypoints/reader.content/ReaderController.ts` | Content script | 修复高亮/提取句子问题 |
| `entrypoints/background.ts` | Service worker 入口 | 理解初始化流程 |
| `lib/providers/registry.ts` | 服务商注册 | 添加新服务商 |

## 联系和贡献

- **Bug 报告**: 在 GitHub Issues 提交
- **功能请求**: 在 Discussions 讨论
- **代码贡献**: Fork → 分支 → PR

---

**最后更新**: 2026-10-02  
**维护者**: @chigusa  
**版本**: P3 (本地 TTS + 云端 TTS)
