# SayLoud P2: Cloud TTS Implementation Spec

**日期**: 2026-09-30  
**前置条件**: P1 完成（browser voice + UI + highlighting）  
**预计工期**: 5-7 天  
**分支**: `p2-cloud-tts`

---

## 0. 概述

### 0.1 目标

在 P1 浏览器语音的基础上，接入 6 个云端 TTS 服务商，实现完整的音频播放管道：

1. **Provider 接口层** — 统一的 TTS 适配器接口
2. **Offscreen AudioWorker** — 云端合成 + 音频播放 + 时间轴对齐
3. **两层缓存** — L1 内存 LRU + L2 IndexedDB（内容寻址）
4. **预加载调度** — 自适应预取 + 并发控制

### 0.2 不包含

- ❌ 设置 UI（P3）
- ❌ 音色列表 UI（P3）
- ❌ 服务商配置表单（P3）
- ❌ Side Panel 实现（P3）
- ❌ 划词朗读（P4）
- ❌ Paragraph Play（P4）

P2 只做**播放管道**，用硬编码的测试配置验证端到端流程。

### 0.3 成功标准

1. ✅ 6 个服务商都能播放（用测试 key 验证）
2. ✅ 逐词高亮在支持的服务上正常工作
3. ✅ 变速、暂停、跳转、音色切换即时生效
4. ✅ 缓存命中率 > 80%（同一文章二次播放）
5. ✅ 首句延迟 < 2 秒（云端服务，正常网络）
6. ✅ 长文（1 万字）播放无断档
7. ✅ offscreen 回收后能正确恢复播放

---

## 1. 架构变更

### 1.1 组件关系

```
Service Worker (background.ts)
  ├─ SessionRouter        (已有，P1)
  ├─ PlaybackEngine       (已有，P1) ← 状态机持有者
  ├─ BrowserSpeaker       (已有，P1)
  └─ OffscreenManager     (新增) ← 管理 offscreen 生命周期
       │
       ▼ chrome.runtime.sendMessage / onMessage
Offscreen Document (entrypoints/offscreen.ts)
  └─ AudioWorker          (新增)
       ├─ Providers       (新增) ← 6 个适配器
       ├─ CacheManager    (新增) ← L1 + L2
       └─ TimelinePlayer  (新增) ← <audio> + 时间轴
```

### 1.2 消息协议（SW ↔ Offscreen）

```typescript
// SW → Offscreen
type OffscreenCommand =
  | { type: 'synthesize'; id: string; text: string; config: ProviderConfig }
  | { type: 'play'; id: string; startTimeMs?: number }
  | { type: 'pause' }
  | { type: 'setRate'; rate: number }
  | { type: 'stop' }

// Offscreen → SW
type OffscreenEvent =
  | { type: 'ready'; id: string; durationMs: number; hasTimings: boolean }
  | { type: 'word'; charStart: number; charEnd: number }
  | { type: 'sentence-end'; id: string }
  | { type: 'error'; id: string; code: string; message: string }
```

### 1.3 状态持有

- **PlaybackEngine（SW）**: 唯一状态持有者
  - 当前句索引、播放状态（idle/loading/playing/paused/error/ended）
  - cursor（句内播放位置）、rate
  - 会话快照写入 `storage.session`

- **AudioWorker（offscreen）**: 无状态执行者
  - 只响应指令，不持有会话状态
  - 被回收时丢失 L1 缓存，L2 仍在
  - 重建后从 SW 的指令中恢复上下文

---

## 2. Provider 接口

### 2.1 核心接口

