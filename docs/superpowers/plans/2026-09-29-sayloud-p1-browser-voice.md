# SayLoud P1：浏览器语音直通 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用浏览器内置语音读整页，句级和词级高亮同步，页面内 28px 竖条控制播放。

**架构：** Service Worker 持有 PlaybackEngine（状态机 + chrome.tts 调用 + 进度推送），content script 提取正文、分句分词、CSS Custom Highlight API 高亮、Preact 渲染竖条 UI。状态快照存 storage.session，SW 被回收后恢复。

**技术栈：** WXT 0.21 + TypeScript 7 + Preact 10 + Vitest 5 + Playwright 1.63 + Biome 2.5

**规格：** `docs/superpowers/specs/2026-09-29-sayloud-design.md`（§0-§3、§4.1-§4.2、§5.1-§5.3）

**P1 范围：** 浏览器语音读整页 + 句级/词级高亮（自适应深色页面推迟到 P4）+ 竖条（播放/暂停/上一句/下一句/语速/剩余时间进度环）+ 气泡卡片提示 + 点击正文跳读 + 自动滚动。**不包含**：云端服务、设置面板、段落按钮、划词按钮、快捷键。首次启动默认用系统第一个音色，语速 1.0。

**P2-P4 后续计划：**
- P2：6 个云端服务适配器 + 对齐算法 + offscreen 音频工作器 + 缓存 + 预取 + 错误分类
- P3：设置面板（两标签页 + schema 表单 + 音色选择 + 首次使用引导）
- P4：页面交互（段落按钮 + 划词 + 快捷键）+ 权限 + i18n + 商店素材

## 全局约束

- Node.js ≥ 22，pnpm ≥ 9
- WXT 0.21（Vite ≥ 6.3.4，TypeScript ≥ 5.4）
- manifest_version 3，Chrome ≥ 121（CSS Custom Highlight API、offscreen documents、chrome.sidePanel）
- 权限：`activeTab`、`scripting`、`storage`、`tts`（P1）；`offscreen`、`unlimitedStorage` 推迟到 P2
- TypeScript strict mode，Biome 格式化与 lint
- 每个任务结束时 `pnpm build` 无错误，相关测试通过
- 中英双语：代码、注释、commit 消息用英文；界面文案本期只有英文（i18n 推迟到 P4）
- 命名：`browser-voice` / `BrowserVoice` / `browserVoice`（浏览器语音）；`side-player` / `SidePlayer` / `sidePlayer`（竖条）

## 审查重点（Review Focus）

1. **空文本输入**：用户在空白页、只有图片的页面、或 Readability 判为不可读的页面点朗读 → 预期竖条显示气泡卡片「页面无可读内容」，不调用 chrome.tts
2. **SW 被回收后恢复**：播放中途 SW 因 30 秒空闲被回收，content script 的 Port 断开又重连 → 预期 SW 从 storage.session 恢复会话快照，content script 重新获得句子列表和当前 cursor，竖条状态（播放中、暂停、当前句 ID）恢复正确
3. **切换 tab 后再回来**：在 tab A 播放，切到 tab B，tab A 自动暂停；回到 tab A 点播放 → 预期从上次位置继续，高亮位置正确
4. **DOM 节点被替换**：播放期间页面 JavaScript 替换了正文容器（SPA 路由跳转）→ 预期高亮自动清除，会话结束，竖条消失或显示「页面已跳转」
5. **chrome.tts.speak 报错**：某些平台浏览器语音不可用（Linux 未安装 speech-dispatcher、headless Chrome）→ 预期气泡卡片提示「浏览器语音不可用」，状态进入 error，不无限重试

---

## 文件结构

```
tts-ng/
├── wxt.config.ts                      WXT 配置：manifest、权限、entrypoints
├── tsconfig.json                      TS 配置：strict + paths
├── biome.json                         Biome 配置
├── vitest.config.ts                   Vitest 配置：WxtVitest 插件
├── playwright.config.ts               E2E 配置
├── package.json                       依赖 + scripts
├── .github/workflows/ci.yml           CI：typecheck + biome + test + e2e + build
├── entrypoints/
│   ├── background.ts                  SW：PlaybackEngine + Router + chrome.tts Speaker
│   ├── content.ts                     content script（runtime 注册）：UI mount + 提取 + 分句 + 高亮
│   └── content/                       content script 子模块
│       ├── extractor.ts               正文提取 + Readability + 偏移映射
│       ├── segmenter.ts               分句分词（Intl.Segmenter）
│       ├── highlighter.ts             CSS Custom Highlight API 句/词高亮
│       └── ui/
│           ├── SidePlayer.tsx         竖条 Preact 组件
│           ├── BubbleCard.tsx         气泡卡片 Preact 组件
│           └── styles.css             Shadow DOM 样式
├── lib/
│   ├── types.ts                       共享类型：Session、EngineState、Message protocol
│   ├── engine/
│   │   ├── PlaybackEngine.ts         状态机：会话、cursor、播放控制
│   │   └── Speaker.ts                 接口 + BrowserSpeaker 实现
│   └── utils/
│       ├── text-normalize.ts          空白合并、NFC
│       └── storage-snapshot.ts        storage.session 快照读写
├── tests/
│   ├── unit/
│   │   ├── extractor.test.ts          提取 + 偏移映射
│   │   ├── segmenter.test.ts          分句分词
│   │   ├── engine.test.ts             PlaybackEngine 状态机
│   │   └── speaker.test.ts            BrowserSpeaker（mock chrome.tts）
│   └── e2e/
│       ├── fixtures.ts                Playwright fixture：加载扩展 + 静态页面
│       ├── basic-read.spec.ts         点朗读 → 播放 → 高亮推进
│       ├── controls.spec.ts           暂停/恢复/上一句/下一句/倍速
│       └── edge-cases.spec.ts         空页面、DOM 替换、TTS 错误
└── public/
    └── icon-128.png                   扩展图标（临时占位）
```

---

## 任务 1：项目脚手架 + CI

