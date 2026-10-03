# V0 安装报告：`@piper-plus/g2p`

**日期**: 2026-10-03
**执行者**: V0 验证（子智能体）
**包版本**: `0.4.2`
**结论**: 安装成功。但**包内不含任何 wasm**——决策摘要中「WebAssembly 就绪」的表述与事实不符。

---

## 1. 安装

### 1.1 干净环境安装（按 V0 清单执行）

在空目录中执行清单里的原始命令：

```
$ npm install @piper-plus/g2p
added 1 package, and audited 2 packages in 1s
found 0 vulnerabilities
```

| 项 | 值 |
|---|---|
| 新增包数 | **1**（零传递依赖） |
| 安装耗时 | 1121 ms（含 npm 开销） |
| 体积（`node_modules/@piper-plus/g2p`） | **332 KB** |
| 包内文件数 | 23 |
| 包内文件字节数 | 290,573 B = **283.8 KB** |
| 漏洞 | 0 |

### 1.2 项目内状态

`package.json` 中**已有** `"@piper-plus/g2p": "^0.4.2"`，但**全仓库无任何代码引用它**：

```
$ grep -rn "@piper-plus" --include=*.ts --include=*.tsx lib/ tests/ entrypoints/
(无输出)
```

即：这个依赖是在决策调研阶段被加进 `package.json` 的，尚未接入。它也没有被 `pnpm-lock.yaml` 之外的任何构建配置引用。

### 1.3 元数据

| 字段 | 值 |
|---|---|
| `license` | MIT |
| `dependencies` | `{}`（无运行时依赖） |
| `peerDependencies` | `{}` |
| `engines` | `{"node": ">=24.0.0"}` |
| `type` | `module`（纯 ESM） |
| `main` | `src/index.js` |

**零运行时依赖 + 纯 ESM**：这一点是真实的优点，浏览器打包没有任何障碍。

### 1.4 包的元数据缺陷：类型入口不可达

`package.json` 同时有顶层 `"types": "types/index.d.ts"`（30 KB，内容准确）和一个**不含 `types` 条件**的 `exports` 映射：

```json
"exports": { ".": "./src/index.js", "./ja": "./src/ja/index.js", ... }
```

在 `moduleResolution: "Bundler"` 下 `exports` 优先，顶层 `types` 字段永远不被读取。后果：

```
tests/v0/comparison.test.ts(21,33): error TS7016: Could not find a declaration file for
module '@piper-plus/g2p'. ... There are types at '.../types/index.d.ts', but this result
could not be resolved when respecting package.json "exports".
```

即包自带的类型声明**在实际消费端拿不到**，导入退化为 `any`。这是上游打包缺陷，不是本仓库的问题——修法是给 `exports` 的每个条目加 `types` 条件。V0 用一个窄垫片 `tests/v0/piper-plus-g2p.d.ts` 绕开，未改项目的 `tsconfig.json`。

---

## 2. 导入测试

清单要求的原命令：

```
$ node -e "const g2p = require('@piper-plus/g2p'); console.log(typeof g2p);"
object
```

通过（`typeof` 为 `object`）。需要说明的是，这是因为 Node 24+ 的 `require(esm)` 互操作把 ESM 命名空间对象返回给了 `require`——它是可用的：

```
$ node -e "const m=require('@piper-plus/g2p'); console.log(typeof m.G2P, typeof m.EnglishG2P);"
function function
```

### 2.1 决策摘要里的示例 API 是错的

`docs/superpowers/plans/p6-decision-summary.md:85` 与 `p6-g2p-library-evaluation.md` 都写了这个用法：

```bash
node -e "const {g2p} = require('@piper-plus/g2p'); console.log(g2p('hello', 'en'));"
```

实际执行：

```
TypeError: g2p is not a function
```

包内**没有名为 `g2p` 的导出**（`'g2p' in m === false`）。真实 API 是 `G2P` 类，且**必须异步构造**：

```js
import { G2P, EnglishG2P, ChineseG2P } from '@piper-plus/g2p';

// 统一入口（异步工厂）
const g2p = await G2P.create({ languages: ['en', 'zh'] });
g2p.phonemize(text, { language: 'en' });   // -> { tokens, prosody, language }

// 或单语言类（en/zh 同步构造）
new EnglishG2P().phonemize(text);          // -> { tokens, prosody }
```

这不是文档笔误的层级——调研结论是**基于这个不存在的 API** 得出的。

---

## 3. 关键发现：包内没有 wasm

V0 清单第 4 项要求测「wasm 加载时间」，决策摘要的「待验证」里也写了「wasm 大小（< 5 MB）」。**这两个指标都不适用**，因为这个包不含 wasm：

```
$ find node_modules/@piper-plus/g2p -name "*.wasm" -o -name "*.bin" -o -name "*.gz"
(无输出)
```

它的 `files` 字段是：

