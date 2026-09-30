# SayLoud P3: 设置、字幕悬浮窗与国际化 Spec

**日期**: 2026-09-30
**前置条件**: P2 完成（`main` = `f93dd81`，865 单测 + 24 E2E 全绿）
**分支**: `p3-settings-caption`（从 `main` 切出）
**目标版本**: 0.3.0

---

## 0. 概述

### 0.1 本轮范围（用户提出的 6 项）

1. 缓存管理（占用显示、上限、开关、清除）
2. i18n（界面中英双语，可手动切换）
3. 离开标签页后依旧播放（默认开）
4. 字幕悬浮窗：把当前朗读的句子显示在置顶小窗里（侧边栏开关控制）
5. 全局设置界面重新设计（现在的过于原型）
6. 侧边栏音量滑块 0%–150%

### 0.2 不包含

- ❌ 划词朗读、Paragraph Play、本网站级开关（P4）
- ❌ 每站点设置、快捷键设置、高亮颜色设置、主题切换（spec §3.6 有，但功能本身尚未实现，本轮不放假开关）
- ❌ OpenAI 兼容多实例（数据模型要改，P4）
- ❌ 音色试听（需要 sidepanel 直连合成，P4）
- ❌ 商店上架材料（单独一轮）
- ❌ `_locales` + `chrome.i18n`：**本轮不做**。`chrome.i18n` 跟随浏览器 UI 语言，无法在运行时切换，而我们要的是「设置里手动选语言」。manifest 里的 `SayLoud` 是品牌名不翻译，`description` 留到上架那轮再本地化。

---

## 1. 评估

| # | 项目 | 现状 | 工作量 | 主要风险 |
|---|---|---|---|---|
| 1 | 缓存管理 | `CacheManager`(L1+L2) 已有 `stats()`/`clearL2()`，但没有设置项、没有 UI、30 天过期没实现 | 0.5 天 | 低。主要坑是 sidepanel 和 offscreen 是同一 IndexedDB 的两个连接，清完要让 offscreen 的计数器失效 |
| 2 | i18n | 完全没有。所有文案是英文硬编码在 TSX / `config-schema.ts` / `errors.ts` 里 | 1 天 | 中。改动面广（含 schema 的 `label/help` 与校验错误），会动到既有单测与 smoke 断言 |
| 3 | 后台继续播放 | `SessionRouter.handleTabActivated` 无条件暂停 | 0.25 天 | 低。`chrome.tts` 与 offscreen 音频本来就不受标签页焦点影响，去掉暂停即可 |
| 4 | 字幕悬浮窗 | 无 | 0.5 天 | **中高**。Document PiP 只能由「有用户手势的页面」打开，且窗口绑定该页面；见 §7 与 V10–V12 |
| 5 | 设置界面重设计 | 两个标签页 + 一个 `<select>` 选服务商 + 朴素表单，无设计语言 | 1.5 天 | 中。会打破 smoke/e2e 的选择器，必须同步更新测试，不能删断言 |
| 6 | 音量 0–150% | 完全没有音量概念 | 0.5 天 | 中。`HTMLAudioElement.volume` 上限 1.0，>100% 必须走 Web Audio `GainNode`；offscreen 里 `AudioContext` 能否 `resume()` 待实测（V11） |

合计约 4.25 天（agent 执行时间）。建议拆成 5 个 subagent 任务顺序执行，每个任务结束时全套检查必须绿（见 §11）。

**依赖顺序**：T1（设置存储 + 后台播放 + 音量）→ T2（i18n）→ T3（缓存后端 + 缓存 UI 数据）→ T4（界面重设计，含缓存/语言/音量/字幕开关的 UI）→ T5（字幕悬浮窗）。

T2 排在 T4 之前，是为了让新 UI 从一开始就用 i18n 键写，避免先写英文再返工。

---

## 2. 全局设置存储

新增 `lib/settings-store.ts`。P2 的 `lib/config-store.ts` 只存服务商配置，这里存「扩展的行为偏好」。

```ts
export const SETTINGS_KEY = 'sayloud:settings';

export type UiLang = 'auto' | 'en' | 'zh-CN';

export interface Settings {
  /** 'auto' 时按浏览器语言判定。 */
  uiLang: UiLang;
  /** 切到别的标签页时继续朗读。默认 true。 */
  keepPlayingInBackground: boolean;
  /** 是否在竖条上显示「字幕」按钮。默认 false。 */
  captionWindow: boolean;
  /** 0–1.5。1 = 原始音量。 */
  volume: number;
  /** 新会话的默认语速，0.5–3。 */
  rate: number;
  cache: {
    /** 关掉时只留内存缓存，并清除已保存的音频。 */
    persist: boolean;
    maxBytes: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'auto',
  keepPlayingInBackground: true,
  captionWindow: false,
  volume: 1,
  rate: 1,
  cache: { persist: true, maxBytes: 200 * 1024 * 1024 },
};
```

- `MAX_BYTES_CHOICES = [50, 100, 200, 500] * 1024 * 1024`，UI 用「50 MB / 100 MB / 200 MB / 500 MB」。
- `SettingsStore`：`load(): Promise<Settings>`、`update(patch: Partial<Settings>): Promise<Settings>`、`subscribe(cb: (s: Settings) => void): () => void`（内部用 `chrome.storage.onChanged` 过滤 `SETTINGS_KEY`）。
- 读取必须**归一化**：未知键丢弃、`volume` 夹到 `[0, 1.5]`、`rate` 夹到 `[0.5, 3]`、`maxBytes` 必须落在 `MAX_BYTES_CHOICES` 里否则取默认、`uiLang` 必须是枚举值。理由和 `config-schema` 一样：`storage.local` 是跨版本共享的不可信输入。
- 三个上下文各持有自己的 `SettingsStore` 实例（SW / sidepanel / content script），靠 `onChanged` 同步，不共享对象。

