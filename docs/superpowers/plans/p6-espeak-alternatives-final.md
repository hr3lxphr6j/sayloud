# P6 阶段 4：英文 G2P 方案最终评估

**调研日期**：2026-10-03  
**触发原因**：espeak-ng-sys 不存在，C 源码编译路线不可行，需寻找替代方案

---

## 执行摘要

**关键发现**：用户直觉正确 —— piper-plus-g2p 不是只有 200 个词，而是有 **123,455 词的完整 CMU Dict**。

V0 验证报告中的"200 词"是**测试桩**，真实实现有：
- ✅ **完整 CMU Dict**（123,455 词，3.6 MB JSON）
- ✅ **Morphological fallback**（处理 -ing/-ed/-s/-er/-ly/-est）
- ✅ **编译时嵌入数据**（`include_str!` 模式）
- ✅ **能编译到 wasm32**（实测通过）
- ✅ **MIT 许可证**（无 GPL 风险）

---

## 方案对比

### 方案 A：espeak-ng-rs 0.2.0（纯 Rust 移植）

#### 技术细节
- **词典**：espeak-ng 数据（~1.03 MB）
- **许可证**：GPL-3.0-or-later ⚠️
- **wasm 体积**：~1.15 MB（引擎 130 KB + 数据 1.03 MB）
- **实现**：纯 Rust，无 C 依赖

#### 实测输出（en-us voice）
```
A P I       → ɐ pˈiː ˈaɪ
Chat        → tʃˈæt
Q           → kjˈuː
API         → ˈeɪ pˈiː ˈaɪ
Agent       → ˈeɪdʒənt
hello world → həlˈoʊ wˈɜːld
Kokoro      → kəkˈɔːɹoʊ
Python      → pˈaɪθɑn
JavaScript  → dʒˈɑvəskɹˌɪpt
```

#### 优势
- ✅ **处理所有 OOV 词**（Kokoro/OpenAI/GitHub 都能发音）
- ✅ 与 JS espeak 逐字符匹配（同源数据）
- ✅ 完全自包含（无运行时依赖）

#### 劣势
- ❌ **GPL-3.0 许可证**（静态链接进 wasm → 衍生作品认定风险）
- ❌ **需要 fork**（构造函数只支持 fs，需改造）
- ⚠️ 数据版本漂移（Kokoro: `ɔː` vs JS 的 `oː`）

---

### 方案 B：piper-plus-g2p 0.4.0（CMU Dict + 规则）⭐ 推荐

#### 技术细节
- **词典**：CMU Dict（123,455 词，3.6 MB JSON）
- **许可证**：MIT ✅
- **wasm 体积**：待测（预计 ~3.8 MB，dict 3.6 MB + 代码 ~200 KB）
- **实现**：纯 Rust，CMU Dict + morphological fallback

#### 实测输出
```
A P I       → ə pˈiː aɪ       (vs espeak: ɐ pˈiː ˈaɪ)
Chat        → tʃˈæt           (一致)
Q           → kjˈuː           (一致)
API         → (空)            (OOV，词典里是小写 api)
Agent       → ˈeɪdʒənt        (一致)
hello world → həlˈoʊ wˈɜːld   (一致)
Kokoro      → (空)            (OOV)
Python      → pˈaɪθɑn         (一致)
JavaScript  → dʒˈɑvəskɹˌɪpt   (一致)
```

#### 核心特性

**1. 完整的 CMU Dict（123,455 词）**
```bash
$ python3 -c "import json; print(len(json.load(open('cmudict_data.json'))))"
123455
```

**2. Morphological Fallback（英语派生词）**
```rust
// 支持的后缀：
-ing    (running → run + IH0 NG)
-ed     (walked → walk + D)
-s/-es  (cats → cat + Z, boxes → box + IH0 Z)
-ies    (countries → country + Z)
-er     (faster → fast + ER0)
-ly     (quickly → quick + L IY0)
-ily    (happily → happy + L IY0)
-est    (fastest → fast + AH0 S T)
```

**3. 编译时嵌入数据（支持 wasm）**
```rust
// src/english.rs:662
const CMU_DICT_JSON: &str = include_str!("../data/cmudict_data.json");
```

**4. OOV 处理策略**
- 词典查找失败 → 尝试 morphological fallback
- Fallback 失败 → **返回空串**（静默跳过）

#### 优势
- ✅ **MIT 许可证**（无 GPL 风险）
- ✅ **无需 fork**（官方支持 wasm）
- ✅ **高覆盖率**（123K 词 + morphological fallback）
- ✅ **质量高**（CMU Dict 是学术标准）
- ✅ **社区维护**（piper 是 Rhasspy 官方 TTS）

#### 劣势
- ⚠️ **OOV 词静默跳过**（API/Kokoro/OpenAI 返回空）
- ⚠️ **体积较大**（~3.8 MB vs espeak 的 1.15 MB）
- ⚠️ **音素细节差异**（`A P I` 的重音位置不同）

---

## OOV 词对比分析

### 关键差异