```typescript
// lib/providers/types.ts

interface Voice {
  id: string;
  name: string;
  lang?: string;           // BCP-47, e.g. 'zh-CN', 'en-US'
  gender?: 'male' | 'female' | 'neutral';
  supportsTimings?: boolean;
}

interface WordTiming {
  charStart: number;       // 相对请求文本的字符偏移
  charEnd: number;
  startMs: number;         // 相对音频开始的时间
  endMs: number;
}

interface SynthesisResult {
  audio: ArrayBuffer;
  mime: string;            // 'audio/mpeg' | 'audio/ogg' | 'audio/wav' ...
  durationMs: number;
  timings?: WordTiming[];  // 缺失时只做句级高亮
}

interface ProviderConfig {
  provider: 'dashscope' | 'volcengine' | 'openai-compat' | 'elevenlabs' | 'azure' | 'browser';
  // provider-specific fields...
}

interface Provider {
  readonly id: string;
  readonly name: string;
  
  /** 能力描述 */
  capabilities(config: ProviderConfig): {
    timings: 'exact' | 'none';
    maxChars: number;        // 单次合成最大字符数
    concurrency: number;      // 推荐并发数
  };
  
  /** 验证配置（设置页「测试连接」） */
  validate(config: ProviderConfig, signal: AbortSignal): Promise<void>;
  
  /** 获取音色列表 */
  listVoices(config: ProviderConfig, signal: AbortSignal): Promise<Voice[]>;
  
  /** 合成单句 */
  synthesize(request: {
    text: string;
    voiceId: string;
    signal: AbortSignal;
  }, config: ProviderConfig): Promise<SynthesisResult>;
}
```

### 2.2 时间戳对齐

不同服务商返回的时间戳格式不同，需要统一对齐：

```typescript
// lib/providers/align-timings.ts

type TimingFormat =
  | { kind: 'offset'; marks: Array<{ charIndex: number; timeMs: number }> }
  | { kind: 'sequential-words'; words: Array<{ text: string; startMs: number; endMs: number }> }
  | { kind: 'chars'; chars: Array<{ char: string; startMs: number; endMs: number }> }

/**
 * 统一对齐到 WordTiming[]
 * 
 * - offset: Azure WordBoundary, chrome.tts charIndex — 直接映射
 * - sequential-words: CosyVoice begin_index, Kokoro — 按顺序在原文中查找，跳过空白标点
 * - chars: 某些服务的字符级时间戳 — 按 Intl.Segmenter 合并成词
 * 
 * @returns undefined 表示对齐失败（该句只做句级高亮）
 */
function alignTimings(
  sentenceText: string,
  format: TimingFormat,
  durationMs: number
): WordTiming[] | undefined;
```

### 2.3 服务商适配器

每个适配器一个文件：

- `lib/providers/dashscope.ts` — 阿里云百炼（CosyVoice / Qwen-TTS）
- `lib/providers/volcengine.ts` — 火山引擎豆包
- `lib/providers/openai-compat.ts` — OpenAI-compatible（含 Kokoro）
- `lib/providers/elevenlabs.ts`
- `lib/providers/azure.ts` — Speech SDK（WebSocket）
- ~~`lib/providers/browser.ts`~~ — 已在 P1 完成（`lib/speaker.ts`）

每个适配器需要：

1. **实现 Provider 接口**
2. **处理流式响应**（SSE / chunked JSON / WebSocket）
3. **错误映射** — 统一错误码
   - `invalid-key` — key 无效
   - `service-unavailable` — 服务未开通
   - `rate-limit` — 限流
   - `no-quota` — 配额耗尽
   - `network-error` — 网络错误
   - `unknown` — 其他
4. **测试覆盖** — MSW mock 响应 + 单元测试

---

## 3. Offscreen AudioWorker

### 3.1 生命周期

```typescript
// entrypoints/offscreen.ts

import { AudioWorker } from '~/lib/audio-worker';

const worker = new AudioWorker();

browser.runtime.onMessage.addListener((message: OffscreenCommand, sender) => {
  return worker.handleCommand(message);
});
```