**SW 侧接线**（`lib/container.ts` + `entrypoints/background.ts`）：

- `createApp` 里构造 `SettingsStore`，`ready` 等它和 `speakers.refresh()` 都完成。
- 启动时把 `settings.volume`、`settings.rate` 应用到引擎。
- 订阅设置变化：`volume` 变 → `engine.setVolume(v)`；`rate` 变且会话非 idle → `engine.dispatch({ type: 'setRate', rate })`。
- `SessionRouter.handleTabActivated(tabId, continueInBackground = false)`：加第二个参数，为 `true` 时直接返回（不暂停）。**默认 `false` 保持既有行为**，既有 router 测试不用改；新增两条测试覆盖 `true` / `false`。这样门控逻辑落在可单测的 router 里，而不是只存在于没有单测的 `background.ts`。
- `tabs.onActivated` 监听器改为：`router.handleTabActivated(tabId, settings.keepPlayingInBackground)`。
  - 语义澄清：单会话规则不变——在另一个标签页点朗读，仍然停掉当前会话；变的只是「切过去看一眼不会暂停」。
- `settings.rate` 字段在 T1 只进 schema（含归一化与单测），**行为接线留到 T4**：语速滑块的 UI 在 T4 出现，届时再由 SW 订阅 rate 变化并 `engine.dispatch({ type: 'setRate' })`、content script 用 `settings.rate` 作为 `load` 的初始语速。

---

## 3. 音量 0%–150%

### 3.1 数据流

```
sidepanel 滑块 ──写──► settings.volume ──onChanged──► SW
                                                      │
                                       engine.setVolume(v)
                                                      │
                    ┌─────────────────────────────────┴──────────────────┐
              SpeakerRouter（转发给主 speaker 和 fallback）
                    │                                                  │
        BrowserSpeaker                                      OffscreenSpeaker
   tts.speak({volume: min(1,v)})                    {type:'setVolume', volume:v}
   （chrome.tts 上限 100%）                          → AudioWorker → TimelinePlayer
```

- `Speaker` 增加可选方法 `setVolume?(volume: number): void`；`SpeakRequest` 增加 `volume?: number`。
- `BrowserSpeaker` 把 `volume` 传给 `chrome.tts` 的 `speak` 选项，**夹到 1.0**（API 上限）。用户选了浏览器语音而滑块 >100% 时，UI 显示一行提示：「浏览器语音最高 100%」。
- `SpeakerRouter.setVolume` 转发给所有 delegate（主 + fallback），这样后面降级到浏览器语音时音量是对的。
- `engine.setVolume(v)` 存值并对当前 speaker 调 `setVolume`；之后每次 `speak()` 都带上 `volume`。
- `OffscreenSpeaker` 完全照抄 `setRate` 的做法：`speak()` 管线里在 `play` 之前发一条 `setVolume`，同时提供公开的 `setVolume()` 给「播放中改音量」用；命令用 `create: false`，不能为了调音量去创建 offscreen 文档。

### 3.2 TimelinePlayer 里的 >100%

`HTMLAudioElement.volume` 上限是 1.0，所以 100% 以上必须走 Web Audio：

```ts
// 每个 offscreen 文档一个 AudioContext，懒创建，整个文档生命周期复用。
// 每条句子的 <audio> 建一个 MediaElementSource + GainNode：
//   src → gain → destination
// audio.volume 固定 1.0，实际音量由 gain.value 决定。
```

- **只有一个 AudioContext**：`new AudioContext()` 很贵，且浏览器对数量有限制。
- **必须整段走图**：一个元素一旦被 `createMediaElementSource` 接走，它的声音就只从图里出。所以要么全部走图，要么全部不走，不能按音量大小切换。策略：`load()` 时尝试建图；如果 `AudioContext` 建不起来、或 `resume()` 后 `state !== 'running'`，就把该文档标记为 `graphDisabled`，之后一律退回 `audio.volume = min(1, v)`（>100% 失效，但播放不受影响）。
- `setVolume(v)`：`gain.gain.value = v`（图可用时），否则 `audio.volume = Math.min(1, v)`。
- blob URL 是同源的，`createMediaElementSource` 不会有 CORS 污染问题。
- 见 V11：offscreen 里 `AudioContext` 的自动播放策略必须实测。**若实测不可用**，退回「上限 100% + UI 提示」，不要为了 150% 把播放搞坏。

---

## 4. 缓存管理

### 4.1 后端

`lib/cache-manager.ts` 扩展：

| 新增 | 说明 |
|---|---|
| `L2Cache.setMaxBytes(bytes)` | 改上限，然后立刻 `prune()` |
| `L2Cache.usage(): Promise<{ bytes: number; entries: number }>` | 供 UI 读占用；内部走已有的 `measure()` |
| `L2Cache.expire(olderThanMs)` | 删掉 `timestamp` 早于阈值的条目；`init()` 里跑一次，30 天 |
| `CacheManager.setPersist(persist)` | `false` 时不再写 L2，并清空 L2 |
| `CacheManager.setMaxBytes(bytes)` | 转发给 L2 |
| `CacheManager.clear()` | 清 L1 + L2 |
| `CacheManager.usage()` | `l2Bytes` / `l2Entries`（L1 是 offscreen 内存里的，UI 不显示） |

- `L2Cache.get()` 命中时顺手把 `timestamp` 更新为现在（`lastAccess` 语义）。这是「按 lastAccess 淘汰」的前提；写入是异步 fire-and-forget，失败只记 console。**这一条可以在实现时按复杂度降级**（若让 `get` 变成写事务导致既有测试大面积要改，就保留 `put` 时间戳，30 天过期照常工作）。
- 清空/过期都要同步维护 `bytes` / `keys` 内存计数器，避免 `prune()` 之后计数器与实际不符。

