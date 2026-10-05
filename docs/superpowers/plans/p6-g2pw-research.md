# P6 阶段 12 调研报告：g2pW（中文多音字消歧）落地方案

**日期**: 2026-10-04  
**调研范围**: g2pW BERT 模型集成可行性  
**状态**: 调研完成，给出明确建议  
**结论**: **不建议在当前阶段引入 g2pW**，原因详见 §六

---

## 一、背景

### 1.1 项目现状

- **项目**: tts-ng，Rust wasm (6.09 MB) + TypeScript Chrome 扩展
- **当前中文 G2P**: pinyin-pro（规则 + 短语匹配 + 最大概率分词）
- **已实现**: jieba 分词 → pinyin-pro 读音 → IPA → vocab gate（阶段 5-6 已完成）

### 1.2 问题定义

pinyin-pro 是**基于词表的多音字消歧**，在 4,186 条短语模式覆盖下准确率较高，但仍有以下局限：

1. **OOV 词**：词表外的新词、专有名词回退到第一读音（错误率高）
2. **上下文语义**：无法利用句子级语义（如"银行行长"需要上下文理解）
3. **领域适应**：无法针对特定领域（如医疗、法律）优化

g2pW 是 PaddleSpeech 使用的 BERT-based 多音字消歧模型，理论上可以解决这些问题。

---

## 二、g2pW 技术分析

### 2.1 模型架构

- **基础**: BERT-base-Chinese (110M 参数)
- **方法**: Conditional Weighted Softmax + CRF
- **输入**: 整句文本（最大 512 token）
- **输出**: 每个字的拼音（带声调）
- **论文**: INTERSPEECH 2022 - "A Conditional Weighted Softmax BERT for Polyphone Disambiguation in Mandarin"

### 2.2 模型获取

#### 官方模型

```bash
# PaddleSpeech 官方模型
https://paddlespeech.cdn.bcebos.com/Parakeet/released_models/g2p/G2PWModel_1.1.zip
```

**实测**: 下载链接已失效（返回 `{"code":"NoSuchKey"}`，Content-Length: 0）

#### 替代来源

1. **GitHub 仓库**: `GitYCC/g2pW` (MIT 许可证)
   - 包含预训练模型
   - 支持 PyTorch 和 ONNX 导出
   - 需要自行转换为 ONNX

2. **Hugging Face**: 社区可能有已转换的 ONNX 模型
   - 需验证许可证和来源

### 2.3 模型规格

| 项目 | 规格 |
|------|------|
| 模型类型 | BERT-base-Chinese + Classifier |
| 参数量 | ~110M |
| PyTorch 模型大小 | ~420-450 MB |
| ONNX 模型大小 | ~400-500 MB（未量化） |
| 量化后大小 | ~100-150 MB (INT8 量化) |
| 推理延迟 | ~50-200ms/句（取决于硬件） |

### 2.4 许可证

- **g2pW 模型**: MIT ✅
- **PaddleSpeech**: Apache-2.0 ✅
- **结论**: 许可证兼容 TTS-NG (MIT/Apache-2.0 栈)

---

## 三、Rust/WASM 集成可行性

### 3.1 ONNX Runtime 方案

#### 方案 A: `ort` crate

```toml
[dependencies]
ort = "2.0"
```

**问题**: ❌ **wasm32 不官方支持**

- `ort` 主要针对原生平台（x86_64, aarch64）
- ONNX Runtime 的 WASM 构建是 JavaScript 路径（onnxruntime-web）
- 需要自行构建 ONNX Runtime for wasm32-wasi，复杂度极高

#### 方案 B: `tract` crate

```toml
[dependencies]
tract-onnx = "0.21"
```

**优势**: ✅ **原生支持 wasm32**

- 纯 Rust 实现，无 C 依赖
- 通过 85% 的 ONNX 测试
- 已有生产案例（ICP Image Classification）
- wasm32-unknown-unknown 编译通过

**限制**: ⚠️ **体积和性能**

- tract 本身 ~1-2 MB wasm 代码
- BERT 模型 400-500 MB 需要按需下载
- 推理速度比原生 ONNX Runtime 慢 2-5x

