# P6 阶段 9B.2 实施记录：英文 WeText TN 集成

**日期**：2026-10-04
**范围**：把 `wetext-rs` 0.1.2 源码复制进仓库，改成 wasm 友好版本，接进英文 TN
**前置**：`p6-wetext-evaluation.md`（9B.1 评估）、`p6-9b-decision.md`（方案 A 第一步：只做英文）
**结论**：**集成完成并全部验证通过**（Rust 187 测试 / TS 1394 测试 / wasm 构建 / 构建体积断言）。
但实施过程中量出**评估报告的三处错误**，其中一处改变结论，见 §三。

---

## 一、做了什么

### 1. 复制源码（不是依赖）

`crates/phonemize/src/backends/wetext/` ← `wetext-rs` 0.1.2（`/tmp/wetext-fork`，PoC 时已打过补丁）：

```
mod.rs  config.rs  contractions.rs  error.rs  normalizer.rs
text_normalizer.rs  token_parser.rs  data/*.json
NOTICE  README.md  LICENSE-Apache-2.0
```

共 5 处改动（`NOTICE` 逐条记录）：

| # | 改动 | 为什么 |
|---|---|---|
| 1 | 删 `from_file`，加 `from_bytes` | `SerializableFst::load` 本来就吃 `&[u8]`；`wasm32-unknown-unknown` 没有文件可读 |
| 2 | 删 `FstCache` / `get_or_load` / `new(path)` / `with_defaults` / 自由函数 `normalize`；`normalize` 改收 `&self` | 全部 FST 一次性预置，没有惰性加载；没有可变状态就不需要 `&mut` |
| 3 | `full_to_half` 从 `postprocess` 挪到 `preprocess` | 上游缺陷：`２０２２年` 里没有 ASCII 数字，TN 整个被跳过且无声 |
| 4 | 三个 `include_str!` 路径与 `use` 路径改模块相对 | 文件搬到了 `backends/wetext/` |
| 5 | **`should_normalize` 恢复 `lang` 参数** | **新发现的上游移植缺陷，见 §三.1** |

另：`error.rs` 删掉 `IoError(#[from] io::Error)`（只为被删掉的 `std::fs` 构造器存在）。

### 2. 依赖

`Cargo.toml`：`rustfst = "1"`（**默认特性必须保留**，见 §五）、`thiserror = "2"`、`regex`/`once_cell`/`serde_json`（contractions 用，默认关闭但保留）。
新增 `.cargo/config.toml`：`getrandom_backend="wasm_js"` + `[target.'cfg(target_arch = "wasm32")'.dependencies] getrandom`。

### 3. 字典协议

`dictionary.rs` 加两个名字（**两个，不是一个压缩包**：registry 的单位是一个 zstd frame，且 tagger 少了 verbalizer 只能用失败）：

```
WETEXT_EN_TN_TAGGER     = "wetext-en-tn-tagger"     161,322 B
WETEXT_EN_TN_VERBALIZER = "wetext-en-tn-verbalizer" 545,550 B
```

`dictionaries_for("en")` 从 `Some(&[])` 改成这两个 —— 这是**行为变更**：`prepare('kokoro-v1','en-US')` 现在要取 707 KB。

`scripts/setup-wetext-fsts.sh`：PyPI `wetext` 0.1.8 wheel（sha256 钉死 `b2083e7f…15454`）→ 抽 `en/tn/{tagger,verbalizer}.fst` → `zstd -19` → `public/dictionaries/`，写 `wetext-en-tn-NOTICE.txt`。与 jieba/IPADic 同一套模式，接进 `postinstall`。

### 4. 接线

- `backends/wetext_tn.rs`：`english(tagger, verbalizer) -> Result<Normalizer, WeTextError>`。
- `lib.rs`：`Phonemizer` 加 `english_tn: Option<WeTextNormalizer>` 字段，`finish_loading` → `build_backends` 里构建（两个 FST 都在才建）；`PhonemizeError` 加 `BackendError::EnglishTn`。
- `pipeline.rs`：`phonemize_en(text, english, tn)`，数字那一步 `tn.normalize(..)`，失败或没准备时落回 `numbers_to_english`。