```typescript
// lib/audio-worker.ts

export class AudioWorker {
  private readonly providers: Map<string, Provider>;
  private readonly cache: CacheManager;
  private readonly player: TimelinePlayer;
  
  async handleCommand(cmd: OffscreenCommand): Promise<void> {
    switch (cmd.type) {
      case 'synthesize':
        await this.synthesize(cmd.id, cmd.text, cmd.config);
        break;
      case 'play':
        await this.player.play(cmd.id, cmd.startTimeMs);
        break;
      case 'pause':
        this.player.pause();
        break;
      case 'setRate':
        this.player.setRate(cmd.rate);
        break;
      case 'stop':
        this.player.stop();
        break;
    }
  }
  
  private async synthesize(id: string, text: string, config: ProviderConfig) {
    // 1. 计算缓存 key
    const cacheKey = this.cache.computeKey(text, config);
    
    // 2. 尝试 L1 → L2
    let result = this.cache.getL1(cacheKey);
    if (!result) {
      result = await this.cache.getL2(cacheKey);
      if (result) this.cache.putL1(cacheKey, result);
    }
    
    // 3. 缓存未命中 → 合成
    if (!result) {
      const provider = this.providers.get(config.provider);
      result = await provider.synthesize({ text, voiceId: config.voiceId, signal: AbortSignal.timeout(30_000) }, config);
      
      // 4. 写入缓存
      this.cache.putL1(cacheKey, result);
      await this.cache.putL2(cacheKey, result);
    }
    
    // 5. 加载到播放器
    await this.player.load(id, result);
    
    // 6. 通知 SW
    this.sendEvent({ type: 'ready', id, durationMs: result.durationMs, hasTimings: !!result.timings });
  }
  
  private sendEvent(event: OffscreenEvent) {
    browser.runtime.sendMessage(event);
  }
}
```

### 3.2 TimelinePlayer

```typescript
// lib/timeline-player.ts

interface LoadedAudio {
  id: string;
  audio: HTMLAudioElement;
  durationMs: number;
  timings?: WordTiming[];
}

export class TimelinePlayer {
  private current: LoadedAudio | null = null;
  private timingTimer: number | null = null;
  private nextWordIndex = 0;
  
  async load(id: string, result: SynthesisResult): Promise<void> {
    this.stop();
    
    const blob = new Blob([result.audio], { type: result.mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    
    // 等待 loadedmetadata（获取真实 duration）
    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = resolve;
      audio.onerror = reject;
    });
    
    this.current = {
      id,
      audio,
      durationMs: result.durationMs,
      timings: result.timings,
    };
  }
  
  async play(id: string, startTimeMs = 0): Promise<void> {
    if (!this.current || this.current.id !== id) {
      throw new Error(`Audio ${id} not loaded`);
    }
    
    this.current.audio.currentTime = startTimeMs / 1000;
    await this.current.audio.play();
    
    // 启动时间轴推送
    if (this.current.timings) {
      this.scheduleNextWord();
    }
    
    // 监听播放结束
    this.current.audio.onended = () => {
      this.sendEvent({ type: 'sentence-end', id });
    };
  }
  
  pause(): void {
    this.current?.audio.pause();
    this.clearTimingTimer();
  }
  
  stop(): void {
    if (this.current) {
      this.current.audio.pause();
      URL.revokeObjectURL(this.current.audio.src);
      this.current = null;
    }
    this.clearTimingTimer();
    this.nextWordIndex = 0;
  }
  
  setRate(rate: number): void {
    if (this.current) {
      this.current.audio.playbackRate = rate;
      // 重新调度下一个词（时间轴需要按 rate 缩放）
      if (this.current.timings && !this.current.audio.paused) {
        this.clearTimingTimer();
        this.scheduleNextWord();
      }
    }
  }
  
  private scheduleNextWord(): void {
    if (!this.current?.timings) return;
    
    const currentTimeMs = this.current.audio.currentTime * 1000;
    const rate = this.current.audio.playbackRate;
    
    // 找到下一个未发送的词
    while (this.nextWordIndex < this.current.timings.length) {
      const word = this.current.timings[this.nextWordIndex];
      const adjustedStartMs = word.startMs / rate;
      
      if (adjustedStartMs > currentTimeMs) {
        // 调度到这个词的开始时间
        const delayMs = adjustedStartMs - currentTimeMs;
        this.timingTimer = window.setTimeout(() => {
          this.sendEvent({
            type: 'word',
            charStart: word.charStart,
            charEnd: word.charEnd,
          });
          this.nextWordIndex++;
          this.scheduleNextWord();
        }, delayMs);
        return;
      }
      
      // 这个词已经过去了，跳过
      this.nextWordIndex++;
    }
  }
  
  private clearTimingTimer(): void {
    if (this.timingTimer !== null) {
      window.clearTimeout(this.timingTimer);
      this.timingTimer = null;
    }
  }
  
  private sendEvent(event: OffscreenEvent): void {
    browser.runtime.sendMessage(event);
  }
}
```

