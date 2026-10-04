# 阶段 9E：中日文文字规范化（WeText）

**日期**：2026-10-04
**状态**：已完成，未提交
**前置**：9B（英文 TN，vendored WeText）、9A（英文 OOV）、9D（中文变调/儿化）

---

## 一、任务书的三处前提与实测不符

任务书说「英文 WeText TN 已集成，但 `wetext_tn.rs:60` 只构建 `Language::En`；
下载中日文的 FST 并启用」。**接线这件事没问题，但它对现状的描述有三处偏差**：

1. **中文和日文本来就不是「没有数字读法」。** 两者各有一个手写读数器
   （`numbers_to_han` / `numbers_to_kanji`），是阶段 4-6 从 JavaScript 逐字移植的，
   被 parity 语料钉着。9B 明确没删它们（「本阶段只接英文」）。所以这一阶段不是
   「从无到有」，是**换一个读数器**——而换读数器就要回答「旧的什么时候还在用」。
2. **`scripts/setup-wetext-dictionaries.sh` 不存在**，实际是
   `scripts/setup-wetext-fsts.sh`。
3. **没有「启用」这个开关可拨。** vendored 副本的 `Language::{Zh,Ja}` 分支一直都在
   （`tagger`/`verbalizer` 的路径映射、`TokenParser` 的 zh/ja 字段顺序都写好了），
   缺的只有 FST 文件、字典注册和管线参数。

结论：照做，但按实测重新定义验收标准——**旧读数器保留为 fallback，新引擎是默认**。
理由写在 `crates/phonemize/src/backends/wetext_tn.rs` 的模块注释里，与
`ToneRules` 同一个论证：v1.0 音色是按 JavaScript 前端（也就是旧读数器）的输出训练的，
把旧路径彻底删掉，就没有东西可以证明「换之前是什么样」。

---

## 二、交付物

| 类型 | 路径 |
|------|------|
| 资产脚本 | `scripts/setup-wetext-fsts.sh`（1 对 → 6 个文件） |
| 字典注册 | `crates/phonemize/src/dictionary.rs`（+4 个名字） |
| 构造器 | `crates/phonemize/src/backends/wetext_tn.rs`（`chinese` / `japanese`） |
| 管线 | `crates/phonemize/src/pipeline.rs`（`numerals` + 两个新参数） |
| 接线 | `crates/phonemize/src/lib.rs`（两个字段、`build_tn`） |
| 副本修复 | `crates/phonemize/src/backends/wetext/normalizer.rs`（修改 7） |
| 测试 | `tests/wetext_zh.rs`、`tests/wetext_ja.rs`（新）；`dictionary.rs`、`zh_pipeline.rs`、`ja_pipeline.rs`、`common/mod.rs`（改） |

---

## 三、修改 7：`should_normalize` 的数字测试

**这是本阶段唯一一处改到 vendored 副本的地方，也是「不修就不能用」的那一处。**

副本原文：

```rust
if text.chars().any(|c| c.is_ascii_digit()) {
```

上游注释还替它辩护：「Python 的 `\d` 是 Unicode 的，差异到不了英文，路过了就不动」。

**英文那半句是对的，但结论错了**：这一行下面就是 `lang != Language::En` 分支——
英文根本不走这里。所以这个差异**只**能影响中文和日文，而它影响得彻底：

| 语言 | 修前与 Python 参考一致 | 修后 |
|------|----------------------|------|
| 中文（48 条探针） | 45/48 | **47/48** |
| 日文（29 条探针） | 23/29 | **29/29** |

修前不一致的条目**全部**是全角数字（`０１２３`、`２０２２年`、`資産３２億ドル、約４２００億円`…）。
`０` 是 U+FF10，`is_ascii_digit` 认不出，于是整句话拿到「这里没什么可规范化的」提前返回，
原样吐出来。**而且它是静默的**：不跑引擎 = 走手写读数器，而那正好是「没有引擎」时的行为，
所以只看输出的测试分不出「引擎没生效」和「引擎没接线」。