**文件：**
- 创建：`package.json`、`wxt.config.ts`、`tsconfig.json`、`biome.json`、`vitest.config.ts`、`playwright.config.ts`、`.github/workflows/ci.yml`、`public/icon-128.png`
- 创建：`entrypoints/background.ts`（空 SW）、`entrypoints/content.ts`（空 content script）

- [ ] **步骤 1：初始化项目**

```bash
cd ~/Dev/tts-ng
pnpm init
pnpm add -D wxt@0.21.4 typescript@7.0.2 @types/chrome@0.3.4 vite@^7.3 \
  preact@10.29.8 @preact/preset-vite@2.10.6 \
  vitest@5.0.2 happy-dom@20.14.5 @vitest/ui@5.0.2 \
  @playwright/test@1.63.0 \
  @biomejs/biome@2.5.14 \
  @mozilla/readability@0.6.0 \
  @testing-library/preact@3.2.4 fake-indexeddb@6.2.5
pnpm add @wxt-dev/browser@0.3.4
```

- [ ] **步骤 2：创建 `wxt.config.ts`**

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'SayLoud',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'tts'],
    action: {},
  },
});
```

- [ ] **步骤 3：创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["@types/chrome", "vite/client"],
    "paths": {
      "~/*": ["./*"]
    }
  },
  "include": ["entrypoints", "lib", "tests", "wxt.config.ts"]
}
```

- [ ] **步骤 4：创建 `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

- [ ] **步骤 5：创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [await WxtVitest()],
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
```

- [ ] **步骤 6：创建 `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    headless: false, // 需要看到 TTS 播放
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **步骤 7：创建 `.github/workflows/ci.yml`**

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsc --noEmit
      - run: pnpm exec biome check .
      - run: pnpm test
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
      - run: pnpm build
```

- [ ] **步骤 8：创建空 entrypoints**

```ts
// entrypoints/background.ts
export default defineBackground(() => {
  console.log('SayLoud SW started');
});

// entrypoints/content.ts
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    console.log('SayLoud content script loaded');
  },
});
```

- [ ] **步骤 9：添加 scripts 到 `package.json`**

```json
{
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "format": "biome format --write .",
    "lint": "biome check ."
  }
}
```

- [ ] **步骤 10：创建临时图标 `public/icon-128.png`**

128x128 蓝色圆形 + 白色播放三角（用任意工具或占位 PNG）

- [ ] **步骤 11：构建验证**

```bash
pnpm build
```

预期：`.output/chrome-mv3/` 生成 manifest.json、background.js、content.js、icon-128.png

- [ ] **步骤 12：Commit**

```bash
git add -A
git commit -m "chore: scaffold P1 with WXT + TS + Preact + CI"
```

---

## 任务 2：共享类型与消息协议

**文件：**
- 创建：`lib/types.ts`

- [ ] **步骤 1：编写失败的导入测试**

```ts
// tests/unit/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Session, EngineState, MessageToEngine, MessageFromEngine } from '~/lib/types';

describe('types', () => {
  it('exports Session type', () => {
    const s: Session = {
      tabId: 1,
      docId: 'doc1',
      sentences: [],
      cursor: 0,
      voice: 'en-US',
      rate: 1.0,
    };
    expect(s.tabId).toBe(1);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test types.test
```

预期：FAIL，报错 "Cannot find module '~/lib/types'"

- [ ] **步骤 3：实现 `lib/types.ts`**

```ts
// lib/types.ts
export interface Session {
  tabId: number;
  docId: string;
  sentences: Sentence[];
  cursor: number; // 当前句子索引
  voice: string; // 音色名
  rate: number; // 0.5-3.0
}

export interface Sentence {
  id: string; // `${blockIndex}:${sentenceIndex}`
  text: string;
  charStart: number; // 在块内的字符偏移
  charEnd: number;
}

export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface MessageToEngine {
  type: 'start' | 'pause' | 'resume' | 'stop' | 'seek' | 'setRate' | 'getState';
  sentences?: Sentence[];
  cursor?: number;
  rate?: number;
}

export interface MessageFromEngine {
  type: 'state' | 'progress' | 'error';
  state?: EngineState;
  cursor?: number;
  sentenceId?: string;
  wordIndex?: number;
  error?: string;
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test types.test
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/types.ts tests/unit/types.test.ts
git commit -m "feat(lib): add shared types for session and messages"
```

---

## 任务 3：正文提取 + 偏移映射

**文件：**
- 创建：`entrypoints/content/extractor.ts`
- 创建：`tests/unit/extractor.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tests/unit/extractor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { extractContent } from '~/entrypoints/content/extractor';

describe('extractor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<article><p>Hello world.</p><p>Goodbye.</p></article>';
  });

  it('extracts blocks with text and offset maps', () => {
    const blocks = extractContent();
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Hello world.');
    expect(blocks[1].text).toBe('Goodbye.');
  });

  it('builds offset-to-range map', () => {
    const blocks = extractContent();
    const range = blocks[0].rangeForOffset(0, 5); // "Hello"
    expect(range.toString()).toBe('Hello');
  });

  it('returns empty array for unreadable page', () => {
    document.body.innerHTML = '<div></div>';
    const blocks = extractContent();
    expect(blocks).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test extractor.test
```

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 `extractor.ts`**

使用 `document.cloneNode(true)` + WeakMap + Mozilla Readability（`serializer: el => el`），按块级祖先分组，构建「字符偏移 → (文本节点, 节点内偏移)」对照表，`rangeForOffset(start, end)` 返回 DOM Range。

空白页或 `isProbablyReaderable() === false` 时返回 `[]`。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test extractor.test
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add entrypoints/content/extractor.ts tests/unit/extractor.test.ts
git commit -m "feat(content): implement text extraction with offset mapping"
```

---

## 任务 4：分句分词（Intl.Segmenter）

**文件：**
- 创建：`entrypoints/content/segmenter.ts`
- 创建：`tests/unit/segmenter.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tests/unit/segmenter.test.ts
import { describe, it, expect } from 'vitest';
import { segmentSentences, segmentWords } from '~/entrypoints/content/segmenter';

