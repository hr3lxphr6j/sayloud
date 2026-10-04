# P6 阶段 9B.4：`123 → one two three` 的真正原因 —— 不是数据，是消费者

**日期**：2026-10-04
**问题**：fork WeText 的数据文件（TSV，用 `csv.reader` 以 `\t` 分隔读）加条目、重新编译，
能不能修掉 `123 → one two three`？
**结论**：**不能，而且不需要。编译好的文法里那个正确读法已经存在，而且已经是最便宜的路径。
坏的是消费者：`rustfst::shortest_path` 在这个文法上返回了**非最小**的路径。**
修法是在我们复制进来的 Rust 代码里换掉抽取那一步（约 40 行），不是改数据。

---

## 一、文法里本来就有什么

拿编译好的 `en/tn/verbalizer.fst`，compose 输入 `cardinal { integer: "123" }`，
把**全部**路径连权重列出来：

```
      权重        读法
   0.000000  "one hundred and twenty three"   ← 最便宜
   0.000100  "one twenty three"
   0.000100  "a hundred and twenty three"
   0.000110  "one hundred twenty three"
   0.000200  "one two three"                  ← 我们实际拿到的
   0.000210  "a hundred twenty three"
   1.000200  "one two three"
```

**正确读法在，而且是最便宜的。** 上游源码也对得上：`cardinal.py` 里
`long_numbers = graph_with_and | pynutil.add_weight(self.single_digits_graph, 0.0001)`
——逐位读法是**更贵**的那条，`add_optional_and` 甚至用 `-0.0001` 让带 `and` 的英式读法更便宜。

**所以加 TSV 条目没有意义**：条目控制的是「有哪些路径」，而这里路径已经齐了；
出问题的是「选哪条」。改数据只能增删路径，改变不了选择算法。

## 二、是选择算法错了

用两种独立方法算同一张 compose 结果的最小值：

| 输入 | `rustfst::shortest_path` | Bellman-Ford（能处理负权） | 独立 Dijkstra |
|---|---|---|---|
| `123` | 0.000200 `one two three` | **0.000000 `one hundred and twenty three`** | 同 |
| `100` | 0.000200 `one oh oh` | **0.000110 `one hundred`** | 同 |
| `1000` | 0.000200 `one oh oh oh` | **0.000010 `thousand`** | 同 |
| `1000000` | 0.000200 `one oh oh oh oh oh oh` | **0.000110 `one million`** | 同 |
| `2,000` | 0.000110 `two thousand` | 0.000110 `two thousand` | 同 ✅ |
| `42` | 0.000110 `forty two` | 0.000110 `forty two` | 同 ✅ |

6 条里 4 条不一致，且不一致的都是**错的那一边更贵**。
Bellman-Ford 已确认收敛（无负环）。

**根因**：这个文法带**负的弧权重**（composed FST 里实测 min = `-0.0001`）。
上游到处用 `pynutil.add_weight(..., -0.0001)` 来排序候选读法。
`rustfst` 的 `shortest_path` 走的是 OpenFST 那套 queue-based shortest-distance + 
`determinize_with_distance`，**不处理负权**，于是选出一条更贵的路径。

`push_weights` 试过：它把总权归一了（多数变成 0.000000），但**选中的读法不变**——不是修法。

## 三、影响面：不止裸整数

拿真实管线跑一遍，把 shipped 结果和「真正的最小值」并排：

| 输入 | shipped（rustfst） | 真正最小值 | |
|---|---|---|---|
| `I have 123 apples.` | `one two three apples` | `one hundred and twenty three apples` | ❌ |
| `There are 100 people.` | `one oh oh people` | `one hundred people` | ❌ |
| `Total 1,234 items.` | `one two three four items` | `thousand two hundred and thirty four items` | ❌ |
| `About 1000000 people.` | `one oh oh oh oh oh oh people` | `one million people` | ❌ |
| `Between 100 and 200 people.` | `one oh oh and two hundred people` | `one hundred and two hundred people` | ❌ |
| `It is 250 km away.` | `two hundred fifty kilometers` | `two hundred and fifty kilometers` | ❌ |
| `Call 555-1234.` | `five hundred fifty five minus …` | `five hundred and fifty five minus …` | ❌ |
| `Meet at 3:30pm.` | `three thirty PM` | 同 | ✅ |
| `About 50% agreed.` | `fifty percent` | 同 | ✅ |
| `She came 1st.` | `first` | 同 | ✅ |
| `Use 1/2 cup.` | `one half` | 同 | ✅ |
| `Made in 2024.` | `twenty twenty four` | 同 | ✅ |
| `Add 2,000 units.` | `two thousand` | 同 | ✅ |
| `Read page 42.` | `forty two` | 同 | ✅ |
| `Room 007.` | `oh oh seven` | 同 | ✅ |
| `It cost 1000 dollars.` | `ten hundred` | 同（两边都错，这是上游文法自己的问题） | ✅ |