**没用 `thread_local`**（评估 §10.5 的建议）：`Normalizer` 改成 `&self` 之后它就是普通字段，随 `Phonemizer` 走。`thread_local` 会让同一线程上两个 `Phonemizer` 共享状态 —— 正是 `cargo test --test-threads=1` 的形状。

### 5. 没有做的事

| 任务书要求 | 实际 | 为什么 |
|---|---|---|
| 删 `numbers.rs` / `numbers_zh.rs` / `numbers_en.rs`（-849 行） | **一个都没删** | 阶段 9B 只有英文接了 TN。删 zh/ja 的两个 = 中日文数字直接读不出来，且没有任何替代；评估 §十一 已写"不建议动"。`numbers_en.rs` 留着是因为 §三.2 |
| `PhonemizePipeline` / `phonemize(&mut self, text, lang)` | 不存在那样的结构 | `pipeline.rs` 是三个纯函数，`Phonemizer` 是入口。照任务书写会写出编译不过的代码 |
| `from_bytes(config, impl IntoIterator<Item=(String, &'static [u8])>)` | `&'a [u8]` | 字节只在解析时借用，`VectorFst` 自己拥有状态；`&'static` 会让 registry 的借用活不过函数 |
| `log::warn!` | 没有 | 这个 crate 没有 `log` 依赖，也没有日志；失败回退写在文档和注释里 |
| `include_bytes!` FST（任务书任务 6.3） | 走字典协议 | 12 MB 原始 FST，`include_bytes!` 要占满整个 wasm；评估 §六.2 和 spec 决策 #4 都是这个结论 |

---

## 二、验证证据

| 命令 | 结果 |
|---|---|
| `cargo test --workspace` | **187 passed**（170 → 187：`wetext_en.rs` 6 条 + 复制进来的模块自带 11 条） |
| `cargo clippy --workspace --all-targets` | 0 warning |
| `cargo fmt --all` | clean |
| `pnpm build:wasm` | 成功（getrandom cfg 生效，rustfst 连进来了） |
| `pnpm typecheck` / `pnpm lint` | clean（191 文件） |
| `pnpm test` | **1394 passed / 65 files** |
| `pnpm test:build` | 13 passed |
| `pnpm test:performance` | 6 passed（界限已按新测量更新） |
| `pnpm check:manifest` | passed |

wasm 里跑通（不是只有原生）：`wasm-pack --target nodejs` + Node，走完整 `required_dictionaries` → `load_dictionary` → `finish_loading`：

```
required: [ 'wetext-en-tn-tagger', 'wetext-en-tn-verbalizer' ]
decompress: 24 ms / parse (finish_loading): 70 ms
"3:30pm"       -> "θɹˈiː θˈɜːdiː pˈiː ˈɛm"
"50%"          -> "fˈɪftiː pɚsˈɛnt"
"1st"          -> "fˈɜːst"
"2,000"        -> "tˈuː θˈaʊzənd"
"10/4/2024"    -> "ðə fˈɔːɹθ ʌv ɑktˈoʊbɚ twˈɛntiː twˈɛntiː fˈɔːɹ"
"I paid $20.50"-> "aɪ pˈeɪd twˈɛntiː pˈɔɪnt fˈaɪv dˈɑlɚz"
"Dr. Smith"    -> "dˈɑktɚ smˈɪθ"
"123"          -> "wˈʌn tˈuː θɹˈiː"
```

---

## 三、评估报告错了三处（一处改变结论）

### 3.1 `should_normalize` 丢了 `lang` 参数（已修，改动 #5）

Python 参考实现：

```python
if operator == "tn" and lang != "en":
    if re.search(r"\d", text): return True
    ... return False
return len(text) > 0        # ← 英文 TN 不做数字门禁
```