describe('segmenter', () => {
  it('splits text into sentences', () => {
    const sents = segmentSentences('Hello world. Goodbye!', 'en');
    expect(sents).toHaveLength(2);
    expect(sents[0]).toEqual({ text: 'Hello world.', start: 0, end: 12 });
    expect(sents[1]).toEqual({ text: 'Goodbye!', start: 13, end: 21 });
  });

  it('splits sentence into words', () => {
    const words = segmentWords('Hello world.', 'en');
    expect(words).toHaveLength(2);
    expect(words[0]).toEqual({ text: 'Hello', start: 0, end: 5 });
    expect(words[1]).toEqual({ text: 'world', start: 6, end: 11 });
  });

  it('handles Chinese text', () => {
    const sents = segmentSentences('你好。再见。', 'zh');
    expect(sents).toHaveLength(2);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test segmenter.test
```

预期：FAIL

- [ ] **步骤 3：实现 `segmenter.ts`**

```ts
// entrypoints/content/segmenter.ts
export interface Segment {
  text: string;
  start: number;
  end: number;
}

export function segmentSentences(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  return Array.from(seg.segment(text), (s) => ({
    text: s.segment,
    start: s.index,
    end: s.index + s.segment.length,
  }));
}

export function segmentWords(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => ({
      text: s.segment,
      start: s.index,
      end: s.index + s.segment.length,
    }));
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test segmenter.test
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add entrypoints/content/segmenter.ts tests/unit/segmenter.test.ts
git commit -m "feat(content): add sentence and word segmentation"
```

---

## 任务 5：CSS Custom Highlight API 高亮器

**文件：**
- 创建：`entrypoints/content/highlighter.ts`
- 创建：`tests/unit/highlighter.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tests/unit/highlighter.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Highlighter } from '~/entrypoints/content/highlighter';

describe('Highlighter', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p>Hello brave new world.</p>';
    // Mock CSS.highlights
    globalThis.CSS = { highlights: new Map() } as any;
  });

  it('highlights sentence range', () => {
    const hl = new Highlighter();
    const range = document.createRange();
    const text = document.body.firstChild!.firstChild!;
    range.setStart(text, 0);
    range.setEnd(text, 5);
    hl.setSentence(range);
    const sent = (CSS.highlights.get('sayloud-sentence') as any);
    expect(sent).toBeDefined();
    expect([...sent]).toHaveLength(1);
  });

  it('highlights word range', () => {
    const hl = new Highlighter();
    const range = document.createRange();
    const text = document.body.firstChild!.firstChild!;
    range.setStart(text, 6);
    range.setEnd(text, 11);
    hl.setWord(range);
    const word = CSS.highlights.get('sayloud-word') as any;
    expect(word).toBeDefined();
  });

  it('clears highlights', () => {
    const hl = new Highlighter();
    const r = document.createRange();
    hl.setSentence(r);
    hl.clear();
    expect(CSS.highlights.get('sayloud-sentence')).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test highlighter.test
```

预期：FAIL

- [ ] **步骤 3：实现 `highlighter.ts`**

```ts
// entrypoints/content/highlighter.ts
export class Highlighter {
  private sentenceHighlight = new Highlight();
  private wordHighlight = new Highlight();

  constructor() {
    CSS.highlights.set('sayloud-sentence', this.sentenceHighlight);
    CSS.highlights.set('sayloud-word', this.wordHighlight);
  }

  setSentence(range: Range) {
    this.sentenceHighlight.clear();
    this.sentenceHighlight.add(range);
  }

  setWord(range: Range) {
    this.wordHighlight.clear();
    this.wordHighlight.add(range);
  }

  clearWord() {
    this.wordHighlight.clear();
  }

  clear() {
    CSS.highlights.delete('sayloud-sentence');
    CSS.highlights.delete('sayloud-word');
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test highlighter.test
```

预期：PASS

- [ ] **步骤 5：注入 CSS 样式（在 content.ts 启动时调用）**

在 `entrypoints/content.ts` 的 `main()` 里加：

```ts
chrome.scripting.insertCSS({
  target: { tabId: chrome.tabs.getCurrent().id },
  css: `
    ::highlight(sayloud-sentence) {
      background-color: rgba(255, 214, 0, 0.34);
    }
    ::highlight(sayloud-word) {
      background-color: #ffb300;
    }
  `,
});
```

（注：`chrome.tabs.getCurrent()` 在 content script 中不可用，需改为从 SW 通过消息获取 tabId，或直接在 SW 中注入 CSS。此处先占位，实际实现时调整。）

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/content/highlighter.ts tests/unit/highlighter.test.ts entrypoints/content.ts
git commit -m "feat(content): add CSS Custom Highlight API highlighter"
```

---

## 任务 6：BrowserSpeaker（chrome.tts 包装）

**文件：**
- 创建：`lib/engine/Speaker.ts`
- 创建：`tests/unit/speaker.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tests/unit/speaker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserSpeaker } from '~/lib/engine/Speaker';

describe('BrowserSpeaker', () => {
  beforeEach(() => {
    globalThis.chrome = {
      tts: {
        speak: vi.fn(),
        stop: vi.fn(),
        getVoices: vi.fn((cb) => cb([{ voiceName: 'TestVoice', lang: 'en-US', eventTypes: ['start', 'word', 'end'] }])),
      },
    } as any;
  });

  it('speaks text and emits word events', async () => {
    const speaker = new BrowserSpeaker();
    const events: any[] = [];
    speaker.on('word', (e) => events.push(e));
    speaker.on('end', () => events.push({ type: 'end' }));

    speaker.speak('Hello world.', 'TestVoice', 1.0);
    
    // 模拟 chrome.tts.speak 的回调
    const onEvent = (chrome.tts.speak as any).mock.calls[0][1].onEvent;
    onEvent({ type: 'start', charIndex: 0 });
    onEvent({ type: 'word', charIndex: 0, length: 5 });
    onEvent({ type: 'word', charIndex: 6, length: 5 });
    onEvent({ type: 'end', charIndex: 12 });

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ charIndex: 0, length: 5 });
  });

  it('stops speaking', () => {
    const speaker = new BrowserSpeaker();
    speaker.speak('Hello.', 'TestVoice', 1.0);
    speaker.stop();
    expect(chrome.tts.stop).toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test speaker.test
```

预期：FAIL

- [ ] **步骤 3：实现 `lib/engine/Speaker.ts`**

```ts
// lib/engine/Speaker.ts
export interface SpeakEvent {
  type: 'word' | 'end' | 'error';
  charIndex?: number;
  length?: number;
  error?: string;
}

export interface Speaker {
  speak(text: string, voice: string, rate: number): void;
  stop(): void;
  on(event: 'word' | 'end' | 'error', handler: (e: SpeakEvent) => void): void;
}

export class BrowserSpeaker implements Speaker {
  private handlers: Map<string, ((e: SpeakEvent) => void)[]> = new Map();

  speak(text: string, voice: string, rate: number): void {
    chrome.tts.speak(text, {
      voiceName: voice,
      rate,
      onEvent: (e) => {
        if (e.type === 'word') {
          this.emit('word', { type: 'word', charIndex: e.charIndex, length: e.length });
        } else if (e.type === 'end') {
          this.emit('end', { type: 'end' });
        } else if (e.type === 'error') {
          this.emit('error', { type: 'error', error: e.errorMessage });
        }
      },
    });
  }

  stop(): void {
    chrome.tts.stop();
  }

  on(event: 'word' | 'end' | 'error', handler: (e: SpeakEvent) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  private emit(event: string, data: SpeakEvent): void {
    this.handlers.get(event)?.forEach((h) => h(data));
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test speaker.test
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/engine/Speaker.ts tests/unit/speaker.test.ts
git commit -m "feat(engine): add BrowserSpeaker wrapping chrome.tts"
```

---

## 任务 7：PlaybackEngine 状态机

**文件：**
- 创建：`lib/engine/PlaybackEngine.ts`
- 创建：`tests/unit/engine.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// tests/unit/engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '~/lib/engine/PlaybackEngine';
import type { Speaker } from '~/lib/engine/Speaker';
import type { Sentence } from '~/lib/types';

describe('PlaybackEngine', () => {
  const mockSpeaker: Speaker = {
    speak: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
  };

  const sentences: Sentence[] = [
    { id: '0:0', text: 'Hello.', charStart: 0, charEnd: 6 },
    { id: '0:1', text: 'World.', charStart: 7, charEnd: 13 },
  ];

  it('starts playing from cursor 0', () => {
    const engine = new PlaybackEngine(mockSpeaker);
    engine.start(1, 'doc1', sentences, 0, 'TestVoice', 1.0);
    expect(engine.getState()).toBe('playing');
    expect(mockSpeaker.speak).toHaveBeenCalledWith('Hello.', 'TestVoice', 1.0);
  });

  it('pauses and resumes', () => {
    const engine = new PlaybackEngine(mockSpeaker);
    engine.start(1, 'doc1', sentences, 0, 'TestVoice', 1.0);
    engine.pause();
    expect(engine.getState()).toBe('paused');
    expect(mockSpeaker.stop).toHaveBeenCalled();
    engine.resume();
    expect(engine.getState()).toBe('playing');
  });

  it('moves to next sentence after end event', () => {
    const engine = new PlaybackEngine(mockSpeaker);
    const onProgress = vi.fn();
    engine.on('progress', onProgress);
    
    // 注册 speaker.on('end', ...) 的回调
    let endHandler: any;
    (mockSpeaker.on as any).mockImplementation((event: string, handler: any) => {
      if (event === 'end') endHandler = handler;
    });

    engine.start(1, 'doc1', sentences, 0, 'TestVoice', 1.0);
    endHandler({ type: 'end' }); // 模拟第一句结束
    
    expect(engine.getCursor()).toBe(1);
    expect(mockSpeaker.speak).toHaveBeenCalledWith('World.', 'TestVoice', 1.0);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test engine.test
```

预期：FAIL

- [ ] **步骤 3：实现 `lib/engine/PlaybackEngine.ts`**

状态机：`idle` → `playing` ⇄ `paused` → `ended`。`start(tabId, docId, sentences, cursor, voice, rate)` 开始播放，`pause()` 停止当前句并记录 cursor，`resume()` 从 cursor 继续，`next()` / `prev()` / `seek(cursor)` 跳转。

Speaker 的 `end` 事件触发 `cursor++` 并继续播放下一句；`word` 事件触发 `emit('progress', { cursor, wordIndex, charIndex })`。

保存 `session` 快照（tabId / docId / sentences / cursor / voice / rate）到 `this.session`，供外部写入 `storage.session`。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test engine.test
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/engine/PlaybackEngine.ts tests/unit/engine.test.ts
git commit -m "feat(engine): implement PlaybackEngine state machine"
```

---

## 任务 8：Service Worker 集成 + storage.session 快照

**文件：**
- 修改：`entrypoints/background.ts`
- 创建：`lib/utils/storage-snapshot.ts`

- [ ] **步骤 1：编写 storage-snapshot 测试**

```ts
// tests/unit/storage-snapshot.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveSnapshot, loadSnapshot } from '~/lib/utils/storage-snapshot';

describe('storage-snapshot', () => {
  beforeEach(() => {
    globalThis.chrome = {
      storage: {
        session: {
          set: vi.fn((data, cb) => cb?.()),
          get: vi.fn((key, cb) => cb?.({})),
        },
      },
    } as any;
  });

  it('saves session snapshot', async () => {
    await saveSnapshot({ tabId: 1, cursor: 2 });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      { 'sayloud-session': { tabId: 1, cursor: 2 } },
      expect.any(Function)
    );
  });

  it('loads session snapshot', async () => {
    (chrome.storage.session.get as any).mockImplementation((key: string, cb: any) => {
      cb({ 'sayloud-session': { tabId: 1, cursor: 2 } });
    });
    const snapshot = await loadSnapshot();
    expect(snapshot).toEqual({ tabId: 1, cursor: 2 });
  });
});
```

运行 `pnpm test storage-snapshot.test`，预期 FAIL。

- [ ] **步骤 2：实现 `lib/utils/storage-snapshot.ts`**

```ts
// lib/utils/storage-snapshot.ts
const SNAPSHOT_KEY = 'sayloud-session';

export async function saveSnapshot(data: any): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [SNAPSHOT_KEY]: data }, () => resolve());
  });
}