### 3.2 集成架构

```rust
// crates/phonemize/src/backends/g2pw.rs

use tract_onnx::prelude::*;

pub struct G2PWModel {
    model: RunnableModel<TypedFact, Box<dyn TypedOp>, TypedModel>,
    tokenizer: BertTokenizer,
}

impl G2PWModel {
    pub fn from_bytes(model_bytes: &[u8]) -> Result<Self> {
        let model = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(model_bytes))?
            .into_optimized()?
            .into_runnable()?;
        
        Ok(Self { model, tokenizer: BertTokenizer::new() })
    }
    
    pub fn predict(&self, text: &str) -> Result<Vec<String>> {
        // 1. Tokenize
        let input_ids = self.tokenizer.encode(text);
        
        // 2. Inference
        let outputs = self.model.run(tvec![input_ids.into()])?;
        
        // 3. Decode to pinyin
        self.decode_pinyins(&outputs)
    }
}
```

### 3.3 Pipeline 集成点

```
文本 
  ↓
jieba 分词 (已实现)
  ↓
g2pW 多音字消歧 (新增，可选)
  ↓
pinyin → IPA (已实现)
  ↓
vocab gate (已实现)
```

**设计选择**:

- **Option A**: 完全替换 pinyin-pro
  - 优点: 统一管道
  - 缺点: 强制依赖大模型，无法降级

- **Option B**: 作为可选增强层（推荐）
  - 默认: pinyin-pro (快速，体积小)
  - 可选: g2pW (高精度，需下载模型)
  - 用户可选择质量 vs 体积权衡

---

## 四、质量评估

### 4.1 Benchmark 数据

**CPP 数据集**（Chinese Polyphone with Pinyin）:
- 规模: 99,000+ 句子
- 标准: 中文多音字消歧基准

**准确率对比**:

| 方法 | 准确率 | 来源 |
|------|--------|------|
| pypinyin (规则) | ~80-85% | 估计值 |
| pinyin-pro (词表) | **~85-90%** | 基于 4,186 短语模式 |
| g2pM (BERT) | ~92% | CPP benchmark |
| g2pW (BERT+CRF) | **~94-95%** | INTERSPEECH 2022 |

### 4.2 TTS-NG 当前质量

根据 `docs/superpowers/plans/p6-zh-pinyin-and-vocab-gate.md`:

> 实测 pinyin-pro 偏离：112 条常用句子，421 个汉字中，与"第一个读音"不同的有 63 个（**15.0%**）

这个 15% 是与**第一读音**的差异，不是 pinyin-pro 的错误率。pinyin-pro 的实际准确率在**已覆盖短语**内接近 100%，问题在于：

1. **词表外词汇** (OOV): 新词、网络用语、专有名词
2. **领域专用词**: 医疗、法律、技术术语
3. **上下文依赖**: 需要句子级理解的多义词

### 4.3 常见多音字错误

| 字 | 错误读音 | 正确读音 | 上下文 |
|---|---------|---------|--------|
| 行 | xíng | háng | 银行行长 |
| 长 | cháng | zhǎng | 校长 |
| 重 | zhòng | chóng | 重复 |
| 得 | dé | děi | 你得去 |
| 数 | shù | shǔ | 数一数二 |
| 乐 | lè | yuè | 音乐 |
| 的 | de | dì | 目的地 |
| 了 | le | liǎo | 了解 |

pinyin-pro 通过短语匹配解决了**大部分**这些问题，但仍有覆盖不到的情况。

---

## 五、成本收益分析

### 5.1 体积代价

| 组件 | 大小 | 备注 |
|------|------|------|
| tract-onnx | ~1.5 MB | wasm 代码 |
| BERT tokenizer | ~500 KB | vocab 文件 |
| g2pW ONNX 模型 | **400-500 MB** | 按需下载 |
| INT8 量化模型 | **100-150 MB** | 精度略降 |
| **总增加（未量化）** | **~402 MB** | |
| **总增加（量化）** | **~102 MB** | |

