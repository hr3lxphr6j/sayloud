# P6 阶段 9B 评估：wetext-rs / WeTextProcessing

**日期**：2026-10-04
**范围**：计划阶段 9B（任务 9B.1「集成 wetext-rs」）——**只做评估与可行性验证，未改动生产代码**
**计划原文**：`docs/superpowers/plans/P6-FINAL.md` §阶段 9B（第 475 行起）
**结论**：**功能上值得做，但不能当依赖直接用。** 需要 vendor 一个带 3 处改动的 fork，
代价是 **+2.01 MB wasm 代码** + **+0.93 MB 压缩 FST 资产**。已在真实
`wasm32-unknown-unknown` 里跑通并逐字符对齐原生结果（附录 A 可复现）。

---

## 一、结论摘要

任务书假设「加一个 `wetext-rs = "0.1"` 依赖，实现 `WeTextTN`，删掉三个 `numbers*.rs`」。
实测下来这条路径**不成立**，但原因不是任务书担心的那个：wetext-rs 的**输出质量很好**，
真正的阻塞是它在 wasm 里**用不了**、以及它**有一个会让 TN 静默失效的上游缺陷**。

| 维度 | 结论 | 证据 |
|---|---|---|
| 功能正确性 | ✅ **显著优于现状** | §四：英文 8 类 TN 缺口，日文 1 处改进，中文 3 处 |
| wasm 可用性 | ❌ 直接依赖不可用，**需 fork** | §五：`std::fs` API + `getrandom 0.3` 编译失败 |
| 许可证 | ✅ Apache-2.0，栈仍然 100% MIT/Apache-2.0 | §三 |
| 成熟度 | ⚠️ **低**：9 star / 131 下载 / 单版本 / 9 个月无更新 | §三 |
| 上游缺陷 | ❌ **有**，`full_to_half` 顺序错误导致全角数字 TN 静默失效 | §三.3（已复现 + 已定位修法） |
| 体积 | ⚠️ 代码 +2.01 MB，资产 +0.93 MB（**资产走现有字典协议**） | §六 |
| 性能 | ✅ 无数字句子 ~0.001 ms（早退）；含数字 ~2 ms；解析一次 9–52 ms | §七 |
| 对照影响 | ⚠️ 25 条取样中**修完 §3.3 后 21 条相同、4 条不同**，其中 1 条是**与训练目标的分歧** | §八 |

**推荐**：分两步。**先只做英文**（缺口最大、且英文没有对照语料包袱），
中文/日文等 §八的三处分歧拍板后再上。

**未做的事（需要你拍板，见 §十一）**：没有删除 `numbers*.rs`，
没有引入 fork，没有改任何生产代码——因为这三件事都改变了**已发布产品的音素输出**，
而且都需要接受一个自维护的 fork。

---

## 二、评估方法

任务书要求对比三个候选。**实际只有两个**：官方 WeTextProcessing 是
Python + pynini（OpenFST C++ 绑定），没有 C API，也无法编到
`wasm32-unknown-unknown`（pynini/kaldifst 依赖 C++ OpenFST）。任务书里的
「考虑直接用官方 WeTextProcessing 的 C API」这条**不存在**。

所以真正的选择是「wetext-rs」与「继续自研」。但 FST 数据本身可以复用：
Python `wetext` 包（PyPI）里就是官方编译好的 FST 文件，
`wetext-rs` 读的就是同一批。**数据源与实现是两件事**，这一点让评估更有余地。

评估用的是「跑起来看」，不是读文档：

1. 从 PyPI 取 `wetext` 0.1.8 的 wheel，取出真实 FST（`/tmp/wetext-py/w18/wetext/fsts`）。
2. 建原生探针，用 wetext-rs 0.1.2 直接读这批 FST，与现状逐条对比。
3. 建 wasm 探针（patch 过的 fork + wasm-pack），在 Node 里跑同一批输入，
   确认与原生**逐字符相同**。