```json
"files": ["src/**/*.js", "data/sv_function_words.json", "types/", "CHANGELOG.md", "LICENSE.md"]
```

**它是纯 JavaScript 规则表**，283.8 KB 全部是 `.js` 源码。所谓「WebAssembly 就绪」不成立——见下面第 4 节，日语路径需要**外部**的 wasm。

---

## 4. 日语路径需要外部 wasm + ~55 MB 词典下载

`JapaneseG2P` 不自带 OpenJTalk。它的 `initialize()` 在缺少模块时直接抛错：

```
openjtalkModule is required. Pass it via new JapaneseG2P({ openjtalkModule })
or initialize({ openjtalkModule }).
```

它需要的模块必须暴露一组 OpenJTalk C API（`_openjtalk_initialize` / `_openjtalk_synthesis_labels` / `allocateUTF8` / `FS`），并且需要把 8 个 MeCab 词典文件写进 wasm 虚拟文件系统。

项目里现有的 `wasm_open_jtalk@0.0.1` **不能**充当这个模块——它是 Emscripten **CLI** 构建（`shouldRunNow=true` + `callMain`），只暴露通用 API：

```
$ grep -o "_openjtalk_[a-z_]*\|allocateUTF8\|UTF8ToString" node_modules/wasm_open_jtalk/js/open_jtalk.js | sort -u
allocateUTF8
UTF8ToString
```

没有 `_openjtalk_*`。词典方面，包内提供的 `DictLoader` 从 GitHub Releases 下载：

```
https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/open_jtalk_dic_utf_8-1.11.tar.gz
```

本机无任何本地 OpenJTalk 词典副本（`find / -name sys.dic` 只命中系统自带的 Apple 词典）。

**后果**：日语路径需要 (a) 一个包外提供的 OpenJTalk wasm 构建，(b) 运行时下载约 50–55 MB 词典。这与 P6 spec §0.4 的「**用户不需要为字典做任何下载动作**」直接冲突。

---

## 5. 与「方案 A」宣称的逐条核对

| 决策摘要的宣称 | 实测 | 判定 |
|---|---|---|
| npm 包开箱即用 | 安装确实成功，但 zh/ja **开箱即用不成立** | ❌ 部分不实 |
| 支持中日英三语 | 英=可用；中=字符透传；日=需外部 wasm+词典 | ❌ |
| MIT 许可 | 属实（MIT，零依赖） | ✅ |
| 日语基于 OpenJTalk，含完整韵律 | 代码属实，但**包不含 wasm**，韵律数据只能由外部模块产出 | ⚠️ 有条件成立 |
| 英文规则驱动，无需 espeak-ng | 属实（且快 ~100×） | ✅ |
| WebAssembly 就绪，浏览器原生运行 | **包内无 wasm**，是纯 JS | ❌ 不实 |
| 待验证：wasm 大小 < 5 MB | 无 wasm 可测 | ⚠️ 不适用 |
| 示例 `g2p('hello','en')` | 抛 `TypeError` | ❌ 不实 |

---

## 6. 附：同一上游另有一个**真正带 wasm** 的包

调研漏掉的一点：上游 `piper-plus`（npm，v0.7.0，与 `@piper-plus/g2p` 同一作者）**自带 Rust wasm**：

```
package/dist/rust-wasm/piper_plus_wasm_bg.wasm   60,077,874 B (57.3 MB)
package/dist/rust-wasm/piper_plus_wasm.js            21,468 B
```

其自述为「WASM phonemizer for Piper Plus TTS — 8-language G2P with **bundled NAIST-JDIC dictionary**」。它还把 `@piper-plus/g2p` 列为自己的依赖，但**对 ja/zh 绕过它**：

```js
// package/src/index.js:935-937
// Languages that REQUIRE Rust WASM (no functional JS G2P fallback):
//   ja — needs jpreprocess (no JS equivalent)
//   zh — needs pinyin dictionary (JS G2P has no pinyin conversion)
const WASM_REQUIRED_LANGUAGES = new Set(["ja", "zh"]);
```

**上游自己明确写了：JS 版 G2P 的 ja 与 zh 没有可用实现。** 这是本次验证最重要的旁证——不是我们的适配问题，是库本身的定位问题。

体积代价是 57.3 MB（词典内置，零下载），与 `@piper-plus/g2p` 的 283.8 KB 是两个量级。这一条应进入 P6 选型讨论，但**不属于本次 V0 的范围**，本次未对它做实测。

---

## 7. 结论

- **安装**：成功。332 KB，零依赖，MIT，安装 1.1 s。
- **导入**：成功，但决策摘要中的示例 API 不存在。
- **包内容**：纯 JS，**无 wasm**；日语需外部 wasm + ~55 MB 词典下载。
- **上游自认**：ja/zh 无可用 JS 实现。

安装本身通过；但「开箱即用的三语方案」这一前提不成立。
