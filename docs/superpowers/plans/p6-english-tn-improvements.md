# P6 英文 TN 质量改进方案

**日期**：2026-10-04
**前置**：阶段 9E + 10（WeText TN + Rust phonemize 已上线）

---

## 一、问题盘点

### 1.1 已知 Bug（现在生产可达）

| Bug | 症状 | 优先级 | 影响面 |
|-----|------|--------|--------|
| **`1,NNN` 丢 "one"** | `1,234` → "thousand two hundred..." | **P0** | 1,000-1,999 所有数字 |
| 首字母 A 读成冠词 | `FAQ` → "eff **uh** cue" | P1 | 缩写语（API/FAQ/RAG） |
| `ninety` 缺 en-US 改写 | `nˈaɪnti` 应改为 `nˈaɪndi` | P2 | 仅 en-US 音色 |
| en-GB 无音色路由 | 8 个英式音色用美式音素 | P1 | 8/32 音色 |

### 1.2 质量权衡（espeak vs Rust）

**Rust 更好**（已验证）：
- 日期：`10/4/2024` → "October fourth twenty twenty four"
- 时间：`3:30pm` → "three thirty PM"
- 分数：`1/2 cup` → "one half cup"
- 距离：`250 km` → "two hundred fifty kilometers"
- 专有名词：TypeScript / YouTube / Kubernetes
- 保留括号（espeak 会吃掉）

**espeak 更好**（已验证）：
- 弱读：`to` → `tə`（Rust 给 `tuː`）
- 弹舌：`ɾ`（Rust 无）
- 缩写按词念：NASA / YAML / XML（Rust 逐字母）
- 金额：`$10.50` → "ten dollars fifty cents"（Rust 没有 cents）

**结论**：**这是有方向的交易**，Rust 对实体（日期/时间/度量）更好，espeak 对自然语言（弱读/缩写）更好。10 月 4 日的 commit 选择了 Rust。

---

## 二、修复方案

### 2.1 P0：修复 `1,NNN` 丢 "one"

**根因**：WeText tagger 的输出就是错的

```bash
# 当前行为（已被测试钉住）
1,234 → "thousand two hundred and thirty four"  # 丢了 "one"
2,234 → "two thousand two hundred..."          # 正常
1,500 → "thousand five hundred"                 # 丢了 "one"
11,234 → "eleven thousand..."                   # 正常
```

**验证**：`crates/phonemize/tests/wetext_en.rs:207` 明确锁住了这个错误行为
```rust
("1,234", "thousand two hundred and thirty four"),
```

**可能的根因**：
1. WeText tagger 的 FST 本身有 bug（1xxx 的规则缺失）
2. 或这是 WeText 的设计（"thousand" 可以单独作为整数）

**修复路径 A：修改 WeText FST**（推荐）
- 需要从源码重建 tagger（pynini + TSV）
- 影响范围：仅 1,000-1,999
- 风险：中等（需要理解 WeText 的 FST 构建流程）
- 工作量：1-2 天（学习 pynini + 定位规则 + 重建 + 测试）

**修复路径 B：后处理**（快速兜底）
- 在 `wetext_tn.rs` 的 `normalize()` 后加正则
```rust
// 匹配 "thousand NNN" 不带前导数字的情况
if text.starts_with("thousand ") && !text.starts_with("one thousand ") {
    text = format!("one {}", text);
}
```
- 影响范围：仅英文，仅 1,000-1,999
- 风险：低（局部改动，易回滚）
- 工作量：1 小时（写代码 + 测试 + 更新期望值）

**修复路径 C：HeadTTS 的英文 TN 替换 WeText**
- HeadTTS 有自己的数字规范化（NRL 7948 rules）
- 优点：MIT 许可，OOV 处理更好
- 缺点：工作量大（~2 天），且 WeText 的其他实体（日期/时间/金额）要重写
- 不推荐：为了 1,000 个数字重写整个 TN 不划算

**建议**：先走路径 B（1 小时快速修复），如果后续发现更多 WeText 问题再考虑路径 A。

---

