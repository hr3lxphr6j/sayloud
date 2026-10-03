# P6 阶段 6 实施记录：中文前端组装

**日期**: 2026-10-03
**范围**: 计划阶段 6（任务 6.1–6.5：jieba 分词、数字转换、标点与 run 切分、完整管道、对照测试）
**状态**: **已实施**，测试全绿（Rust 128 → 168，TS 1461 → 1466）
**结论**: `lang="zh"` 不再报错，中文管道端到端可用，与 JS 前端在 47 条语料上逐字符相同。
计划里两处技术前提需要修正（见 §二、§五），另发现一个**既有**的构建体积上限早已失效（见 §八）。

计划原文：`2026-10-03-p6-rust-phonemize-implementation.md` §阶段 6（1595 行起）。

---

## 一、结论

`Phonemizer::phonemize_with(text, {lang: "zh-CN"})` 现在走完整的 `pipeline::phonemize_zh`：

```
文本
  → numbers_to_han        数字读法（一百二十三）      backends/numbers_zh.rs
  → map_punctuation       全角标点 → ASCII（“ ”）      backends/zh_text.rs
  → split_runs            Han / Latin / other          backends/zh_text.rs
      Han   → word_lengths (jieba) + han_to_ipa_by_words (pinyin)  词间一个空格
      Latin → EnglishG2p（不是 espeak，见 §五）
      other → keep_punctuation（保留 \s 且不 trim）
  → collapse_whitespace
  → vocab 闸门（阶段 5）
```

顺序与 `ChinesePhonemizer.phonemize` 一致（JS 写的是 `mapPunctuation(numbersToHan(text))`），
顺序本身是有意义的：数字必须**先**变成汉字，否则它不属于任何 script，会落进 `other` run
被当标点丢掉——不发声，且不报错。

## 二、jieba：计划的前提需要修正

计划任务 6.1 写的是 `jieba-rs = "0.6"` + `Jieba::new()`（内置词典），并预期「体积增长
< 1 MB，主要是 jieba 词典」。**实测两条都不成立**，而且原因是一条硬性技术障碍：

```
error: linking with `rust-lld` failed: exit status: 1
  = note: rust-lld: error: ... undefined symbol: ZSTD_freeDCtx
```

`jieba-rs` 的 `default-dict` 特性用 `include-flate` 内嵌 `dict.txt`，而 `include-flate`
**运行时**用 C 的 `zstd` crate 解压 —— 于是 `zstd-sys` 进入 wasm 链接。`zstd-sys` 用宿主的
`ar` 打包 wasm 目标文件，而 macOS 的 `ar` 只懂 Mach-O，它写出一个没有任何成员的归档，
链接就在每个 `ZSTD_*` 符号上失败。

**这正是本项目 `Cargo.toml` 早就记录过的同一个坑**（当初为它选了 `ruzstd` 而不是 C zstd，
理由原文：「Working around that means putting `llvm-ar` on every build machine and in CI」）。
所以结论是沿用同一条决定：**C zstd 不进构建**。

于是：

```toml
jieba-rs = { version = "0.11", default-features = false }   # 不要 default-dict
```

词典改为走**既有的字典协议**（spec §3.2），和 IPADic 同一条路：

| | |
|---|---|
| 资产 | `public/dictionaries/jieba-zh-dict.bin.zst` |
| 大小 | `dict.txt` 5,071,843 B → zstd -19 **1,632,261 B** |
| 生成 | `scripts/setup-jieba-dict.sh`（下载 → sha256 校验 → 压缩 → 原子改名） |
| 名字 | `dictionary::JIEBA_ZH = "jieba-zh-dict"` |
| 加载 | `SegmenterZh::from_dictionary(&bytes)` → `Jieba::with_dict` |

这个选择顺带满足了两件事：wasm 只涨 jieba 的**代码**（+886 KB，含 HMM 模型），
4.8 MB 的词典不进二进制；而且 **JS 侧一行都不用改** —— `RustPhonemizer.prepare` 本来就是
「问 wasm 要名字，然后按 `/dictionaries/{name}.bin.zst` 取」，名字是 wasm 决定的
（这正是 spec §3.2 想要的效果，这次得到了验证）。

### 为什么是 jieba-rs 而不是 `lindera-cc-cedict`