Rust 移植里 `lang` 参数没了，于是英文**没有数字就整个跳过 TN**。后果是英文 TN 里**不涉及数字的那一半完全不工作**：

| 输入 | Python `wetext` 0.1.8 | 移植原样 | 修好后 |
|---|---|---|---|
| `Dr. Smith` | `doctor Smith` | `Dr. Smith` | `doctor Smith` ✅ |
| `Mr. Jones` | `Mister Jones` | `Mr. Jones` | `Mister Jones` ✅ |

**评估 §4.1 的表格里 `Dr. Smith` 那行写的是「WeText: —」，即没测。** 测了就会看到。

修法与参考实现一致（把 `lang` 传回去）。41 条探针里，修前 34 条与参考一致，修后 34 条一致、且剩下的差异全部收敛到 §3.2 那一类。

### 3.2 引擎级平局：`rustfst` 与 `kaldifst` 不是同一个答案（**未修，这是结论性的**）

裸数字串在英文文法里有**多条等代价路径**，走哪条由 FST 引擎的平局消解决定。Python 自己就写着这件事（`wetext/fst_utils.py`：*"OpenFst/Pynini breaks equal-weight paths lexicographically, while kaldifst's one-best tie depends on state order"*），`normalize_candidates` 把平局列出来而不消解。`rustfst` 又是另一种消解：

| 输入 | Python 参考 | 本项目 | 两者代价 |
|---|---|---|---|
| `123` | `one hundred and twenty three` | `one two three` | 1.000 / 1.000 |
| `100` | `one hundred` | `one oh oh` | 1.000 / 1.000 |
| `1,234` | `thousand two hundred and thirty four` | `one two three four` | 1.000 / 1.000 |
| `1,500 people` | `thousand five hundred people` | `one five zero zero people` | 101.000 / 101.000 |
| `250 km` | `two hundred and fifty kilometers` | `two hundred fifty kilometers` | 1.000 / 1.000 |
| `1000` | `ten hundred` | `ten hundred` | 0.990 / 0.990 |

**两边都有错**：参考实现把 `1000` 读成 `ten hundred`、把 `1,234` 的 `one` 吃掉。**结论：这个文法不是数字阅读器**，它是给实体（时间/日期/金额/百分比/序数/分数/单位/缩写）用的；裸整数是它的弱项，且弱的方式不由我们决定。

对现状的净影响（英文 `phonemize_en` 的数字那一步）：

- **变好**：`3:30pm`、`50%`、`1st`、`1/2`、`2,000`、`10/4/2024`、`$20.50`、`Dr. Smith`、`250 km` —— 8 类缺口。
- **变差**：裸整数。`num2words` 给 `123` → `one hundred twenty three`，引擎给 `one two three`。

代码里两半都钉住了测试（`tests/wetext_en.rs`），注释写明这是**已知弱点而不是复制缺陷**，并写清退路（按 tagger 的实体名分流，而不是再写一张规则表）。

### 3.3 体积与性能的数字都不对

| | 评估 | 实测（release wasm，同一 profile，改动前/后各构建一次） |
|---|---|---|
| wasm 代码 | +2.01 MB | **+1,013,905 B**（5,081,554 → 6,095,459，+19.9%） |
| 无数字热路径 | ~0.001 ms（早退） | **0.54 ms**（`hello world`）；3.54 ms（68 字符句） |
| 首次解析 | 9–52 ms | 24 ms 解压 + **70 ms 解析**（`prepare` 上，一次） |

- `+2.01 MB` 是在**空壳 app** 上量的，那个链接进来的 `rustfst` 比本 crate 实际可达的多。真实数字是 +0.97 MiB。
- `~0.001 ms` 是 §3.1 那个 bug 的副产品：门禁被跳过，所以"没数字就免费"。参考实现**每条英文都跑 TN**，早退不存在。真实成本 0.5–3.5 ms/句，约占合成（500–750 ms）的 0.5%，但**"热路径 < 1 ms"这个验收标准达不到**。

