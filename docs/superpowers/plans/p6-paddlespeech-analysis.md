# PaddleSpeech 中文 G2P 架构分析

**日期**: 2026-10-04  
**目的**: 对比 PaddleSpeech 与 TTS-NG 的中文文本处理管线

---

## 📊 PaddleSpeech 架构总览

### 核心流程

```
输入文本
  ↓
TextNormalizer (文本规范化 TN)
  - 繁简转换
  - 全角→半角
  - 日期/时间规范化
  - 数字→文字
  - 电话号码
  - 温度/度量单位
  - 百分比/分数/范围
  - 希腊字母
  ↓
jieba 分词 (psg.lcut)
  ↓
多音字消歧 (3 种模式)
  - pypinyin: 基于词库
  - g2pM: BERT 模型
  - g2pW: BERT + 权重 (推荐)
  ↓
变调处理 (ToneSandhi)
  - 三声变调
  - "一"/"不" 变调
  - 语境变调
  ↓
儿化音合并
  - 必须儿化词表
  - 不儿化词表
  - 位置判断
  ↓
韵律预测 (可选)
  - RhyPredictor
  - 韵律边界标记
  ↓
拼音→IPA
```

---

## 🔍 关键组件详解

### 1. TextNormalizer (TN)

**文件**: `paddlespeech/t2s/frontend/zh_normalization/text_normlization.py`

**功能**:

| 类型 | 正则表达式 | 处理函数 | 示例 |
|------|-----------|---------|------|
| 日期 | `RE_DATE` | `replace_date` | "2024/1/15" → "二零二四年一月十五日" |
| 时间 | `RE_TIME` | `replace_time` | "10:30" → "十点三十分" |
| 温度 | `RE_TEMPERATURE` | `replace_temperature` | "25°C" → "二十五摄氏度" |
| 电话 | `RE_MOBILE_PHONE` | `replace_mobile` | "13812345678" → "幺三八..." |
| 分数 | `RE_FRAC` | `replace_frac` | "1/3" → "三分之一" |
| 百分比 | `RE_PERCENTAGE` | `replace_percentage` | "50%" → "百分之五十" |
| 范围 | `RE_RANGE` | `replace_range` | "10~20" → "十至二十" |
| 数字 | `RE_NUMBER` | `replace_number` | "123" → "一百二十三" |

**特色功能**:

```python
# 希腊字母转换
'α' → '阿尔法'
'β' → '贝塔'
'Δ' → '德尔塔'

# 标记转换
'①' → '一'
'/' → '每'
'~' → '至'

# 特殊字符过滤
re.sub(r'[-——《》【】<=>{}()（）#&@""^_|…\\]', '', sentence)
```

---

### 2. 多音字消歧 (Polyphonic)

**三种模式**:

#### 模式 1: pypinyin (规则)
```python
from pypinyin import lazy_pinyin, Style

# 基于词库
lazy_pinyin(word, neutral_tone_with_five=True, style=Style.INITIALS)
lazy_pinyin(word, neutral_tone_with_five=True, style=Style.FINALS_TONE3)

# 自定义词库
load_phrases_dict({
    '开户行': [['ka1i'], ['hu4'], ['hang2']],
    '发卡行': [['fa4'], ['ka3'], ['hang2']],
})
```

**优点**: 快速，无需模型  
**缺点**: 准确率较低（~85%）

#### 模式 2: g2pM (BERT)
```python
from g2pM import G2pM

g2pM_model = G2pM()
pinyins = g2pM_model(text, tone=True, char_split=False)
```

**优点**: 上下文感知  
**缺点**: 需要加载模型，较慢

#### 模式 3: g2pW (推荐)
```python
from paddlespeech.t2s.frontend.g2pw import G2PWOnnxConverter

g2pW_model = G2PWOnnxConverter(
    style='pinyin', 
    enable_non_tradional_chinese=True
)
pinyins = g2pW_model(sentence)[0]
```

**特点**:
- 整句预测（不是逐词）
- ONNX 推理（快速）
- 繁体输入
- 准确率最高（~95%）