4. 用**生产的** `phonemize` crate 跑同一批输入，取现状基线。

> **为什么必须「跑起来」**：单看成熟度指标（9 star、131 下载、单版本）会直接
> 判死，而那是错的——它的输出质量远超预期。同样，单看文档会以为
> `embedded-fsts` 特性可用、`Normalizer::new(path)` 能工作，两条都不是真的。

---

## 三、成熟度评估

### 3.1 指标（2026-10-04 实测）

| 项 | 值 |
|---|---|
| GitHub | `SpenserCai/wetext-rs`，**9 star**，最后 push **2025-12-30** |
| crates.io | `wetext-rs` **0.1.2**，**1** 个版本，累计 **131** 下载（近 90 天 58） |
| 源码规模 | ~50 KB，1 个作者，无 CI 徽章 |
| 许可证 | **Apache-2.0** ✅ |
| 依赖 | `rustfst 1`（932K 下载，活跃，MIT/Apache-2.0）、`regex`、`anyhow`、`once_cell`、`unicode-segmentation`、`serde_json` |
| FST 数据 | **不在 crate 里**。来自 PyPI `wetext`（pengzhendong）或 ModelScope，**版本未钉死** |

### 3.2 `embedded-fsts` 是一个空特性（已证实）

`Cargo.toml` 声明了 `embedded-fsts`，README 也提它，但**源码里没有任何引用**：

```
$ grep -rn "embedded" wetext-rs-0.1.2/src/
src/contractions.rs:6://! The contraction rules are embedded at compile time from JSON files
src/contractions.rs:13:/// Contractions data embedded at compile time
```

那两处说的是 contractions JSON，不是 FST。**API 只有文件系统一种**：
`Normalizer::new("path/to/fsts", config)` → `FstTextNormalizer::from_file`。
这直接撞上本 crate 的硬规则（`crates/phonemize/README.md`）：
「**There is no filesystem and no network in here.**」

### 3.3 上游缺陷：`full_to_half` 顺序错误 → 全角数字 TN 静默失效（已复现）

`normalize_with_config` 的顺序是：

```
preprocess   → 只有 traditional_to_simple
should_normalize → 检查「是否含 ASCII 数字」，无数字就不做 TN
tag/reorder/verbalize
postprocess  → full_to_half、remove_interjections、remove_puncts、tag_oov
```

`full_to_half` 在 **postprocess**，即 TN **之后**。于是
`２０２２年`（全角）里没有 ASCII 数字 → `should_normalize` 返回 false →
**整个 TN 被跳过** → 最后才把全角转半角 → 输出 `2022年`（数字没读出来）。

实测量化（日文，11 条）：

| | TN 生效条数 |
|---|---|
| 上游原样 | **6 / 11** |
| 把 `full_to_half` 挪到 `preprocess` 后 | **10 / 11** |

全角数字在日文/中文里极其常见（`１２００円`、`３２億`），所以这是
**会让功能静默失效**的缺陷，且失败时没有任何报错。

**这一条的后果**：不能「先上游用着，有问题再说」。要么接受全角数字不工作，
要么 fork 修它——而一旦 fork 修了行为，就不再是「上游的实现」了。

### 3.4 数据版本未绑定

`wetext-rs` 不带 FST，FST 来自 PyPI `wetext`。crate 是 `0.1.2`，
Python 包已经到 `0.1.8`（5.07 MB wheel），两者之间**布局已经漂移**：
新版 FST 目录里有 `prefix.fst` / `prefix_matcher.fst`，而 wetext-rs 的
文档布局里没有；实测 wetext-rs 也确实不读它们（只用 `tagger` + `verbalizer`）。
**能对上，但是碰巧对上的**，没有任何版本约束保证下次还能对上。

---

## 四、功能实测：现状的缺口是真的