### 2.2 P1：首字母 A 读成冠词

**根因**：`spelled_out` 把 `A P I` 交给 CMU 词典，而 `A` 在词典里是单词 a（/ə/）

```rust
// crates/phonemize/src/backends/g2p_en.rs
// 当前：逐字母查 CMU Dict
"API" → ["A", "P", "I"] → CMU["A"] = "ə" → "ə pˈiː aɪ"
```

**这是阶段 4 刻意保留的旧行为**（测试已钉住）：
```rust
assert_eq!(ipa("API"), "ə pˈiː aɪ");
```

**修复**：26 个字母的发音表（硬编码）
```rust
const LETTER_NAMES: &[(&str, &str)] = &[
    ("A", "eɪ"), ("B", "biː"), ("C", "siː"), ("D", "diː"),
    ("E", "iː"), ("F", "ɛf"), ("G", "dʒiː"), ("H", "eɪtʃ"),
    // ... 其余 18 个
];

// 在 CMU Dict 查询前先查字母表
if text.len() == 1 && text.chars().next().unwrap().is_ascii_alphabetic() {
    if let Some(phoneme) = LETTER_NAMES.iter()
        .find(|(letter, _)| letter.eq_ignore_ascii_case(text))
        .map(|(_, phoneme)| phoneme) {
        return Some(phoneme.to_string());
    }
}
```

**影响面**：
- 中日文的拉丁段（生产已上线）会改变
- 需要回归测试中日文 parity 语料

**风险**：低（改动局部，逻辑清晰）

**工作量**：2-3 小时（写代码 + 更新期望值 + 跨语言回归）

---

### 2.3 P2：`ninety` 缺 en-US 改写

**根因**：`kokoro-js` 有 `nˈaɪnti`→`nˈaɪndi` 改写（仅 en-us），Rust 没有

**当前状态**：
- `KokoroEngine.render()` 保留了 `lang` 参数但没用
- 注释说"for the ninety rewrite"

**修复**：
```rust
// crates/phonemize/src/backends/vocab.rs 或单独模块
const EN_US_REWRITES: &[(&str, &str)] = &[
    ("nˈaɪnti", "nˈaɪndi"),
    ("nˈaɪntiːn", "nˈaɪndiːn"),
    // 可能还有其他
];

pub fn apply_en_us_rewrites(ipa: &str) -> String {
    let mut result = ipa.to_string();
    for (from, to) in EN_US_REWRITES {
        result = result.replace(from, to);
    }
    result
}
```

**集成点**：
```rust
// lib/models/kokoro-engine.ts
const ipa = await this.phonemizer.phonemize(text, lang);
const rewritten = lang === 'en-US' ? applyEnUsRewrites(ipa) : ipa;
const ids = tokenizer(rewritten);
```

**影响面**：仅 en-US 音色（16/32）

**风险**：低（局部改动，可选特性）

**工作量**：1-2 小时

---

### 2.4 P1：en-GB 音色路由

**根因**：Rust 英文链路是美式单套，8 个英式音色（`bf_*` / `bm_*`）用美式音素

**现状**：
- `p6-phase10-english.md` §四：132/137 条 en-GB 与 en-US 不同
- Rust 匹配 en-GB **0 条**

**可能的解决方案**：

**方案 A：espeak 的 en-GB 变体**（质量未知）
- 用 espeak 的 `en-gb` 变体替换 en-US
- 优点：无需训练数据
- 缺点：回到 espeak（+2.5 MB），且阶段 10 的权衡就白做了

**方案 B：音素映射表**（快速兜底）
```rust
// 美式 → 英式的音素映射（简化版）
const EN_GB_PHONEME_MAP: &[(&str, &str)] = &[
    ("ɑː", "ɒ"),   // lot: US /ɑː/ → GB /ɒ/
    ("æ", "ɑː"),   // bath: US /æ/ → GB /ɑː/
    ("ɚ", "ə"),    // letter: US /ɚ/ → GB /ə/
    // ... 需要语言学专家补全
];
```
- 优点：体积小，速度快
- 缺点：不精确（上下文无关的映射）

