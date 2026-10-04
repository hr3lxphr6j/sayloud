# P6 阶段 9B.3：WeText FST 结构考察 —— 门控与自行改造可行性

**日期**：2026-10-04
**问题**：（1）WeText 处理的是"Dr."这类缩写和数字，能不能用便宜的正则做门控？
（2）FST 是什么结构，我们能自己改造、添加规则吗？
**方法**：全部实测。加载真实的 shipped FST，跑 compose，按状态挂规则扫描，对比输入输出。
**结论**：门控**可行**（宽正则召回 15/16，误报 2/18）；FST **可以读写和改动**，
但 **tagger 不能用二进制手术加规则**（挂遍 14,110 个状态只有 start 生效，且只在句首），
所以加词要 **从源码重建**（whitelist 是一张 3,050 行的 TSV）。

---

## 一、两个 FST 的结构

都是 OpenFST 二进制、`TropicalWeight`、`VectorFst`，**标签是单个 UTF-8 字节**
（`input.as_bytes().iter().map(|&b| b as Label)`，见 `wetext/text_normalizer.rs`）。

| | `en/tn/tagger.fst` | `en/tn/verbalizer.fst` |
|---|---|---|
| 文件 | 5,645,674 B | 6,398,822 B |
| 状态 | **14,110** | **157,163** |
| 转移 | **342,268** | 282,050 |
| 终态 | **4** | 8 |
| start | 0（**入度 0**） | 0 |
| 最大出度 | 185 | 216 |
| 平均出度 | **24.26** | 1.79 |
| 不同标签 | 243（可打印 ASCII 95），范围 0..=244 | 同 |
| ε-转移 | **3,143** | — |
| 最忙状态 | 2059（入度 **41,951**） | — |

tagger 是稠密的（平均出度 24，几乎是个字典树/DAWG），verbalizer 是稀疏的（1.79，近乎线性链）。
两者都有 ε-转移，所以构造是「若干规则 FST union 起来再 optimize」，不是手写状态机。

### 输出的 token 格式

tagger 的输出是**语义类框架文本**，这是整条管线真正的接口：

```
Dr. Smith    -> whitelist { name: "Dr." } w { v: "Smith" }
3:30pm       -> time { hours: "3" minutes: "30" suffix: "pm" }
50%          -> measure { integer: "50" units: "%" }
1st          -> ordinal { integer: "1st" }
1/2          -> fraction { numerator: "1" denominator: "2" }
2,000        -> cardinal { integer: "2,000" }
10/4/2024    -> date { month: "10" day: "4" year: "2024" }
$20.50       -> money { currency_maj: "$" integer_part: "20" fractional_part: "50" }
555-1234     -> range { value: "555-1234" }
hello        -> w { v: "hello" }
,            -> p { v: "," }
```

类名清单（英语，来自 `tn/english/normalizer.py` 的 `RuleSpec` 表）：
`cardinal` `ordinal` `decimal` `fraction` `time` `measure` `money` `telephone`
`electronic` `serial` `whitelist` `range` `date`，加两个透传类 `w`（词）、`p`（标点）。
`w` 的权重是 **100**（兜底），其余是 0.99–1.01。

---

## 二、门控：能，而且值得

### 实测：TN 对哪些文本是空操作

21 条句子里，TN **改变**了 15 条、**原样返回** 6 条。
「原样返回」的 6 条都含标点（tagger 给 `p`），`p` 是透传的——**标点不构成需要 TN 的理由**。

### 两个候选门控

| 门控 | 召回（该改变的） | 误报（不该改变的） |
|---|---|---|
| A：`/\d/` | **10 / 16** | 0 / 18 |
| B：`\d` ∨ email/URL ∨ 符号集 ∨ 缩写形 ∨ 2+ 连续大写 | **15 / 16** | **2 / 18** |

A 漏掉的全是**无数字**的类：`whitelist`（`Dr.` `Mr.` `Acme Inc. & Co.` `U.S.A.`）
和 `electronic`（`foo@bar.com`、`https://example.com`）。
B 只漏了 `U.S.A.`（正则里那条缩写形匹配没覆盖到，属于可修的细节）。

**误报是免费的**（最多白跑一次 TN），所以门控应当保守——B 这种宽口径是对的。
代价是普通散文里约 11% 的句子会白跑。

### 成本：门控省下的不是恒定的

release native，同一批输入：

| | 每句 |
|---|---|
| 11 字符、无数字 | **0.47 ms** |
| 71 字符、无数字 | **3.27 ms** |
| 710 字符、无数字 | **32.4 ms** |
| 56 字符、有数字 | 3.33 ms |