### 3.4 小错：附录 B 的理由写错了（不影响结论）

评估附录 B 说 `SerializableFst::load` 是泛型 `Read`、所以 `from_bytes` 是“把 `File` 换成切片”。实际签名是
`fn load(input: &[u8]) -> Result<Self>`（rustfst 1.3.1），上游的 `from_file` 是 `read` 先读文件再调它。
所以 `from_bytes` 是**去掉读文件那一步**，不是换 reader —— 结论一样（能编），理由不同。
复制进来的 `text_normalizer.rs` / `NOTICE` 按实际签名写。

另：附录 B 说 PoC 的 fork“移除了 `std::fs` API”，实际那三个阻塞点里只有 `getrandom` 是真需要 cfg 的，
`from_file` 在 `wasm32-unknown-unknown` 上**能编过**（`std::fs` 在 std 里有存根，只是运行时不可用）。
本项目的复制版删掉它是因为 crate 规则（“这里没有文件系统”），不是因为编不过。

---

## 四、顺带发现的既有问题：构建体积上限又失效了

`tests/build/build-output.test.ts` 的上限 38–42 MB，实测 **44,414,626 B（42.36 MiB）**。其中本阶段只占 1,721,687 B（wasm 1,013,905 + 资产 706,872 + NOTICE 910）；**其余 2.79 MB 是 `scripts/setup-headtts-dict.sh` 落的 HeadTTS 词典，它没进上方清单** —— 和阶段 6 IPADic 那次一模一样的漏法（清单里 21.6+17.8+4.0+2.5=45.9 与"46.8"自洽，说明那次测量早于 IPADic）。

**也就是说动手前就已经超上限 0.7 MB。** 已改成 43–46 MB，并把 HeadTTS 补进清单、把"谁往 `public/` 放资产谁负责挪这个数"写进注释。没人发现的理由还是老的：`pnpm test:build` 是手动的、CI 不跑它。

---

## 五、需要拍板的

1. **英文管线用哪一半读裸整数？** 现状是引擎（`123` → `one two three`），备选是按 tagger 的实体名分流（实体走引擎、裸数字走 `num2words`）；实现约 30 行，但要先把 tagger 的 token 名暴露出来。**目前英文管线生产环境不走**（README：English 由 kokoro-js 的 espeak 负责），所以这个决定不紧急，但它是 §3.2 的唯一出口。
2. **热路径 3.5 ms/句能不能接受？** 对英文管线而言它比原来慢 96 倍；合成是 500–750 ms，所以 0.5%。若不能接受，唯一办法是只对含实体的句子跑 TN —— 那也是第 1 条的同一个门。
3. **`rustfst` 默认特性必须保留**（`state-label-u32`）：关掉会改 `Label` 类型，而复制进来的代码把 label 当 UTF-8 字节用（`label as u8`）。`Cargo.toml` 里写清楚了，别当成"tidiness 改进"。
4. 中文/日文（9B 第二步）仍未动：`两百` vs `二百`、`trim` 契约、全角数字 —— 加上本次的 §3.2（中文 `123` → `幺二三`，参考实现也是这样，所以中文的裸数字问题是**共有的**，不是移植差异）。

---

## 六、复现

```bash
# 资产（PyPI wheel，sha256 钉死）
./scripts/setup-wetext-fsts.sh

# Rust
cargo test --workspace && cargo clippy --workspace --all-targets

# wasm（getrandom cfg 生效的证明）
pnpm build:wasm && pnpm typecheck && pnpm lint && pnpm test

# 体积
pnpm test:build

# 与 Python 参考实现对照（需要 pip install wetext==0.1.8），见 §3.2 的表格
```

原生/wasm 输出逐字符相同：`tests/wetext_en.rs` 与 `pnpm test:performance` 两处都跑同一批输入。