### 4.2 设置如何到达 offscreen

> ⚠️ **实测修正（2026-09-30，T3）**：原稿写「offscreen 文档是扩展页面，**可以直接用 `browser.storage.local`**」是**错的**。真机 Chromium 实测（在 offscreen 文档里发一条探针消息给 SW）：`hasStorage: 'undefined'`、`hasPermissions: 'undefined'`、`hasI18n: 'undefined'`，只有 `chrome.runtime` 与 `chrome.offscreen` 可用。所以缓存策略**必须走消息**，offscreen 自己读不到 settings。

- `entrypoints/offscreen/main.ts` 启动时发一条 `CACHE_POLICY_REQUEST`，SW 回 `{ type: 'cache-policy', cache: { persist, maxBytes } }`（`pullCachePolicy`），文档拿到后应用；settings 变化时 SW 用 `pushCachePolicy` 把新策略推给**活着的**文档（没有接收方时静默成功）。
- 两种消息都**不是** `OffscreenCommand`：它们不从执行器状态机的角度讲「这一句话」，命令通道仍然只携带一句话需要的东西。
- 为什么是「文档主动问」而不是「SW 记得推」：Chrome 在静音 30s 后回收 offscreen 文档，新文档启动时先问一次，不依赖任何人在它不存在时还记得发消息。`CACHE_POLICY_REQUEST` 也会在 SW 冷启动后被应答（监听器在顶层注册）。
- V14 已用真机脚本验证：offscreen 持有连接时，sidepanel 打开同一个 IndexedDB **不出现 `blocked`**；把 `persist` 改成 `false` 后 offscreen 确实清空了 store（1 → 0），改回 `true` 后新写入落盘（0 → 1）。

### 4.3 UI 侧（sidepanel）

新增 `lib/cache-admin.ts`（sidepanel 专用，不进 SW bundle）：

- `readCacheUsage(): Promise<{ bytes: number; entries: number }>`：自己 new 一个 `L2Cache`，`init()` + `usage()`。**不通过 SW / 不唤醒 offscreen**——读占用不该有副作用，也不该为了显示数字创建文档。
- `clearCache(): Promise<void>`：自己 `L2Cache.clear()`，然后 `browser.runtime.sendMessage({ type: CACHE_CLEARED })` 广播，让**活着的** offscreen 清 L1 并重新 `measure()`。off 屏不在时 `sendMessage` 会以「没有接收方」reject，必须 catch 掉当作成功（要清的东西已经清完了）。
- `CACHE_CLEARED` 常量放 `lib/offscreen-protocol.ts` 导出（`{ type: 'cache-cleared' }`，全小写连字符，与现有命令风格一致），offscreen 的 `onMessage` 里在 `isOffscreenCommand` 过滤**之前**单独处理它。SW 的 `runtime.onMessage` 监听器会因为不认识这个类型而忽略，无需改动。

### 4.4 UI

设置标签页新增「缓存」卡片：持久化开关、上限下拉、`已用 12.4 MB · 86 段`、清除按钮（二次确认用行内「确认清除 / 取消」，不用 `window.confirm`）。关掉持久化开关时，卡片下方出现一行说明：「关闭会清除已保存的音频。」

措辞上要写明这是**音频缓存**（L2 IndexedDB），**不含端侧模型**——端侧模型是 Cache Storage 里的另一份数据，由 P4 的「模型」标签页管理。两处各自显示自己的占用，不合并，免得用户以为清音频缓存能腾出模型的空间。

---

## 5. i18n

### 5.1 方案：自建轻量字典，不用 `chrome.i18n`

理由：`chrome.i18n` 的 `getMessage` 只能跟随浏览器 UI 语言，无法运行时切换；而我们要在设置里手动选语言（`auto` / 英文 / 中文）。自建字典约 100 行，类型安全、可单测、零依赖。

新增 `lib/i18n/`：

```
lib/i18n/messages.en.ts   // 英文，唯一事实来源
lib/i18n/messages.zh.ts   // 中文，类型必须满足 Record<MessageKey, string>
lib/i18n/index.ts         // resolveLang / createTranslator / I18nProvider / useT
```

```ts
// messages.en.ts
export const en = {
  'sideplayer.play': 'Play',
  'sideplayer.pause': 'Pause',
  'settings.cache.used': 'Used {size} · {count} clips',
  // …
} as const;
export type MessageKey = keyof typeof en;

// messages.zh.ts
import type { MessageKey } from './messages.en';
export const zh: Record<MessageKey, string> = {
  'sideplayer.play': '播放',
  // …
};
```

- **键名规范**：`<区域>.<控件>[.<状态>]`，全小写点分。区域：`sideplayer` / `bubble` / `panel` / `provider` / `field` / `error` / `voice` / `caption` / `settings`。
- `createTranslator(lang)` 返回 `(key: MessageKey, params?: Record<string, string | number>) => string`；插值语法 `{name}`，缺参数时原样保留 `{name}`（不要抛错，UI 不该因为少个参数崩）。
- `resolveLang(setting: UiLang, browserLang: string): 'en' | 'zh-CN'`：`setting !== 'auto'` 时直接用；否则 `browserLang` 以 `zh` 开头（大小写不敏感）→ `'zh-CN'`，其余 → `'en'`。
- `I18nProvider`（Preact context）+ `useT()` hook。语言来自 settings，切换时整个 UI 重渲染，同时 `document.documentElement.lang = 'zh-CN' | 'en'`。
- 非组件代码（`describeProviderError`、`HINTS`）不 import 全局单例：**接受 `t` 作为参数**，或返回**键 + 参数**由 UI 翻译。优先后者（见下）。
- 中文排版按仓库既有的中文文档约定：中英文之间留空格、用全角标点。