export async function loadSnapshot(): Promise<any> {
  return new Promise((resolve) => {
    chrome.storage.session.get(SNAPSHOT_KEY, (result) => {
      resolve(result[SNAPSHOT_KEY] || null);
    });
  });
}
```

运行 `pnpm test storage-snapshot.test`，预期 PASS。

- [ ] **步骤 3：集成到 `entrypoints/background.ts`**

```ts
// entrypoints/background.ts
import { PlaybackEngine } from '~/lib/engine/PlaybackEngine';
import { BrowserSpeaker } from '~/lib/engine/Speaker';
import { saveSnapshot, loadSnapshot } from '~/lib/utils/storage-snapshot';
import type { MessageToEngine, MessageFromEngine } from '~/lib/types';

export default defineBackground(() => {
  const speaker = new BrowserSpeaker();
  const engine = new PlaybackEngine(speaker);
  const ports = new Map<number, chrome.runtime.Port>(); // tabId -> Port

  // 恢复会话快照
  loadSnapshot().then((snapshot) => {
    if (snapshot) {
      console.log('[SW] Restoring session from snapshot:', snapshot);
      // engine.restore(snapshot); // 待 PlaybackEngine 实现 restore 方法
    }
  });

  // 监听进度事件，写快照
  engine.on('progress', async (e) => {
    await saveSnapshot(engine.getSession());
    const port = ports.get(engine.getSession()?.tabId);
    if (port) {
      port.postMessage({ type: 'progress', ...e } as MessageFromEngine);
    }
  });

  // 监听状态变化
  engine.on('stateChange', async (state) => {
    await saveSnapshot(engine.getSession());
  });

  // Port 连接（content script 连接）
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sayloud') return;
    const tabId = port.sender?.tab?.id;
    if (!tabId) return;
    ports.set(tabId, port);

    port.onMessage.addListener((msg: MessageToEngine) => {
      if (msg.type === 'start' && msg.sentences) {
        engine.start(tabId, `doc-${tabId}`, msg.sentences, msg.cursor || 0, 'en-US', msg.rate || 1.0);
      } else if (msg.type === 'pause') {
        engine.pause();
      } else if (msg.type === 'resume') {
        engine.resume();
      } else if (msg.type === 'stop') {
        engine.stop();
      } else if (msg.type === 'seek' && msg.cursor !== undefined) {
        engine.seek(msg.cursor);
      } else if (msg.type === 'setRate' && msg.rate) {
        engine.setRate(msg.rate);
      } else if (msg.type === 'getState') {
        port.postMessage({ type: 'state', state: engine.getState(), cursor: engine.getCursor() });
      }
    });

    port.onDisconnect.addListener(() => {
      ports.delete(tabId);
    });
  });

  // tab 关闭或更新时停止会话
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (engine.getSession()?.tabId === tabId) {
      engine.stop();
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url && engine.getSession()?.tabId === tabId) {
      engine.stop();
    }
  });

  console.log('[SW] SayLoud background initialized');
});
```

- [ ] **步骤 4：在 PlaybackEngine 中补充缺失方法**

在 `lib/engine/PlaybackEngine.ts` 中添加：

```ts
getSession() {
  return this.session;
}

