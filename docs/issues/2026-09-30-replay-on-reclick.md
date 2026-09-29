# Issue: 重新点击扩展图标会从头播放

**日期**：2026-09-30  
**发现者**：用户测试  
**优先级**：P2（影响用户体验，但不是功能性 bug）

## 问题描述

当插件已经在某个页面上播放时，用户再次点击扩展图标（action icon），会导致：

1. **当前播放被中断**
2. **从头开始重新播放**

## 预期行为

用户再次点击扩展图标时，应该：

- **Option A（推荐）**：什么都不做，保持当前播放状态（Speechify 的行为）
- **Option B**：切换播放/暂停（类似媒体播放器的习惯）
- **Option C**：显示一个提示："插件已在此页面运行"

## 根本原因（初步分析）

`background.ts` 的 `chrome.action.onClicked` 监听器可能：

1. **无条件注入 content script**，即使已经注入过
2. **无条件发送 `start` 命令**，导致 PlaybackEngine 重置

## 修复方案（待确认）

### 方案 A：检测已运行状态（推荐）

```typescript
// background.ts
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  
  // 1. 检查该 tab 是否已经注入
  const isInjected = await checkIfInjected(tab.id);
  
  if (isInjected) {
    // 2. 已注入：什么都不做，或者发送 toggle 命令
    console.log('Content script already running on tab', tab.id);
    return;
  }
  
  // 3. 未注入：正常注入
  await chrome.scripting.executeScript({...});
});

async function checkIfInjected(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return response?.pong === true;
  } catch {
    return false;
  }
}
```

### 方案 B：content script 防御性检查

```typescript
// reader.content.tsx
if ((globalThis as any).__SAYLOUD_INJECTED__) {
  console.log('SayLoud already running on this page');
  return;
}
(globalThis as any).__SAYLOUD_INJECTED__ = true;
```

### 方案 C：Session Router 防御

```typescript
// lib/router.ts
export class SessionRouter {
  start() {
    if (this.isStarted) {
      console.warn('Router already started');
      return;
    }
    this.isStarted = true;
    // ...
  }
}
```

## 实施时间线

- **P1**：已记录 issue，不修复
- **P2 前**：验证根本原因，实施方案 A + B（双重防护）

## 相关文件

- `entrypoints/background.ts`
- `entrypoints/reader.content.tsx`
- `lib/router.ts`

## 测试步骤

1. 打开任意网页
2. 点击扩展图标，开始播放
3. 等待播放到第 5 句
4. **再次点击扩展图标**
5. 观察：是否从第 1 句重新播放？

## 竞品行为

- **Speechify**：再次点击无反应，保持当前播放状态
- **Read Aloud**：再次点击无反应（侧边栏已经打开）

## 用户影响

- **轻度烦人**：误触扩展图标会打断阅读
- **不是严重 bug**：用户可以通过不再次点击来避免

## 备注

此问题可能与"插件启动时强制刷新 VoiceCache"（M1）的修复有关，因为每次点击都会触发 `SessionRouter.start()`。