**论文**: [g2pW: A Conditional Weighted Softmax BERT for Polyphone Disambiguation](https://github.com/GitYCC/g2pW)

---

### 3. 变调处理 (ToneSandhi)

**文件**: `paddlespeech/t2s/frontend/tone_sandhi.py`

**规则**:

| 规则 | 示例 | 说明 |
|------|------|------|
| 三声变调 | "你好" → "ni2 hao3" | 两个三声，前一个变二声 |
| "一" 变调 | "一个" → "yi2 ge4" | 后接去声变二声 |
| "不" 变调 | "不对" → "bu2 dui4" | 后接去声变二声 |
| 轻声 | "桌子" → "zhuo1 zi5" | 助词轻读 |

**实现**:
```python
def modified_tone(self, word: str, pos: str, finals: List[str]) -> List[str]:
    # 1. 三声变调
    finals = self._three_sandhi(word, finals)
    # 2. "一"/"不" 变调
    finals = self._yi_sandhi(word, finals)
    finals = self._bu_sandhi(word, finals)
    # 3. 轻声
    finals = self._neural_sandhi(word, pos, finals)
    return finals
```

---

### 4. 儿化音处理

**三个词表**:

```python
# 必须儿化
must_erhua = {
    "小院儿", "胡同儿", "范儿", "老汉儿", "撒欢儿"
}

# 不儿化
not_erhua = {
    "虐儿", "为儿", "护儿", "幼儿", "孤儿", "婴儿",
    "女儿", "男儿", "花儿", "鸟儿", "猫儿", "狗儿"
}

# POS 过滤
if pos in {"a", "j", "nr"}:  # 形容词/简称/人名
    return  # 不儿化
```

**合并规则**:
```python
# "玩儿" → ['w', 'ar2']  (不是 ['w', 'an2', 'er2'])
if word[-1] == "儿" and finals[-1] == 'er2':
    finals[-2] = finals[-2][:-1] + 'r' + finals[-2][-1]  # 韵母 + r
    finals.pop()  # 删除 er
```

---

### 5. 韵律预测 (RhyPredictor)

**可选功能**，添加韵律边界标记：

```python
# 输入
"我们一起去吃饭吧"

# 输出 (带韵律标记)
"我们#1一起#2去吃饭#3吧#4"

# sp1/sp2/sp3/sp4 对应不同长度的停顿
```

---

## 🆚 与 TTS-NG 的对比

### 当前 TTS-NG 实现

| 模块 | TTS-NG | PaddleSpeech |
|------|--------|--------------|
| **TN** | ✅ 数字 (自实现) | ✅ 完整 (日期/时间/电话/温度/...) |
| **分词** | ✅ jieba-rs | ✅ jieba (Python) |
| **多音字** | ✅ pinyin-pro | ✅ g2pW (BERT) |
| **变调** | ❌ | ✅ ToneSandhi |
| **儿化音** | ❌ | ✅ 词表 + 规则 |
| **韵律** | ❌ | ✅ RhyPredictor (可选) |
| **拼音→IPA** | ✅ pinyin-table.json | ✅ generate_lexicon |

---

## 📋 TTS-NG 缺失的功能

### 高优先级

1. **变调处理** ⚠️
   - 当前: "你好" → [ni3, hao3] (错误)
   - 应该: "你好" → [ni2, hao3] (前字变二声)
   
2. **儿化音** ⚠️
   - 当前: "玩儿" → [wan2, er2] (两个音节)
   - 应该: "玩儿" → [war2] (合并)

3. **TN 完整性** ⚠️
   - 当前: 只支持数字
   - 缺失: 日期/时间/电话/温度/分数/百分比/...

### 中优先级

4. **轻声处理**
   - "桌子" 的 "子" 应该是轻声 (tone5)

5. **"一"/"不" 变调**
   - "一个" 的 "一" 应该从 tone1 变 tone2

6. **多音字精度**
   - 当前: pinyin-pro (规则)
   - 可选: g2pW (BERT, 更准确)

### 低优先级

7. **韵律预测**
   - 长句停顿标记

8. **希腊字母**
   - "α" → "阿尔法"

---

## 💡 行动建议

### 方案 A: 轻量级补全 (推荐) ⭐

**只补核心功能，不引入新依赖**

```rust
// 1. 变调规则 (自实现 ~200 行)
crates/phonemize/src/backends/tone_sandhi_zh.rs

// 2. 儿化音合并 (自实现 ~100 行)
crates/phonemize/src/backends/erhua_zh.rs

// 3. TN 扩展 (WeText)
// 复用阶段 9 的 WeText 方案
```

**预估时间**: 2-3 天

**收益**:
- ✅ 解决最明显的发音错误（变调/儿化）
- ✅ 完整的 TN 功能
- ✅ 零新增模型依赖
- ✅ 体积增加 < 100 KB

---

### 方案 B: 全功能移植

**移植 PaddleSpeech 全部功能**

```rust
// 1. TN 完整移植
crates/phonemize/src/backends/zh_normalization/

// 2. g2pW 集成 (ONNX)
crates/phonemize/src/backends/g2pw/

// 3. 变调/儿化/韵律
crates/phonemize/src/backends/tone_sandhi_zh.rs
crates/phonemize/src/backends/erhua_zh.rs
crates/phonemize/src/backends/rhy_predictor_zh.rs
```

**预估时间**: 1-2 周

**收益**:
- ✅ 与 PaddleSpeech 特性对齐
- ✅ 最高质量输出
- ❌ 体积增加 ~5-10 MB (g2pW ONNX 模型)
- ❌ 复杂度大幅增加

---

### 方案 C: 混合方案

**核心自实现 + 可选模型**

```rust
// 默认: 轻量级
- 变调规则
- 儿化音
- WeText TN

// 可选: 高精度
- g2pW ONNX (按需下载)
- 韵律预测
```

**预估时间**: 3-5 天

**收益**:
- ✅ 默认轻量
- ✅ 可选升级
- ⚠️ 维护两套实现

---

## 📊 许可证分析

### PaddleSpeech 依赖

| 组件 | 许可证 | 可移植? |
|------|--------|---------|
| jieba | MIT ✅ | ✅ (已集成 jieba-rs) |
| pypinyin | MIT ✅ | ✅ (类似功能已实现) |
| g2pM | Apache-2.0 ✅ | ✅ (可选) |
| g2pW | MIT ✅ | ✅ (可选) |
| ToneSandhi | Apache-2.0 ✅ | ✅ (规则可移植) |
| TextNormalizer | Apache-2.0 ✅ | ✅ |

**结论**: PaddleSpeech 整体是 **Apache-2.0**，所有组件都可以安全移植！

---

## 🎯 推荐路径

### 阶段 9A: GPL 替换 (优先)

**解决当前的 GPL 问题**

1. WeText TN (中/日/英统一)
2. HeadTTS G2P (替换 piper)

**时间**: 2-3 天  
**详见**: `p6-phase9-final-plan.md`

---

### 阶段 9B: 中文质量提升 (后续)

**补全 PaddleSpeech 核心功能**

```rust
// 1. 变调规则 (1 天)
pub struct ToneSandhiZh {
    // 三声变调
    // "一"/"不" 变调
    // 轻声规则
}

// 2. 儿化音 (0.5 天)
pub struct ErhuaZh {
    must_erhua: HashSet<&'static str>,
    not_erhua: HashSet<&'static str>,
}

// 3. 集成到管线 (0.5 天)
// zh_pipeline.rs 添加两个步骤
```

**时间**: 2 天  
**收益**: 显著提升中文发音质量

---

### 可选: g2pW 集成 (如果需要更高精度)

```toml
# Cargo.toml (可选特性)
[dependencies]
ort = { version = "2.0", optional = true }  # ONNX Runtime

[features]
g2pw = ["ort"]
```

**时间**: 2-3 天  
**体积**: +5 MB (ONNX 模型)  
**精度**: 多音字准确率 85% → 95%

---

## 📚 参考资源

### PaddleSpeech

- **仓库**: https://github.com/PaddlePaddle/PaddleSpeech
- **许可证**: Apache-2.0 ✅
- **前端代码**: `paddlespeech/t2s/frontend/zh_frontend.py`
- **TN 代码**: `paddlespeech/t2s/frontend/zh_normalization/`

### g2pW

- **论文**: [INTERSPEECH 2022] g2pW: A Conditional Weighted Softmax BERT
- **仓库**: https://github.com/GitYCC/g2pW
- **许可证**: MIT ✅

### 其他资源

- **pypinyin**: https://github.com/mozillazg/python-pinyin (MIT)
- **g2pM**: https://github.com/kakaobrain/g2pM (Apache-2.0)
- **jieba**: https://github.com/fxsjy/jieba (MIT)

---

## 🎊 总结

### PaddleSpeech 的优势

1. **完整的 TN 系统**（日期/时间/电话/...）
2. **三种多音字消歧方案**（规则/g2pM/g2pW）
3. **完善的变调规则**（三声/"一"/"不"/轻声）
4. **儿化音处理**（词表 + 合并规则）
5. **可选韵律预测**

### TTS-NG 的现状

1. ✅ **核心功能完整**（分词/G2P）
2. ⚠️ **缺少变调处理**（最明显的质量问题）
3. ⚠️ **缺少儿化音**（影响自然度）
4. ⚠️ **TN 不完整**（只有数字）

### 建议

**优先级排序**:

1. **阶段 9A**: GPL 替换（WeText + HeadTTS）⭐⭐⭐
2. **阶段 9B**: 变调 + 儿化音 ⭐⭐
3. **可选**: g2pW 集成（更高精度）⭐

---

**你想先做哪个？**

- **A**: 阶段 9A（GPL 替换）→ 解决许可证问题
- **B**: 阶段 9B（变调+儿化）→ 提升中文质量
- **C**: 同时进行（并行子代理）
- **D**: 先研究更多细节