### 5.2 需要翻译的面

| 位置 | 处理 |
|---|---|
| `entrypoints/sidepanel/**` 全部文案 | `useT()` |
| `entrypoints/reader.content/SidePlayer.tsx` 的 `HINTS`、aria-label、BubbleCard 文案 | 改成键；content script 自己读 settings 决定语言（`chrome.storage` 对 content script 可用），并订阅变化 |
| `entrypoints/reader.content/BubbleCard.tsx` 的默认文案 | 由调用方传已翻译的字符串 |
| `lib/providers/config-schema.ts` 的 `label` / `summary` / `help` / 选项 `label` | **改成键**：`labelKey` / `summaryKey` / `helpKey` / 选项 `labelKey`。schema 里不再出现英文句子 |
| `lib/providers/config-schema.ts` 的 `validateFormValues` 错误 | **改成错误码**：`FieldErrors = Record<string, { code: 'required' \| 'invalid-url' \| 'invalid-number' \| 'invalid-select'; params?: Record<string, string> }>`，由 UI 翻译。SW 侧若也用到校验，同样只传码 |
| `lib/providers/errors.ts` 的 `CODE_MESSAGES` | 改成键；`describeProviderError(error, t)` 或拆成 `providerErrorSummary(error): { key, params }` + 原始 detail。服务商返回的 detail 原文保持英文不翻译（那是远端文案） |
| `lib/format-time.ts` 的剩余时间 | 键 + 参数。wpm / 字/分 的区分本轮不做 |
| 音色名（`volcengine-voices.ts` 里的中文音色名） | **不翻译**，原样显示 |

- `ProviderSchema.label` 这类被 UI 直接读的字段：改为 `labelKey: MessageKey`，UI 用 `t(schema.labelKey)`。`PROVIDER_SCHEMAS` 的键顺序即显示顺序，不变。
- 语音服务商名字的中文：百炼 → 「阿里云百炼」、火山 → 「火山引擎豆包」、OpenAI 兼容 → 「OpenAI 兼容」、Azure → 「Azure 语音」、浏览器语音 → 「浏览器语音」。

### 5.3 测试影响（重要）

- 单测默认 `en`：`I18nProvider` 默认语言为 `'en'`，`useT()` 在没有 Provider 时回退英文。既有断言（如 `getByText('Base URL is required.')`）应尽量保持通过；若某处断言的是 schema 字段标签，改为断言键或包一层 `en` provider。
- smoke 与 e2e 一律跑英文。**不要**把 e2e 改成中文断言。
  - ⚠️ **实测修正（2026-09-30，T2）**：原稿写「Chromium 默认 `en-US`」是**错的**。Playwright 的 `launchPersistentContext` 会**继承宿主机 locale**，所以在中文机器上 smoke 脚本整个跑在中文环境里，每一条英文断言都失败；e2e 之所以看起来正常，是因为 Playwright runner 自己默认 `en-US`，不是浏览器。**必须在两套 harness 里显式钉 `locale: 'en-US'`**（`tests/e2e/fixtures.ts` 的 `launchPersistentContext` 与 `.smoke/sidepanel-smoke.mjs`）。
- 新增：`tests/unit/i18n.test.ts` 断言 `zh` 覆盖 `en` 的每一个键（`Object.keys(en).every(k => k in zh)`）、插值行为、`resolveLang` 的边界。
- 新增一条中文渲染测试：`uiLang: 'zh-CN'` 时侧边栏出现中文标题。

---

## 6. 离开标签页后依旧播放

- `settings.keepPlayingInBackground` 默认 `true`。
- `entrypoints/background.ts` 的 `tabs.onActivated` 监听器改为条件调用（见 §2）。
- 不变量：单会话不变（另一个标签页开始朗读仍然停掉旧的）；标签页关闭 / 导航仍然结束会话。
- 相关：标签页不可见时，`scrollIntoView` 自动滚动照常工作（无副作用）；offscreen 音频与 `chrome.tts` 都不受焦点影响，所以这一项就是「少暂停一次」。

---

## 7. 字幕悬浮窗（Document Picture-in-Picture）

### 7.1 已确认的 Chrome 约束

- `documentPictureInPicture.requestWindow()` **在侧边栏页面里打不开**（Chrome 已知 bug，WICG/document-picture-in-picture#88，popup 与 offscreen 同样不行）。所以**不能**由侧边栏开关直接开关悬浮窗。
- 必须由**有用户手势的页面**打开 → 由 **content script** 在竖条按钮的点击处理里调用。
- 窗口绑定打开它的那个页面：页面导航 / 关闭 → 悬浮窗一起关。全局同一时间只允许一个 Document PiP 窗口。

### 7.2 交互（用户已确认的方案）

- 侧边栏「朗读」标签页有开关 **悬浮窗字幕**（`settings.captionWindow`，默认关）。开关只决定「竖条上有没有那个按钮」。
- 打开时，竖条在语速按钮和齿轮之间多一个按钮（字幕图标，`aria-label="Caption window"`）。点击 → 打开置顶悬浮窗；再点 → 关闭。
- 侧边栏关掉开关 → 拥有悬浮窗的 content script 通过 `storage.onChanged` 收到通知并关闭窗口。
- `documentPictureInPicture` 不存在（Chrome < 116）时，不渲染该按钮，并在设置里给开关加一行说明「当前浏览器不支持」。
- 竖条按钮的 `onClick` 里必须**同步**调用 `requestWindow()`（在第一个 `await` 之前），否则用户手势过期。