**18 条里 7 条不一致。** 而且不一致的不只是裸整数——`250 km`、`555-1234`、`2,000`
这些**实体**类里也有错的。所以 9B.2 报告里「实体 8 类明显更好、裸整数是弱项」
这个判断只在「实体里恰好有几条是对的」这个意义上成立，**底层抽取是坏的**。

## 四、对 9B.2 报告的一处更正

9B.2 把这件事写成「**引擎级平局**：两边代价都是 1.000，`rustfst` 与 `kaldifst` 消解不同」。
**那个框定是错的**：不是平局，路径权重**不同**，正确的那条**严格更便宜**。
也不是「引擎口味不同」——是 `rustfst::shortest_path` 在负权文法上给了错的答案。

顺带：中文 `1,234` → `两百` 而训练目标用 `二百`，9B.2 记为「唯一解释不清的分歧」。
**很可能同一个根因**（同一条抽取路径），修完值得重新量一次。

## 五、修法

在 `crates/phonemize/src/backends/wetext/text_normalizer.rs` 里，
把

```rust
let best_path: VectorFst<TropicalWeight> = shortest_path(&composed)?;
// ... decode_linear_fst
```

换成自己算：

1. **Bellman-Ford 松弛**（`|V|` 轮，容忍负权；这些文法无负环，实测 2–4 轮收敛），
   同时记下每个状态的入边；
2. 在终态里取 `dist + final_weight` 最小的那个，**回溯**得到输出标签；
3. 组装字符串。

约 40 行，已在探针里验证能复现全部正确读法（§二 / §三 的「真正最小值」列就是这么算的）。
成本：composed FST 很小（一个 token 约 100 状态），Bellman-Ford 是微秒级，
比现在这次 `shortest_path` 还便宜。

> 顺带说明为什么这**不是**在给上游打补丁：`rustfst` 那边可以去提 issue，
> 但我们的 wasm 不能等它；而这 40 行在我们复制进来的那份代码里，
> 与「fork 源码而不是依赖 crate」的既有决定一致。

---

## 六、复现

```bash
zstd -d public/dictionaries/wetext-en-tn-verbalizer.bin.zst -o /tmp/verbalizer.fst
# 探针在 /tmp/fstprobe（rustfst 1.3.1）：
#   - 列全部路径与权重（paths_iter）
#   - Bellman-Ford + 回溯
#   - 与 shortest_path 对比
# 生产代码不含这些探针。
```

---

## 七、实施记录（2026-10-04）

### 改了什么

| 文件 | 改动 |
|---|---|
| `crates/phonemize/src/backends/wetext/text_normalizer.rs` | `normalize` 第 3 步不再调 `rustfst::shortest_path`，改调本模块的 `cheapest_path_labels`（Bellman-Ford + 回溯，约 75 行含文档）。`fst_to_string(&VectorFst)` 换成 `labels_to_string(&[Label])`，两条抽取路径共用同一段组装逻辑（高位码点 / UTF-8 字节的判别原封不动）。删掉 `shortest_path`、`decode_linear_fst` 两个 import。 |
| `crates/phonemize/tests/wetext_en.rs` | 6 → **7** 条测试。新增 `reads_the_sentences_the_bug_moved_and_leaves_the_rest_where_they_were`（本文件 §三 那张表的 15 条整句 + `1000` 那条）与 `the_cheapest_reading_of_a_bare_integer_is_the_cardinal_one`（`123` 的回归锁）。原 `a_bare_number_has_no_right_answer_and_the_engine_reads_it_digit_by_digit` 被它取代。`reads_the_entity_classes_…` 的 `250 km` 期望值改 `two hundred and fifty kilometers`；`the_pipeline_reads_numerals_through_the_engine` 加了一条 `I have 123 apples.` 的音素断言，让修复必须穿过整条管线。 |
| `crates/phonemize/README.md`、`src/backends/wetext/{NOTICE,README.md,mod.rs}`、`src/pipeline.rs` | 把「等代价 / 引擎口味不同 / 裸整数是弱项」三处都改成实际结论；`NOTICE` 新增改动 #6，编号总数 5 → 6。 |
| `docs/superpowers/plans/P6-FINAL.md` | 在 9B 那段的三条收敛假设下加「9B.4 更正了 (3)」并改掉改动计数。 |

### 算法