用**生产的** `phonemize` crate 跑（附录 A.4）。下面左边是现状，右边是 WeText。

### 4.1 英文：8 类缺口（这一部分是任务书的动机，实测成立）

| 输入 | 现状输出 | WeText |
|---|---|---|
| `3:30pm` | `θɹˈiː:` + `T H I R T Y P M` 逐字母拼读 | `three thirty PM` |
| `50%` | `fˈɪftiː`（**% 被丢掉**） | `fifty percent` |
| `1st` | `ˈɑnəst`（"onest"，num2words 的产物） | `first` |
| `1/2` | `wˈʌntˈuː`（"one two"） | — |
| `2,000` | `tˈuː,zˈɪɹoʊ`（"two,zero"） | `two thousand` |
| `Dr. Smith` | `dɹˈaɪv smˈɪθ`（**"drive"**） | — |
| `I paid $20.50` | `$twˈɛntiː pˈɔɪnt fˈaɪv zˈɪɹoʊ`（`$` 留在音素里） | `one hundred dollars` 类 |
| `10/4/2024` | `ten four two thousand and twenty four` | `the fourth of october twenty twenty four` |

`3:30pm` 那条尤其说明问题：现状把 `30pm` 当成一个 OOV 英文词，
走**逐字母拼读**回退，念成 "T H I R T Y P M"。

### 4.2 中文 / 日文

| 输入 | 现状 | WeText |
|---|---|---|
| zh `$100` | `$一百`（**美元没读**） | `一百美元` |
| zh `3:30` | `三:三十` | `三点三十分` |
| zh `13800138000` | `一百三十八…`（当数字读） | `幺三八零零幺三八零零零`（电话读法） |
| zh `2024年10月4日` | `二千零二十四年十月四日` | `二零二四年十月四日`（年份逐位，符合中文习惯） |
| ja `2024年10月4日` | `二千二十四年十月四日` | 相同 |
| ja `123` | `百二十三` | 相同 |
| ja `５０％` | `五十パーセント` | 相同 |

即：**中文的缺失比日文大**，日文基本已经在同一水平（仅 `1,234` 一类逗号分隔更好）。

---

## 五、wasm 可行性：作为依赖不可用，但 fork 很小

三个阻塞点，全部已复现并已验证解法。

### 5.1 文件系统 API

`wasm32-unknown-unknown` 没有 `std::fs`。阻塞点只有一个函数。
**关键是 rustfst 的 `SerializableFst::load` 是泛型 `Read`**：

```rust
fn load(input: &mut impl Read) -> Result<Self>
```

所以 `from_file` 换成 `from_bytes` 就是同一段解析、把 `File` 换成 `&[u8]`，
**约 40 行**（含注释）。加上让调用方按相对路径预置 FST 的 `from_bytes` 构造器，
一共约 **60 行**（附录 B）。

### 5.2 `getrandom 0.3` 拒绝编译

```
wetext-rs → rustfst → rand 0.9 → rand_chacha → rand_core → getrandom 0.3.4
error: The wasm32-unknown-unknown targets are not supported by default;
       you may need to enable the "wasm_js" configuration flag.
```

`rand` 是 `rustfst` 的**非可选**依赖（FST 写出用），本地删不掉。
解法是 getrandom 0.3 的文档路径：`--cfg getrandom_backend="wasm_js"` +
直接依赖 `getrandom` 并开 `wasm_js` 特性。已验证**可以用
`.cargo/config.toml` 落地**，不需要在 CI 里配环境变量：

```toml
[target.wasm32-unknown-unknown]
rustflags = ['--cfg', 'getrandom_backend="wasm_js"']
```

> 这是本项目第三次撞上「依赖过不了 wasm 边界」：前两次是 `zstd-sys`
> 的 C 归档（`Cargo.toml` 里 ruzstd 与 jieba 两条长注释）。
> 与前两次不同的是，这次**不需要把 C 弄进来**，只需要一个 cfg。