参考实现那边是 `re.search(r"\d", text)`，Python `str` 上的 `\d` 是 **Unicode 类别 Nd**。
Rust 的 `char::is_numeric` 是 `Nd | Nl | No`，**超集**——方向是安全的那一边：
最多让引擎在参考实现会跳过的文本上跑一遍，而跑一遍没有实体可改时返回原文。
反方向才是 bug。

英文侧无法触发这条路径（`lang != En`），所以 9B 到 9E 之间没有任何东西能发现它。

探针脚本（一次性，未提交）：`pip install wetext==0.1.8` 建 venv，用
`wetext.Normalizer(lang=..., operator="tn")` 跑同一批输入，与
`crates/phonemize/src/backends/wetext/` 的 `Normalizer::from_bytes` 逐条对照。
`pip` 包里的 `fsts/` 就是脚本下载的那份 wheel，所以两边跑的是同几个 FST。

**唯一剩下的分歧**：`1.2.3%` → 参考实现 `一点二.百分之三`，本副本 `一.百分之二点三`。
参考实现的前处理是四个链式正则，第二条规则会重扫到第一条已经走过的 `2.3%`；本副本把整串
和 tagger 复合，在第一个点处切开。两边都是对畸形输入的人为切法，而本副本的答案**恰好**是
`numbers_to_han` 的答案——也就是说接线没有改变这条输入。`tests/wetext_zh.rs` 钉着它。

---

## 四、两种语言各自买到了什么

### 中文

44 条探针里 **22 条输出改变**（47 条 parity 语料里 5 条）。明显更好的：

| 输入 | 修前（`numbers_to_han`） | 修后（WeText） |
|------|------------------------|---------------|
| `2024年` | 二千零二十四年 | **二零二四年** |
| `下午3:30` | 三点**:**三十分（冒号留在输出里） | **三点三十分** |
| `$20.50` | 二十点五零（没有「美元」） | **二十点五零美元** |
| `1/2` | 一二 | **二分之一** |
| `1,234个` | 一,二百三十四 | **一千二百三十四个** |
| `电话番号是090-1234-5678` | 九十 千二百三十四 五千六百七十八 | **零九十 一二三四 五六七八** |
| `10,000,000元` | 十,零,零元 | **一千万** |

变差的：

- **`０１２３` → 零一百二十三**（旧：一百二十三）。tagger 把它切成 `math{0}` `math{123}`，
  而不是剥掉前导零。**参考实现给同样的答案**，所以这是文法的性质不是副本的 bug。
- `电话是555-1234` 多了一个「减」（旧读数器什么都不加）。两边都错，新的多一个词。

### 日文

36 条探针里 **8 条改变**，而且 40 条 parity 语料**一条都不变**——
`the_pipeline_matches_the_javascript_one` 仍然全绿。

原因：日文的手写读数器是三个里最好的（单次从左到右扫描 + 有下标的贪婪分数/百分号判断），
`50%` / `15.6%` 本来就是对的。WeText 补的是**分隔符与单位**：

| 输入 | 修前 | 修后 |
|------|------|------|
| `1,234` | いち,にひゃくさんじゅうよん | **千二百三十四** |
| `1/2` | いちに | **二分の一** |
| `2.5km` | にてんご**kˈeɪ ˈɛm**（字母 K、M） | **にてんごキロメートル** |
| `¥1,200` | いち,にひゃく | **千二百円** |
| `090-1234-5678` | 九十・千二百三十四・五千六百七十八 | **ゼロ九ゼロの一二三四の五六七八** |

变差的：

- **`０` → `〇`（U+3007）**，而本 crate 的分段器不认这个码位（不在 CJK 统一表意文字区），
  于是被 `keep_punctuation` 丢掉，整个字读成静音。旧行为是 れい。
  参考实现同样输出 `〇`，所以是文法的性质。`tests/wetext_ja.rs` 钉着。