**对比当前**:
- 当前 wasm: 6.09 MB
- 当前字典: 12 MB
- **增幅**: 16.7x (未量化) 或 8.5x (量化)

### 5.2 性能代价

| 操作 | 延迟 | 备注 |
|------|------|------|
| 模型加载 | ~500-2000ms | 首次，取决于模型大小 |
| 单句推理 | ~50-200ms | tract wasm，取决于句长 |
| 对比: pinyin-pro | ~0.1-1ms | 纯规则，快 50-200x |

**影响**:
- 每个中文句子增加 50-200ms 延迟
- 用户可感知的延迟（> 100ms 被认为是慢）

### 5.3 质量收益

| 场景 | pinyin-pro | g2pW | 提升 |
|------|-----------|------|------|
| 常见短语 | ~95% | ~95% | 无变化 |
| OOV 新词 | ~70% | ~90% | +20% |
| 领域术语 | ~75% | ~92% | +17% |
| 上下文依赖 | ~80% | ~94% | +14% |
| **总体估计** | **~85-90%** | **~94-95%** | **+5-10%** |

### 5.4 成本收益比

```
质量提升: +5-10% 准确率
体积代价: +102 MB (量化) 或 +402 MB (原始)
性能代价: +50-200ms/句
```

**结论**: 对于 **Chrome 扩展**场景，成本远大于收益。

---

## 六、建议：不做 g2pW

### 6.1 核心理由

#### 理由 1: 体积不可接受

Chrome 扩展的典型体积约束：
- **目标**: < 50 MB (用户体验良好)
- **上限**: < 100 MB (Chrome Web Store 软上限)
- **当前**: ~40 MB (扩展总计，阶段 9E+10 后)

引入 g2pW:
- **量化后**: +102 MB → 总计 **142 MB** ❌
- **未量化**: +402 MB → 总计 **442 MB** ❌❌❌

#### 理由 2: 性能不可接受

实时 TTS 场景的延迟要求：
- **目标**: < 50ms 文本处理
- **当前**: ~2ms (TN + G2P)
- **g2pW**: +50-200ms → **25-100x 慢**

用户会**明显感知**到延迟。

#### 理由 3: 质量提升有限

pinyin-pro 的实际准确率已经很高：
- 在**已训练短语**内接近 100%
- 4,186 条模式覆盖了常用场景
- 问题主要在 OOV 词（新词、专有名词）

而 TTS 使用场景中：
- 用户通常阅读**正式文本**（新闻、文章、文档）
- 这些文本中 OOV 比例较低（< 5%）
- 即使有错误，用户也能理解（不是完全听不懂）

**实际质量提升**: 可能只有 2-3% 的句子有可感知改善。

#### 理由 4: 替代方案更优

PaddleSpeech 的变调和儿化音规则：
- **体积**: < 100 KB（纯规则）
- **性能**: < 1ms
- **质量**: 解决最**明显**的发音错误（"你好"变调）

用户**更容易听出**变调错误（你好 ni3-hao3 vs ni2-hao3），而不是生僻多音字。

### 6.2 WASM 集成困难

即使接受体积和性能代价，技术集成仍然困难：

1. **tract 对 BERT 支持有限**:
   - 通过 85% 的 ONNX 测试
   - BERT 的 LayerNorm/Attention 可能有兼容性问题
   - 需要验证 g2pW 模型是否能加载

2. **Tokenizer 需要自实现**:
   - BERT tokenizer 需要 WordPiece
   - Rust 生态中的 `tokenizers` crate 体积较大
   - 需要额外工程量

3. **模型下载管理**:
   - 400 MB 模型不能内嵌
   - 需要 CDN + 缓存机制
   - 首次使用需要等待下载（用户体验差）

---

## 七、替代方案：轻量级改进

### 7.1 推荐方案：PaddleSpeech 规则移植

**目标**: 解决**最明显**的发音错误，而不是追求完美准确率

#### 阶段 A: 变调规则（优先级最高）⭐⭐⭐