### 7.3 窗口内容

```
┌──────────────────────────────────┐
│  (favicon) example.com           │  ← 浏览器自带的标题栏，不是我们画的
├──────────────────────────────────┤
│                                  │
│   这是当前正在朗读的句子，其中    │  ← 当前句，active word 高亮
│   高亮的部分是正在读的那个词。    │
│                                  │
│        第 12 / 87 句              │  ← 小字、次要色
└──────────────────────────────────┘
```

- 只显示：当前句（词高亮）+ 一行「第 n / m 句」。
- **不放播放控件**（进度控制只在页面竖条里，spec §3.6 的原则）。若后续要加，是单独一轮。
- 字号随窗口大小缩放：`font-size: clamp(16px, 5vmin, 40px)`；句子居中、允许换行、`overflow-wrap: anywhere`。
- 主题跟随系统（`prefers-color-scheme`）。
- 只高亮句子而服务商没给时间戳时，不画词高亮（与页面内规则一致，不做估算）。

### 7.4 实现

新增 `entrypoints/reader.content/CaptionWindow.ts`：

```ts
export class CaptionWindow {
  static isSupported(): boolean;           // 'documentPictureInPicture' in window
  open(initial: CaptionState): boolean;    // 必须在点击处理里同步调用
  update(state: CaptionState): void;
  close(): void;
  get isOpen(): boolean;
}
export interface CaptionState {
  text: string;
  charStart: number;   // -1 表示没有词级时间戳
  charEnd: number;
  index: number;
  total: number;
}
```

- 用 Preact 渲染进 `pipWindow.document.body`（PiP 窗口与打开它的页面同源，可以直接写 DOM）。
- 样式注入：优先 `pipWindow.document.adoptedStyleSheets = [sheet]`（constructable stylesheet），失败时退回插入 `<style>` 元素。原因：PiP 文档会继承打开页面的 CSP，严格 CSP 站点可能挡掉 inline style（见 V12）。
  - ⚠️ **实测修正（2026-09-30，T5）**：stylesheet **必须用 PiP 窗口自己的构造函数建**（`new pipWindow.CSSStyleSheet()`）。用 content script 自己那份 `CSSStyleSheet` 建再赋给 `pipWindow.document.adoptedStyleSheets` 会抛 `NotAllowedError: … Sharing constructed stylesheets in multiple documents is not allowed`（CSP 与否都抛）。细节见 §9 V12。
- `pipWindow.addEventListener('pagehide', …)` → 标记为已关闭，通知 controller 更新状态（按钮回到「未打开」）。
- `ReaderController` 需要把当前词的位置暴露到 `ReaderState`：新增 `word: { index: number; charStart: number; charEnd: number } | null`，在 `onWord` 里更新、句子切换时清空。句子的文本从已有的 `doc.sentences[status.index]` 取（content script 本来就持有整份句子列表）。

---

## 8. 设置界面重新设计

### 8.1 信息架构（按 spec §3.6）

```
┌────────────────────────────────────────┐
│ SayLoud                    [朗读][设置] │  ← 第三个「模型」标签在 P4 加入
├────────────────────────────────────────┤
│  (标签页内容)                           │
└────────────────────────────────────────┘
```

**朗读**（日常要调的）：

```
┌────────────────────────────────────────┐
│ ⓘ 现在用的是浏览器自带语音，可以立即朗读 │  ← 仅未配置云端服务时显示
│   配置云端服务 ›                        │
├────────────────────────────────────────┤
│ 音色                                    │
│ ┌────────────────────────────────────┐ │
│ │ (◍) 美佳 Meijia            更换 ›  │ │
│ │     DashScope · 逐词高亮            │ │
│ └────────────────────────────────────┘ │
├────────────────────────────────────────┤
│ 音量                            100%    │
│ [─────────●──────────]                 │  ← 0–150%
│ 浏览器语音最高 100%                     │  ← 仅浏览器语音时显示
├────────────────────────────────────────┤
│ 语速                            1.0×    │
│ [──────●─────────────]                 │  ← 0.5–3.0
├────────────────────────────────────────┤
│ 悬浮窗字幕                    [ ● ]     │
│ 在页面上点竖条的字幕按钮打开              │
├────────────────────────────────────────┤
│ 正在朗读                                │
│ 第 12 / 87 句 · 32%                     │
│ [████████░░░░░░░░░░░░░░░]              │
└────────────────────────────────────────┘
```

**设置**（配好就不动的）：

```
┌────────────────────────────────────────┐
│ 语音服务                                │
│ ┌────────────────────────────────────┐ │
│ │ ● 浏览器语音              使用中    │ │  ← 点一行原地展开表单
│ ├────────────────────────────────────┤ │
│ │ ● 阿里云百炼      已配置        ▾  │ │
│ │   ┌──────────────────────────────┐ │ │
│ │   │ API key   [••••••••]         │ │ │
│ │   │ 区域      [中国 (cn-beijing)▾]│ │ │
│ │   │ …                            │ │ │
│ │   │ [测试连接] [保存] [忘记密钥]  │ │ │
│ │   └──────────────────────────────┘ │ │
│ ├────────────────────────────────────┤ │
│ │ ○ 火山引擎豆包                      │ │
│ ├────────────────────────────────────┤ │
│ │ ○ OpenAI 兼容                       │ │
│ ├────────────────────────────────────┤ │
│ │ ○ ElevenLabs                        │ │
│ ├────────────────────────────────────┤ │
│ │ ○ Azure 语音                        │ │
│ └────────────────────────────────────┘ │
├────────────────────────────────────────┤
│ 缓存                                    │
│ 保存合成音频                  [ ● ]     │
│ 上限                [200 MB         ▾] │
│ 已用 12.4 MB · 86 段                    │
│ [清除缓存]                              │
├────────────────────────────────────────┤
│ 界面语言            [跟随浏览器      ▾] │
├────────────────────────────────────────┤
│ 关于 SayLoud 0.3.0 · MIT · 隐私说明     │
└────────────────────────────────────────┘
```