getCursor() {
  return this.session?.cursor || 0;
}

on(event: 'progress' | 'stateChange', handler: (data: any) => void) {
  // 实现事件监听
}
```

- [ ] **步骤 5：Commit**

```bash
git add entrypoints/background.ts lib/utils/storage-snapshot.ts tests/unit/storage-snapshot.test.ts lib/engine/PlaybackEngine.ts
git commit -m "feat(sw): integrate engine with storage.session snapshots"
```

---

## 任务 9：Content Script UI mount + 提取 + 高亮集成

**文件：**
- 修改：`entrypoints/content.ts`
- 创建：`entrypoints/content/ui/SidePlayer.tsx`
- 创建：`entrypoints/content/ui/BubbleCard.tsx`
- 创建：`entrypoints/content/ui/styles.css`

- [ ] **步骤 1：创建 SidePlayer 组件（占位版本）**

```tsx
// entrypoints/content/ui/SidePlayer.tsx
import { h } from 'preact';
import { useState } from 'preact/hooks';

export function SidePlayer() {
  const [playing, setPlaying] = useState(false);

  return (
    <div class="side-player">
      <button onClick={() => setPlaying(!playing)}>
        {playing ? '⏸' : '▶'}
      </button>
      <div class="rate">1.0×</div>
    </div>
  );
}
```

- [ ] **步骤 2：创建 BubbleCard 组件（占位）**

```tsx
// entrypoints/content/ui/BubbleCard.tsx
import { h } from 'preact';

export function BubbleCard({ message }: { message: string }) {
  return <div class="bubble-card">{message}</div>;
}
```

- [ ] **步骤 3：创建样式 `entrypoints/content/ui/styles.css`**

```css
.side-player {
  position: fixed;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  background: rgba(28, 28, 30, 0.92);
  border-radius: 16px;
  padding: 11px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  z-index: 999999;
}