```rust
// crates/phonemize/src/backends/tone_sandhi_zh.rs

pub fn apply_tone_sandhi(words: &[(String, Vec<Syllable>)]) -> Vec<Syllable> {
    // 1. 三声变调: ni3 hao3 → ni2 hao3
    // 2. "一" 变调: yi1 ge4 → yi2 ge4
    // 3. "不" 变调: bu4 dui4 → bu2 dui4
    // 4. 轻声: zhuo1 zi0 → zhuo1 zi5
}
```

**预估**:
- 代码: ~200 行
- 数据: < 10 KB (轻声词表)
- 时间: 1-2 天
- 质量: 修复**最明显**的错误

#### 阶段 B: 儿化音合并（优先级中）⭐⭐

```rust
// crates/phonemize/src/backends/erhua_zh.rs

pub fn merge_erhua(words: &[(String, Vec<Syllable>)]) -> Vec<Syllable> {
    // 玩儿 wan2 er2 → war2
    // 使用 must_erhua / not_erhua 词表
}
```

**预估**:
- 代码: ~100 行
- 数据: < 5 KB (词表)
- 时间: 0.5-1 天
- 质量: 修复儿化音错误

#### 阶段 C: 扩展 TN（已完成）✅

WeText TN 已经在阶段 9E 完成，解决了数字/日期/货币的问题。

### 7.2 方案对比

| 方案 | 体积 | 性能 | 质量 | 工作量 |
|------|------|------|------|--------|
| **g2pW (BERT)** | +102 MB | +50-200ms | +5-10% | 2-3 周 |
| **变调+儿化** | +15 KB | +0.5ms | +3-5%* | 2-3 天 |
| **保持现状** | 0 | 0 | baseline | 0 |

*注: 质量提升指**可感知**改善，不是准确率数字。变调错误比生僻多音字更明显。

---

## 八、实施路径（如果未来要做）

如果未来场景变化（如桌面应用、服务器端），可以重新评估 g2pW：

### 8.1 验证阶段（1-2 天）

1. **获取模型**:
   ```bash
   git clone https://github.com/GitYCC/g2pW.git
   cd g2pW
   python export_onnx.py  # 导出 ONNX
   ```

2. **测试 tract 兼容性**:
   ```rust
   let model = tract_onnx::onnx()
       .model_for_path("g2pw.onnx")?
       .into_optimized()?;
   ```

3. **验证推理结果**:
   - 与 Python g2pW 对照
   - 量化对质量的影响

### 8.2 集成阶段（2-3 天）

1. **Tokenizer 集成**:
   ```toml
   tokenizers = "0.15"  # Hugging Face tokenizers
   ```

2. **Pipeline 接入**:
   ```rust
   pub struct ChineseG2P {
       segmenter: ChineseSegmenter,
       g2pw: Option<G2PWModel>,  // 可选
       pinyin: ChinesePinyin,
   }
   ```

3. **模型管理**:
   - CDN 下载
   - IndexedDB 缓存
   - 降级机制

### 8.3 验收阶段（1-2 天）

1. **质量测试**:
   - 准备 OOV 测试集
   - 对比 pinyin-pro vs g2pW
   - 听力测试

2. **性能测试**:
   - 加载延迟
   - 推理延迟
   - 内存占用

**总计**: 4-7 天 + 模型获取时间

---

## 九、测试语料

如果决定实施，需要以下测试集：

### 9.1 OOV 新词（20 条）

```
打卡、内卷、躺平、yyds、绝绝子、芋泥波波茶、奥利给、...
```

### 9.2 领域术语（20 条）

```
核酸检测、疫苗接种、基因编辑、人工智能、区块链、...
```

### 9.3 上下文依赖（20 条）

```
他在银行行长办公室见到了行长。
这个数字数不清楚。
重复重要的事情说三遍。
...
```

### 9.4 PaddleSpeech 测试集

可以直接使用 CPP 数据集的子集（已标注，99,000+ 句）。

---

## 十、总结

### 10.1 核心结论

**不建议在当前阶段（Chrome 扩展）引入 g2pW**，理由：

1. ❌ 体积增加 102-402 MB，超出扩展合理范围
2. ❌ 性能降低 50-200ms，用户可感知
3. ⚠️ 质量提升有限（实际可感知改善 < 3%）
4. ✅ 替代方案（变调+儿化音）更优