---

## 4. 缓存策略

### 4.1 缓存 Key

```typescript
// lib/cache-manager.ts

import { createHash } from 'crypto'; // 注意：需要 polyfill（webcrypto）

interface CacheKey {
  hash: string;  // SHA-256 hex
}

function computeCacheKey(text: string, config: ProviderConfig): CacheKey {
  // 规范化配置：只包含影响音频输出的字段
  const normalized = {
    provider: config.provider,
    voiceId: config.voiceId,
    model: config.model,
    // 不包含 apiKey, baseUrl 等
  };
  
  const payload = JSON.stringify({ text, config: normalized });
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
  
  return { hash };
}
```

### 4.2 L1: 内存 LRU

```typescript
// lib/cache-manager.ts

interface CacheEntry {
  key: string;
  result: SynthesisResult;
  size: number;  // audio.byteLength
}

class L1Cache {
  private readonly maxSize = 50 * 1024 * 1024;  // 50MB
  private readonly entries = new Map<string, CacheEntry>();
  private currentSize = 0;
  
  get(key: string): SynthesisResult | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // LRU: 移到末尾
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.result;
    }
  }
  
  put(key: string, result: SynthesisResult): void {
    const size = result.audio.byteLength;
    
    // 驱逐直到有足够空间
    while (this.currentSize + size > this.maxSize && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      const entry = this.entries.get(firstKey)!;
      this.entries.delete(firstKey);
      this.currentSize -= entry.size;
    }
    
    this.entries.set(key, { key, result, size });
    this.currentSize += size;
  }
  
  clear(): void {
    this.entries.clear();
    this.currentSize = 0;
  }
}
```

### 4.3 L2: IndexedDB

```typescript
// lib/cache-manager.ts

interface L2Entry {
  key: string;
  audio: ArrayBuffer;
  mime: string;
  durationMs: number;
  timings?: WordTiming[];
  timestamp: number;  // 写入时间，用于 LRU 清理
}

class L2Cache {
  private db: IDBDatabase | null = null;
  
  async init(): Promise<void> {
    this.db = await openDB('sayloud-cache', 1, {
      upgrade(db) {
        const store = db.createObjectStore('audio', { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp');
      },
    });
  }
  
  async get(key: string): Promise<SynthesisResult | undefined> {
    const tx = this.db!.transaction('audio', 'readonly');
    const entry = await tx.objectStore('audio').get(key) as L2Entry | undefined;
    
    if (entry) {
      return {
        audio: entry.audio,
        mime: entry.mime,
        durationMs: entry.durationMs,
        timings: entry.timings,
      };
    }
  }
  
  async put(key: string, result: SynthesisResult): Promise<void> {
    const entry: L2Entry = {
      key,
      audio: result.audio,
      mime: result.mime,
      durationMs: result.durationMs,
      timings: result.timings,
      timestamp: Date.now(),
    };
    
    const tx = this.db!.transaction('audio', 'readwrite');
    await tx.objectStore('audio').put(entry);
  }
  
  async clear(): Promise<void> {
    const tx = this.db!.transaction('audio', 'readwrite');
    await tx.objectStore('audio').clear();
  }
}

export class CacheManager {
  private readonly l1 = new L1Cache();
  private readonly l2 = new L2Cache();
  
  async init(): Promise<void> {
    await this.l2.init();
  }
  
  computeKey(text: string, config: ProviderConfig): string {
    return computeCacheKey(text, config).hash;
  }
  
  getL1(key: string): SynthesisResult | undefined {
    return this.l1.get(key);
  }
  
  async getL2(key: string): Promise<SynthesisResult | undefined> {
    return await this.l2.get(key);
  }
  
  putL1(key: string, result: SynthesisResult): void {
    this.l1.put(key, result);
  }
  
  async putL2(key: string, result: SynthesisResult): Promise<void> {
    await this.l2.put(key, result);
  }
  
  clearL1(): void {
    this.l1.clear();
  }
  
  async clearL2(): Promise<void> {
    await this.l2.clear();
  }
}
```

---

## 5. PlaybackEngine 集成

### 5.1 Speaker 接口扩展