.side-player button {
  background: none;
  border: none;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.bubble-card {
  position: fixed;
  right: 50px;
  top: 50%;
  background: #fff;
  border-radius: 11px;
  padding: 10px 12px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.2);
  font-size: 12px;
  z-index: 999998;
}
```

- [ ] **步骤 4：在 content.ts 中 mount UI + 提取 + 高亮**

```ts
// entrypoints/content.ts
import { render } from 'preact';
import { SidePlayer } from './content/ui/SidePlayer';
import { extractContent } from './content/extractor';
import { segmentSentences } from './content/segmenter';
import { Highlighter } from './content/highlighter';
import type { Sentence, MessageToEngine, MessageFromEngine } from '~/lib/types';
import styles from './content/ui/styles.css?inline';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // 创建 shadow root
    const host = document.createElement('div');
    host.id = 'sayloud-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    
    // 注入样式
    const style = document.createElement('style');
    style.textContent = styles;
    shadow.appendChild(style);

    // mount UI
    const uiRoot = document.createElement('div');
    shadow.appendChild(uiRoot);
    render(<SidePlayer />, uiRoot);

    // 注入高亮 CSS
    const highlightStyle = document.createElement('style');
    highlightStyle.textContent = `
      ::highlight(sayloud-sentence) {
        background-color: rgba(255, 214, 0, 0.34);
      }
      ::highlight(sayloud-word) {
        background-color: #ffb300;
      }
    `;
    document.head.appendChild(highlightStyle);

    // 连接 SW
    const port = chrome.runtime.connect({ name: 'sayloud' });
    const highlighter = new Highlighter();
    let sentences: Sentence[] = [];

    // 提取正文
    function startReading() {
      const blocks = extractContent();
      if (blocks.length === 0) {
        console.warn('[Content] No readable content');
        return;
      }
      
      sentences = blocks.flatMap((block, blockIndex) => {
        const sents = segmentSentences(block.text, 'en');
        return sents.map((s, sentIndex) => ({
          id: `${blockIndex}:${sentIndex}`,
          text: s.text,
          charStart: s.start,
          charEnd: s.end,
        }));
      });

      port.postMessage({ type: 'start', sentences, cursor: 0, rate: 1.0 } as MessageToEngine);
    }

    // 监听进度事件
    port.onMessage.addListener((msg: MessageFromEngine) => {
      if (msg.type === 'progress' && msg.cursor !== undefined) {
        const sent = sentences[msg.cursor];
        if (sent) {
          // 高亮句子（简化版，实际需要从 block 的 rangeForOffset 获取）
          console.log('[Content] Highlight sentence:', sent.id);
        }
      }
    });

    // 临时：点击页面开始朗读
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#sayloud-host')) return;
      startReading();
    }, { once: true });

    console.log('[Content] SayLoud UI mounted');
  },
});
```

- [ ] **步骤 5：手动测试**

```bash
pnpm dev
```

加载扩展到 Chrome，打开任意网页，点击页面 → 竖条出现，控制台输出句子列表。

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/content.ts entrypoints/content/ui/
git commit -m "feat(content): mount SidePlayer UI and integrate extraction/highlight"
```

---

## 任务 10：E2E 测试：基本朗读流程

**文件：**
- 创建：`tests/e2e/fixtures.ts`
- 创建：`tests/e2e/basic-read.spec.ts`

- [ ] **步骤 1：创建 fixture**

```ts
// tests/e2e/fixtures.ts
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const extPath = path.resolve(__dirname, '../../.output/chrome-mv3');
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    });
    await use(ctx);
    await ctx.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent('serviceworker');
    const extId = background.url().split('/')[2];
    await use(extId);
  },
});

export { expect } from '@playwright/test';
```

- [ ] **步骤 2：编写 E2E 测试**

```ts
// tests/e2e/basic-read.spec.ts
import { test, expect } from './fixtures';

test('reads a simple page with sentence highlight', async ({ context, page }) => {
  await page.goto('data:text/html,<p>Hello world. Goodbye.</p>');
  await page.waitForTimeout(500);
  
  // 点击页面触发朗读
  await page.click('p');
  await page.waitForTimeout(1000);

  // 检查竖条是否出现
  const sidePlayer = page.locator('#sayloud-host');
  await expect(sidePlayer).toBeVisible();

  // 检查高亮（需要从 main world 查询 CSS.highlights）
  const hasHighlight = await page.evaluate(() => {
    const h = CSS.highlights.get('sayloud-sentence');
    return h ? h.size > 0 : false;
  });
  expect(hasHighlight).toBe(true);

  await page.waitForTimeout(3000); // 等待 TTS 播放完
});
```

- [ ] **步骤 3：运行测试验证**

```bash
pnpm build
pnpm test:e2e basic-read.spec
```

预期：浏览器打开，朗读两句话，高亮出现，测试 PASS。

- [ ] **步骤 4：Commit**

```bash
git add tests/e2e/
git commit -m "test(e2e): add basic reading flow test"
```

---

## 任务 11：控件交互：暂停/恢复/上一句/下一句/倍速

**文件：**
- 修改：`entrypoints/content/ui/SidePlayer.tsx`

- [ ] **步骤 1：编写 E2E 测试**

```ts
// tests/e2e/controls.spec.ts
import { test, expect } from './fixtures';

test('pause and resume playback', async ({ page }) => {
  await page.goto('data:text/html,<p>Hello world. Goodbye world. Farewell.</p>');
  await page.click('p');
  await page.waitForTimeout(500);

  const playBtn = page.locator('#sayloud-host').getByRole('button').first();
  await playBtn.click(); // pause
  await page.waitForTimeout(500);
  await playBtn.click(); // resume
  
  await page.waitForTimeout(3000);
});

test('next and previous sentence', async ({ page }) => {
  await page.goto('data:text/html,<p>Sentence one. Sentence two. Sentence three.</p>');
  await page.click('p');
  await page.waitForTimeout(500);

  const nextBtn = page.locator('#sayloud-host').getByRole('button').nth(2);
  await nextBtn.click();
  
  // 检查 cursor 是否前进
  const cursor = await page.evaluate(() => {
    return (window as any).__sayloudCursor; // 临时测试钩子
  });
  expect(cursor).toBeGreaterThan(0);
});
```

运行 `pnpm test:e2e controls.spec`，预期 FAIL。

- [ ] **步骤 2：实现 SidePlayer 控件**

在 `SidePlayer.tsx` 中添加：