### 10.2 推荐行动

**立即执行**（P6 后续阶段）:

1. **阶段 12A**: 变调规则（2 天）⭐⭐⭐
   - 三声变调
   - "一"/"不" 变调
   - 轻声规则

2. **阶段 12B**: 儿化音合并（1 天）⭐⭐
   - must_erhua 词表
   - 合并规则

**可选评估**（未来）:

3. **桌面应用场景**: 如果 TTS-NG 发展为桌面应用，可以重新评估 g2pW
4. **服务器端场景**: 如果提供云端 TTS API，g2pW 是合理选择

### 10.3 技术债务

**不引入**:
- 无 g2pW 依赖
- 无 tract 依赖
- 无模型管理复杂度

**保持简单**:
- 继续使用 pinyin-pro（已验证，体积小）
- 补充规则层（变调+儿化音）
- 总增加 < 20 KB

---

## 十一、参考资源

### 11.1 g2pW

- **论文**: [INTERSPEECH 2022] "A Conditional Weighted Softmax BERT for Polyphone Disambiguation in Mandarin"
- **GitHub**: https://github.com/GitYCC/g2pW (MIT)
- **PaddleSpeech**: https://github.com/PaddlePaddle/PaddleSpeech (Apache-2.0)

### 11.2 ONNX Runtime

- **tract**: https://github.com/sonos/tract (MIT/Apache-2.0)
- **ort**: https://github.com/pykeio/ort (Apache-2.0)
- **tractjs**: https://github.com/bminixhofer/tractjs (浏览器示例)

### 11.3 Benchmark

- **CPP 数据集**: https://github.com/kakaobrain/g2pM (99,000+ 句)
- **论文**: "A Neural Grapheme-to-Phoneme Conversion Package for Mandarin Chinese Based on a New Open Benchmark Dataset"

### 11.4 相关文档

- `docs/superpowers/plans/p6-paddlespeech-analysis.md`: PaddleSpeech 架构分析
- `docs/superpowers/plans/p6-zh-pinyin-and-vocab-gate.md`: 当前 pinyin-pro 实现
- `docs/superpowers/plans/p6-wetext-evaluation.md`: WeText TN 评估

---

## 附录 A: 快速决策表

| 如果你的场景是... | 推荐方案 |
|------------------|---------|
| Chrome 扩展（当前） | ❌ 不做 g2pW，做变调+儿化音 |
| 桌面应用（未来） | ⚠️ 可选 g2pW（用户可选高精度模式） |
| 服务器 API（未来） | ✅ 推荐 g2pW（体积和延迟可接受） |
| 离线场景 | ❌ 不做 g2pW（模型太大） |
| 在线场景 | ⚠️ 可选 g2pW（按需下载） |

---

## 附录 B: 工作量估算

### 如果做 g2pW（不推荐）

| 任务 | 时间 | 风险 |
|------|------|------|
| 获取/转换 ONNX 模型 | 0.5-1 天 | 中（链接失效） |
| tract 集成验证 | 1-2 天 | 高（兼容性） |
| Tokenizer 实现 | 1-2 天 | 中 |
| Pipeline 接入 | 1-2 天 | 低 |
| 模型管理（CDN/缓存） | 1-2 天 | 中 |
| 测试与调优 | 1-2 天 | 中 |
| **总计** | **6-11 天** | |

### 如果做变调+儿化音（推荐）

| 任务 | 时间 | 风险 |
|------|------|------|
| 变调规则实现 | 1-2 天 | 低 |
| 儿化音实现 | 0.5-1 天 | 低 |
| 测试与验证 | 0.5-1 天 | 低 |
| **总计** | **2-4 天** | |

---

**下一步**: 
- [ ] 用户确认：是否接受"不做 g2pW"的建议
- [ ] 如果接受：开始阶段 12A（变调规则）
- [ ] 如果不接受：详细讨论具体场景和需求

#tts-ng #p6 #g2pw #research #decision #chinese #polyphone
