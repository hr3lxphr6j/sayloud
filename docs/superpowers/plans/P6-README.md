# P6 文档说明

## 📄 主文档

**[P6-FINAL.md](./P6-FINAL.md)** - P6 项目最终架构文档（唯一权威来源）

这是 P6 项目的**唯一权威文档**，包含：
- 项目概述和目标
- 已完成工作（阶段 1-8）
- 当前架构
- 最终目标架构（阶段 9）
- 关键技术决策
- 实施路线图
- 历史决策与教训

**其他 P6 文档仅作为历史参考，不应作为决策依据。**

---

## 📚 保留的历史文档

### 实施记录（历史价值）

这些文档记录了各阶段的具体实施过程，保留作为历史参考：

- `p6-implementation-summary.md` - 阶段 1-3 总结
- `p6-phase3-corrections.md` - 日语 G2P 实施
- `p6-phase4-corrections.md` - 英文 G2P 实施（含 espeak 失败分析）
- `p6-phase5-plan.md` - 英文数字转换
- `p6-phase5-rust-vs-js-comparison.md` - 阶段 5 对照分析
- `p6-zh-pinyin-and-vocab-gate.md` - 中文 G2P 和 Vocab 闸门
- `p6-zh-frontend.md` - 中文前端组装
- `p6-phase7-two-workers.md` - 双 worker 架构
- `p6-phase8-cleanup.md` - JS 链清理
- `p6-9b2-implementation.md` - **阶段 9B.2：英文 WeText TN 集成**（含实测数字与三处评估更正）

### 调研资料（参考价值）

这些文档记录了技术调研过程，保留作为技术参考：

- `p6-espeak-alternatives-final.md` - 英文 G2P 方案对比（espeak vs piper）
- `p6-g2p-library-evaluation.md` - G2P 库评估
- `p6-paddlespeech-analysis.md` - PaddleSpeech 中文 G2P 分析
- `p6-piper-plus-g2p-reuse-analysis.md` - piper-plus 代码复用分析
- `p6-v0-failure-analysis.md` - V0 实验失败分析

---

## 🗑️ 已删除的过时文档

以下文档基于错误前提或已过时，已被删除：

### 基于 GPL 误判的文档
- ❌ `p6-phase9-final-plan.md` - HeadTTS 移植计划（基于 GPL 误判）
- ❌ `p6-phase9-headtts-integration.md`
- ❌ `p6-phase9-wetext.md`
- ❌ `p6-final-roadmap.md` - 包含 GPL 替换内容
- ❌ `p6-next-steps.md` - 包含 GPL 替换内容

### 过程性文档（已被 P6-FINAL.md 取代）
- ❌ `p6-architecture-evaluation.md`
- ❌ `p6-architecture-review-summary.md`
- ❌ `p6-complete-work-summary.md`
- ❌ `p6-decision-summary.md`
- ❌ `p6-final-decision.md`
- ❌ `p6-final-recommendation.md`
- ❌ `p6-final-status.md`
- ❌ `p6-license-correction.md`
- ❌ `p6-oov-verification.md`
- ❌ `p6-revised-final-plan.md`
- ❌ `p6-phonemize-architecture-review.md`

---

## 📖 如何使用这些文档

### 如果你想了解 P6 项目

➡️ **先读 [P6-FINAL.md](./P6-FINAL.md)**

这是唯一的权威文档，包含所有关键信息。

### 如果你想了解某个阶段的实施细节

➡️ **查看对应的 `p6-phase*.md` 文档**

例如：
- 阶段 3（日语）→ `p6-phase3-corrections.md`
- 阶段 4（英文）→ `p6-phase4-corrections.md`
- 阶段 8（清理）→ `p6-phase8-cleanup.md`

### 如果你想了解技术调研过程

➡️ **查看调研资料文档**

例如：
- 英文 G2P 方案 → `p6-espeak-alternatives-final.md`
- PaddleSpeech 分析 → `p6-paddlespeech-analysis.md`

---

## ⚠️ 重要提示

1. **P6-FINAL.md 是唯一权威文档**
   - 其他文档仅作为历史参考
   - 任何冲突以 P6-FINAL.md 为准

2. **历史文档可能包含过时信息**
   - 例如：`p6-phase4-corrections.md` 中说 piper "OOV 静默跳过"，但实际代码有字母拼读 fallback
   - 阅读时注意文档编写时间和上下文

3. **已删除的文档不应再参考**
   - 这些文档基于错误前提（如 GPL 误判）
   - 已被 P6-FINAL.md 取代

---

**最后更新**: 2026-10-04  
**维护者**: TTS-NG 团队