### 5.3 已验证的 PoC

`wasm-pack build --target nodejs` 在**真实 `wasm32-unknown-unknown`** 里构建成功，
三语言输出与原生**逐字符相同**（附录 A.5）：

```
zh  2024年10月4日 -> 二零二四年十月四日
zh  $100          -> 一百美元
zh  3:30          -> 三点三十分
zh  13800138000   -> 幺三八零零幺三八零零零
en  10/4/2024     -> the fourth of october twenty twenty four
en  $100          -> one hundred dollars
en  3:30pm        -> three thirty PM
en  50%           -> fifty percent
en  1st           -> first
en  2,000         -> two thousand
ja  123           -> 百二十三
ja  50%           -> 五十パーセント
```

**结论：技术上通了。** 阻塞不是「能不能」，是「愿不愿意维护 fork」。

---

## 六、体积成本

### 6.1 代码：+2.01 MB（这是最大的单项代价）

同一输入、同一 `[profile.release]`（`opt-level="z"`, `lto=true`, `codegen-units=1`）：

| | wasm |
|---|---|
| 空壳基线 | 1,197 B |
| 基线 + wetext-rs（可达） | **2,013,373 B** |

即 **+2.01 MB**，几乎全部来自 `rustfst`（crate 自身源码才 ~50 KB）。
作为对照：**现在的 phonemize wasm 是 5,081,554 B**，
所以这是 **+39.6%**。

> spec §2.3 给**整个 wasm**的估算是 ~3 MB。加 2 MB 会把它推到 ~7 MB。
> 需要接受这一点，或者只上英文（仍要付完整的 2 MB，因为 `rustfst` 是全量链接）。

### 6.2 资产：+0.93 MB 压缩（可接受）

TN 只需要 `tagger` + `verbalizer`，**不需要** `prefix*` / `itn`：

| 文件 | 原始 | gzip | **zstd -19** |
|---|---|---|---|
| `en/tn/tagger.fst` | 5,645,674 | 373,067 | 161,322 |
| `en/tn/verbalizer.fst` | 6,398,822 | 849,120 | **545,550** |
| `zh/tn/tagger.fst` | 527,178 | 74,886 | 53,826 |
| `zh/tn/verbalizer.fst` | 1,069,758 | 164,470 | 105,929 |
| `ja/tn/tagger.fst` | 401,870 | 45,459 | 29,657 |
| `ja/tn/verbalizer.fst` | 328,042 | 50,488 | 33,486 |
| `full_to_half.fst` | 15,634 | 1,674 | 956 |
| **合计** | **14,386,978** | — | **930,726** |

**这些应该走现有的字典协议**（§3.2 按语言 `prepare` 时 fetch、wasm 内
ruzstd 解压），不进 wasm 二进制——这正好满足 spec **决策 #4**
（「字典**不编译进 wasm**」）。对照现有资产：jieba 1.63 MB、IPADic 8.51 MB，
所以 0.93 MB 在预算内。

---

## 七、性能（已实测，含一个重要的缓解事实）

在 wasm 里测（Node，附录 A.5）：

| | 解析（每语言一次，prepare 时） | 热路径 |
|---|---|---|
| ja（0.73 MB 原始） | 14.1 ms | **0.001 ms**（无数字）/ 2.14 ms（有数字） |
| zh（1.60 MB 原始） | 8.8 ms | **0.001 ms** / 1.96 ms |
| en（12.04 MB 原始） | 51.5 ms | **0.000 ms** / 2.19 ms |

**缓解事实**：`should_normalize` 只在文本含 **ASCII 数字**时才跑 TN。
绝大多数句子（无数字）走早退，成本 ~0.001 ms——即**基本免费**。
只有含数字/日期/金额的句子付 ~2 ms。