| 词 | espeak-ng-rs | piper-plus-g2p | JS espeak |
|---|---|---|---|
| **API** | ˈeɪ pˈiː ˈaɪ | (空) | ˈeɪ pˈiː ˈaɪ |
| **Kokoro** | kəkˈɔːɹoʊ | (空) | kəkˈoːɹoʊ |
| **OpenAI** | ˈoʊpənˌeɪ ˈaɪ | (空) | - |
| **GitHub** | ɡˈɪtˌhʌb | (空) | - |

### 影响评估

**场景 1：日语文本中的 Latin 段落**
```
こんにちは API です
```

- **espeak 路线**：所有 Latin 词都能发音（包括 API）
- **piper 路线**：`API` 返回空 → **需要 fallback 机制**

**场景 2：专有名词（品牌/产品/人名）**
- Kokoro、OpenAI、GitHub、ChatGPT 等都是 OOV
- piper 会静默跳过，espeak 会尝试发音

### 解决方案

**两个方向**：

1. **接受静默跳过**
   - 专有名词不发音（UI 提示"此词无发音数据"）
   - 只影响罕见词，常见词 123K 覆盖

2. **补充自定义词典**
   - piper 支持外挂词典（`CMUDICT_PATH` 环境变量）
   - 可以维护一个 `custom_words.json`（产品名/技术术语）
   - 例如：`{"api": "EY1 P IY1 AY1", "kokoro": "K OW0 K OW1 R OW0"}`

---

## 最终推荐

### 🏆 推荐方案：piper-plus-g2p 0.4.0

**理由**：
1. ✅ **MIT 许可证** —— 无法务风险，立即可用
2. ✅ **质量高** —— CMU Dict 是学术标准，123K 词覆盖率高
3. ✅ **官方支持 wasm** —— 无需 fork，维护成本低
4. ✅ **社区活跃** —— piper 是 Rhasspy 官方引擎，用户量大
5. ⚠️ **OOV 可补** —— 用自定义词典解决专有名词

**OOV 词的妥协**：
- 罕见专有名词（Kokoro/OpenAI）静默跳过可接受
- 可选：维护小型自定义词典（~100 词）补充技术术语
- 好处：避免 espeak 的"生造发音"（GitHub → ɡˈɪtˌhʌb 可能更奇怪）

### 实施方案

**阶段 4.1：集成 piper-plus-g2p**
```toml
[dependencies]
piper-plus-g2p = { version = "0.4.0", features = ["english"] }
```

**阶段 4.2：嵌入 CMU Dict**
- 数据已在 crate 内（`include_str!`）
- wasm 构建自动包含

**阶段 4.3：对照测试**
- 与 JS espeak 对比（接受音素细节差异）
- OOV 词标记为"预期跳过"

**阶段 4.4（可选）：自定义词典**
- 如果 OOV 词成为问题，补充 `custom_words.json`
- 先观察真实使用场景再决定

---

## 次选方案：espeak-ng-rs（需确认 GPL）

如果：
- 法务确认 GPL-3.0 静态链接可接受
- 需要 OOV 词的"尽力发音"
- 可以接受 fork 维护成本

则 espeak-ng-rs 是备选。

---

## 数据参考

**piper-plus-g2p 完整能力**：
```bash
# 词典规模
$ wc -c data/cmudict_data.json
3776640  # 3.6 MB

$ python3 -c "import json; print(len(json.load(open('data/cmudict_data.json'))))"
123455  # 123,455 词条

# 编译时嵌入
$ grep -n "include_str.*cmudict" src/english.rs
662:        const CMU_DICT_JSON: &str = include_str!("../data/cmudict_data.json");

# Morphological fallback
$ grep -A 5 "try_morphological_fallback" src/english.rs | head -10
/// Try morphological fallback for OOV words.
///
/// Strips common English suffixes and looks up the base form in the CMU
/// dictionary. If found, returns the base ARPAbet string with the suffix
/// phonemes appended. Returns `None` if no match is found.
///
/// Supported suffixes: -ing, -ed, -s/-es/-ies, -er, -ly/-ily, -est
```

**espeak-ng-rs 对比**：
```bash
# 体积
~1.15 MB (引擎 130 KB + 数据 1.03 MB)

# OOV 处理
所有词都能发音（基于规则引擎）

# 许可证
GPL-3.0-or-later（阻断点）
```

---

## 决策点

**请确认**：

1. **接受 piper-plus-g2p 的 OOV 静默跳过**？
   - 是 → 立即启动阶段 4（预计 1 天）
   - 否 → 需要评估 GPL 风险或寻找其他方案

2. **是否需要自定义词典**？
   - 先不加 → 观察真实使用
   - 立即加 → 我准备 100 词技术术语表

---

## 结论

**piper-plus-g2p 是最佳选择**：
- ✅ 许可证清晰（MIT）
- ✅ 质量高（CMU Dict）
- ✅ 维护成本低（官方支持）
- ✅ 覆盖率足够（123K + fallback）
- ⚠️ OOV 静默跳过可接受（或用小词典补）

**用户的直觉完全正确** —— 200 词确实不合理，真相是 123,455 词的完整实现。
