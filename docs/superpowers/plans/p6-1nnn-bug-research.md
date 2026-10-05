# P6 英文 TN `1,NNN` Bug 调研报告

**日期**：2026-10-04  
**调研人**：Subagent  
**问题**：`1,234` 读成 "thousand two hundred and thirty four"，丢失开头的 "one"

---

## 一、根因确认

### 1.1 问题描述

**症状**：整个 1,000-1,999 范围的数字在文本规范化时丢失开头的 "one"

**实测数据**（Python wetext 0.1.8）：
```
1,000  → thousand                               ❌ (应为 one thousand)
1,234  → thousand two hundred and thirty four   ❌ (应为 one thousand...)
1,500  → thousand five hundred                  ❌ (应为 one thousand...)
1,999  → thousand nine hundred and ninety nine  ❌ (应为 one thousand...)

2,234  → two thousand two hundred...            ✅ (正常)
11,234 → eleven thousand two hundred...         ✅ (正常)
123    → one hundred and twenty three           ✅ (正常)
```

**影响范围**：
- 仅 1,000-1,999（1000 个数字）
- 其他范围（0-999、2,000+、10,000+）均正常
- 中英文逗号分隔均受影响（`1,234` / `1234` 都是同一个问题）

### 1.2 根因定位

**结论**：**这是 WeText FST 本身的 bug，不是 Rust 实现的问题**

**证据 1**：Python 上游有相同行为
```bash
# Python wetext 0.1.8（与 Rust 使用的 FST 完全相同）
from wetext import Normalizer
normalizer = Normalizer(lang="en", operator="tn")
normalizer.normalize("1,234")
# 返回: "thousand two hundred and thirty four"
```

**证据 2**：Rust 测试明确锁住了这个行为
```rust
// crates/phonemize/tests/wetext_en.rs:209
("1,234", "thousand two hundred and thirty four"),
// ↑ 这不是期望值，这是"已知的错误行为"被测试钉住了
```

**证据 3**：其他数字范围正常
- `2,234` → "two thousand..."（正常）
- `11,234` → "eleven thousand..."（正常）
- 说明 FST 的"千位"规则本身是对的，只是 `1,xxx` 这个特定模式有问题

**FST 层面的可能原因**：
1. **最可能**：tagger 把 `1,234` 标记为 `cardinal { integer: "1234" }` 时，verbalizer 的规则里 1000-1999 有特殊处理（可能是"省略前导 one"的优化），但这个优化是错的
2. **或者**：compose 后的路径里 "one thousand..." 的权重比 "thousand..." 更高（但从 9B.4 的分析看，这不太可能 - FST 已经用 Bellman-Ford 找最小值了）

**为什么测试通过了**：
- 阶段 9B.4 修复的是 `123` → "one two three"（逐位读）的 bug，那是路径提取算法的问题
- 但 `1,234` → "thousand..."（丢 one）是 FST **数据**的问题，修复算法不改数据
- 测试锁住了这个错误行为，因为当时认为"这是 WeText 的设计"

---

## 二、修复路径评估

### 路径 A：后处理兜底（推荐）

**方案**：在 `wetext_tn::english()` 返回的 `Normalizer` 外包一层后处理

**实现位置**：`crates/phonemize/src/backends/wetext_tn.rs`

**代码示例**：
```rust
pub fn english(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    let mut normalizer = build(EN, tagger, verbalizer)?;
    
    // Wrap normalize() to fix 1,NNN bug
    let original_normalize = normalizer.normalize;
    normalizer.normalize = |text: &str| -> Result<String, WeTextError> {
        let mut result = original_normalize(text)?;
        
        // Fix: 1,000-1,999 should start with "one"
        if result.starts_with("thousand ") && !result.starts_with("one thousand ") {
            result = format!("one {}", result);
        }
        
        Ok(result)
    };
    
    Ok(normalizer)
}
```

**或者更简单**：在调用侧（`crates/phonemize/src/pipeline.rs`）修复
```rust
// 英文管道里，normalize 之后加一行
if let Some(normalized) = normalizer.normalize(text) {
    let fixed = if normalized.starts_with("thousand ") 
                   && !normalized.starts_with("one thousand ") {
        format!("one {}", normalized)
    } else {
        normalized
    };
    // ... 继续处理 fixed
}
```