**代价**：相对现状（spec §1.1：中文 0.07 ms、日文 0.16 ms、英文 3.28 ms）
含数字句子的 TN 是 **~2 ms**，对中文是 ~30 倍。绝对量上占合成
（500–750 ms）的 ~0.3%，用户听不出来，但任务书的验收标准
「热路径 < 1 ms」**达不到**（实测 ~2 ms）。
另一个必须在验收里写清的：**首次解析 9–52 ms**，会落在 `prepare()` 上
（en 52 ms 最重），不是首句。

---

## 八、对照影响（blast radius）

**这是最需要拍板的一段。** 整个 P6 的方法论是「Rust 输出必须逐字符等于 JS 输出，
**或有记录的更优**」（spec §5.1，决策 #12）。JS 链已在阶段 8 删除，
所以现在的一致性由**钉死的 fixture** 承载。

取 25 条含数字的输入（中文对照语料 17 条 + 日文测试套件 8 条），
比对「现状的数值展开」与 WeText。**分两次量**，因为第一次量出了 §3.3 的缺陷：

| 配置 | 相同 | 不同 |
|---|---|---|
| 上游原样 | 18 | 7（其中 3 条是 ja 全角数字**完全没做**，§3.3） |
| fork（`full_to_half` 挪到 `preprocess`，ja 开启） | **21** | **4** |

修完之后剩下的 4 条差异：

| 语言 | 输入 | 现状 | WeText | 判断 |
|---|---|---|---|---|
| ja | `1,234` | `一,二百三十四` | `千二百三十四` | ✅ **改进**（现状把逗号读了出来） |
| zh | `1.2.3%` | `一.百分之二点三` | `一点二.百分之三` | ⚠️ 不同，WeText 更合理 |
| zh | `1.2.3` | `一点二.三` | `一.二点三` | ⚠️ 不同 |
| zh | `1,234` | `一,二百三十四` | `一,两百三十四` | ❌ **分歧**（见下） |

注意 ja 是全角数字修好之后才对齐的——**这 3 条差异不是「实现差异」而是
上游的静默失效**，也说明为什么 §3.3 必须先修。

**中文 `两百` vs `二百` 是唯一的实质分歧**：WeText 用「两」，现状（misaki /
pinyin-pro）用「二」。两者口语都成立，但 **Kokoro 是在 misaki 的输出上训练的**，
换引擎就是给模型喂了它没见过的读法。这正是 spec §5.1 说的
「差异要能解释」——这个差异**解释不清**。

另外两个必须处理的契约问题：

1. **`normalize()` 会无条件 `trim()`**（`preprocess` 与 `postprocess` 各一次），
   而中文链**故意不 trim**（`zh_text.rs`：保留 `\s` 且不 trim，靠最后
   一次 `collapse_whitespace` 收尾；对照语料里有 2 条带首尾空白）。
   所以 WeText **不能**直接替换 `numbers_to_han` 那个位置，要么包一层
   保留空白的适配，要么接受契约变更并记录。
2. **`should_normalize` 只看 ASCII 数字**，所以全角/罗马数字走不到 TN——
   除了 §3.3 的全角问题，还有 `1,234` 这类依赖 `full_to_half` 或标签器本身。

**正面**：中文对照语料 47 条里只有 17 条含数字，而
`should_normalize` 对无数字文本**完全早退**，所以那 30 条无数字语料
（以及全部标点/拉丁行为）**不受影响**——风险面比想象的小，且可精确列举。

---

## 九、方案对比

| | wetext-rs + fork | 官方 WeTextProcessing | 继续自研扩充 |
|---|---|---|---|
| wasm 可用 | ✅（需 fork，已验证） | ❌（Python + pynini/C++ OpenFST） | ✅ |
| 语言覆盖 | zh/ja/en 三语言 | 同左（同一批 FST） | 需逐个补 |
| TN 类型 | 10+（数字/日期/时间/金额/电话/序数/分数/百分比/逗号/缩写） | 同左 | 英文目前 8 类缺口 |
| 代码体积 | **+2.01 MB** | — | ~0（规则表） |
| 资产 | +0.93 MB（复用现有字典协议） | 同左 | 0 |
| 维护 | **要维护 fork**（9 star、上游有缺陷、数据未绑定） | 无（不用它） | 自己写规则，可控 |
| 许可证 | Apache-2.0 ✅ | Apache-2.0 | — |

