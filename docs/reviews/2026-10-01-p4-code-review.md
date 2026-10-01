# P4 代码评审（2026-10-01）

## 方式

一个独立 subagent（`onetoken/claude-opus-5-5`）对 `git diff 3e2fa234..HEAD`
（P4 全期：84 文件 / +13578 行）做**只读**评审，目标是「需不需要抽象、重构、清理」。

brief 里给了这一轮踩过的 6 个 bug 模式，要求它照这些模式找**同类的、还没被发现的**问题，
而不是通读一遍给泛泛的意见。它给出 3 条必修 / 4 条建议 / 3 条参考 / 2 个澄清问题。

**每一条结论都由人复核过。** 下面明确标出成立与否 —— 评审的 3 条「必修」里有 2 条不成立，
它们的措辞都很可信，这正是必须复核的理由。

---

## 采纳

### #1 `load()` 的竞态会泄漏一整个 session —— 已修

**位置**：`lib/models/kokoro-engine.ts`（原在 `entrypoints/offscreen/local.worker.ts`）

```ts
this.disposeSession();
const started = Date.now();
this.tts = await KokoroTTS.from_pretrained(...);   // ← 两个并发调用都会走到这里
```

两个 `load()` 同时进来时都看到 `tts === null`，于是都建 session，**后写的覆盖先写的**。
被覆盖的那个再也无人引用 —— 没有句柄可以 dispose 它，它就一直占着权重（fp32 是 325 MB）。

**触发窗口**：首次建立 session 的那十几秒。期间用户 seek（或连点播放）就会挤进第二个
`load()`。这是评审这条里唯一真正会伤到用户的部分。

**修法**（`kokoro-engine.ts`）：

```ts
const generation = ++this.loads;
...
const session = await KokoroTTS.from_pretrained(...);

if (generation !== this.loads) {
  session.model?.dispose?.();
  throw new Error('superseded by a newer load');
}
```

**顺带做的**：把 `KokoroEngine` 从 worker 里抽出来。它是这个 bug 能长期存在的原因 ——
一个埋在 worker 模块里的类**没有办法写测试**。抽出后 6 条单测覆盖了竞态、复用、
设备变更和 dispose 语义，其中 2 条在删掉 generation 检查后是**红的**。

抽取没有破坏结构保证：`tests/build/build-output.test.ts` 的 9 条断言（含「ORT 只能出现在
offscreen worker 里」）全部仍然通过。

---

## 经复核**不成立**（记录下来，免得下次被重新发现一遍）

### #2 「`engineFor()` 的错误吞没会让第二句永远卡住」—— 不成立

评审说 `catch` 只挂在第一次创建的 promise 上，第二次失败就没有接收者。

**实际上**每次 `this.engine` 为 `null` 时，`if (this.engine) return this.engine;` 之后的
几行都会**重新执行**，包括 `this.engine.catch(...)`。它漏看了控制流。

### #3 「音素化失败的 code 传不到 fallback 逻辑，生僻字不会降级」—— 不成立（因果链反了）

评审说 worker 把错误都映射成 `code: 'unknown'`，而 `PlaybackEngine` 只认 `tts-error`，
所以不会降级。

**实际上** `code` 根本到不了 `PlaybackEngine`：`SpeakerEvents.error` 的 payload 是
`string`（只有 message），`OffscreenSpeaker` 只透传 message。统一成 `tts-error` 的那一步
发生在 `bindSpeakerEvents` 里 —— 所以生僻字**会**降级到浏览器语音，与评审的结论相反。

（它提到的「`unknown` 不利于诊断」这一点仍然对，但那只是诊断体验，不是行为缺陷。）

### #7 「worker 崩溃的修复没有回归测试」—— 不成立

`tests/unit/models/worker-engine.test.ts` 有 12 条测试，其中
`rejects the request in flight when the worker dies` 用 `worker.crash()` 驱动，而且它在
修复前的代码上是**红的**（做过反向验证）。评审大概率没读到这个文件。

---

## 评估后**不做**

| # | 评审的建议 | 不做的理由 |
|---|---|---|
| #4 | `resolveSource()` 的探测竞态让 controller 留在飞行中 | 评审自己也标成「当前没有实际伤害」——`fetch` 在 promise settle 后自行清理，abort 一个已完成的 controller 是空操作 |
| #5 | 音素化职责分散（phonemizer 与 worker 都在判断语言） | 观察是对的，但改动面覆盖中英两条管线，而收益是「以后加日文时少改一处」。等真要加第三种语言时再做 |
| #6 | `preferredTier()` 的 fallback 不跳过 `brokenOn` | 已有不变式测试保证每个设备类都被显式覆盖，fallback 只在配置错误时触发。可以改，但改了也没有观测不到的好处 |
| #8 | `lib/models/` 导出过多（94 个） | TypeScript 没有「只对测试可见」，`export` 是唯一选择。加 `@internal` 会让 IDE 隐藏它们，但收益只是补全列表更短 |
| #9 | `pinyin-table.json` 静态导入 | 评审自己结论是「不改」：7 KB，且中文用户的第一次朗读就需要它 |
| #10 | `FakeLocalEngine` 的 `msPerCharacter` 与真实性能不符 | 评审自己结论是「不改」：fake 的目的是快，不是逼真 |

---

## 两个澄清问题的答案

**Q1 `validate()` 只检查「已下载」，不检查「能加载」？**

按设计。而且评审的前提不成立：**本机服务商没有 Test 按钮**（`ProviderConfig.tsx` 里
`schema.id !== 'local'` 就是去掉它的那次改动）。`validate()` 是朗读页的就绪检查调的，
每次切到该标签页都会跑 —— 试加载 12 秒会让面板每次都卡住。

**Q2 音素化失败时，跳过那个字还是整句拒绝？**

保持现状（整句拒绝）。因为错误统一成 `tts-error` 后会**整句降级到浏览器语音** ——
生僻字不会让这一句消失，而是换个声音念完。而「跳过那个字」会让本地模型念出一个**缺字的
句子**，听感上更难察觉、更糟。

---

## 这一轮评审本身留下的教训

1. **subagent 的报告必须逐条复核。** 3 条「必修」里 2 条不成立，而它们的措辞都很像真的 ——
   失败模式是「读得不够仔细」，不是「分析错了」，所以看起来尤其可信。
2. **一份只说「有问题」的评审没法用，一份说清「为什么这是问题、改不改的代价」的可以。**
   这次给 brief 时要求了分级 + 代价，所以即使有错判，剩下那几条也能直接用。
3. **反过来也成立**：它抓到的 #1 是真问题，而且是这一轮里唯一一个我没想到的 ——
   把踩过的坑当作「模式」写进 brief 是有回报的。