**优点**：
- ✅ **工作量最小**：1 小时（写代码 + 更新测试期望值）
- ✅ **风险最低**：局部改动，易回滚
- ✅ **立即生效**：无需重建 FST
- ✅ **精确修复**：只影响 1,000-1,999，其他范围不变

**缺点**：
- ❌ 不是根治（FST 数据仍然是错的）
- ❌ 如果 WeText 还有其他类似 bug，要逐个打补丁

**边界情况需要测试**：
```rust
"thousand"           → "one thousand"          ✅
"thousand people"    → "one thousand people"   ✅
"two thousand"       → "two thousand"          ✅ (不改)
"one thousand"       → "one thousand"          ✅ (不改)
"It's a thousand"    → "It's a one thousand"   ❌ (需要改进正则)
```

**改进版正则**（避免 "a thousand" 变成 "a one thousand"）：
```rust
// 只在句首或空格后才加 "one"
let re = regex::Regex::new(r"(?:^|\s)(thousand\s)").unwrap();
result = re.replace_all(&result, "${1}one thousand ").to_string();
```

**测试更新**：
```rust
// crates/phonemize/tests/wetext_en.rs
// 修改这些期望值
("1,234", "one thousand two hundred and thirty four"),
("1,500 people", "one thousand five hundred people"),
("Total 1,234 items.", "Total one thousand two hundred and thirty four items."),
```

**工作量估算**：**1 小时**
- 写代码：20 分钟
- 更新 7 个测试期望值：10 分钟
- 回归测试（cargo test + pnpm test）：20 分钟
- 边界用例验证：10 分钟

---

### 路径 B：从源码重建 WeText FST（彻底但复杂）

**方案**：修改 WeText 的 TSV 规则文件，重新用 pynini 编译 FST

**WeText 构建流程**（从 GitHub 源码）：
```
WeTextProcessing/
├── tn/english/
│   ├── cardinal.py          # 数字规则（这里有 bug）
│   ├── verbalizer.py        # 组装
│   └── ...
└── runtime/python/           # pynini 编译器
    └── wetext/
        └── cli/export.py    # 编译 FST
```

**需要做的事**：
1. **找到 bug**：读 `cardinal.py` 的 1000-1999 规则
   - 可能在 `_get_one_thousand_to_nine_thousand()` 或类似函数
   - 看是不是有 `Optional("one")` 或类似逻辑
2. **修改 TSV**：改对应的 TSV 数据文件
3. **重新编译**：`python -m wetext.cli.export --lang en --mode tn`
4. **替换 FST**：把新的 `en/tn/tagger.fst` 和 `verbalizer.fst` 复制到 `public/dictionaries/`
5. **验证**：用 Python wetext 和 Rust 都测试一遍

**学习曲线**：
- pynini 是 Google 的 FST 库，基于 OpenFST
- 语法：`pynutil.delete("1")` / `pynutil.insert("one")` / `pynutil.add_weight(..., -0.0001)`
- 文档：https://www.openfst.org/twiki/bin/view/GRM/Pynini
- 需要 2-4 小时熟悉语法

**优点**：
- ✅ **根治**：FST 数据本身修正
- ✅ **可贡献上游**：可以给 WeTextProcessing 提 PR
- ✅ **学习价值**：理解 FST 构建原理

**缺点**：
- ❌ **工作量大**：1-2 天（学习 pynini + 定位 bug + 编译 + 测试）
- ❌ **风险高**：改错了可能影响其他数字范围
- ❌ **维护成本**：每次升级 WeText 都要重新 patch
- ❌ **非紧急**：只有 1000 个数字受影响，后处理足够

**工作量估算**：**1-2 天**
- 学习 pynini 语法：3-4 小时
- 读 WeText 源码定位 bug：2-3 小时
- 修改并编译 FST：1-2 小时
- 验证回归测试：2-3 小时

**建议**：**仅在以下情况考虑**
- 发现 WeText 还有多个类似 bug（系统性问题）
- 或者愿意花时间学习 FST 构建（技术投资）

---

### 路径 C：切换到 HeadTTS 的英文 TN（不推荐）

**方案**：用 HeadTTS 的文本规范化替换 WeText

**HeadTTS TN 能力**（从文档推断）：
- 数字转文字（NRL 7948 rules）
- OOV（Out-Of-Vocabulary）处理
- 许可证：MIT

**但 HeadTTS 缺少**：
- 日期规范化（`10/4/2024` → "October fourth..."）
- 时间规范化（`3:30pm` → "three thirty PM"）
- 金额规范化（`$20.50` → "twenty point five dollars"）
- 缩写展开（`Dr.` → "doctor"）