spec §1.4 附注里留了这条备选（6.92 MB，且 lindera 的加载机制已经在跑）。**没有采用**：
JS 侧的分词是 `jieba-wasm`（就是 `jieba-rs` 编译成 wasm），换词典就会换分词边界，
而验收标准是「对照 JS」。用同一个 crate 是**构造性**的一致，不是碰巧一致。

### 一致性是怎么保证的

1. crate 版本钉死（`jieba-rs` 0.11.0）；
2. 词典内容钉死（脚本校验 sha256，来自同一个 tag 的同一个文件，与 crate 内嵌的那份逐字节相同）；
3. `cut(text, true)` —— **HMM 必须开**。`jieba-wasm` 带的是 jieba-rs 的词典而不是 Python
   jieba 的 `dict.txt`，差别恰好藏在这个开关后面：关掉时 `还书` 会切成 `还|书`。这一点
   `chinese.ts` 的 `jiebaBoundaries` 注释里已经记录过（24 条语料上 `cut(text, true)` 与
   `jieba.lcut` 24/24 一致，`hmm: false` 第一条就分叉）。

移植前做过一次性交叉验证：`jieba-rs` 0.11.0 + 这份词典 vs `jieba-wasm` 2.4.0，
98 条语料（阶段 5 的 45 条 + 53 条新写）**98/98 分词完全相同**。那份语料是临时实验、
没有提交；**持续生效**的检查是 47 条管道语料（分词错了会表现为空格错了）。

**顺带发现**：`jieba-rs` 0.11 的 `cut` 返回 `Vec<Token>` 而不是它自己文档里的 `Vec<&str>`，
而且它文档里的例子（`我们中出了一个叛徒` → `我们|中|出|了|一个|叛徒`）**已经过时**——
现在的词典切出来是 `我们|中出|了|一个|叛徒`，`jieba-wasm` 也一样。测试的期望值因此取自
**oracle**（`jieba-wasm`），不是取自 crate 的文档。

## 三、数字转换：四次顺序扫描，不是一次扫描

`numbers.ts` 是四条链式 `replace`，顺序是有意义的（最长模式优先）。移植时最容易走的捷径是
「写一个从左到右的扫描器，按数字串逐个判断它是什么」。**这个捷径是错的**：

```
输入      1.2.3%
一次扫描  一点二 . 百分之三
JS 链式   一 . 百分之二点三        ← 正确
```

原因：第一条规则扫过 `1.2` 之后**从头重新开始**，于是它找到了已经被第一条规则走过的
`2.3%`。所以 `numbers_zh::replace` 是**每个模式一次**，按同样的顺序。

「失败时从哪里继续」也照抄了：正则引擎在匹配失败后前进一个位置，而本实现是「跳过整个数字串」。
两者等价，因为这里每个模式都要求数字串后面紧跟一个**非数字**字符，所以同一个串的任何更短
前缀也不可能匹配——这个推理写在 `replace` 的文档注释里，并且有测试钉住
（`reproduces_the_chained_pattern_order`）。

已知缺口**照抄不修**（`1,234` 读成 `一,二百三十四`、`-5` 读成 `五`、`15％` 丢掉「百」），
因为两侧必须先一致才能一起改。每条都有测试记录。

## 四、中文文本规则：与 `common.ts` 的三处刻意分歧

`zh_text.rs` 镜像的是 `chinese.ts` 的文本层，**不是**共享的 `text.rs`（它镜像 `common.ts`）。
两个 JS 文件不一样，两个 Rust 模块就必须不一样：

| | `chinese.ts`（→ `zh_text.rs`） | `common.ts`（→ `text.rs`） |
|---|---|---|
| 引号 | `「」《》【】«»` → `“ ”` | 同样的字符 → `"` |
| 空白 | `keepPunctuation` 保留 `\s`，再折叠成一个空格 | 只保留集合里的字面空格 |
| Han run | 含 `〇`(U+3007) 与兼容表意文字(F900–FAFF)，**无 kana** | 不含这两者，有 kana |

三处都是**可观测**的，不是美观问题：

- `“ ”` 与 `"` 都在词表里，所以是不同的音素串；
- `你好 世界` 里那个空格是**唯一**的词边界，`text.rs` 的 keep 会把它丢掉，两个词会粘在一起；
- `〇` 被 `pinyin-pro` 读作 `ling2`，落进 `other` 就会被丢掉——而「字符静默消失」正是词表闸门
  存在的理由。

