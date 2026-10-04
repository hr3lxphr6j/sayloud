# P6 阶段 9B.5：中文 `1,234 → 两百` 的成因 —— 不是 shortest_path

**日期**：2026-10-04
**问题**：中文的 `两百` 是不是英文那个 `shortest_path` 负权 bug（9B.4）？
**结论**：**不是，根因完全不同。** 中文的 `两百` 是**文法数据里的确定性读法**——数字记号的首位 `2` 读「两」——不是从候选里「选」出来的；`shortest_path` 与能处理负权的 Bellman-Ford 在 **81 条**中文输入上给出**逐条相同**的读法。`1,234 → 两百` 的具体触发点是**标签器把逗号当分隔符**，让 `234` 成为一个新记号（首位是 2），而不是 `1,234` 这个数被读成两百。

---

## 一、证据

### 1. 结构数字（负权弧的量级：英文 vs 中文）

| FST | states | arcs | 负权弧 | 负权值分布 |
|---|---|---|---|---|
| zh tagger | 10,050 | 25,407 | 12 | 全部 -1.0 |
| zh verbalizer | 26,101 | 47,280 | 13 | 全部 -1.0 |
| ja tagger / verbalizer | 4,429 / 8,558 | 21,791 / 14,080 | 0 / 0 | — |
| （对照）en tagger | 14,110 | 342,268 | **25,838** | 25,717 条为 -1e-4 |

英文的负权是 `add_weight(..., -0.0001)` 那种**候选排序微调**、铺满整张图；中文只有 25 条、量级是 -1.0，只出现在热线/电话类读法上（`110`、`119`、`13800138000` 的 composed 图各命中 1 条，两条读数仍相同）。**触发英文 bug 的形状在中文里几乎不存在**。

### 2. `两百` 在 verbalizer 里是**唯一**路径

`math { value: "200" }` 上 compose：**27 状态 / 26 弧**（链），`all_paths` 只列出一条 —— `两百`。没有 `二百` 候选，因此没有「选错」的余地（`cardinal { value: "200" }`、`math { value: "1,234" }`、`cardinal { value: "1,234" }` 三种标记法**根本不被接受**）。

### 3. 标签器原始输出（逗号是那个关键）

```
1,234   → math { value: "1" } char { value: "," } math { value: "234" }   ← 26 条路径全部在逗号处切开
1,234个  → measure { value: "1,234个" }   → 一千二百三十四个
1,234元  → measure { value: "1,234元" }   → 一千二百三十四元
1234    → math { value: "1234" }          → 一千二百三十四
200     → math { value: "200" }           → 两百
```

没有一条 tagger 路径把 `1,234` 合成单个数字记号（26 条穷举），所以 `一千两百三十四` 这份 wheel 产生不出来。

### 4. 实测规则：记号的**首位** 2 读「两」，非首位读「二」

`200→两百`、`202→两百零二`、`2万→两万`、`2亿→两亿`、`2000→两千`、`2100→两千一百`、`2200→两千二百`、`1234→一千二百三十四`、`2345→两千三百四十五`。这是标准普通话读法，属文法数据。逗号让它显形的对照：`1,234`（两百）vs `1,234个`（二百）。

### 5. 两种抽取方法：16 条指定输入逐条相同

| 输入 | shortest_path 读法 | Bellman-Ford 读法 | 权重 | |
|---|---|---|---|---|
| `1,234` | 一,两百三十四 | 一,两百三十四 | 0.000000 | 同 |
| `1234` | 一千二百三十四 | 一千二百三十四 | 0.000000 | 同 |
| `100` | 一百 | 一百 | 0.000000 | 同 |
| `一千二百三十四` | 一千二百三十四 | 一千二百三十四 | 0.000000 | 同 |
| `200` | 两百 | 两百 | 0.000000 | 同 |
| `两百` | 两百 | 两百 | 0.000000 | 同 |
| `1,234个` | 一千二百三十四个 | 一千二百三十四个 | 0.000000 | 同 |
| `2024年10月4日` | 二零二四年十月四日 | 二零二四年十月四日 | 0.000000 | 同 |
| `3:30` | 三点三十分 | 三点三十分 | 0.000000 | 同 |
| `50%` | 百分之五十 | 百分之五十 | 0.000000 | 同 |
| `13800138000` | 幺三八零零幺三八零零零 | 幺三八零零幺三八零零零 | -1.000000 | 同 |
| `$100` | 一百美元 | 一百美元 | 0.000000 | 同 |
| `15` | 十五 | 十五 | 0.000000 | 同 |
| `15%` | 百分之十五 | 百分之十五 | 0.000000 | 同 |
| `3.14` | 三点一四 | 三点一四 | 0.000000 | 同 |
| `第3` | 第三 | 第三 | 0.000000 | 同 |

**identical: 16, differing: 0。** 另有 65 条补充输入（`2万`/`2亿`/`1,234,567`/`110,119`/`110`/`119`/`1,234元`/`2,345元`/`2024-10-04`/`-5`/`1e5`/`A4` 等），三轮合计 81 条去重后的中文输入全部 **0 条不一致**；日文 12 条 **0 条不一致**（ja 两张 FST 零负权）。

### 6. 独立参照实现

Python `wetext==0.1.8` + `kaldifst`（wheel sha256 `b2083e7f…`，与 `scripts/setup-wetext-fsts.sh` 钉的是同一份）：`normalize('1,234') = '一,两百三十四'`，与我探针的 `shortest_path` 结果逐字相同；`nbest=8` 的 8 条候选中**没有任何 `二百`**（`['一,两百三十四', '1,两百三十四', '一,二三十四', '一,二十三四', …]`）。