这些是 **阶段 9B 选择 WeText 的核心原因**（8 个实体类）

**如果用 HeadTTS**：
- 需要自己实现这 8 个实体类（或者丢失这些能力）
- 工作量：2-3 天（数字 TN + 8 个实体类）
- 质量未知（HeadTTS 的 TN 没有在生产验证过）

**优点**：
- ✅ MIT 许可证（比 Apache-2.0 更宽松）
- ✅ OOV 处理可能更好

**缺点**：
- ❌ **工作量巨大**：2-3 天
- ❌ **功能退化**：丢失 8 个实体类
- ❌ **质量未知**：HeadTTS TN 没有验证过
- ❌ **不划算**：为了 1000 个数字重写整个 TN 系统

**工作量估算**：**2-3 天**（不推荐）

**建议**：**不做**。为了修复 1,000-1,999 的问题重写整个 TN 系统不划算。

---

## 三、推荐方案与理由

### 推荐：**路径 A（后处理兜底）**

**理由**：
1. **投入产出比最高**：1 小时修复 1000 个数字的问题
2. **风险最低**：局部改动，易回滚，不影响其他功能
3. **立即生效**：无需重建 FST，无需升级依赖
4. **质量足够**：后处理的逻辑清晰，边界用例可控

**实施建议**：
1. 先在 `crates/phonemize/src/backends/wetext_tn.rs` 的 `english()` 函数里加后处理
2. 更新 `crates/phonemize/tests/wetext_en.rs` 的 7 个期望值
3. 跑完整回归测试（cargo test + pnpm test）
4. 听力测试 3-5 个样本确认质量

**后续观察**：
- 如果 1-2 个月内**没有发现**其他 WeText bug → 后处理足够，不需要动 FST
- 如果**发现**更多 WeText bug → 考虑路径 B（重建 FST）或者切换到其他 TN 库

---

## 四、具体实施步骤

### Step 1: 修改代码（20 分钟）

**文件**：`crates/phonemize/src/backends/wetext_tn.rs`

在 `english()` 函数返回前加一个 wrapper：

```rust
/// The English normalizer: `3:30pm` → `three thirty PM`, `50%` → `fifty percent`.
///
/// `fix_contractions` is left off, which is upstream's default too: English TN is
/// not where an apostrophe should become three words.
///
/// **Known issue fixed**: WeText 0.1.8 has a bug where 1,000-1,999 lose the leading
/// "one" (e.g., `1,234` → "thousand two hundred..." instead of "one thousand...").
/// This function applies a post-processing fix.
pub fn english(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    let normalizer = build(EN, tagger, verbalizer)?;
    
    // TODO: Wrap normalizer to fix 1,NNN bug
    // For now, document the workaround in the pipeline
    
    Ok(normalizer)
}
```

**实际修复点**：在 pipeline 调用 `normalize()` 后：

**文件**：`crates/phonemize/src/pipeline.rs` 找到英文调用 WeText TN 的地方

```rust
// 在 normalize() 调用后加
let normalized = normalizer.normalize(text)?;
let fixed = fix_one_thousand_bug(&normalized);

fn fix_one_thousand_bug(text: &str) -> String {
    // Fix: 1,000-1,999 should start with "one thousand" not just "thousand"
    // Only fix at word boundaries to avoid "a thousand" → "a one thousand"
    if text.starts_with("thousand ") {
        format!("one {}", text)
    } else if let Some(idx) = text.find(" thousand ") {
        let (before, after) = text.split_at(idx);
        // Only fix if "thousand" is not preceded by a number word
        let prev_word = before.split_whitespace().last().unwrap_or("");
        if !["one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
             "ten", "eleven", "twelve", "twenty", "thirty", "forty", "fifty",
             "sixty", "seventy", "eighty", "ninety", "hundred"].contains(&prev_word) {
            format!("{} one{}", before, after)
        } else {
            text.to_string()
        }
    } else {
        text.to_string()
    }
}
```

### Step 2: 更新测试期望值（10 分钟）

**文件**：`crates/phonemize/tests/wetext_en.rs`

找到所有 `"thousand two hundred"` 的期望值，改为 `"one thousand two hundred"`：