**成本与长度近似线性，约 4.6 ms / 100 字符**（release wasm 里 0.54–3.54 ms/句，
量级一致）。所以对长文本门控不是锦上添花：一段 5,000 字的英文 ≈ 230 ms。

注意：无数字的句子**并不会自动早退**——`should_normalize` 对英文不做数字门禁
（那是 9B.2 修的上游缺陷）。所以今天每条英文都真跑 FST，门控是唯一能省的地方。

---

## 三、FST 能不能自己改造：能读能写，但加规则有硬障碍

### 3.1 读写：可以，几乎无损

`rustfst` 能 `load` 也能 `write` 这两个 FST。往返一次：
**14,110 状态、5,645,674 字节，完全一致，只有 3 个字节不同**（偏移 58–60，
是头部里一个原本留 0 的转移计数，序列化时被填上了）。语法本身逐位相同。

### 3.2 union：可以，规则也确实生效——但只在句首

把 `Kokoro → whitelist { name: "Kokoro" }` 用 `union` 并进去，写回、重载，
**单独输入 `Kokoro` 时规则正确触发**。进了句子就不行：

| 输入 | 扩展后 tagger 输出 |
|---|---|
| `Kokoro` | `whitelist { name: "Kokoro" }` ✅ |
| `Kokoro is a model.` | `whitelist { name: "Kokoro" } w { v: "is" } …` ✅（加了回边，见下） |
| `the Kokoro model` | `w { v: "the" } w { v: "Kokoro" } w { v: "model" }` ❌ |
| `I use ChatGPT and Nginx daily.` | 全是 `w` ❌ |

原因：手工搭的规则**终态是死的**，匹配完 `Kokoro` 就吞不下后面的 ` is a model.`，
所以整条路径作废，只能退回 `w` 规则。

### 3.3 死掉的终态可以救回来，但只对句首有效

把规则改成「从 start 进 → 匹配 → 输出**带尾随分隔符**的完整 token → ε 回 start」，
句首那次就对了（`whitelist { name: "Kokoro" } w { v: "is" } …`，
注意 token 之间的分隔符是**一个空格**，漏了它标签器就接不上）。

但这只解决句首。**挂遍全部 14,110 个状态**，看哪里的规则能同时在三个探针
（词在句首 / 句中 / 句末）生效：

```
states where a hung rule fires (of 14110): 1
  state 0      score 1  start=1 mid=0 mid2=0
```

**只有 start 状态，而且只有词在句首时。** 换句话说：tagger 在 optimize 之后，
「一个 token 结束之后」**不是一个共享状态**——它是上下文相关的，
所以没有地方能挂一条「任何位置都生效」的新规则。

### 3.4 verbalizer 反而可以

verbalizer 的输入是规整的 token 流，结构简单得多。同样挂规则扫描：

```
states whose hung rule produces a full correct reading: 2
  state 671: "I sawkoh koh roh  today"
  state 673: "I saw koh koh roh today"        ← 正确
```

**state 673**（157,163 个状态里）能给出正确的句中读法。
前提是规则要写成「匹配 token + 尾随空格、输出读法 + 尾随空格、ε 回该状态」——
少一个空格就变 `<no match>`。

代价：这个状态号是**这一份 FST 构建的产物**，重建 FST 就会变，
所以它不是可以写死在代码里的东西，得在构建时搜索出来。

### 3.5 所以「加词」的正确做法是从源码重建

`WeTextProcessing` 里 whitelist 本来就是**数据**，不是代码：

```
tn/english/data/whitelist/tts.tsv           3,050 行
tn/english/data/whitelist/alternatives.tsv     21 行
tn/english/data/whitelist/symbol.tsv           23 行
tn/english/data/address/state.tsv              （州名缩写）
tn/english/data/{date,time,money,measure,…}/
```

`tn/english/rules/whitelist.py` 用 `pynini.string_map(load_labels(...))` 把 TSV 读成图。
所以**加一个词 = 加一行 TSV + 重建 FST**。重建需要 Python + `pynini`
（PyPI 上有 2.1.7），是构建期一次性动作，产物照现有字典协议提交/分发。

这条路同时解决三件事：加词、修上游 `full_to_half` 的顺序缺陷、修 `should_normalize`
的门禁——都在源码层面，不用碰二进制。

---

## 四、给这一阶段的建议

1. **门控值得做**，用宽口径（数字 ∨ email/URL ∨ 符号 ∨ 缩写形 ∨ 连续大写）。
   收益是长文本省下线性增长的时间；代价只是散文里约 11% 白跑。
   *但*它只解决速度，不解决 9B.2 的 `123 → one two three`。