**音色选择页**（点音色卡片的「更换 ›」后整体切换，带返回箭头）：

```
┌────────────────────────────────────────┐
│ ‹  音色                                  │
│ [搜索音色或 ID…            ]  [全部语言▾]│
│ ┌────────────────────────────────────┐ │
│ │ (◍) 美佳 Meijia     逐词高亮        │ │
│ │     zh-CN · zh_female_…            │ │
│ ├────────────────────────────────────┤ │
│ │ ( ) 龙婉 Longwan    仅句级高亮      │ │
│ └────────────────────────────────────┘ │
│ 音色 ID [_______________] [使用此 ID]   │  ← 已有的手动填写，保留
└────────────────────────────────────────┘
```

### 8.2 交互规则

- 服务商列表每行一个 `<button class="provider-row" data-provider="dashscope" aria-expanded>`；同一时间只展开一行。行首状态点：已保存（且当前生效）→ 实心绿 + 「使用中」徽章；已保存未生效 → 空心绿；未配置 → 灰。**不做红点**（要持久化「上次测试结果」，本轮不做）。
- 行摘要：已配置显示「已配置 · 音色 <name>」；未配置显示 schema 的 `summary`。
- 展开的表单里按钮文案保持 `Test Connection` / `Save` / `Forget saved key`（英文键不变，仅翻译），`id="field-<key>"` 的约定保留，smoke 脚本好改。
- 表单字段仍然由 `config-schema.ts` 驱动，只是 label/help 换成键。
- 语速与音量滑块：拖动时只更新本地显示（`onInput`），松手时写 settings（`onChange`，range 的 change 在松手时触发），避免拖动过程狂写 storage。
- 悬浮窗开关、缓存开关用真正的 switch 组件（`role="switch"` + `aria-checked`），不是裸 checkbox。

### 8.3 视觉规范

在 `entrypoints/sidepanel/styles.css` 里建立 token（现有 CSS 变量保留并扩展）：

```css
:root {
  --radius: 8px;
  --radius-sm: 6px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --surface-2: /* 卡片背景，浅色 #f7f7f9 / 深色 #26262a */;
  --shadow-1: 0 1px 2px rgb(0 0 0 / 0.06);
  --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}
```

- 卡片：1px `--border` + `--radius` + 内边距 `--space-3`，标题行 12px 大写字距已够用，保留 `h2` 样式但去掉 `text-transform`（中文没有大小写，大写化会显得突兀）→ 改成普通 12px 加粗 + `--muted`。
- 列表行：上下 padding 8px，行间 1px 分隔线，hover 背景 `--surface`。
- 焦点可见：所有可交互元素 `:focus-visible { box-shadow: var(--focus) }`。
- 新增组件（`entrypoints/sidepanel/ui/`）：`Card.tsx`、`Row.tsx`、`Switch.tsx`、`Slider.tsx`、`StatusDot.tsx`。每个都要有可访问名（switch 有 label，slider 有 `aria-label` + `aria-valuetext`）。
- 侧边栏宽度最小约 320px，所有布局在 320px 下不横向滚动。

### 8.4 测试影响

- `.smoke/sidepanel-smoke.mjs` 现在用 `#provider-select` / `#provider-select option` 选服务商，改成点 `[data-provider=…]` 行。**34 项检查都要保留**（语义等价改写），并新增：缓存卡片可见 + 已用数字出现、语言下拉可切到中文、音量滑块存在且能改、悬浮窗开关存在。
- 标签相关的断言要**遍历标签列表**，不要写死「朗读」「设置」两个名字——P4 会加第三个「模型」标签，届时 smoke 不该重写。
- `tests/unit/provider-config-panel.test.tsx`：选择器与断言同步更新。
- `tests/e2e/settings.spec.ts` 只依赖竖条上的齿轮，预期不受影响（跑一遍确认）。

---

## 9. 验证点（需要在真机 Chrome 上确认）

| 编号 | 待验证 | 影响 | 不可用时的退路 |
|---|---|---|---|
| **V10** | content script（隔离世界）能调 `documentPictureInPicture.requestWindow()`，并且能读写返回的 `pipWindow.document` | 字幕悬浮窗能否实现 | 退回 `chrome.windows.create({type:'popup'})`（不置顶，效果差），或本轮砍掉该项并告知用户 |
| **V11** | offscreen 文档里 `new AudioContext()` 能 `resume()` 到 `running`（自动播放策略），`GainNode` >1 确实变响 | 音量能否超过 100% | 音量上限退回 100%，UI 提示；播放不受影响 |
| **V12** | 严格 CSP 页面（如 GitHub）上，PiP 文档里 `adoptedStyleSheets` / 内联 `<style>` 是否被挡 | 悬浮窗样式 | 用 `style.sheet.insertRule` 逐条注入；再不行则只给最少量的内联属性样式 |
| **V13** | `chrome.tts.speak({volume})` 是否被 Chrome 的语音引擎遵守 | 浏览器语音音量 | 浏览器语音忽略音量，UI 说明 |
| **V14** | sidepanel 打开 IndexedDB 读取占用时，offscreen 已持有连接，不出现 `blocked` / 版本冲突 | 缓存 UI | 改由 SW 转发统计 |

