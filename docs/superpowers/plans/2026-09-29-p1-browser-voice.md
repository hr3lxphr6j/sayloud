# SayLoud P1 实现计划：浏览器语音端到端

**日期**：2026-09-29  
**执行方式**：子代理驱动开发，实现者用 `deepseek-flash` [packy-code-anthropic]，审查者为当前会话  
**分支**：`p1-browser-voice`

---

## 目标

用浏览器内置 TTS 读整页网页，原文同步句级 + 词级高亮，页面右侧 28px 竖条控制播放。

## 技术栈

- WXT 0.21.4 + Vite 8 + TypeScript 6.0.3 (pinned)
- Preact 10.29.8 + @preact/preset-vite
- Vitest 5 + happy-dom + @testing-library/preact
- Playwright 1.63 (E2E，真实 chrome.tts)
- Biome 2.5.14

## 架构

- **PlaybackEngine 在 Service Worker**：状态机 + chrome.tts 调用 + 快照持久化到 `storage.session`
- **content script runtime 注册**：`registration: 'runtime'`，SW 在 action.onClicked 时注入
- **单会话**：同一时间只有一个 tab 在播放
- **E2E 用真实 TTS**：macOS 系统语音，headless chromium

## P1 范围

**包含**：点击图标 → 提取正文 → 浏览器语音朗读 → 句/词高亮 → 竖条控制（播放/暂停/上下句/倍速/剩余时间）→ 点击跳读 → 自动滚动 → SW 被回收后恢复

**不包含**：云端 TTS / 设置面板 / 段落按钮 / 划词 / 快捷键 / i18n / 自适应深色配色（P2-P4）

---

## 任务路线图

### 任务 1：项目脚手架

**产出**：`package.json` + `wxt.config.ts` + `tsconfig` + `biome` + `vitest` + `playwright` + CI + 空 entrypoints

**验收**：
- `pnpm build` 生成 manifest，4 个权限，无 `host_permissions` / `content_scripts`
- `pnpm typecheck` 和 `pnpm lint` 通过

### 任务 2：协议类型 + 文本工具

**产出**：
- `lib/protocol.ts`：`EnginePhase` / `EngineSentence` / `EngineStatus` / `EngineCommand` / `EngineEvent` / `SessionSnapshot`
- `lib/text-utils.ts`：`normalizeText()` / `segmentSentences()` / `segmentWords()`

**验收**：`tests/unit/text-utils.test.ts` 测试通过（英文/中文分句分词）

### 任务 3：正文提取 + 偏移映射

**产出**：
- `lib/extractor.ts`：`extractBlocks() => Block[]`
- `Block` 接口：`{ text: string; rangeFor(start, end): Range | null }`

**验收**：`tests/unit/extractor.test.ts` 测试通过（Readability 提取 + 兜底 + 空页面）

### 任务 4：ReadingDoc（句子模型）

**产出**：
- `lib/reading-doc.ts`：`buildReadingDoc(blocks) => ReadingDoc`
- `ReadingDoc` 方法：`getSentence(index)` / `rangeForSentence(index)` / `rangeForWord(index, wordIndex)` / `sentenceAt(node, offset)`

**验收**：测试覆盖句子查找 + Range 映射

### 任务 5：Highlighter + 点击跳读

**产出**：
- `lib/highlighter.ts`：`Highlighter` 类（`setSentence()` / `setWord()` / `clear()`）
- `lib/click-to-seek.ts`：`sentenceIndexFromPoint(doc, x, y)`

**验收**：单元测试（mock `CSS.highlights`）

### 任务 6：自动滚动控制器

**产出**：`lib/autoscroll.ts`：`AutoscrollController` 类

**验收**：测试暂停检测 + 滚动行为（fake window/clock）

### 任务 7：BrowserSpeaker（chrome.tts 包装）

**产出**：
- `lib/speaker.ts`：`Speaker` 接口 + `createBrowserSpeaker()`
- `lib/voice-picker.ts`：`pickVoice(voices, lang)`

**验收**：测试 word 事件、generation token、stale 事件过滤（mock `browser.tts`）

### 任务 8：PlaybackEngine（状态机）

**产出**：`lib/engine.ts`：`PlaybackEngine` 类（`load` / `play` / `pause` / `seek` / `next` / `prev` / `setRate` / `restore` / `snapshot`）

**验收**：测试完整状态机（fake speaker + fake clock）

### 任务 9：快照存储 + 背景路由

