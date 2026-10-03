# P6 最终决策：两次验证后的结论

**日期**: 2026-10-03  
**V0 验证**: @piper-plus/g2p@0.4.2 ❌ 失败  
**V1 验证**: piper-plus@0.7.0 Rust wasm ❌ 失败  
**结论**: 回到原 P6 计划（24 任务自建方案）

---

## 执行摘要

经过两轮验证（V0 + V1），我们排除了两个候选方案：

1. **@piper-plus/g2p** - 降级回退层，中日文不可用
2. **piper-plus Rust wasm** - 架构错配，只有日语部分可用

**最终决策：执行原 P6 计划**（8 阶段 24 任务，估算 2-3 周）

---

## 🔍 代码复用机会（新增）

虽然 piper-plus/g2p 的完整引擎不可用，但其**算法层**有高复用价值：

### ✅ 可复用模块

1. **日语韵律提取逻辑** ⭐⭐⭐⭐⭐
   - 文件：`src/ja/phoneme-extract.js` (200 行)
   - 价值：A1/A2/A3 → Kurihara 标记、N 音变规则、PUA 映射
   - 节省：2-3 天

2. **PUA 映射表** ⭐⭐⭐⭐
   - 文件：`src/pua-map.js` (99 项)
   - 价值：与 P6 spec §1.3 词表定义完全一致
   - 节省：半天

3. **语言检测器** ⭐⭐
   - 文件：`src/detect.js`
   - 价值：Unicode 范围检测，中英日混排分段
   - 节省：半天

**总节省**: ⏱️ **3-4 天开发时间**

详细分析：`p6-piper-plus-g2p-reuse-analysis.md`

---

## 两次验证的核心发现

### V0: @piper-plus/g2p@0.4.2（332 KB，纯 JS）

| 语言 | 结果 | 原因 |
|------|------|------|
| 中文 | ❌ | 无 G2P，原样返回汉字（93.3% vocab 缺失） |
| 日语 | ❌ | 需外部下载 ~55 MB 词典（违反零下载要求） |
| 英文 | ⚠️ | 可用但劣于 espeak（2/10 样本有硬错误） |

**根因**：这是降级回退层，不是完整实现。上游注释明确标注中日文需要 Rust wasm。

---

### V1: piper-plus@0.7.0 Rust wasm（57 MB）

| 语言 | 结果 | 原因 |
|------|------|------|
| 中文 | ❌ | 开箱返回汉字；词典未发布且格式不匹配；补词典后仍 70% vocab 不兼容 |
| 日语 | ⚠️ | **可用且质量优于现状**，但 31.4% vocab 缺失 + 音素体系不同 |
| 英文 | ❌ | **Rust wasm 里根本没有英语**（Cargo 特性无 `en`） |

**三条决定性问题**：

1. **英语不在这条链路里** - Cargo 特性 `["ja","zh","ko","es","fr","pt","sv"]` 无 `en`，57 MB 对英语毫无帮助，GPL 问题不解决

2. **中文是双重问题** - npm 包漏发词典（jsDelivr 404）；上游词典格式不匹配（带调符号 vs 要求行尾数字）；音素体系不同（IPA vs 注音符号）

3. **API 方向性错配** - 输出是 ID 而非音素串；映射外的音素静默替换成 PAD；P6 要的是「可直接进 Kokoro tokenizer 的音素串」

**唯一收获**：日语 jpreprocess + NAIST-JDIC（质量高于现状，零下载，MIT+BSD，冷启动 30 ms）值得单独评估

---

## 决策矩阵（最终）

| 维度 | piper-plus Rust | 原 P6 计划 | @piper-plus/g2p |
|------|----------------|-----------|-----------------|
| **中英日覆盖** | ❌ 日部分可用 | ✅ 3 语言 | ❌ 仅英文劣质可用 |
| **开箱即用** | ❌ 中文缺词典 | ✅ | ❌ 日文需下载 |
| **零适配工作** | ❌ 大量适配 | ✅ 按 spec 设计 | ❌ |
| **TN/FST** | ❌ 无 | ✅ P6 首要目标 | ❌ |
| **输出格式** | ❌ ID + PUA | ✅ 音素串 | ❌ |
| **Vocab 兼容** | ❌ 31-92% 缺失 | ✅ 按 vocab 设计 | ❌ 93% 缺失 |
| **英语方案** | ❌ 无 | ✅ espeak-ng | ⚠️ 劣于 espeak |
| **开发时间** | ~1-2 周适配 | 2-3 周 | N/A |
| **维护成本** | 中（依赖上游） | 高（自维护） | N/A |
| **许可证** | MIT+BSD | ⚠️ GPL (espeak) | MIT |
| **状态** | ✅ V1 验证完成 | ⏳ 待执行 | ✅ V0 验证完成 |