**方案 C：训练 en-GB 的 G2P 模型**（重工程）
- 用 en-GB 词典重新训练 HeadTTS 或类似模型
- 优点：质量最好
- 缺点：工作量大（1-2 周），需要 en-GB 发音词典

**方案 D：暂时降级**（回退）
- 8 个 en-GB 音色标记为"使用美式发音"
- 文档说明这是已知限制
- 优点：零代码，诚实
- 缺点：用户体验差

**建议**：先走方案 D（文档说明），如果用户强烈需求再考虑方案 B（音素映射）。方案 A 和 C 的投入产出比不高。

---

## 三、实施优先级

| 任务 | 优先级 | 工作量 | 预期效果 |
|------|--------|--------|----------|
| **修复 `1,NNN` bug**（路径 B） | **P0** | **1h** | 立即修复 1,000-1,999 |
| 首字母 A 读成冠词 | P1 | 2-3h | 修复 API/FAQ/RAG |
| `ninety` 改写 | P2 | 1-2h | en-US 音色质量提升 |
| en-GB 音色（方案 D） | P1 | 10min | 文档说明 |

**建议实施顺序**：
1. P0: `1,NNN` bug（1h）← **立即做**
2. P1: 首字母 A（2-3h）← 次优先
3. P1: en-GB 文档（10min）← 同步做
4. P2: `ninety` 改写（1-2h）← 可选

**总工作量**：4-6 小时（如果全做）

---

## 四、测试策略

### 4.1 单元测试更新

```rust
// crates/phonemize/tests/wetext_en.rs
// 修改期望值
("1,234", "one thousand two hundred and thirty four"),  // 加 "one"
("1,500 people", "one thousand five hundred people"),   // 加 "one"

// crates/phonemize/src/backends/g2p_en.rs
// 更新字母测试
assert_eq!(ipa("API"), "eɪ piː aɪ");  // 不再是 "ə"
assert_eq!(ipa("FAQ"), "ɛf eɪ kjuː");
```

### 4.2 回归测试

```bash
# Rust 测试
cargo test --workspace

# 中日文 parity（字母 A 的改动会影响）
cargo test zh_pipeline
cargo test ja_pipeline

# TypeScript 测试
pnpm test
```

### 4.3 听力测试（推荐但非强制）

用修复后的代码生成这些样本，听一下：
- `I have 1,234 apples.`
- `Use the API to connect.`
- `It's ninety degrees.`（en-US）
- `The quick brown fox.`（en-GB）

---

## 五、风险评估

### 高风险
- 无

### 中风险
- **字母 A 的改动会影响中日文拉丁段**（已上线）
  - 缓解：回归测试 parity 语料
  - 回滚：Git revert，10 秒恢复

### 低风险
- `1,NNN` 后处理可能有边界情况
- `ninety` 改写可能遗漏其他词
- en-GB 文档方案可能被用户投诉

**总体评估**：低风险，高收益，建议立即实施。

---

## 六、后续可能

如果修复后发现 WeText 还有其他问题（除了 `1,NNN`），再考虑：

1. **切换到 HeadTTS 的英文 TN**
   - HeadTTS 自带数字/日期/时间/金额规范化
   - MIT 许可，OOV 更好
   - 工作量：2-3 天

2. **修改 WeText 源码重建 FST**
   - 需要学习 pynini + WeText 构建流程
   - 工作量：3-5 天
   - 只在 WeText 问题系统性时才值得

3. **保持现状**
   - 如果只有 `1,NNN` 一个 bug，后处理足够

**当前建议**：先修 `1,NNN`，观察一段时间，再决定是否需要更大改动。

---

## 附录：参考资料

- `docs/superpowers/plans/p6-phase10-english.md` §四/§五：espeak vs Rust 对照
- `crates/phonemize/tests/wetext_en.rs`：当前被钉住的错误行为
- `docs/superpowers/plans/p6-9b4-shortest-path-bug.md`：WeText FST 的结构分析
- `crates/phonemize/src/backends/g2p_en.rs:107`：字母 A 读成冠词的现场
