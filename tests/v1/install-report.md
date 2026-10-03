# V1 安装报告：`piper-plus@0.7.0`

**日期**: 2026-10-03
**执行者**: V1 验证（子智能体）
**包版本**: `0.7.0`（发布于 2026-08-28，MIT，作者 ayutaz）
**结论**: 安装成功，**57 MB Rust wasm 确实存在**，且**日语词典确实内置**（零下载）。但 npm 包**漏发了中文拼音词典**，且上游那份词典的格式与 Rust 解析器不匹配——详见 §4 与 `api-exploration.md` §5。

---

## 1. 安装

### 1.1 安装方式与命令

V0 把 `@piper-plus/g2p` 装进了项目的 `package.json`。V1 **没有**这样做：本包 60 MB，而这是一次评估，不是依赖决策。改为装进隔离沙箱：

```
$ mkdir -p tests/v1/.sandbox && cd tests/v1/.sandbox
$ npm install piper-plus@0.7.0 --no-audit --no-fund
added 20 packages in 5s
```

复现入口：`bash tests/v1/setup.sh`（幂等，含 §4 的词典补齐步骤）。

| 项 | 值 |
|---|---|
| 新增包数 | **20**（1 个直接依赖 + 1 个 peer + 18 个传递依赖） |
| 安装耗时 | 5.6 s |
| `node_modules` 总体积 | **205 MB** |
| 其中 `piper-plus` 本身 | **58 MB** |
| 其中 `onnxruntime-web`（peer） | **139 MB** |
| 漏洞 | 0 |

对比 V0：`@piper-plus/g2p` 是 332 KB / 1 个包 / 零依赖。**同一个上游的两个包差了 180 倍体积**，因为 wasm 就在后者里。

### 1.2 依赖树

```
piper-plus@0.7.0
├── @piper-plus/g2p@0.4.2          ← V0 验证过、判定失败的那个包
└── onnxruntime-web@1.30.0         ← peerDependency（npm 7+ 自动安装）
    ├── flatbuffers@25.9.23
    ├── guid-typescript@1.0.9
    ├── long@5.3.2
    ├── onnxruntime-common@1.30.0
    ├── platform@1.3.6
    └── protobufjs@7.6.6 (+ 13 个 @protobufjs/* 子包)
```

两点值得记下：

1. **`@piper-plus/g2p` 是硬依赖**（`"@piper-plus/g2p": "^0.4.2"`）。也就是说引入本包**必然同时引入 V0 判定失败的那条 JS G2P 链路**。这不是巧合：上游自己的架构里，英语/西语/法语等语言就是由这个 JS 层承担的（见 §3.2）。
2. **`onnxruntime-web` 是 peer 而不是依赖**，但对 G2P 路径**完全不需要**——它只在合成（ONNX 推理）时用到。npm 会替你装上这 139 MB。若在浏览器扩展里只取 G2P，需要显式忽略这个 peer；`engines` 字段要求 `node >= 24`（本机 v26.10.0，满足）。

### 1.3 包内文件清单（28 个文件，60,325,922 B = 57.53 MiB）

```
dist/rust-wasm/piper_plus_wasm_bg.wasm     60,077,874 B   ← 57.29 MiB，唯一的大件
dist/rust-wasm/piper_plus_wasm.js              24 KB       wasm-bindgen 胶水
dist/rust-wasm/piper_plus_wasm.d.ts            12 KB       类型定义（API 真相源）
dist/rust-wasm/piper_plus_wasm_bg.wasm.d.ts     1 KB
dist/rust-wasm/package.json                     1 KB
src/index.js                                   48 KB       合成主类（PiperPlus）
src/{model-manager,speaker-encoder,timing,...}.js            合成/缓存/计时
src/phonemizer/rust-wasm-adapter.js            12 KB       把 wasm 包成 PhonemizerInterface
src/phonemizer/{composite,js-g2p}-adapter.js                 语言路由 + JS G2P 回退
src/phonemizer-compat.js                        1 KB        ← 只是 re-export @piper-plus/g2p
types/index.d.ts                               32 KB
bin/piper-cli.js                               12 KB        仅 ONNX 合成（不过 G2P）
LICENSE.md / THIRD-PARTY-LICENSES.md / README.npm.md
```

**`dist/rust-wasm/piper_plus_wasm_bg.wasm` 校验值**：

```
size    60,077,874 bytes (57.29 MiB)
sha256  f94f140761e3b4733a339cab6c1cbe077788c7de8f5a014888082c94856ebca0
```

上游 `src/rust/piper-wasm/Cargo.toml` 的注释解释了这 57 MB 的构成：