---

## 为什么不采用 piper-plus

### 1. 不是一个「三语 G2P 模块」

piper-plus 的架构定位：
- **英语**：由 JS 层（@piper-plus/g2p）承担 → V0 已判定失败
- **中文**：需要外部词典 + 格式转换 + 音素体系映射
- **日语**：Rust wasm 内置，质量好

它不是「装一个包就能替换现有三语链路」的方案，而是「需要大量适配工作」的半成品。

### 2. 核心目标不满足

P6 §0.2 的两条理由：

| 理由 | piper-plus 是否解决 |
|------|-------------------|
| ① TN / FST（数字、URL、缩写规范化） | ❌ 无。数字与拉丁文原样透传 |
| ② 日语汉字转换不再痛苦 | ⚠️ 部分。jpreprocess 替代 kuromoji，但音素体系不同 |

**TN/FST 是 P6 的首要目标**，而 piper-plus 完全没有这一层。

### 3. 适配工作量不小于自建

若要让 piper-plus 工作，需要：

**中文**：
- 补 2.7 MB 拼音词典
- 转换成 TONE3 格式（41,923 单字 + 143,863 音节）
- 映射 IPA 音素体系 → Kokoro 注音符号体系（~70% 不兼容）
- 自建 TN/FST 层

**日语**：
- 映射 PUA + 音高标记 + ASCII `g` → Kokoro 音素集
- 处理 31.4% vocab 缺失（6 个音素 + 音高标记）
- 产品决策：接受读音变化（`こんにちは` ha→wa）

**英语**：
- 自建或继续用 espeak（GPL 问题不解决）

**总计**：~1-2 周适配工作，且最终仍有 GPL 风险（英语）+ 音素体系不匹配（中文）。

### 4. API 错配

`phonemize()` 返回 ID 而非音素串，前提是「你有自己的模型，需要把音素映射成 ID」。

P6 的需求是「产出可直接进 Kokoro tokenizer 的音素串」——方向相反。

---

## 原 P6 计划的优势

### 1. 完全对齐需求

- ✅ 输出逐字符等于 JS 链（或有记录的更优）
- ✅ 三语完整覆盖
- ✅ TN/FST 作为核心目标
- ✅ 按 Kokoro vocab 设计，零适配
- ✅ 冷启动 < 100 ms
- ✅ 用户零下载

### 2. 技术路径清晰

**已实测可行**（P6 spec §1.4）：
- 日语：lindera + 假名映射表（10 ms 加载，0.11 ms/句）
- 中文：lindera + pinyin 表 + jieba
- 英语：espeak-ng C 源码编译（或评估其他方案）

**风险可控**：
- espeak GPL → 需法务确认（已知风险）
- C 编译复杂 → CI 多平台验证

### 3. 长期可维护

- 完全自主控制
- 可优化到 ~3 MB wasm + ~10 MB 压缩字典
- 不依赖上游的架构决策

---

## 唯一值得保留的：日语 jpreprocess

piper-plus 的日语部分（jpreprocess + NAIST-JDIC）**是有价值的**：

### 优势

- ✅ 质量高于现状 kana2ipa
  - 助词 は 读 wa（现链读 ha 是错的）
  - 长音、拨音变体、无声化、音高标记全部正确
- ✅ 零下载（词典编进 wasm）
- ✅ MIT+BSD-3-Clause（无 GPL）
- ✅ 冷启动 30 ms
- ✅ 替代 kuromoji（P6 §0.2 第二理由）

### 代价

- ⚠️ 57 MB wasm（55 MB 是词典）
- ⚠️ 单句 0.41 ms（比现链 0.18 ms 慢 2.3×，质量换的）
- ⚠️ 31.4% vocab 缺失（需适配层）
- ⚠️ 读音会变（`こんにちは` ha→wa，需产品决策）

### 建议