```typescript
// lib/speaker.ts (已有)

// P1: 同步接口
interface Speaker {
  pickVoice(voices: Voice[], preferredLang?: string): Voice | null;
  speak(text: string, voice: Voice, rate: number, onEvent: (event: SpeakEvent) => void): void;
  stop(): void;
}

// P2: 需要异步接口
interface AsyncSpeaker {
  pickVoice(voices: Voice[], preferredLang?: string): Voice | null;
  synthesize(text: string, voice: Voice): Promise<{ id: string }>;
  play(id: string, rate: number, startTimeMs?: number, onEvent: (event: SpeakEvent) => void): Promise<void>;
  pause(): void;
  stop(): void;
}
```

实现两个适配器：

1. **BrowserSpeaker** (已有) — 包装 `chrome.tts`，同步接口
2. **OffscreenSpeaker** (新增) — 包装 offscreen，异步接口

### 5.2 PlaybackEngine 修改

```typescript
// lib/playback-engine.ts (现有)

// P1: 同步播放
private async playCurrentSentence() {
  const sentence = this.sentences[this.cursor.sentenceIndex];
  this.speaker.speak(sentence.text, this.voice, this.rate, (event) => {
    this.handleSpeakEvent(event);
  });
}

// P2: 异步播放
private async playCurrentSentence() {
  const sentence = this.sentences[this.cursor.sentenceIndex];
  
  // 1. 合成（可能命中缓存）
  const { id } = await this.speaker.synthesize(sentence.text, this.voice);
  
  // 2. 播放
  await this.speaker.play(id, this.rate, this.cursor.charOffset, (event) => {
    this.handleSpeakEvent(event);
  });
}
```

**问题**：现有 `PlaybackEngine.speaker` 是同步接口。

**解决方案**：

- 定义统一的 `Speaker` 接口，同时支持同步和异步
- BrowserSpeaker 实现同步方法（synthesize 立即返回）
- OffscreenSpeaker 实现异步方法
- PlaybackEngine 用 `await` 调用，BrowserSpeaker 的 Promise 立即 resolve

```typescript
// lib/speaker.ts

interface Speaker {
  readonly kind: 'sync' | 'async';
  
  pickVoice(voices: Voice[], preferredLang?: string): Voice | null;
  
  /** 合成（同步 speaker 立即返回，异步 speaker 等待缓存/合成） */
  synthesize(text: string, voice: Voice): Promise<{ id: string }>;
  
  /** 播放 */
  play(id: string, rate: number, startTimeMs: number, onEvent: (event: SpeakEvent) => void): Promise<void>;
  
  pause(): void;
  stop(): void;
}

// BrowserSpeaker: synthesize 立即返回，play 调用 chrome.tts.speak
// OffscreenSpeaker: synthesize 发送 'synthesize' 指令并等待 'ready'，play 发送 'play' 指令
```

### 5.3 预加载调度

```typescript
// lib/playback-engine.ts

private async prefetch() {
  const horizonMs = 12_000 * (1 + this.rate * 0.5);  // 自适应：12s × (1 + rate × RTF假设0.5)
  
  let accumulatedMs = 0;
  let prefetchIndex = this.cursor.sentenceIndex + 1;
  
  const pending: Promise<void>[] = [];
  
  while (accumulatedMs < horizonMs && prefetchIndex < this.sentences.length) {
    const sentence = this.sentences[prefetchIndex];
    
    // 并发控制：cloud 2路，localhost 1路
    if (pending.length >= this.maxConcurrency) {
      await Promise.race(pending);
    }
    
    const task = this.speaker.synthesize(sentence.text, this.voice).then(() => {
      // 从 pending 中移除
      const index = pending.indexOf(task);
      if (index >= 0) pending.splice(index, 1);
    });
    
    pending.push(task);
    
    // 估算该句时长（字数 / 300 字/分钟）
    accumulatedMs += (sentence.text.length / 300) * 60_000 / this.rate;
    prefetchIndex++;
  }
}
```

---

## 6. OffscreenManager

管理 offscreen 的生命周期：创建、检测回收、重建。