**关于「继续自研」**：现状的 `numbers*.rs` 共 **849 行**
（`numbers.rs` 192 + `numbers_zh.rs` 426 + `numbers_en.rs` 231，
不是任务书说的 ~350 行），英文侧靠 `num2words` crate。
补到 WeText 的覆盖面需要大量规则，且日期/金额/电话的规则很难写对。
**自研要复现 WeText 的效果，工作量远大于 2 MB。** 这是 fork 值得的真实理由。

---

## 十、实施计划（建议两步走）

### 第一步：只做英文（建议先做）

理由：英文缺口最大（§4.1 八类），**且英文没有对照语料**——
`en_g2p.rs` 是按手写期望钉的，改动可见且可控；中文 `两百` 分歧、
日文全角问题都不在第一步里。

1. vendor fork 到 `vendor/wetext-rs/`，pin 到 `0.1.2` + 附录 B 的 3 处改动，
   在 `NOTICE` 记录（与 `piper-plus-g2p` 的 git-pin 先例一致）。
2. `.cargo/config.toml` 加 getrandom cfg。
3. 加 `scripts/setup-wetext-fsts.sh`：从钉死版本的 PyPI wheel 取
   `en/tn/{tagger,verbalizer}.fst`，sha256 校验，zstd 压缩到
   `public/dictionaries/`，写 `-NOTICE.txt`。**复用 jieba/IPADic 的模式。**
4. 字典协议加一类（`WETEXT_EN_TN`），`prepare('kokoro-v1','en-US')` 时取。
5. `backends/wetext_tn.rs`：`Normalizer` 按语言缓存（`thread_local`，
   与 PoC 一致），**解析一次**，返回 `Result`，失败时**回退到原文**
   （任务书 §注意事项 4）。
6. `pipeline.rs`：`numbers_to_english(&normalized)` → `wetext_tn(&normalized, En)`；
   英文段落先把 `num2words` 与新引擎的输出对齐，再删 `numbers_en.rs`。
7. 测试：§4.1 八类各一条 + 早退（无数字不变）+ 失败回退。
8. 体积断言：`tests/build/build-output.test.ts` 的上限要跟着动
   （当前 55–59 MB，wasm +2 MB）。

### 第二步（拍板后）：中文 / 日文

- 先修 §3.3，再决定 §八的 `两百` 分歧（接受并记录，或在 fork 里改回 `二`）。
- 处理 `trim()` 契约。
- 中文需额外决定是否启用 `traditional_to_simple`（+31 KB）。

---

## 十一、待决策（需要你拍板）

> **2026-10-04 实情更新**（后续阶段已给出答案，本节保留作历史记录）：
> 1. ✅ 已决定：**复制源码进仓库直接改**（不依赖 crate、不做 vendor fork）。
> 2. ❌ 实测是 **+1,013,905 B（+19.9%）**，不是 +2.01 MB——那个数是在空壳 app 上量的。
>    见 `p6-9b2-implementation.md` §三.3。
> 3. ✅ 已决定：**不是分歧，不改。** `两百` 就是正确读法；成因（标记首位 2 读「两」，
>    以及逗号被标签器当分隔符）见 `p6-9b5-zh-shortest-path.md`。
> 4. ✅ 已执行：先英文（9B.2 已落地）。中文/日文未接。
>
> 另：§八 把 `123 → one two three` 归因为「引擎级平局」是**错的**——不是平局，
> 是 `rustfst::shortest_path` 在负权文法上返回非最小路径。见 `p6-9b4-shortest-path-bug.md`。