**在 P6 完成后**，作为独立的「P6.5 日语质量提升」任务评估：

1. 从 piper-plus 源码提取 jpreprocess Rust crate
2. 自建只含日语的 wasm（可能 ~15 MB）
3. 实现 PUA + 音高标记 → Kokoro 音素集映射
4. A/B 测试听感差异
5. 产品决策是否接受读音变化

**不作为 P6 的一部分**，因为：
- P6 目标是「等价替换 JS 链」
- 日语读音变化需要产品决策
- 不影响 P6 核心目标（TN/FST）

---

## 最终决策

### 执行原 P6 计划

理由：
1. 两次验证排除了「现成方案」的可能性
2. 原计划技术路径清晰、风险可控
3. 完全对齐需求，长期可维护
4. 已有详细实施计划（8 阶段 24 任务）

### 实施路径

**立即开始**：
- 使用 `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md` 的实施计划
- 执行方式：subagent-driven-development 或 executing-plans
- 估算时间：2-3 周

**espeak GPL 问题**：
- 提前与法务确认 GPL 许可兼容性
- 若不兼容，评估备选英语 G2P 方案
- 最坏情况：保留现有 espeak wasm（不改变现状）

**P6 完成后**：
- 评估 jpreprocess 日语质量提升（P6.5）
- 持续优化 wasm 体积和性能

---

## 方法论总结

### V0/V1 验证的价值

1. **避免了错误投入**
   - 直接自建：2-3 周后可能发现有现成方案
   - 直接用 piper-plus：1-2 周适配后发现架构不匹配

2. **获得了清晰的决策依据**
   - 30 条样本 × 3 链路对比
   - Vocab 兼容性量化（31-93% 缺失）
   - 性能基准（冷启动、单句耗时）

3. **发现了潜在的未来优化**
   - jpreprocess 日语质量提升
   - lindera 实测可用（V0 已验证）

### 两次验证的投入产出

| 项 | 投入 | 产出 |
|---|---|---|
| V0 | 694 秒（deepseek-flash） | 排除 @piper-plus/g2p，发现 Rust wasm |
| V1 | 1130 秒（deepseek-flash） | 排除 Rust wasm，发现 jpreprocess 价值 |
| **总计** | **~30 分钟** | **明确决策 + 未来优化方向** |

**结论**：30 分钟验证节省了 1-2 周的弯路，投入产出比极高。

---

## 下一步行动

### 立即执行

1. **确认 P6 实施方案**
   - 用户拍板：执行原 P6 计划
   - 选择执行方式（subagent-driven 或 inline）

2. **法务确认**
   - espeak-ng GPL-3.0 许可兼容性
   - 若不兼容，评估备选方案

3. **启动 P6 实施**
   - 按 24 任务逐步执行
   - 目标：2-3 周完成

### 可选（P6 完成后）

1. **P6.5：日语质量提升**
   - 提取 jpreprocess
   - 实现适配层
   - A/B 测试

2. **持续优化**
   - wasm 体积优化
   - 字典压缩算法
   - 冷启动时间

---

## 附录：验证交付物

### V0 验证（tests/v0/）

- ✅ v0-summary.md (13K)
- ✅ install-report.md (8K)
- ✅ piper-comparison.json
- ✅ vocab-check.json
- ✅ performance-results.json
- ✅ kokoro-vocabs.json（实测词表，可复现基准）

### V1 验证（tests/v1/）

- ✅ v1-summary.md (15K)
- ✅ install-report.md (11K)
- ✅ api-exploration.md (8K)
- ✅ piper-plus-comparison.json
- ✅ vocab-check.json
- ✅ performance-results.json
- ✅ wasm-harness.mjs（穷举 id map 反解 + PUA 展开）
- ✅ convert-pinyin-tone3.mjs（带调拼音格式转换器）

### 规划文档（docs/superpowers/plans/）

- ✅ 2026-10-03-p6-rust-phonemize-spec.md (111K, 3726 行)
- ✅ p6-implementation-summary.md (4.2K)
- ✅ p6-g2p-library-evaluation.md (6.5K)
- ✅ p6-decision-summary.md (6.0K)
- ✅ p6-v0-failure-analysis.md (6.4K)
- ✅ p6-final-decision.md (本文档)

---

**文档路径**: `docs/superpowers/plans/p6-final-decision.md`