**产出**：
- `lib/snapshot-store.ts`：`SnapshotStore` 接口
- `lib/router.ts`：`SessionRouter` 类
- `entrypoints/background.ts`：集成 engine + router

**验收**：
- 测试快照读写（fake storage）
- 测试路由逻辑（fake ports）
- 手动测试：点击图标能注入 content script

### 任务 10：Side Player UI 组件

**产出**：
- `components/SidePlayer.tsx`
- `components/BubbleCard.tsx`
- `components/ProgressRing.tsx`
- `lib/format-time.ts`

**验收**：组件测试（testing-library），验证 aria-labels

### 任务 11：Content 控制器 + 入口

**产出**：
- `lib/content-controller.ts`：`ContentController` 类
- `entrypoints/reader.content.tsx`：UI mount + 提取 + 高亮同步

**验收**：手动测试完整流程（dev 模式）

### 任务 12：E2E 测试 + README

**产出**：
- `tests/e2e/fixtures.ts`
- `tests/e2e/basic-read.spec.ts`
- `tests/e2e/controls.spec.ts`
- `README.md`

**验收**：E2E 全部通过 + CI 绿色

---

## 详细任务展开（示例）

### 任务 1：项目脚手架

1. 初始化项目

```bash
cd ~/Dev/tts-ng
git checkout -b p1-browser-voice
pnpm init
```

2. 安装依赖

```bash
pnpm add -D wxt@0.21.4 typescript@6.0.3 @types/node \
  vite@^8.3 @wxt-dev/browser@0.3.4 \
  preact@10.29.8 @preact/preset-vite@2.10.6 @babel/core \
  vitest@5.0.2 happy-dom@20.14.5 @vitest/ui@5.0.2 \
  @playwright/test@1.63.0 \
  @biomejs/biome@2.5.14 \
  @mozilla/readability@0.6.0 \
  @testing-library/preact@3.2.4
```

3. 创建 `wxt.config.ts`

```ts
import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ mode }) => ({
    name: 'SayLoud',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'tts'],
    action: {},
    ...(mode === 'e2e' && { host_permissions: ['http://127.0.0.1/*'] }),
  }),
  outDir: process.env.SAYLOUD_E2E ? '.output-e2e' : '.output',
});
```

4. 创建 `tsconfig.json`

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" }
}
```

5. 创建 `biome.json`（`pnpm exec biome init` 后手动编辑）

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": [".output*", ".wxt", "node_modules", "docs"] },
  "organizeImports": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 }
}
```

6. 创建 `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import preact from '@preact/preset-vite';
export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: { environment: 'happy-dom', globals: true },
});
```

7. 创建 `playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
});
```

8. 创建 CI workflow `.github/workflows/ci.yml`

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
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
      - run: pnpm build
```

9. 更新 `.gitignore`

```
.output/
.output-e2e/
.wxt/
node_modules/
.idea/
```

10. 添加 scripts 到 `package.json`

```json
{
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "build:e2e": "SAYLOUD_E2E=1 wxt build --mode e2e",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "postinstall": "wxt prepare"
  }
}
```

11. 创建空 entrypoints

```ts
// entrypoints/background.ts
export default defineBackground(() => {
  console.log('[SW] SayLoud started');
});

// entrypoints/reader.content.ts
export default defineContentScript({
  registration: 'runtime',
  main() {
    console.log('[Content] SayLoud reader loaded');
  },
});
```

12. 创建占位图标 `public/icon-128.png`（128x128 蓝色圆 + 白色三角）

13. 验证构建

```bash
pnpm install
pnpm build
cat .output/chrome-mv3/manifest.json | grep permissions
```

预期：`"permissions": ["activeTab", "scripting", "storage", "tts"]`，无 `host_permissions` / `content_scripts`

14. Commit

```bash
git add -A
git commit -m "chore(p1): scaffold WXT + Preact + TS + CI"
```

---

### 任务 2：协议类型 + 文本工具

1. 创建 `lib/protocol.ts`

```ts
export type EnginePhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface EngineSentence {
  text: string;
  lang: string;
}

export interface EngineStatus {
  phase: EnginePhase;
  index: number;
  total: number;
  rate: number;
  voice: string;
  charsRead: number;
  charsTotal: number;
  charsPerSec: number;
  error?: 'no-voice' | 'tts-error' | 'no-content';
}

export type EngineCommand =
  | { type: 'load'; sentences: EngineSentence[]; startIndex: number; rate: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; index: number }
  | { type: 'setRate'; rate: number }
  | { type: 'stop' }
  | { type: 'sync'; docId: string };