V10–V12 由**执行 T5 的 subagent 先做一个小实验**（e2e 里加一个临时 spec，或直接手写一个最小页面验证），把结论写回本文件；V13/V14 用 e2e 覆盖。**结论必须在提交里体现**（spec 补实测结论 + commit message 说明）。

> ✅ **V10 实测通过（2026-09-30，T5）**：content script（隔离世界）**能**打开并操作 PiP 文档，字幕悬浮窗可按 §7.4 实现。
> - 手法：临时 Playwright spec（headless Chromium 153.0.8010.12）里用 CDP 找到扩展**自己的** content script 世界（`Runtime.executionContextCreated` 报告 `{ origin: 'chrome-extension://<id>', name: 'SayLoud', auxData: { isDefault: false, type: 'isolated' } }`），在该世界内装一个探针，再由 `page.click` 派发**真实**点击（用户手势是文档级的，与哪个世界收到事件无关）。
> - 结果：`{ supported: 'object', calledSynchronously: true, opened: true, readBack: 'hello', canWrite: true, hasClose: 'function', hasAdopted: 'object' }` —— `requestWindow()` 在点击处理里同步调用即被接受，返回的 `pipWindow.document` 是可读写的同源文档。同样的探针在一个普通（非扩展）隔离世界里也通过。
> - 附带发现：Playwright 把 PiP 窗口暴露成 `context.pages()` 里的**第二个 page**（URL `about:blank`），且能在其中 `evaluate`/`locator`。所以字幕窗口的 e2e 可以断言真实内容，而不只是「按钮出现了」。
>
> ⚠️ **V12 实测修正（2026-09-30，T5）**：PiP 文档**确实继承**打开页面的 CSP，且**只有** constructable stylesheet 能穿过严格 CSP；`<style>` 是被挡的那条路。
> - 页面用 `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'">`，用户点击打开 PiP 后：
>   - 内联 `<style>`：**被挡**。`document.styleSheets.length === 0`，元素的 `color` 仍是 `rgb(0, 0, 0)`，并触发两条 `securitypolicyviolation`（`style-src-elem` / blockedURI `inline`）。
>   - `adoptedStyleSheets` + `new pipWindow.CSSStyleSheet()`：**生效**，背景色应用成功，无违规、无异常。
>   - 坑：用**打开页面那份** `CSSStyleSheet` 建的表加不进去 —— `NotAllowedError: Failed to set the 'adoptedStyleSheets' property on 'Document': Sharing constructed stylesheets in multiple documents is not allowed`（该报错与 CSP 无关，普通页面同样复现）。
> - 对照（同页面去掉 CSP meta）：内联 `<style>` 生效（`rgb(1, 2, 3)`，`styleSheets.length === 1`），adopted 也生效。
> - 结论：主路径 = 在 PiP 窗口的 realm 里建 constructable sheet；`<style>` 只作为老引擎的兜底。严格 CSP 站点 + 没有 constructable stylesheet 的引擎才会真的没样式，而 Document PiP 本身要求 Chrome 116+，两者同时缺失不存在。
> - 顺带确认：`documentPictureInPicture` 在扩展的边栏页面里也存在（`typeof === 'object'`），所以 §7.2 那条「设置里提示当前浏览器不支持」的开关提示可以按同一判断来做 —— 它只在 API 真的不存在（Chrome < 116）时才显示。

---

## 10. 测试计划

| 层 | 覆盖 |
|---|---|
| 单元 | `settings-store`（归一化 / 夹值 / 订阅）；`i18n`（键完整性 / 插值 / 语言判定）；`cache-manager`（setMaxBytes / usage / expire / clear / persist=false）；`cache-admin`（广播 + 无接收方不报错）；`timeline-player`（gain 与降级路径）；`speaker`（volume 夹到 1）；`offscreen-speaker`（setVolume 命令、create:false）；`caption-window`（假 `documentPictureInPicture`：支持检测、open/update/close、pagehide）；`provider-config-panel`（新结构 + 错误码渲染） |
| 单元 | 语言相关：`zh` 覆盖全部键；`uiLang: 'zh-CN'` 时侧边栏渲染中文 |
| E2E | 音量：滑块拖到 0 → 播放时 `gain`/`volume` 为 0（通过 offscreen 观测或断言命令）；缓存：播放两句 → 占用 >0 → 清除 → 占用 0；后台播放：朗读中切标签页 → 仍在播放（`status.phase === 'playing'`），关掉设置后切标签页 → 暂停；字幕窗口：开关打开后竖条出现按钮（PiP 本身在 headless 里能否打开见 V10 结论） |
| smoke | 34 项等价保留 + 新增 4 项 |
| 手动 | 用户验收清单（真机 Chrome，见 §12） |