所以 `split_runs` 是 zh 自己的（`〇` / 兼容表意文字 / kana 三种输入都有测试），
`keep_punctuation` 也是 zh 自己的（**不 trim**：`chinese.ts` 的注释明确写了不 trim，
而且一 trim 就会把逗号后的空格吃掉、把两个词粘起来）。

## 五、拉丁段：唯一一处刻意的输出分歧

`chinese.ts` 把 Latin run 交给 **espeak**（全大写逐字母拼读）；Rust 交给 **`EnglishG2p`**
（CMU Dict + 拼读规则）。这是阶段 4 已经拍板的取舍，不是本阶段的疏漏——`phonemize_ja`
的 Latin 分支早就是这么做的。

后果：混排文本的**逐字符对照不可能成立**。所以：

- **对照语料里没有拉丁字符**（47 条全是汉字/数字/标点）。生成器注入的 latin phonemizer
  是**抛异常**的，任何一个拉丁字符进来都会让生成失败，而不是静默产出一条没法对照的样本。
- 混排用**结构**断言：`你好ABC世界` 的输出 == `你好` + `ABC` + `世界` 三次调用的拼接。
  这条性质（「run 之间不插入任何东西」）才是必须成立的，而它成立。
- 差异本身被显式记录在 `phonemize-rust.test.ts`（`differs from JavaScript only where the
  Latin engine does`），免得下一个人以为是 bug。

顺带记录一个容易被当成 bug 的细节：CMU Dict 里字母 `A` 的读音是 `ə`，所以 Rust 把 `API`
拼成 `ə pˈiː aɪ`。这是阶段 4 已经用测试钉住的答案（`en_g2p.rs`），不是本阶段引入的。

## 六、对照结果

**语料**：`crates/phonemize/tests/fixtures/zh-frontend-parity.json`，47 条，
由 `tests/unit/models/phonemize/zh-frontend-parity.test.ts` 用**生产的** `ChinesePhonemizer`
生成。两侧都钉在这份语料上（JS 侧检查自己仍然产出 `js`，Rust 侧检查自己产出同样的串），
所以谁也不能单方面漂移。

**结果：46/46 逐字符相同。**

覆盖：数字（整数/小数/百分比/全角/超长/已记录缺口）、标点（逗号→句号、顿号、引号、
会被丢掉的 `-` `/` `%`）、词边界（`人设曾经`、`还书`、`中华人民共和国武汉市长江大桥`）、
空白（空格/多空格/U+3000）、`〇` 与兼容表意文字、kana 被丢弃、空串、两条超长句。

另有**三处独立**的钉法，因为它们失败的原因不同：

1. **语料**（上面那条）——广覆盖；
2. **JS 测试套件自己的期望值**，逐字抄进 `matches_the_javascript_suite_sample_for_sample`
   （P5 spec §3.11.7 的例子 `第 3 季度营收增长了 15.6%。` 等 6 条）。冗余，但可读、有名字，
   而且在语料存在之前就写好了；
3. **跨 wasm 边界**再跑一遍同一份语料（`phonemize-rust.test.ts`）——`cargo test` 证明不了
   「这个 wasm 构建的行为和原生一样」，这一条证明。

## 七、体积

| | 之前 | 之后 | 差 |
|---|---|---|---|
| wasm（wasm-opt 后） | 4,195,046 | **5,081,554** | **+886,508** |
| wasm（gzip） | — | 1,401,472 | |
| 词典资产 | 0 | 1,632,261 | +1,632,261（按需加载） |
| 扩展构建产物 | 55.35 MB | 56.98 MB | +1.63 MB |

计划的预期是「< 1 MB，主要是 jieba 词典」。实际是：**词典不进 wasm**（按需取），
wasm 涨的 886 KB 全是 jieba 的**代码**（含 HMM 模型）。两项相加 2.5 MB，
其中 1.6 MB 是只在中文语音下才付的成本。

阶段 7 接线后预期**下降**：worker 换到 Rust 之后，kuromoji 的 16.9 MB 与 jieba-wasm 的
3.8 MB 都可以从产物里去掉。

## 八、发现一个既有问题：构建体积上限早已失效

`tests/build/build-output.test.ts` 断言产物总大小在 44–50 MB，注释写「Measured 46.8 MB」。
**加上本阶段的 1.63 MB 之后实测 56,983,122 B**，超出上限 7 MB。