> wasm-opt: `-Os` balances size and speed. **The binary is 96% dictionary data (NAIST-JDIC)**, so code-level optimization has minimal impact on total size.

即 **约 55 MB 是日语词典数据，代码只占 ~2 MB**。

---

## 2. 词典是否内置？——分语言回答

这是 V1 最关键的问题，而答案是**分开的**：

| 语言 | 词典 | 是否内置 | 依据 |
|---|---|---|---|
| **日语** | NAIST-JDIC（jpreprocess） | ✅ **内置** | `ja = ["piper-plus-g2p/naist-jdic"]`，`JapanesePhonemizer::new_bundled()`，`include_bytes!()`；.d.ts 亦写「with bundled Japanese dictionary」 |
| **中文** | 拼音单字表 + 词组表 | ❌ **未随 npm 包发布** | 包内**没有 `assets/` 目录**；`pinyin_single.json` / `pinyin_phrases.json` 在 npm 上 404 |
| 其他（ko/es/fr/pt/sv） | 纯规则，无需词典 | — | Cargo 注释：「These features have no Cargo dependencies because the G2P logic is pure Rust」 |
| 英语 | CMUdict（`cmudict_data.json`） | ❌ **未编译进这个 wasm 构建** | `multilingual` 特性列表里**根本没有 `en`**，见 §3.2 |

**日语零下载已实测确认**：Node 进程只读本地 wasm 文件，没有任何 fetch，10/10 日语样本产出正确读音（`こんにちは` → `ko[N_nnichiwa`，`東京` → `to[okyoo`）。V0 里「日语需要运行时下载 ~55 MB」的问题**在 Rust wasm 路径上确实解决了**。

---

## 3. 入口点与 exports

### 3.1 `exports` 映射

```json
{
  ".":                   { "types": "./types/index.d.ts", "import": "./src/index.js" },
  "./timing":            { "types": "./types/index.d.ts", "import": "./src/timing.js" },
  "./phonemizer":        { "import": "./src/phonemizer-compat.js" },
  "./streaming":         { "types": "./types/index.d.ts", "import": "./src/streaming-pipeline.js" },
  "./wasm/multilingual": { "import": "./dist/rust-wasm/piper_plus_wasm.js" }
}
```

- **Rust wasm 的唯一公开入口是 `piper-plus/wasm/multilingual`**。深路径 `piper-plus/dist/rust-wasm/piper_plus_wasm.js` 会被 Node 以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝（实测）。
- 与 V0 的老毛病相同：**`./phonemizer` 没有 `types` 条件**，所以那个子路径导入在 `moduleResolution: "Bundler"` 下拿不到类型（V0 记录过同一个上游缺陷）。
- `./phonemizer` 本身**只是把 `@piper-plus/g2p` 原样 re-export**（`phonemizer-compat.js` 全文就是一组 `export { ... } from "@piper-plus/g2p"`）。README 里那段「`G2P.create({languages:['ja','en']})` 会走 Rust WASM 日语」的示例，**在 npm 包里不成立**——它导出的仍是 V0 那个需要 `openjtalkModule` 注入、否则抛错的类。

### 3.2 wasm 构建里到底有哪几种语言（权威答案）

`src/rust/piper-wasm/Cargo.toml`：

```toml
multilingual          = ["ja", "zh", "ko", "es", "fr", "pt", "sv"]
multilingual-external = ["ja-external", "zh-external", "ko", "es", "fr", "pt", "sv"]
```

**`en` 不在列表里。** 因此本 wasm 的英语走 `PassthroughPhonemizer`（按字符切分），实测 10/10 如此：

```
en "hello"              -> h e l l o
en "The quick brown fox" -> T h e   q u i c k   b r o w n   f o x
```

这不是 bug，是上游的架构分工：英语由 JS 层（`@piper-plus/g2p` 的 `SimpleEnglishPhonemizer`）承担，wasm 只负责「JS 做不了」的语言。**换句话说，这 57 MB 买到的实际只有日语（+ 中文，且需外部词典）。**

---

## 4. 关键发现：npm 包漏发了中文拼音词典

`RustWasmAdapter.create()` 会在构造后尝试拉取中文词典：

```js
const dictBase = options.zhDictBaseUrl || new URL("../../assets/", import.meta.url).href;
const [singleResp, phraseResp] = await Promise.all([
  fetch(new URL("pinyin_single.json", dictBase)),
  fetch(new URL("pinyin_phrases.json", dictBase)),
]);
if (singleResp.ok && phraseResp.ok) { wasm.setChineseDictionary(...) }
else { console.warn("[piper-plus] Chinese pinyin dictionaries not found, zh will use passthrough"); }
```