- `電話は555-1234` 里的连字符被读成「マイナス」——电话号想要的是「の」，
  但旧读数器把两段数字粘成一个大数，并没有更好。

---

## 五、设计：为什么做成 `Option<&Normalizer>` 而不是直接替换

三个管线都长这样：

```rust
let with_numerals = numerals(text, tn, Gate::EngineDecides, numbers_to_han);
```

- `tn` 是 `Option<&WeTextNormalizer>` —— `None` 就是**阶段 6 管线逐字复现**。
- 这不是 hedge：`zh-frontend-parity.json` 是 JavaScript 前端的输出，而 JS 链在阶段 8 删了，
  语料**无法重新生成**。要让它继续当「对照」而不是「一张过期的期望值表」，
  就必须有一条能跑出当年输出的路径。和 `ToneRules::Off` 是同一件事。
- 中文/日文**不需要** `tn_gate`：它们的 `should_normalize` 本身就是数字门控
  （修改 5 的 `lang != En` 分支）。再加一道门只可能是对引擎已经回答的问题给出第二种答案。
  英文需要，因为上游的英文 TN 故意不做数字门控。

两个 parity 测试因此改成对比**两个开关的正交组合**（`zh_pipeline.rs`）：

| 组合 | 含义 | 谁用它 |
|------|------|--------|
| `(Off, None)` | 阶段 6 管线 | `matches_the_javascript_pipeline_on_the_corpus` |
| `(On, None)` | + 变调/儿化 | `the_tone_rules_change_exactly_these_samples` |
| `(On, Some)` | shipped | `the_text_normalizer_changes_exactly_these_samples` |

三张表都**双向断言**：表内的条目必须变且必须等于钉住的值；不表内的条目必须**不变**。
所以「变调改了第三条样本」和「TN 悄悄改了第五条」都会失败，而不是被写进表里。

---

## 六、体积与测试

| | 前 | 后 | Δ |
|---|---|---|---|
| phonemize.wasm | 6,088,746 B | **6,090,205 B** | **+1,459 B**（+0.024%） |
| 资产 | — | +223,092 B | 4 个 FST + 3 份 NOTICE |
| Rust 测试 | 280 | **296** | +16 |
| TS 测试 | 1394 | 1394 | 0 |

wasm 几乎没动是对的：FST **引擎**（`rustfst`，1.01 MB）是 9B 付的钱，
本阶段新增的只有两个 `Option` 字段、一个共享的 `numerals` 函数、一个 Unicode 数字判据。
资产 223 KB（en 707 KB 作对比）是因为中文的基数文法比英文小得多。

`scripts/setup-wetext-fsts.sh` 现在建 6 个文件，幂等性检查覆盖全部 6 个，
每语言一份 NOTICE（`wetext-{en,zh,ja}-tn-NOTICE.txt`）。

---

## 七、未做与已知缺口

- **听感 A/B 没做。** 和 9D 一样：变的是模型训练分布之外的读数（年份、电话号、金额），
  需要真人判断。回滚是 `crates/phonemize/src/lib.rs` 里 `self.chinese_tn` / `self.japanese_tn`
  传 `None`（一行，每个语言各一处）。
- **`0` 前导零**：`０１２３`/`0123` 读成「零一百二十三」。参考实现同样如此。
  如果要修，得在 TN 之前单独处理，而那会偏离参考实现——所以先记录不修。
- **日文 `０` 读成静音**（U+3007 不被分段器认作 Han）。
  可行修法是在 `text.rs::classify` 加 `〇`，但那会同时改变 Chinese 前端的行为
  （`chinese.ts` 的行首 run 正则**包含** `〇`，而 `text.rs` 的 JS 镜像不含），
  属于阶段 6 刻意复现的分歧，不能在这里顺手改。
- **中文 `555-1234` 的「减」**、**日文电话号的「マイナス」**：文法的读法，未修。