1. **接受一个自维护的 fork？** 上游 9 star、9 个月无更新、有会让 TN
   静默失效的缺陷（§3.3），FST 数据版本未绑定（§3.4）。
2. **接受 +2.01 MB wasm（+39.6%）？** 这是 `rustfst` 的全量链接，
   只做英文也省不掉。
3. **接受中文 `两百` 与训练目标的分歧？**（§八）这是唯一解释不清的差异。
4. **范围**：先英文（推荐），还是三语言一起上？

在第 1 与第 3 条有答案之前，我不建议动 `numbers*.rs`——
删掉它们是不可逆的一步，而它们目前的三语言输出是**已被测试钉住**的。

---

## 附录 A：复现命令

```bash
# A.1 取真实 FST（Python 包就是官方 FST 的分发渠道）
curl -sL https://files.pythonhosted.org/packages/43/fe/ca7ccae2673b64ba7d63612e68b31963e3842dd77fb6aa632270d123d685/wetext-0.1.8-py3-none-any.whl -o w18.whl
unzip -q w18.whl -d w18     # → w18/wetext/fsts/

# A.2 确认 embedded-fsts 是空的
curl -sL https://crates.io/api/v1/crates/wetext-rs/0.1.2/download | tar xz
grep -rn "embedded" wetext-rs-0.1.2/src/     # 只有 contractions 两行注释

# A.3 确认 wasm 编译失败（阻塞点，§5.2）
cargo build --target wasm32-unknown-unknown   # error: wasm32-unknown-unknown targets are not supported

# A.4 现状基线（在 tts-ng 里）
cargo test -p phonemize --test <probe> -- --nocapture

# A.5 PoC（fork + wasm）
wasm-pack build --target nodejs --release
node -e 'const m=require("./pkg/wetext_wasm_poc.js"); console.log(m.normalize("3:30pm","en"))'
```

## 附录 B：fork 的 3 处改动（共约 60 行）

1. `src/text_normalizer.rs`：加 `FstTextNormalizer::from_bytes`
   （`SerializableFst::load(&mut &bytes[..])`）。
2. `src/normalizer.rs`：`FstCache` 加 `preloaded: HashMap<String, FstTextNormalizer>`，
   `get_or_load` 先查它；加公开构造器
   `Normalizer::from_bytes(config, impl IntoIterator<Item=(String, &'static [u8])>)`。
3. `src/normalizer.rs`：把 `full_to_half` 从 `postprocess` 挪到 `preprocess`
   （§3.3，2 处 move，无逻辑改动）。

基线是 crates.io 的 `wetext-rs 0.1.2`（sha256 of the `.crate`：见实施时重算并钉死）。
补丁全文：