2. **不要做 FST 二进制手术**。读、写、union 都能跑通，但 tagger 加规则在句中不生效
   （§3.3），这是结构性的、不是手法问题。

3. **要加词汇或修缺陷，从源码重建**：`pynini` + `WeTextProcessing` 的 TSV，
   构建期做，产物提交。这条路可复现、可审计，且不依赖 magic state number。

4. **品牌名发音不是 TN 的活**。whitelist 只能把词映射成**别的词**，
   最终的读音由英文 G2P（HeadTTS / L2S 规则）决定。
   要控制 `Kokoro` 怎么念，该进的是 G2P 的词典，不是 TN 的 FST。

---

## 附录：复现

```bash
# 1. 取 FST
zstd -d public/dictionaries/wetext-en-tn-tagger.bin.zst -o /tmp/tagger.fst
zstd -d public/dictionaries/wetext-en-tn-verbalizer.bin.zst -o /tmp/verbalizer.fst

# 2. 结构统计 / union / 挂规则扫描：见本文件 §一、§3.3 的探针
#    （探针在 /tmp/fstprobe，用 rustfst 1.3.1；生产代码不含它们）

# 3. 上游源码（whitelist 是数据）
git clone --depth 1 https://github.com/wenet-e2e/WeTextProcessing /tmp/WeTextProcessing
ls /tmp/WeTextProcessing/tn/english/data/whitelist/

# 4. 重建路线（构建期）
pip install pynini        # 2.1.7
```

---

## 五、门控放在哪一层：先看钱花在哪

决定前先量了一次「tagger 和 verbalizer 各占多少」（release native，同批输入）：

| 用例 | tagger | verbalizer | 合计 | verbalizer 占比 |
|---|---|---|---|---|
| 45 ch、无实体 | 2.346 ms | 0.170 ms | 2.162 ms | **7%** |
| 71 ch、无实体 | 3.530 ms | 0.292 ms | 3.623 ms | **8%** |
| 56 ch、有实体 | 2.474 ms | 0.036 ms | 2.844 ms | **1%** |
| 710 ch、无实体 | 33.391 ms | 2.777 ms | 33.352 ms | **8%** |

**tagger 占 92%。** 而且 18 条普通/含实体句子里 **15 条 tagger 只输出 `w`/`p`**（即无事可做）。

这两条合起来把设计锁死了：

- **「先跑 tagger，再按类分流」在速度上一无所获**——省下的只有那 8%。
- **要让门控有意义，它必须在 tagger 之前。**
- tagger 的成本是「把文本按字节走一遍 342k 转移的自动机」，46 µs/字符。
  任何以 FST 形式坐在前面的门控仍然要做一次 compose，和 regex 扫一遍字符类是几个数量级的差别。

### 所以：两层，各管各的问题

**第一层（regex，在 tagger 之前）——「这里可能有活干吗？」**

纯性能快路径，必须是**可靠的过近似**：说「跳过」时绝不能漏掉 TN 本来会改的东西；
误报只代价一次白跑。控制在数字 ∨ 符号集 ∨ 缩写形 ∨ 连续大写 ∨ email/URL。
收益：普通散文里约 83% 的句子（实测 15/18）直接跳过全部 TN，
710 字符那档从 33 ms 降到大约 5.6 ms 均值。

**第二层（Rust，按 tagger 输出的类名分流）——「这段数字该用哪个读法？」**

`123 → one two three` 那个问题的出口。这里**不能用 regex**：类名是文法用权重和
多条规则编码出来的东西（`cardinal` / `time` / `money` / `date` / …），
用正则重写一遍等于手工重新推导那 13 个类，而且会和文法各自演化。
tagger 的输出本来就是 ground truth，直接读它。

两层不冲突：第一层回答「要不要进场」，第二层回答「进场后怎么走」。

### 为什么不是「放进 tagger」

1. **tagger 就是成本本身**（92%），门控进去就白做。
2. 单独造一个小的门控 FST 也绕不过 compose 的开销，比 regex 慢几个数量级，
   而且要多一份要构建、验证、分发、版本化的 FST。
3. §3.3 已经证明**没法往 tagger 里加规则**——真要动那一层，
   只能从源码重建（`pynini` + TSV），那是「修文法」，不是「加门控」。

### 第一层必须配一条不变量测试

regex 是第二份「什么样的文本需要规范化」的定义，这会漂移。所以锁住它：

```
gate 说 false  ⇒  tagger 的输出只有 w / p
```

这条对语料可测。漂移一旦发生，测试红，而不是线上静默退化。
这也是允许第一层存在的前提——它是个**快路径过滤器**，不是语义权威。