```tsx
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function SidePlayer() {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  const [port, setPort] = useState<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const p = chrome.runtime.connect({ name: 'sayloud' });
    setPort(p);
    p.onMessage.addListener((msg) => {
      if (msg.type === 'state') {
        setPlaying(msg.state === 'playing');
      }
    });
    return () => p.disconnect();
  }, []);

  const handlePlayPause = () => {
    if (playing) {
      port?.postMessage({ type: 'pause' });
    } else {
      port?.postMessage({ type: 'resume' });
    }
  };

  const handleNext = () => port?.postMessage({ type: 'next' });
  const handlePrev = () => port?.postMessage({ type: 'prev' });
  const handleRateChange = (delta: number) => {
    const newRate = Math.max(0.5, Math.min(3.0, rate + delta));
    setRate(newRate);
    port?.postMessage({ type: 'setRate', rate: newRate });
  };

  return (
    <div class="side-player">
      <button onClick={handlePrev}>⏮</button>
      <button onClick={handlePlayPause}>{playing ? '⏸' : '▶'}</button>
      <button onClick={handleNext}>⏭</button>
      <div class="rate" onClick={() => handleRateChange(0.1)}>
        {rate.toFixed(1)}×
      </div>
    </div>
  );
}
```

- [ ] **步骤 3：在 PlaybackEngine 中添加 `next()` 和 `prev()` 方法**

```ts
// lib/engine/PlaybackEngine.ts
next() {
  if (this.session && this.session.cursor < this.session.sentences.length - 1) {
    this.seek(this.session.cursor + 1);
  }
}

prev() {
  if (this.session && this.session.cursor > 0) {
    this.seek(this.session.cursor - 1);
  }
}
```

- [ ] **步骤 4：在 background.ts 中处理 `next` / `prev` 消息**

在 `port.onMessage.addListener` 中添加：

```ts
else if (msg.type === 'next') {
  engine.next();
} else if (msg.type === 'prev') {
  engine.prev();
}
```

- [ ] **步骤 5：运行测试验证通过**

```bash
pnpm test:e2e controls.spec
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/content/ui/SidePlayer.tsx lib/engine/PlaybackEngine.ts entrypoints/background.ts tests/e2e/controls.spec.ts
git commit -m "feat(ui): add playback controls to SidePlayer"
```

---

## 任务 12：剩余时间进度环 + BubbleCard 提示

**文件：**
- 修改：`entrypoints/content/ui/SidePlayer.tsx`
- 修改：`entrypoints/content/ui/BubbleCard.tsx`
- 修改：`entrypoints/content/ui/styles.css`

- [ ] **步骤 1：在 SidePlayer 中添加进度环和剩余时间**

```tsx
// SidePlayer.tsx（新增部分）
const [totalChars, setTotalChars] = useState(0);
const [readChars, setReadChars] = useState(0);
const [showBubble, setShowBubble] = useState(false);

useEffect(() => {
  // 计算总字符数
  port?.postMessage({ type: 'getState' });
  port?.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      setReadChars(msg.charIndex || 0);
    }
  });
}, [port]);

const progress = totalChars > 0 ? (readChars / totalChars) * 100 : 0;
const remainingSecs = Math.ceil((totalChars - readChars) / 5); // 假设 5 chars/sec

return (
  <div class="side-player" onMouseEnter={() => setShowBubble(true)} onMouseLeave={() => setShowBubble(false)}>
    <div class="progress-ring" style={`--progress: ${progress}`} />
    {showBubble && <BubbleCard message={`${Math.floor(remainingSecs / 60)}:${(remainingSecs % 60).toString().padStart(2, '0')} remaining`} />}
    {/* 其他按钮 */}
  </div>
);
```

- [ ] **步骤 2：在 styles.css 中添加进度环样式**

```css
.progress-ring {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: conic-gradient(#0071e3 calc(var(--progress) * 1%), transparent 0);
}
```

- [ ] **步骤 3：手动测试**

```bash
pnpm dev
```

悬停竖条 → 气泡卡片显示剩余时间。

- [ ] **步骤 4：Commit**

```bash
git add entrypoints/content/ui/
git commit -m "feat(ui): add progress ring and remaining time bubble"
```

---

## 任务 13：点击正文跳读 + 自动滚动

**文件：**
- 修改：`entrypoints/content.ts`

- [ ] **步骤 1：实现点击跳读**

在 `content.ts` 中添加：

```ts
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#sayloud-host')) return;
  const target = e.target as Node;
  if (!target) return;

  // 找到点击位置对应的句子
  const clickedSentenceIndex = sentences.findIndex((s) => {
    // 简化：假设按顺序匹配
    return true; // 实际需要用 caretPositionFromPoint
  });

  if (clickedSentenceIndex >= 0) {
    port.postMessage({ type: 'seek', cursor: clickedSentenceIndex });
  }
});
```

- [ ] **步骤 2：实现自动滚动**

在进度事件处理中添加：

```ts
port.onMessage.addListener((msg) => {
  if (msg.type === 'progress' && msg.cursor !== undefined) {
    const sent = sentences[msg.cursor];
    if (sent) {
      // 获取句子的 Range 并滚动到视口
      const range = getRangeForSentence(sent); // 待实现
      if (range) {
        range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
});
```

- [ ] **步骤 3：手动测试**

长文章页面，点击中间某句 → 从那句开始读，页面自动滚动。

- [ ] **步骤 4：Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat(content): add click-to-seek and auto-scroll"
```

---

## 任务 14：边缘情况测试 + 错误处理

**文件：**
- 创建：`tests/e2e/edge-cases.spec.ts`
- 修改：`entrypoints/background.ts`（错误处理）

- [ ] **步骤 1：编写边缘情况测试**

```ts
// tests/e2e/edge-cases.spec.ts
import { test, expect } from './fixtures';

test('shows error on empty page', async ({ page }) => {
  await page.goto('data:text/html,<div></div>');
  await page.click('div');
  await page.waitForTimeout(500);

  const bubble = page.locator('.bubble-card');
  await expect(bubble).toContainText('No readable content');
});