```diff
--- a/src/text_normalizer.rs
+++ b/src/text_normalizer.rs
@@ -45,6 +45,19 @@
         Ok(Self { fst })
     }
 
+    /// Load FST from an in-memory OpenFST binary, for targets with no filesystem.
+    ///
+    /// `SerializableFst::load` is generic over `Read`, so this is the same parse
+    /// as [`Self::from_file`] with the `File` swapped for a slice — the only
+    /// difference that matters is that `wasm32-unknown-unknown` has no `File`.
+    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
+        let mut reader = bytes;
+        let fst = VectorFst::<TropicalWeight>::load(&mut reader)
+            .map_err(|e| WeTextError::FstLoadError(e.to_string()))?;
+
+        Ok(Self { fst })
+    }
+
     /// Apply FST for text transformation
     ///
     /// Implementation flow:

--- a/src/normalizer.rs
+++ b/src/normalizer.rs
@@ -15,6 +15,10 @@
 struct FstCache {
     fsts: HashMap<String, FstTextNormalizer>,
+    /// FSTs supplied by the caller as bytes, keyed by the same relative path a
+    /// filesystem build would use. Checked before `fst_dir`, so a target with no
+    /// filesystem never touches it.
+    preloaded: HashMap<String, FstTextNormalizer>,
     fst_dir: PathBuf,
 }
 
@@ -22,11 +26,21 @@
     fn new<P: AsRef<Path>>(fst_dir: P) -> Self {
         Self {
             fsts: HashMap::new(),
+            preloaded: HashMap::new(),
             fst_dir: fst_dir.as_ref().to_path_buf(),
         }
     }
 
+    /// Seed the cache with one FST held in memory.
+    fn preload(&mut self, relative_path: &str, normalizer: FstTextNormalizer) {
+        self.preloaded
+            .insert(relative_path.to_string(), normalizer);
+    }
+
     fn get_or_load(&mut self, relative_path: &str) -> Result<&FstTextNormalizer> {
+        if self.preloaded.contains_key(relative_path) {
+            return Ok(self.preloaded.get(relative_path).unwrap());
+        }
         if !self.fsts.contains_key(relative_path) {
             let full_path = self.fst_dir.join(relative_path);
             let normalizer = FstTextNormalizer::from_file(&full_path)?;
@@ -74,6 +88,22 @@
         Self::new(fst_dir, NormalizerConfig::default())
     }
 
+    /// Create a Normalizer for a target with no filesystem, from FST bytes.
+    ///
+    /// The caller supplies exactly the FSTs the configuration will ask for, under
+    /// the same relative paths a filesystem build uses (`"zh/tn/tagger.fst"`).
+    /// Nothing is read from disk, so this is the constructor a wasm build wants.
+    pub fn from_bytes(
+        config: NormalizerConfig,
+        fsts: impl IntoIterator<Item = (String, &'static [u8])>,
+    ) -> Result<Self> {
+        let mut cache = FstCache::new(".");
+        for (relative_path, bytes) in fsts {
+            cache.preload(&relative_path, FstTextNormalizer::from_bytes(bytes)?);
+        }
+        Ok(Self { config, cache })
+    }
+
     /// Normalize text using the configured settings
     pub fn normalize(&mut self, text: &str) -> Result<String> {
         self.normalize_with_config(text, &self.config.clone())
@@ -203,6 +233,16 @@
 
         if config.traditional_to_simple {
             let fst = self.cache.get_or_load("traditional_to_simple.fst")?;
+            result = fst.normalize(&result)?;
+        }
+
+        // `full_to_half` has to run here and not in `postprocess`. Upstream applies
+        // it after the TN, which is too late: `should_normalize` looks for an
+        // ASCII digit, and ２０２２年 has none, so full-width numerals reached the
+        // tagger unnormalised and passed through untouched. Japanese and Chinese
+        // text is full of them.
+        if config.full_to_half {
+            let fst = self.cache.get_or_load("full_to_half.fst")?;
             result = fst.normalize(&result)?;
         }
 
@@ -213,11 +253,6 @@
     fn postprocess(&mut self, text: &str, config: &NormalizerConfig) -> Result<String> {
         let mut result = text.to_string();
 
-        if config.full_to_half {
-            let fst = self.cache.get_or_load("full_to_half.fst")?;
-            result = fst.normalize(&result)?;
-        }
-
         if config.remove_interjections {
             let fst = self.cache.get_or_load("remove_interjections.fst")?;
             result = fst.normalize(&result)?;
```

PoC 侧的 `.cargo/config.toml`（§5.2）：

```toml
[target.wasm32-unknown-unknown]
rustflags = ['--cfg', 'getrandom_backend="wasm_js"']
```

> PoC 跑在 `/tmp`（`/tmp/wetext-fork`、`/tmp/wetext-wasm-poc`），**不是仓库里的文件**。
> 上面的 diff 是唯一被保留的副本；重做时按 A.1 取 FST、按本附录打补丁即可。