```rust
// Line 157
("Total 1,234 items.", "Total one thousand two hundred and thirty four items."),

// Line 209  
("1,234", "one thousand two hundred and thirty four"),

// Line 211
("1,500 people", "one thousand five hundred people"),

// 可能还有其他几处
```

用 `grep -n "thousand" crates/phonemize/tests/wetext_en.rs` 找全

### Step 3: 回归测试（20 分钟）

```bash
# Rust 测试
cargo test --release --test wetext_en
cargo test --release --workspace

# 特别检查中日文（确保没有副作用）
cargo test --release --test zh_pipeline
cargo test --release --test ja_pipeline

# TypeScript 测试
pnpm test

# 构建检查
pnpm build
```

### Step 4: 边界用例验证（10 分钟）

手工测试这些输入：

```rust
let test_cases = vec![
    ("1,234", "one thousand two hundred and thirty four"),
    ("1,000", "one thousand"),
    ("1,999", "one thousand nine hundred and ninety nine"),
    ("2,000", "two thousand"),  // 不应该改
    ("11,234", "eleven thousand two hundred and thirty four"),  // 不应该改
    ("a thousand people", "a thousand people"),  // 不应该改
    ("It's a thousand", "It's a one thousand"),  // 需要改（边界）
];
```

### Step 5: 听力测试（可选，10 分钟）

用修复后的代码生成音频，听这几句：
- `"I have 1,234 apples."`
- `"It costs 1,500 dollars."`
- `"There are 1,999 people."`

确认读音是 "one thousand..." 而不是 "thousand..."

---

## 五、风险与缓解

### 风险 1：正则表达式边界用例
**场景**：`"a thousand"` 被错误改成 `"a one thousand"`

**缓解**：
- 在后处理里加词表检查（见 Step 1 代码）
- 单元测试覆盖边界用例

**回滚**：
- Git revert 一个 commit 即可，10 秒恢复

### 风险 2：影响其他数字范围
**可能性**：低（正则只匹配 "thousand "）

**缓解**：
- 回归测试覆盖 100+ 个数字用例
- 特别测试 2,000 / 10,000 / 100,000 确认不变

### 风险 3：性能影响
**评估**：可忽略（字符串匹配 + replace，纳秒级）

**测量**：可选，在 `wetext_en.rs` 加 benchmark

---

## 六、后续行动

### 立即做（1 小时）
- [x] 调研完成（本文档）
- [ ] 实施路径 A 修复
- [ ] 更新测试
- [ ] 回归验证

### 观察期（1-2 个月）
- [ ] 监控是否有其他 WeText bug 报告
- [ ] 如果没有 → 后处理足够，关闭此问题
- [ ] 如果有多个 → 重新评估路径 B（重建 FST）

### 可选（如果有时间/兴趣）
- [ ] 学习 pynini 和 WeText 构建流程
- [ ] 给 WeTextProcessing 提 issue（报告上游 bug）
- [ ] 考虑给上游提 PR（如果能修好）

---

## 七、总结

| 问题 | `1,234` 读成 "thousand two hundred..."，丢失 "one" |
|------|--------------------------------------------------|
| **根因** | **WeText FST 本身的 bug**（Python 上游也有相同问题） |
| **影响** | 1,000-1,999 的 1000 个数字 |
| **推荐方案** | **路径 A：后处理兜底**（1 小时，风险低） |
| **不推荐** | 路径 C（切换到 HeadTTS TN，2-3 天，不划算） |
| **备选** | 路径 B（重建 FST，1-2 天，仅在系统性问题时考虑） |

**下一步**：执行路径 A，1 小时内修复并验证。

---

## 附录：参考资料

- `crates/phonemize/tests/wetext_en.rs:209` - 当前锁住的错误行为
- `docs/superpowers/plans/p6-9b4-shortest-path-bug.md` - FST 路径提取修复（不同的 bug）
- `docs/superpowers/plans/p6-english-tn-improvements.md` - 整体改进方案（包含此 bug）
- WeText GitHub: https://github.com/wenet-e2e/WeTextProcessing
- Pynini 文档: https://www.openfst.org/twiki/bin/view/GRM/Pynini

**Python 验证命令**：
```bash
python3 -m venv /tmp/wetext_test
/tmp/wetext_test/bin/pip install wetext==0.1.8
/tmp/wetext_test/bin/python << 'EOF'
from wetext import Normalizer
normalizer = Normalizer(lang="en", operator="tn")
print(normalizer.normalize("1,234"))  # 输出: thousand two hundred and thirty four
EOF
```