从 `src/phonemizer/` 往上两级即包根，所以它找的是 `piper-plus/assets/`。**包里没有 `assets/` 目录**：

```
$ curl -o /dev/null -w "%{http_code}" \
    https://cdn.jsdelivr.net/npm/piper-plus@0.7.0/assets/pinyin_single.json
404
```

上游仓库里这两个文件是存在的（`src/wasm/openjtalk-web/assets/pinyin_{single,phrases}.json`，合计 **2.7 MB**，对比现在随扩展发布的 kuromoji 词典 17.8 MB，是**可以打包进扩展的量级**）。所以这是一个**发布配置漏项**，不是设计约束。

但补齐文件**还不够**——格式对不上。见 `api-exploration.md` §5：上游那份词典用带声调符号的拼音（`nǐ`），而 Rust 的 `extract_tone` 只认行尾数字（`ni3`），且全文件**零**声调符号处理代码。V1 因此写了一个转换器（`scripts/convert-pinyin-tone3.mjs`）把 41,923 条单字 + 143,863 个词组音节转成 TONE3，中文路径才真正产出音素。

---

## 5. 许可

`THIRD-PARTY-LICENSES.md` 列出的全部是 **MIT / BSD-3-Clause**，**没有任何 GPL**：

| 组件 | 许可 |
|---|---|
| piper-plus 本身 | MIT |
| Open JTalk / HTS Engine API | BSD-3-Clause |
| NAIST Japanese Dictionary (UniDic) | BSD-3-Clause |
| ONNX Runtime Web | MIT |

对 P6 的动机（摆脱 espeak-ng 的 GPL）而言这是**利好**。但该文件有一处**过时陈述**：

> The OpenJTalk dictionary files are not included in the npm package. They are **downloaded at runtime on first use** and cached locally in IndexedDB.

这与事实相反——README 说 v0.2.0 起词典已编译进 wasm，V1 也实测日语零下载可用。**许可正文本身（BSD-3-Clause 全文）是照录的**，所以合规上未必有问题，但这句话会让读者以为不需要处理随包分发的 BSD 归属声明。属于需要在集成时自行更正/记录的文档缺陷。

---

## 6. 与 V0 的对照

| 项 | V0（`@piper-plus/g2p@0.4.2`） | V1（`piper-plus@0.7.0`） |
|---|---|---|
| 体积 | 332 KB | **60.3 MB**（+ 139 MB peer） |
| 包内 wasm | **无** | **57.29 MiB** |
| 日语 | 无法初始化（需外部 OpenJTalk wasm + ~55 MB 下载） | ✅ **内置 NAIST-JDIC，零下载，可用** |
| 中文 | 汉字透传（93.3% 词表缺失） | 默认透传；**补齐并转换词典后可用**（PUA 声调 token） |
| 英语 | 可用但劣于 espeak | **不在此 wasm 构建内**，仍是 V0 那条 JS 链路 |
| 许可 | MIT | MIT + BSD-3-Clause |

**结论**：V0 报告里「调研漏掉的那个包值得重新评估」这条建议是对的——57 MB 的 wasm 里确实有一个**能离线工作的日语 G2P**。但它不是一个三语方案：英语不在这条链路里，中文要自己补 2.7 MB 词典并做格式转换。判定见 `v1-summary.md`。

---

## 7. 交付物与复现

| 文件 | 内容 |
|---|---|
| `tests/v1/setup.sh` | 幂等重建：装包 → 建 `node_modules` 链接 → 拉上游词典 → 转 TONE3 |
| `tests/v1/scripts/convert-pinyin-tone3.mjs` | 带声调拼音 → TONE3（41,923 单字 / 143,863 音节） |
| `tests/v1/wasm-harness.mjs` | wasm 封装：穷举 id map 反解、PUA 展开、词典加载、词表丢字分析 |
| `tests/v1/install-report.md` | 本文档 |
| `tests/v1/api-exploration.md` | API 调研（ID 语义、PAD 兜底、语言提示、PUA 契约） |
| `tests/v1/piper-plus-comparison.json` | 30 条样本三链路对照 |
| `tests/v1/vocab-check.json` | 双词表兼容性（字符集 + 词表当 id map 的丢字率） |
| `tests/v1/performance-results.json` | 性能基准 |
| `tests/v1/v1-summary.md` | 总结与判定 |

沙箱与派生资产在 `tests/v1/.sandbox/`（已 gitignore），交付物是 JSON 报告与 markdown。
