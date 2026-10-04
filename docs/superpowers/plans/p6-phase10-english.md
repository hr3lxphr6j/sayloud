# 阶段 10：英文接入 Rust phonemize（移除 espeak）

**日期**：2026-10-04
**状态**：已完成，未提交
**前置**：阶段 8（删 JS 链）、9A/9B/9E

---

## 一、任务书的两处前提与实测不符

任务书说「生产环境仍在使用 JS 版本（`lib/models/phonemize/english.ts`），
需要在 `entrypoints/offscreen/kokoro.worker.ts` 中启用 Rust phonemize」。

**`lib/models/phonemize/english.ts` 不存在**，阶段 8 已经把整条 JS 链删掉了
（commit `56aa256`，−17.8 MB）。英文文本**早就**在走 Rust wasm 了：
`WorkerLocalEngine.synthesize` → `phonemize.worker.ts` → `RustPhonemizer` →
`pipeline::phonemize_en`。它甚至被**调用**了两次——一次是为了拿 IPA，一次是为了数 token。

真正的缺口在**另一半**：`KokoroEngine.render()` 按语言分叉。

```ts
if (isChinese(lang) || isJapanese(lang)) {
  // IPA → generate_from_ids()
}
// 英文：把**原文**交给 tts.generate()
const audio = await tts.generate(piece.text, options);
```

`tts.generate()` 是 `kokoro-js` 自己的前端：内部调 `phonemizer`（espeak-ng wasm），
再加一串数字/标点/字符替换。所以：

- Rust 算出来的英文 IPA 被**丢掉**了，模型听到的是 espeak 的发音；
- `countTokens()` 数的是 Rust 的 IPA，而实际喂给模型的是 espeak 的 IPA——
  切片策略和实际输入描述的不是同一个东西；
- `phonemizer` 是**模块级 import**，所以 espeak 的 wasm 从 kokoro worker 存在的那一刻
  就在依赖图里，无论 `generate()` 被不被调用。

**第二处**：任务书列的关键文件 `entrypoints/offscreen/kokoro.worker.ts` 不需要改——
phase 7 之后它只做消息分发，`KokoroEngine` 在它自己可以测试的模块里。
真正要改的是 `lib/models/kokoro-engine.ts` 和 `wxt.config.ts`。

---

## 二、改动

| 文件 | 改动 |
|------|------|
| `lib/models/kokoro-engine.ts` | `render()` 不再按语言分叉：三种语言都 `tokenizer(ipa)` → `generate_from_ids()` |
| `lib/models/worker-protocol.ts` | `SynthesizePiece` 去掉 `text`（只剩 `ipa`）+ 类型守卫 |
| `lib/models/worker-engine.ts` | 发 `{ ipa }` |
| `lib/models/phonemizer-stub.ts` | 新增：`phonemizer` 的替身，调用即抛 |
| `wxt.config.ts` | `resolve.alias.phonemizer` → 替身 |
| `lib/models/language.ts` | **删除**（`isChinese`/`isJapanese` 再无引用） |

**别名必须打在 `phonemizer` 这个裸模块名上，不能打在路径上**：说
`import ... from "phonemizer"` 的是 `kokoro-js`，而 `resolve.alias` 是在解析前替换
*import 源字符串*。指到 `false` 不行——那会把 import 留成一个空模块，只对 default export 生效。
`phonemizer` 不是本仓的直接依赖（它是 `kokoro-js` 的，pnpm 放在 store 里），
所以没有 `package.json` 条目可以删，也没有别的地方提到它。

**去掉调用不等于去掉字节。** 这是阶段 8 教训的镜像：bundler 跟的是 import 图，
不是调用图。Emscripten 模块在 bundle 求值时构造，所以必须让**模块名**解析不到真包。

---

## 三、体积（同一会话内，同一份资产的两次构建）

| | 前（HEAD 代码） | 后 | Δ |
|---|---|---|---|
| kokoro worker chunk | 2,225,156 B | **904,657 B** | **−1,320,499 B** |
| 扩展总计 | 41,842,043 B | **40,521,530 B** | **−1,320,513 B**（−3.16%） |
| phonemize.wasm | 6,090,205 B | 6,090,205 B | 0 |

两次构建用的是同一份 `public/dictionaries/`（含 9E 新加的中日文 FST），
所以差值是纯粹的 phase 10，不是跨会话拼出来的数字。

> 参考：9A 记录的 41.62 MB 是不含 9E 那 223 KB 资产的数字，加回来是 41.84 MB，
> 与上表「前」一致。

构建产物里 espeak 的痕迹：`espeak-ng-data`、`eSpeakNG` 两个 marker
**在「前」各命中 1 个 JS 文件，在「后」0 个**。