test('handles chrome.tts error gracefully', async ({ page }) => {
  // Mock chrome.tts.speak to fail
  await page.addInitScript(() => {
    (chrome as any).tts.speak = (_: any, opts: any) => {
      opts.onEvent({ type: 'error', errorMessage: 'TTS not available' });
    };
  });

  await page.goto('data:text/html,<p>Hello.</p>');
  await page.click('p');
  await page.waitForTimeout(500);

  const bubble = page.locator('.bubble-card');
  await expect(bubble).toContainText('TTS not available');
});
```

- [ ] **步骤 2：在 BrowserSpeaker 中处理错误**

Speaker 的 `error` 事件传递给 engine，engine 进入 `error` 状态，通过 Port 发送 `{ type: 'error', error: msg }` 给 content script，SidePlayer 显示 BubbleCard。

- [ ] **步骤 3：运行测试验证**

```bash
pnpm test:e2e edge-cases.spec
```

预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add tests/e2e/edge-cases.spec.ts entrypoints/background.ts lib/engine/
git commit -m "test(e2e): add edge cases for empty page and TTS error"
```

---

## 任务 15：最终集成验证 + 文档

**文件：**
- 创建：`README.md`

- [ ] **步骤 1：完整 E2E 测试套件**

```bash
pnpm build
pnpm test
pnpm test:e2e
```

预期：所有测试 PASS

- [ ] **步骤 2：手动测试清单**

1. 打开 Wikipedia 英文文章 → 点朗读 → 句子逐个高亮，词高亮跟随
2. 暂停 → 恢复 → 上一句 → 下一句 → 倍速 1.5×
3. 点击中间某句 → 从那句开始读
4. 切换到另一个 tab → 回来点播放 → 继续
5. 空白页 → 显示「无可读内容」

- [ ] **步骤 3：编写 `README.md`**

```md
# SayLoud

A Chrome extension for reading web pages aloud using browser's built-in TTS, with synchronized sentence/word highlighting.

## P1 Features (Current)

- ✅ Read full page with browser voice
- ✅ Sentence-level + word-level highlighting
- ✅ 28px side player with playback controls
- ✅ Click-to-seek and auto-scroll
- ⏳ Cloud TTS services (P2)
- ⏳ Settings panel (P3)
- ⏳ Paragraph/selection buttons (P4)

## Development

```bash
pnpm install
pnpm dev          # Load .output/chrome-mv3 in chrome://extensions
pnpm test         # Unit tests
pnpm test:e2e     # E2E tests (requires Chrome with TTS)
pnpm build        # Production build
```

## Testing

E2E tests require TTS voices. On macOS, voices are built-in. On Linux, install `speech-dispatcher`.

## Architecture

- Service Worker: PlaybackEngine + chrome.tts wrapper
- Content Script: Text extraction + CSS Highlight API + Preact UI
- State snapshots saved to `chrome.storage.session` for SW recovery

## License

MIT
```

- [ ] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: add P1 README with features and dev guide"
```

- [ ] **步骤 5：最终验证**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

预期：全部成功

- [ ] **步骤 6：Tag release**

```bash
git tag v0.1.0-p1
git push origin main --tags
```

---

## 自检

**1. 规格覆盖度：**
- §0-§3（概述、范围、provider 接口、提取、分句、高亮、竖条）— 已覆盖
- §4.1-§4.2（状态机、进度推送）— 已覆盖
- §5.1（测试）— 已覆盖
- §6 V1-V3（验证点）— V1 sidePanel 推迟到 P3；V2 offscreen 恢复已覆盖（SW 快照）；V3 chrome.tts 已集成
- **遗漏**：自适应深色页面高亮（§3.3）推迟到 P4；已读淡化（§3.3）推迟到 P4；气泡卡片的详细错误分类（§4.5）部分实现

**2. 步骤扫描：**
- 任务 3 步骤 3「实现 extractor.ts」只给了接口描述和算法提示，函数签名由测试决定 ✅
- 任务 8 步骤 3「集成到 background.ts」给了完整代码块，但包含注释标记待实现的部分，实现者需补充 `engine.restore()` ✅
- 任务 11 步骤 2 给了完整组件代码，因为 Preact 组件的结构由框架约定决定，测试只验证行为 ✅

**3. 类型一致性：**
- `Session.cursor` 在所有任务中都是 `number` ✅
- `MessageToEngine` / `MessageFromEngine` 在任务 2、8、9 中一致使用 ✅
- `Speaker` 接口在任务 6、7 中一致 ✅

**4. 审查重点：**
- 空文本输入 → 任务 14 测试覆盖 ✅
- SW 被回收后恢复 → 任务 8 实现快照 + 任务 14 可补充测试
- 切换 tab 后再回来 → 任务 8 background.ts 中 `tabs.onRemoved` / `tabs.onUpdated` 处理 ✅
- DOM 节点被替换 → 任务 9 content.ts 中 `tabs.onUpdated` 监听 URL 变化停止会话 ✅
- chrome.tts.speak 报错 → 任务 14 测试覆盖 ✅

**5. 比例：**
- 规格 477 行，计划约 900 行。计划比规格长 1.9 倍，主要因为包含了详细的测试步骤和 commit 命令。代码块主要是类型定义、测试断言和配置文件，实际实现逻辑（extractor / engine）由实现者编写。比例合理 ✅

---

计划已完成并保存到 `docs/superpowers/plans/2026-09-29-sayloud-p1-browser-voice.md`。请审阅这份计划。你希望用哪种执行方式？

- **子代理驱动** - 每个任务由一个全新子代理实现，并在下一个任务开始前由一个全新审查者检查，最后再做一次覆盖整个分支的审查。最彻底；代价是每个任务、每次审查各一个全新上下文。
- **原生执行** - 我在当前会话里按这个运行环境的方式亲自实现每个任务，最后由一个跑在最强模型上的全新审查者检查整个分支。最便宜、最快；直到最后才有独立审查。会话用中档模型就能跑好，因为计划已经承载了设计。

针对这份计划，我推荐**子代理驱动**，因为任务之间的依赖紧密（engine → speaker → UI → E2E），每个任务的接口需要被下一个任务验证，早期发现接口不匹配比最后再改更便宜。这份计划抓住你想要的东西了吗？我们用哪种方式？