每个任务结束都要跑：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:manifest && pnpm smoke:sidepanel && pnpm test:e2e
```

---

## 11. 任务分解（subagent 执行顺序）

每个任务：先写失败测试 → 实现 → 全套检查绿 → commit（`feat:` / `fix:` / `refactor:` 前缀，英文 commit message，每个任务 1–3 个 commit）。**不要**跨任务攒改动。

### T1 — 设置存储 + 后台继续播放 + 音量

- 新增 `lib/settings-store.ts` + `tests/unit/settings-store.test.ts`。
- 音量管道：`lib/speaker.ts`（`SpeakRequest.volume`、`Speaker.setVolume?`、`TtsSpeakOptions.volume`、`BrowserSpeaker` 夹到 1）、`lib/speaker-router.ts`（转发）、`lib/playback-engine.ts`（`setVolume` + speak 带 volume）、`lib/offscreen-protocol.ts`（`setVolume` 命令）、`lib/offscreen-speaker.ts`、`lib/audio-worker.ts`、`lib/timeline-player.ts`（AudioContext + GainNode + 降级）。
- `lib/container.ts` 构造 `SettingsStore`，`ready` 等设置加载；`entrypoints/background.ts` 应用 volume 并订阅变化；`tabs.onActivated` 把 `keepPlayingInBackground` 传给 router。
- `lib/router.ts`：`handleTabActivated(tabId, continueInBackground = false)` + 两条新单测。
- **不做**：语速行为接线、任何 UI（T4）。
- 验收：单测覆盖上面每一项；`pnpm test:e2e` 里加一条「切标签页仍在播放」的用例（用 `page.bringToFront()` 切到第二个页面，断言竖条仍是 Pause 状态；若 fixture 下不好写，可留到 T4 并在 commit 里说明）。
- 产出：`docs/superpowers/plans/` 不动；commit message 里写清 V11/V13 的实测结论（若在 e2e 里验过）。

### T2 — i18n 基础设施 + 全量字符串迁移

- 新增 `lib/i18n/{messages.en,messages.zh,index}.ts` + `tests/unit/i18n.test.ts`。
- `config-schema.ts` 的 `label/summary/help/选项 label` → 键；`validateFormValues` → 错误码。
- `errors.ts` 的 `CODE_MESSAGES` → 键；`describeProviderError` 改签名。
- sidepanel 全部文案 + `SidePlayer` / `BubbleCard` / `ReaderController` 的提示与 aria-label → 键；content script 读 settings 决定语言。
- 设置标签页加「界面语言」下拉（结构简单即可，T4 会重排视觉）。
- 更新既有单测与 smoke 断言（英文默认值尽量不变，减少无谓 diff）。
- 验收：`tests/unit/i18n.test.ts` 键完整性；一条中文渲染测试；smoke 全绿。

### T3 — 缓存管理（后端 + 数据层）

- `lib/cache-manager.ts` 扩展（§4.1）。
- `entrypoints/offscreen/main.ts`：向 SW 要一次 cache 策略并应用（见 §4.2 修正）；处理 `cache-cleared` 广播（清 L1 + 重新 measure）。
- 新增 `lib/cache-admin.ts`（sidepanel 侧读/清）。
- `lib/settings-store.ts` 若缺 cache 字段则补齐（T1 应已建好）。
- 验收：单测覆盖 setMaxBytes / usage / expire / persist=false / 广播；**暂不做 UI**（T4 做），但 `cache-admin` 要有单测。

### T4 — 设置界面重设计

- `styles.css` token + `entrypoints/sidepanel/ui/*` 原语组件。
- `SidePanel.tsx`：头部 + 分段标签 + 视图切换（标签页 / 音色选择页）。**标签列表必须数据驱动**（`TABS` 数组 + 遍历渲染），加一个标签不改渲染逻辑——P4 会加第三个「模型」标签。
- `ReadingTab.tsx`：音色卡片、音量滑块、语速滑块、悬浮窗开关、会话进度（按 §8.1 线框）。
- 语速行为接线：SW 订阅 `settings.rate` 变化 → `engine.dispatch({ type: 'setRate' })`（idle 时忽略）；content script 用 `settings.rate` 作为 `load` 的初始语速。
- 新增 `SettingsTab.tsx`：服务商列表（行展开）、缓存卡片、界面语言、关于。
- `ProviderConfig.tsx` 改为「行内展开表单」（保留全部现有行为与测试语义）；`VoicePicker.tsx` 重排视觉。
- 更新 `.smoke/sidepanel-smoke.mjs`（34 项等价 + 4 项新增）与 `tests/unit/provider-config-panel.test.tsx`。
- 验收：smoke 全绿；e2e `settings.spec.ts` 全绿；320px 宽度无横向滚动（可用 e2e 断言 `document.body.scrollWidth <= innerWidth`）。

### T5 — 字幕悬浮窗

- **先做 V10/V11/V12 的小实验**，把结论写进本文件 §9。
- 新增 `entrypoints/reader.content/CaptionWindow.ts` + `CaptionView.tsx` + 单测（假 `documentPictureInPicture`）。
- `ReaderController`：`ReaderState.word`、`captionWindow` 设置读取与订阅、按钮状态。
- `SidePlayer.tsx`：字幕按钮（受设置与支持检测控制）。
- 验收：单测；能自动化的 e2e 断言按钮出现/消失与窗口内容（若 headless 打不开 PiP，就用假 API 的单测覆盖 + 留给用户手测，并在 commit 里说明）。

---

## 12. 用户手动验收清单（本轮结束前）

1. 设置里把界面语言切成中文 → 侧边栏、竖条提示、悬浮窗全部中文；切回英文/跟随浏览器正常。
2. 音量滑块：0% 静音、100% 正常、150% 明显更响；浏览器语音时上限 100% 且提示可见。
3. 语速滑块 0.5×–3× 对正在朗读的会话立即生效。
4. 朗读中切到别的标签页（设置默认开）→ 继续读；关掉该设置再切 → 暂停。
5. 缓存：播几句后看占用增长 → 清除 → 占用归零 → 重播同一段能听出来（缓存生效）。
6. 悬浮窗：打开开关 → 竖条出现字幕按钮 → 点击弹出置顶小窗 → 词级高亮跟着走 → 关掉开关 → 窗口自动关闭。
7. 界面重设计后，六家服务商配置、测试连接、保存、忘记密钥、音色选择、手动填音色 ID 全部照常工作。
8. 严格 CSP 的站点（GitHub）上：朗读正常、悬浮窗样式正常。

---

## 13. 收尾

- 版本号 0.2.0 → 0.3.0（`package.json` + `wxt.config.ts`）。
- 合并 `p3-settings-caption` → `main`，打 tag `v0.3.0-p3`。
- 回填 spec §9 的实测结论与本节清单结果。