**marker 的选法踩了两次坑**，记在 `tests/build/build-output.test.ts` 里：
`phonemizer` 是我们自己的词（phonemize worker、`PhonemizeService`、wasm 的
`phonemizer_free` 导出），命中三个无关 chunk；`espeak` 是
`WeSpeakerResNetModel` 的子串（transformers.js 支持的模型列表），永远命中。
所以用了 `espeak-ng-data` 和 `eSpeakNG`。

---

## 四、音质：这一阶段是对是错，目前只有纸上证据

**真实音频没听过**（模型 163 MB，本机无缓存）。下面是阶段 10 首次尝试时留下的
137 条 / 12 组逐字符对照（Rust vs `kokoro-js` 的 espeak 路径），本次没有重跑：
**该数据来自一次未提交的尝试，只用来说明缺口在哪，不作为验收依据。**

- 逐字符相同 2/137；过写明的约定表后 23/137。
- Rust 抛错 0、空输出 0；词表外字符 Rust 0 / espeak 3——espeak 把 `(`→`«`、`)`→`»`，
  而 v1 词表没有这两个字符，所以括号静默消失。
- **espeak 更好的**：`to` 弱读（21 句 `tə` vs `tuː`）、弹舌 `ɾ`、
  缩写语按词念（NASA/YAML/XML/API/JSON/HTTP/FAQ/RAG）、`$10.50` →「十美元五十分」、
  `Monday`。
- **Rust 更好的**：日期 `10/4/2024`、`3:30pm`、`1/2 cup`→one half、`250 km`→kilometers、
  `vs.`→versus、TypeScript/YouTube/Kubernetes/localhost、保留括号。
- **8 个英式音色整族失配**：132/137 条 en-GB 与 en-US 不同，Rust 匹配 en-GB **0 条**——
  Rust 英文链路是**美式单套**，而 en-GB 音色（`bf_*`/`bm_*`，共 8 个）此前由 espeak
  按 `en` 变体发音。

**所以这是一个有方向的交易，不是纯改进。** 要判断，需要真人听这六组：

1. 普通英文句子（`af_heart`）
2. `1,234`（Rust 有一个已知 bug，见 §五）
3. `$10.50`
4. NASA / API / FAQ（缩写语按词念 vs 按字母念）
5. `ninety`（en-US 的 `nˈaɪnti`→`nˈaɪndi` 改写，见 §五）
6. `bf_emma` 的 A/B（英式音色路由到美式音素）

---

## 五、已知缺口（都不是本阶段引入的，但现在生产可达）

1. **`1,NNN` 丢「one」**：`1,234` → `θˈaʊzənd tˈuː hˈʌndɹəd…`。
   `crates/phonemize/tests/wetext_en.rs:207` 就钉着 `("1,234", "thousand two hundred and thirty four")`
   ——这是 9B.4 锁住的引擎行为。`2,234`/`11,234`/`123,456`/`1,234,567` 都正常，
   **只有 `1,000`–`1,999`**。建议先修这个。
2. **首字母 A 读成冠词**：`FAQ` → `ˈɛf ə kjˈuː`、`RAG` → `ˈɑːɹ ə dʒˈiː`。
   `spelled_out` 把 `A P I` 交给 CMU 词典，而 `A` 在词典里是单词 a。
   阶段 4 的 `g2p_en.rs` 测试已钉 `ipa("API") == "ə pˈiː aɪ"`——**这是刻意保留的旧行为**，
   修法很小（26 个字母的名字表）但会改到中日文拉丁段（生产已上线）。
3. **`ninety` 的 en-US 改写缺失**：`kokoro-js` 有 `nˈaɪnti`→`nˈaɪndi`（仅 en-us），
   Rust 给 `nˈaɪntiː`。`KokoroEngine.render` 因此保留 `lang` 参数不读——
   补这个改写只需要它，把参数摘掉会让这个缺口变成一个重新接线的活儿。
4. **en-GB 无音色路由**（§四）。

---

## 六、验证

全绿：`cargo test --workspace`（296）、`cargo clippy --all-targets -- -D warnings`、
`cargo fmt --check`、`pnpm test`（1395）、`pnpm test:build`（14 条，含新的
`carries no trace of espeak-ng`）、`pnpm typecheck`、`pnpm lint`、`pnpm check:manifest`、
`pnpm check:headtts`。

`pnpm test:build` 的体积窗口从 40–46 MB 降到 **38.89–45 MB**：
地板设在测量值下方约一个中文词表（1.63 MB）处，因为它的作用是抓「构建悄悄没拷字典」
（这个测试已经漏掉过一次），不是能压多低压多低。