```typescript
// lib/offscreen-manager.ts

export class OffscreenManager {
  private creating: Promise<void> | null = null;
  
  async ensureReady(): Promise<void> {
    if (await browser.offscreen.hasDocument()) return;
    
    // 避免并发创建
    if (this.creating) {
      await this.creating;
      return;
    }
    
    this.creating = browser.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play cloud TTS audio',
    }).finally(() => {
      this.creating = null;
    });
    
    await this.creating;
  }
  
  async sendCommand(cmd: OffscreenCommand): Promise<void> {
    await this.ensureReady();
    await browser.runtime.sendMessage(cmd);
  }
}
```

集成到 `lib/container.ts`：

```typescript
// lib/container.ts

export function createApp(deps: AppDeps): App {
  const offscreenManager = new OffscreenManager();
  
  // 根据配置选择 speaker
  const speaker = shouldUseCloudTTS(config)
    ? new OffscreenSpeaker(offscreenManager, config)
    : new BrowserSpeaker(deps.tts);
  
  const fallbackSpeaker = new BrowserSpeaker(deps.tts);
  
  const engine = new PlaybackEngine({
    speaker,
    fallbackSpeaker,
    store: deps.storage.session,
  });
  
  // ...
}
```

---

## 7. 错误处理

### 7.1 错误码统一

所有 Provider 的错误都映射到统一的错误码：

```typescript
// lib/providers/errors.ts

export class ProviderError extends Error {
  constructor(
    public readonly code: 'invalid-key' | 'service-unavailable' | 'rate-limit' | 'no-quota' | 'network-error' | 'unknown',
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}
```

### 7.2 降级策略

```typescript
// lib/playback-engine.ts (P1 已实现)

private async playCurrentSentence() {
  try {
    await this.speaker.synthesize(...);
    await this.speaker.play(...);
  } catch (error) {
    if (this.canFallback(error)) {
      // 切换到 fallbackSpeaker（浏览器语音）
      this.speaker = this.fallbackSpeaker;
      this.usingFallback = true;
      
      // 重新播放当前句
      await this.playCurrentSentence();
    } else {
      this.handleError(error);
    }
  }
}
```

---

## 8. 测试策略

### 8.1 Provider 单元测试

用 MSW mock HTTP/WebSocket 响应：

```typescript
// tests/unit/providers/dashscope.test.ts

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DashscopeProvider } from '~/lib/providers/dashscope';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('DashscopeProvider', () => {
  it('synthesizes with CosyVoice', async () => {
    server.use(
      http.post('https://test.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', () => {
        return HttpResponse.text('event:result\ndata:{"audio":"base64..."}\n\n');
      })
    );
    
    const provider = new DashscopeProvider();
    const result = await provider.synthesize({
      text: '你好世界',
      voiceId: 'cosyvoice-v1',
      signal: AbortSignal.timeout(5000),
    }, {
      provider: 'dashscope',
      apiKey: 'test-key',
      workspaceId: 'test-ws',
      region: 'cn-beijing',
      model: 'cosyvoice-v3',
    });
    
    expect(result.audio).toBeInstanceOf(ArrayBuffer);
    expect(result.mime).toBe('audio/mpeg');
  });
});
```

### 8.2 端到端测试

用测试 key（或 mock）验证完整流程：

```typescript
// tests/e2e/cloud-tts.spec.ts

test('plays with dashscope', async ({ page }) => {
  // 注入测试配置
  await page.addInitScript(() => {
    localStorage.setItem('sayloud-config', JSON.stringify({
      provider: 'dashscope',
      apiKey: process.env.DASHSCOPE_TEST_KEY,
      // ...
    }));
  });
  
  await page.goto('http://localhost:3000/test-page.html');
  await page.click('#sayloud-play');
  
  // 等待首句播放
  await page.waitForSelector('.sayloud-highlight-sentence', { timeout: 3000 });
  
  // 验证高亮
  const highlight = await page.$('.sayloud-highlight-sentence');
  expect(highlight).toBeTruthy();
});
```

### 8.3 CI 中的测试

- **Unit tests**: 用 MSW mock，不需要真实 key
- **E2E tests**: 
  - 默认只测试 browser voice（P1）
  - 云端服务的 E2E 用 `@skip` 标记，只在本地手动运行

---