顺带更正：`p6-9b-decision.md` 记的「WeText: `1,234` → `一千两百三十四`」在这份 wheel 上**复现不出来**（该记号法不被 verbalizer 接受），而 `p6-wetext-evaluation.md` 自己记的 `一,两百三十四` 与本次一致；`setup-wetext-fsts.sh` 的注释也提到同一条读数在不同 wheel 版本间变过。

---

## 二、影响面

- **9B.4 那 40 行 Bellman-Ford 替换对中文/日文改变 0 条输出**（81 条 zh + 12 条 ja 全同）。该修法只为英文有效，别指望它动 `两百`。
- 会受「首位 2」影响的输入：`zh-frontend-parity.json` 47 条里只有 **1 条**（就是 `1,234`，现 JS 音素 `i→,ɚ↘pai↓sa→nʂɻ̩↗ sɹ̩↘` = 一,二百三十四 → 变 `一,两百三十四`，第二个音节声母 `ɚ`→`l`（`liang`→`lja0ŋ`））；45 条 `zh-parity.json` 里没有首位 2 的数字 → **0 条**。
- 若要让 WeText 对齐 Kokoro/misaki 的 `二百`，只能动**文法数据**（换 wheel 或改权重/加 `二` 的候选），改抽取算法无效。

---

## 三、可复现命令

```bash
# 1) 取 FST（wheel 与 setup-wetext-fsts.sh 钉的是同一份，sha256 b2083e7f…）
cd /tmp && curl -sL "https://files.pythonhosted.org/packages/43/fe/ca7ccae2673b64ba7d63612e68b31963e3842dd77fb6aa632270d123d685/wetext-0.1.8-py3-none-any.whl" -o w18.whl
mkdir -p /tmp/w18 && unzip -o -q w18.whl -d /tmp/w18
mkdir -p /tmp/zhfst
cp /tmp/w18/wetext/fsts/zh/tn/tagger.fst      /tmp/zhfst/zh_tagger.fst        # 同法复制 zh/ja/en 的 verbalizer、ja 的 tagger
# 2) 探针（rustfst 1.3.1，与生产同版本）
cd /tmp/zhfstprobe && cargo build --release
./target/release/zhfstprobe zh stats                     # 状态/弧/负权弧直方图
./target/release/zhfstprobe zh corpus                    # 默认 16 条：tagger 原始输出 + 两种读法
./target/release/zhfstprobe zh summary '1,234' '200' '1,234个'   # 紧凑对比表（含权重）
./target/release/zhfstprobe zh deep '1,234'              # 穷举 tagger 路径及其 verbalizer 路径
./target/release/zhfstprobe zh raw 'math { value: "200" }'      # 直接跑 verbalizer
./target/release/zhfstprobe ja summary                   # 日文对照
# 3) 参照实现
python3 -m venv /tmp/wetextvenv && /tmp/wetextvenv/bin/pip install wetext==0.1.8
/tmp/wetextvenv/bin/python -c "from wetext import Normalizer; n=Normalizer(lang='zh',operator='tn'); print(n.normalize('1,234'), n.normalize('1,234',nbest=8))"
```

探针：`/tmp/zhfstprobe/src/main.rs`（单文件，含自实现的 Bellman-Ford + 逆邻接回溯、`all_paths` 穷举、英文自检）；FST：`/tmp/zhfst/`。**本次未改动仓库任何文件。**

---

## 四、不确定的地方

1. 我的 Bellman-Ford 是自己写的（`|V|` 轮松弛 + 逆邻接回溯），「两边一致」也可能是「两边同样错」。缓解：它在英文上复现了 9B.4 四行中的三行（`123`/`100`/`1000000` 连权重逐位吻合，`123` 的 composed 图实测 neg_arcs=2 / min=-0.0001），且独立的 Python 参照实现在 25 条上与它逐字相同。英文 `1000` 那行**复现不出来**：tagger 把它标成 `date { year: "1000" }`，两条方法都给 `ten hundred`。
2. 路径枚举是深度受限 DFS（允许重复入栈，展开预算 400 万次），不是形式化的 epsilon-闭包穷举；但「`math{200}` 只有一条接受路径」靠的是 27 状态/26 弧这个结构性事实，与枚举方法无关。
3. 81 条是三轮扫描合并去重后的清单（`/tmp/zh_inputs.txt`），本轮 81 条全部走到 verbalizer 并给出了可比对的一对读数；**没覆盖的是长句/实体密集语料**（本次只测短输入，日期/时间/货币/电话/度量各取一两个）。要在 9B 第二步接线前下定论，应拿 `zh-frontend-parity.json` 那 47 条整句再跑一遍。
4. 我没跑仓库自己的代码（另一 agent 正用同一工作区），探针复刻的是 tagger → reorder → verbalizer 三步，未接 `full_to_half` / `remove_puncts` / `tag_oov`——不过中文 TN 目前并未接到生产（`wetext_tn.rs:60` 只构造 `Language::En`）。
5. 「两百」与「二百」哪个该是产品行为是策略问题（misaki 偏好 `二百`，而 `两百` 才是口语常读），本报告只能确认它**不是**最短路径 bug。
6. `p6-9b-decision.md` 里 `一千两百三十四` 的来源无法追溯（`setup-wetext-fsts.sh` 的注释暗示是另一个 wheel 版本），我没有去翻历史 wheel 逐一对比。