export type EngineEvent =
  | { type: 'status'; status: EngineStatus }
  | { type: 'word'; index: number; charStart: number; charEnd: number };

export interface SessionSnapshot {
  tabId: number;
  docId: string;
  sentences: EngineSentence[];
  index: number;
  resumeOffset: number;
  voice: string;
  rate: number;
  charsRead: number;
}
```

2. 创建 `lib/text-utils.ts`

```ts
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().normalize('NFC');
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export function segmentSentences(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  return Array.from(seg.segment(text))
    .map((s) => ({ text: s.segment.trim(), start: s.index, end: s.index + s.segment.length }))
    .filter((s) => s.text.length > 0);
}

export function segmentWords(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}
```

3. 创建测试 `tests/unit/text-utils.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { normalizeText, segmentSentences, segmentWords } from '~/lib/text-utils';

describe('text-utils', () => {
  it('normalizes whitespace', () => {
    expect(normalizeText('Hello   \n  world')).toBe('Hello world');
  });

  it('segments English sentences', () => {
    const sents = segmentSentences('Hello world. Goodbye!', 'en');
    expect(sents).toHaveLength(2);
    expect(sents[0].text).toBe('Hello world.');
  });

  it('segments Chinese sentences', () => {
    const sents = segmentSentences('你好。再见。', 'zh');
    expect(sents).toHaveLength(2);
  });

  it('segments words', () => {
    const words = segmentWords('Hello world.', 'en');
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world']);
  });
});
```

4. 运行测试

```bash
pnpm test text-utils.test
```

预期：PASS

5. Commit

```bash
git add lib/ tests/
git commit -m "feat(lib): add protocol types and text utils"
```

---

## 剩余任务（3-12）执行指引

**实现者**：按照任务 1-2 的详细程度，逐个实现任务 3-12。每个任务包含：

1. **接口定义**（类型签名 / 函数签名）
2. **测试先行**（先写失败的测试）
3. **实现**（通过测试）
4. **验收**（`pnpm test` + `pnpm typecheck` + `pnpm lint`）
5. **Commit**（清晰的消息）

**审查者**（我）：每个任务完成后审查 diff，运行测试，决定是否通过 → 开始下一个任务。

---

## 关键接口约定

### `lib/extractor.ts`

```ts
export interface Block {
  text: string;
  rangeFor(start: number, end: number): Range | null;
}
export function extractBlocks(): Block[];
```

### `lib/reading-doc.ts`

```ts
export interface ReadingDoc {
  sentences: Array<{ text: string; lang: string }>;
  getSentence(index: number): { text: string; lang: string } | null;
  rangeForSentence(index: number): Range | null;
  rangeForWord(index: number, wordIndex: number): Range | null;
  sentenceAt(node: Node, offset: number): number | null;
}
export function buildReadingDoc(blocks: Block[]): ReadingDoc;
```

### `lib/speaker.ts`

```ts
export interface Speaker {
  speak(text: string, voice: string, rate: number, lang: string): void;
  stop(): void;
  onStart(callback: () => void): void;
  onWord(callback: (charIndex: number, length?: number) => void): void;
  onEnd(callback: () => void): void;
  onError(callback: (error: string) => void): void;
}
export function createBrowserSpeaker(): Speaker;
```

### `lib/engine.ts`

```ts
export class PlaybackEngine {
  load(sentences: EngineSentence[], startIndex: number, rate: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(index: number): void;
  setRate(rate: number): void;
  stop(): void;
  restore(snapshot: SessionSnapshot): void;
  snapshot(): SessionSnapshot | null;
  subscribe(listener: (event: EngineEvent) => void): void;
}
```

### `lib/router.ts`

```ts
export class SessionRouter {
  onActionClicked(tab: { id: number; url: string }): Promise<void>;
  onConnect(port: { name: string; sender: { tab?: { id: number } } }): void;
  onTabRemoved(tabId: number): void;
  onTabUpdated(tabId: number, changeInfo: { url?: string }): void;
}
```

---

## E2E 测试约定

- 用真实 chrome.tts（macOS 系统语音）
- 测试页面通过本地 HTTP 服务器提供（不用 data: URL）
- SW 暴露测试钩子：`self.sayloudActivate(tabId)` (e2e 模式)
- 验证高亮：`page.evaluate(() => CSS.highlights.get('sayloud-sentence')?.size)`
- 验证 UI：`page.locator('#sayloud-host').getByRole('button', { name: 'Pause' })`

---

**执行方式**：子代理驱动开发