## 9. 实施步骤

### Phase 1: Provider 接口层（2 天）

1. **Task 1.1**: 定义 Provider 接口 + 错误码 + 时间戳对齐工具（1分）
2. **Task 1.2**: 实现 DashscopeProvider（2分）
3. **Task 1.3**: 实现 VolcengineProvider（2分）
4. **Task 1.4**: 实现 OpenAICompatProvider（2分）
5. **Task 1.5**: 实现 ElevenLabsProvider（2分）
6. **Task 1.6**: 实现 AzureProvider（3分，WebSocket 复杂度高）

每个 Provider 都包含：
- 适配器实现
- MSW mock + 单元测试
- 错误映射

### Phase 2: Offscreen + AudioWorker（2 天）

7. **Task 2.1**: TimelinePlayer（<audio> 播放 + 时间轴推送）（2分）
8. **Task 2.2**: CacheManager（L1 LRU + L2 IndexedDB）（2分）
9. **Task 2.3**: AudioWorker（集成 Provider + Cache + Player）（2分）
10. **Task 2.4**: Offscreen entrypoint + 消息协议（1分）

### Phase 3: PlaybackEngine 集成（1.5 天）

11. **Task 3.1**: Speaker 接口统一（支持同步+异步）（1分）
12. **Task 3.2**: OffscreenSpeaker 实现（2分）
13. **Task 3.3**: OffscreenManager（生命周期管理）（1分）
14. **Task 3.4**: 预加载调度（2分）
15. **Task 3.5**: Container 集成（选择 speaker 逻辑）（1分）

### Phase 4: 测试 + 验证（1.5 天）

16. **Task 4.1**: E2E 测试（6 个服务商）（2分）
17. **Task 4.2**: 手动验证清单（长文、变速、跳转、缓存命中）（2分）
18. **Task 4.3**: 性能测试（首句延迟、缓存命中率）（1分）

---

## 10. 风险 & 缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Azure Speech SDK 体积大（~400KB） | 扩展体积 | 只在 offscreen 里懒加载，不打包到 content script |
| Offscreen 回收时机不确定 | 播放中断 | 实测约 35s，实现重建逻辑 + 从 L2 恢复 |
| 服务商限流 | 合成失败 | 降级到 fallbackSpeaker（浏览器语音） |
| 缓存 key 冲突 | 播放错误音频 | SHA-256 冲突概率极低；config 规范化要准确 |
| WebSocket 连接泄漏（Azure） | 内存泄漏 | offscreen 回收时自动清理；主动关闭连接 |

---

## 11. 验收标准

### 11.1 功能验收

- [ ] 6 个服务商都能播放（用测试 key 验证）
- [ ] 逐词高亮在 CosyVoice / Azure / ElevenLabs 上正常工作
- [ ] 变速（0.5x - 2x）即时生效，音频不重新合成
- [ ] 暂停 → 播放无断档
- [ ] 跳转（seek）立即生效，取消预加载中的请求
- [ ] 音色切换清空缓存，重新合成
- [ ] 同一文章二次播放缓存命中率 > 80%

### 11.2 性能验收

- [ ] 首句延迟 < 2 秒（云端服务，正常网络）
- [ ] 长文（1 万字）播放无断档
- [ ] L1 缓存命中率 > 50%（连续播放）
- [ ] L2 缓存命中率 > 80%（二次播放）

### 11.3 边缘情况

- [ ] Offscreen 回收后能正确恢复播放
- [ ] 网络错误能降级到浏览器语音
- [ ] 服务未开通提示清晰（附控制台链接）
- [ ] Key 无效提示清晰

### 11.4 测试覆盖

- [ ] Provider 单元测试覆盖率 > 80%
- [ ] AudioWorker 单元测试覆盖率 > 80%
- [ ] E2E 测试覆盖 6 个服务商（手动运行）

---

## 12. 后续工作（P3）

P2 完成后，P3 将实现：

- 设置 UI（Side Panel）
- 服务商配置表单（schema-driven）
- 音色选择器
- 缓存管理（清空、查看大小）
- 错误提示优化（BubbleCard）

P2 为了验证流程，会硬编码测试配置。P3 会把这些配置移到 UI 中。