就是本文件 §五 的做法，实现细节：从 start 起 `dist[start] = 0`，对全部状态做
最多 `|V|` 轮松弛（一轮无变化即停；实测 2–4 轮），每条松弛记录
`incoming[next] = (from, olabel)`；然后在终态里取 `dist + final_weight` 最小者（严格
小于，平局保留先找到的），沿 `incoming` 回溯到 start，收 `olabel`、跳过 ε、反转。
更新用严格 `<`，所以零代价环不会被反复松弛，回溯也必然终止。

**§二 的机制要说清一处**（结论不变，只是路径不同）：`shortest_path(&fst)` 走的是
默认 `nshortest = 1`，因此实际是 `single_shortest_path`，不是 §二 写的「queue-based
shortest-distance + determinize」（那条是 `nshortest > 1` / `unique` 的路线）。
`single_shortest_path` 是一个带 `enqueued` 标志的松弛循环，队列由 `AutoQueue` 按 FST
的**结构属性**选：无权 → LIFO；各 SCC 都平凡（即无环）→ SCC 缩并的拓扑序；否则按
SCC 分队列。**它从不看权重的符号**，而且 `TrivialQueue` / `TopOrderQueue` /
`FifoQueue` 的 `update()` 都是空操作，被 `enqueued` 挡住的再松弛会被直接丢弃。
这与非负权下无关紧要、与负权下有关系。顺带：`shortest_distance` 用的是同一套
`AutoQueue`，所以它也不能当作修法（**这是读源码得出的判断，没有实测它与真值的差**；
实测证明非最小的是 `shortest_path`）。

**和旧实现的语义差异只有一处**：`composed.num_states() == 0` 或无可行终态时返回
原文——与原来一致（原来是 `shortest_path` 结果为空时返回原文）。公开 API 签名没变。

### 验证

1. **枚举复算**：对 `cardinal { integer: "123" }` 用 `paths_iter` 列出全部 7 条路径，
   与 §一 的表逐条一致；`cheapest_path_labels` 选中的就是 0.000000 那条。
2. **RED → GREEN**：把抽取临时换回 `shortest_path`，新测试 4 条失败，失败信息
   逐条是本节 §三 的旧读数（`Some("one two three")` vs
   `Some("one hundred and twenty three")` 等）；换回 Bellman-Ford 后 7/7 通过。
3. **真实管线 18 条**：§三 表里的 7 条全部变成「真正最小值」列的值，其余 11 条
   一位没变。`123`、`1,234`、`1,500 people`、`1000000`、`250 km` 等裸/实体用例
   也逐条钉在测试里。

### 改完哪些输入变了

只有 §三 那 7 条。**另有两条要更正本文前面的表**：

- §二 的 `1000` 行（`0.000010 thousand`）成立，但那是**手写 `cardinal { integer:
  "1000" }`** 的结果；真实管线把 `1000` 标成 `date { year: "1000" }`，那里
  `ten hundred` 与 `one thousand` 是 **0.000100 的真平局**，两边参考实现都取
  `ten hundred`。所以 §三 说「`1000 dollars` 两边都错」是对的，原因不是同一个。
- §三 的 `Call 555-1234.` 行，期望列写成 `… minus …` 是错的。tagger 把它标成
  `range { value: "555-1234" }`，最便宜的读法是 **`-0.000100` 的 `… to …`**
  （`five hundred and fifty five to one thousand two hundred and thirty four`），
  电话读法 `… minus …` 在 `0.000000`；即便按手写的 `cardinal { integer:
  "555-1234" }` compose 也是 `to` 更便宜。§三 那一行是在「shipped 的前 39 个字符」
  基础上把期望列补出来的，`minus` 是从 shipped 那边带过去的。测试按实测的 `to` 钉。

### 性能（release，原生，3000 次/输入，5 轮取最好）

| 输入 | `shortest_path` | Bellman-Ford |
|---|---|---|
| `hello world` | 466 µs | **461 µs** |
| `I have 123 apples.` | 1289 µs | **1273 µs** |
| `Between 100 and 200 people.` | 1854 µs | **1831 µs** |

跑的不是同一进程、同一轮，所以这 0.5–1.3% 落在噪声里；能说的是**没有变慢**，与 §五
的预估一致（composed FST 一个 token 约 100 状态，BF 是几百条弧上的几轮扫描，而旧的
`shortest_path` 还要 queue + determinize）。

### 没做

上游 `wetext-rs` / `kaldifst` 的同一处缺陷没有上游报告（本次只改本地副本）。§二 用的
那三张表（`cardinal { integer: … }` 的手写 compose）仍只存在于临时探针里，没有提交
数据；持续检查靠 `crates/phonemize/tests/wetext_en.rs` 的 7 条测试。