算一下就知道**不是本阶段造成的**：

```
56,983,122 − 1,632,261（新词典）− 703（新 NOTICE）= 55,350,158 B = 55.35 MB
```

55.35 MB 与阶段 5 记录里的「pnpm build 产物 55.35 MB」**完全吻合**，也就是本阶段动手前
就已经超了 5.35 MB。主因是 **IPADic 词典 8.11 MB** —— 它落地时这个上限没有跟着动，
而常量上方那段注释的清单里**根本没有提到它**（清单只写了 ONNX 21.6 + kuromoji 17.8 +
jieba 4.0 + worker 2.5 = 45.9，与 46.8 自洽，说明那次测量发生在 IPADic 之前）。

没人发现，是因为 `pnpm test:build` 是**手动**的，而 CI 里没有它（`.github/workflows/` 里
搜不到 `test:build`）。这正是本项目反复记录的那类「假绿」：一个断言只在没人跑的时候失败。

本阶段把上限改成 55–59 MB，并把注释里的清单补成实测值、把「本上限在阶段 6 之前就已失效」
写进去——否则下一个人会以为阶段 6 让产物涨了 7 MB。

## 九、文件清单

**新增**

| 文件 | 内容 |
|---|---|
| `crates/phonemize/src/backends/segmenter_zh.rs` | jieba 分词 + 覆盖率检查 |
| `crates/phonemize/src/backends/numbers_zh.rs` | `numbers.ts` 的移植（四次顺序扫描） |
| `crates/phonemize/src/backends/zh_text.rs` | `chinese.ts` 的文本层（标点/run/保留标点） |
| `crates/phonemize/tests/zh_pipeline.rs` | 中文管道集成测试（9 条） |
| `crates/phonemize/tests/fixtures/zh-frontend-parity.json` | 47 条管道对照语料 |
| `tests/unit/models/phonemize/zh-frontend-parity.test.ts` | 语料生成器 + JS 侧钉子 |
| `scripts/setup-jieba-dict.sh` | 下载/校验/压缩词典资产 |

**修改**

| 文件 | 改动 |
|---|---|
| `crates/phonemize/src/backends/pinyin.rs` | 新增 `han_to_ipa_by_words` + `join_by_words` + `PinyinError::WordBoundaries` |
| `crates/phonemize/src/pipeline.rs` | 新增 `phonemize_zh` + 三个错误变体 |
| `crates/phonemize/src/lib.rs` | `"zh"` 分支、`chinese` 字段、`BackendError` |
| `crates/phonemize/src/dictionary.rs` | `JIEBA_ZH`、`zh` 需要词典 |
| `crates/phonemize/src/text.rs` | `is_js_whitespace` 改为 `pub`（zh 的 keep 需要同一个空白集合） |
| `crates/phonemize/src/backends/mod.rs` | 导出三个新模块 |
| `crates/phonemize/Cargo.toml` | `jieba-rs`（`default-features = false`）+ 理由 |
| `crates/phonemize/tests/{common/mod.rs,dictionary.rs,ja_pipeline.rs}` | zh 的 prepare 流程；`zh` 需要词典；`pipeline-not-implemented` 已无语言可触发 |
| `tests/unit/models/phonemize-rust.test.ts` | 接缝期望值改 `dictionary-not-loaded`；新增跨边界中文对照 |
| `tests/build/build-output.test.ts` | 体积上限按实测重设 + 记录它早已失效 |
| `package.json` | `postinstall` 加 jieba 词典构建 |

## 十、未做

- **v1.1-zh（注音符号前端）**：JS 侧也还没有，属于 P5 阶段 2。`vocab::repair` 的 `ɚ → əɹ`
  分支已经就位，等前端来用它。
- **`zh` 的跨语言边界情形**：kana 落在中文句子里会被丢弃，顺带丢掉两个 Han run 之间的词边界
  （`你好あ世界` 里没有空格，而 `你好世界` 有）。这是两侧**一致**的行为，不是 bug，
  但值得知道——有测试记录。
- **阶段 7 接线**：`RustPhonemizer` 目前仍只被测试引用，worker 还是 JS 链。
  接线时要记得 `prepare('kokoro-v1', 'zh-CN')` 现在会取一个词典。
