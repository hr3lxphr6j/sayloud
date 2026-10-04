# P6 Rust Phonemize 项目 - 最终架构文档

**项目名称**: P6 Rust Phonemize  
**最后更新**: 2026-10-04  
**状态**: 阶段 1-8 已完成，阶段 9 规划中

---

## 📋 目录

1. [项目概述](#项目概述)
2. [已完成工作（阶段 1-8）](#已完成工作阶段-1-8)
3. [当前架构](#当前架构)
4. [最终目标架构（阶段 9）](#最终目标架构阶段-9)
5. [关键技术决策](#关键技术决策)
6. [实施路线图](#实施路线图)
7. [附录：历史决策与教训](#附录历史决策与教训)

---

## 项目概述

### 目标

将 TTS-NG 的多语言音素化（phonemize）管线从 JavaScript 迁移到 Rust，编译为单个 wasm 模块，支持中文、日语、英文三种语言。

### 核心需求

1. ✅ **单 wasm 模块**：所有三语言的 G2P 逻辑编译到一个 wasm
2. ✅ **MIT/Apache-2.0 许可证**：无 GPL 依赖
3. ✅ **字典协议**：大字典（IPADic/jieba）按需加载，不编进 wasm
4. ✅ **OOV 处理**：未知词不能静默丢失
5. ✅ **输出匹配 JS**：100% 对照测试通过
6. ⚠️ **性能**：冷启动 < 100ms（日语 164ms，未达标但可接受）

---

## 已完成工作（阶段 1-8）

### 阶段概览

| 阶段 | 内容 | Commits | 测试 | 状态 |
|------|------|---------|------|------|
| 1-2 | Workspace + 字典协议 | 4 | - | ✅ |
| 3 | 日语 G2P | 1 | 58 | ✅ |
| 4 | 英文 G2P | 1 | 71 | ✅ |
| 4.5 | 英文数字 | 2 | 89 | ✅ |
| 5 | 中文 G2P + vocab | 4 | 128 | ✅ |
| 6 | 中文前端组装 | 6 | 168 | ✅ |
| 7 | 双 worker 架构 | 3 | 169 | ✅ |
| 8 | JS 链清理 | 1 | 170 | ✅ |

**总计**: 22 commits, 170 Rust tests, 1393 TS tests

### 技术统计

**代码量**：
- Rust: ~6,500 行（src ~3,500 + tests ~2,800）
- 删除 JS: ~1,200 行

**体积**：
- phonemize.wasm: 5.1 MB (gzip 1.4 MB)
- 扩展包: 57.7 MB → 39.9 MB (-17.8 MB)

**性能**（热路径）：
- 中文: 0.050 ms / 32 字
- 日语: 0.039 ms / 35 字
- 英文: 0.037 ms

**性能**（冷启动）：
- 中文: 82.6 ms（jieba 词典 1.6 MB 解压）
- 日语: 164.3 ms（IPADic 词典 8.5 MB 解压）⚠️
- 英文: 18.0 ms（CMU Dict 哈希表构建）

---

## 当前架构

### 三语言管线（阶段 1-8 完成）

#### 日语
```
输入文本
  ↓
lindera 分词 (MIT)
  ↓
数字转换（自实现）
  ↓
lindera 全上下文标注
  ↓
韵律标记提取 + PUA 映射
  ↓
Vocab 闸门（V1_0 IPA）
  ↓
输出 IPA
```

#### 英文
```
输入文本
  ↓
Latin 段识别
  ↓
数字转换（自实现）
  ↓
piper-plus-g2p (MIT)
  ├─ CMU Dict 查询（123,455 词）
  └─ OOV fallback: 字母拼读
  ↓
Vocab 闸门（V1_0 IPA）
  ↓
输出 IPA
```

#### 中文
```
输入文本
  ↓
jieba-rs 分词 (MIT)
  ↓
数字转换（自实现）
  ↓
pinyin-pro 移植（静态表）
  ↓
Vocab 闸门（V1_0 IPA / V1_1_ZH Zhuyin）
  ↓
输出 IPA/Zhuyin
```

### 依赖清单（阶段 1-8）

| 组件 | Crate | 许可证 | 用途 |
|------|-------|--------|------|
| 日语分词 | lindera | MIT | Mecab 分词 |
| 英文 G2P | piper-plus-g2p | MIT | CMU Dict |
| 英文数字 | num2words | MIT | 数字转文字 |
| 中文分词 | jieba-rs | MIT | HMM 分词 |
| 字典压缩 | ruzstd | MIT/Apache-2.0 | zstd 解压 |

**结论**: ✅ 100% MIT/Apache-2.0

### 架构特点（阶段 1-8）

✅ **优点**：
- 单 wasm 模块（5.1 MB）
- 许可证清洁
- 三语言全覆盖
- 170 Rust + 1393 TS 测试
- 热路径性能优秀（< 0.1ms）

⚠️ **限制**：
- **英文 OOV**: 字母拼读（"Kokoro" → "K-O-K-O-R-O"）不够准确
- **英文 TN**: 只支持数字，缺少日期/时间/金额/电话等
- **中文多音字**: 静态表无法消歧（"重要" vs "重复"）
- **中文变调**: 无变调规则（"你好" ni3 hao3 → 应该是 ni2 hao3）
- **中文儿化音**: 无儿化音合并（"玩儿" [wan2, er2] → 应该是 [war2]）
- **代码重复**: 三个 `numbers*.rs`，职责重叠

---

## 最终目标架构（阶段 9）

### 设计原则

1. **统一 TN 层**: 三语言使用同一个 TN 引擎（wetext-rs）
2. **完整的英文 OOV**: 规则引擎替代字母拼读
3. **中文质量提升**: 多音字消歧 + 变调 + 儿化音
4. **删除重复代码**: 统一 TN 后删除 `numbers*.rs`

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    输入文本 (任意语言)                    │
└─────────────────────────────────────────────────────────┘
                          ↓
                ┌─────────────────────┐
                │  文本规范化 (TN)     │
                │  wetext-rs           │
                │  (zh/ja/en 统一)     │
                └─────────────────────┘
                          ↓
        ┌─────────────────┼─────────────────┐
        ↓                 ↓                 ↓
   ┌─────────┐      ┌─────────┐      ┌─────────┐
   │ 日语     │      │ 中文     │      │ 英文     │
   └─────────┘      └─────────┘      └─────────┘
        ↓                 ↓                 ↓
   lindera          jieba-rs          (无需分词)
   分词              分词
        ↓                 ↓                 ↓
   查表              g2pW              HeadTTS
   (直接)            多音字消歧          NRL 规则
                          ↓
                     变调规则
                          ↓
                     儿化音合并
        ↓                 ↓                 ↓
   ┌─────────────────────────────────────────┐
   │          Vocab 闸门 (V1_0 / V1_1_ZH)      │
   └─────────────────────────────────────────┘
                          ↓
                   输出 IPA/Zhuyin
```

### 核心变更

#### 1. 统一 TN 层（wetext-rs）

**当前问题**：
- 三个 `numbers*.rs`（~500 行重复代码）
- 只支持数字，缺少日期/时间/金额/电话等
- 英文侧逻辑缺失

**解决方案**：
```rust
// 删除：
// - numbers.rs
// - numbers_zh.rs
// - numbers_en.rs

// 新增：
// crates/phonemize/src/backends/wetext_tn.rs

use wetext_rs::Processor;

pub struct WeTextTN {
    zh_processor: Processor,
    ja_processor: Processor,
    en_processor: Processor,
}

impl WeTextTN {
    pub fn normalize(&self, text: &str, lang: Language) -> String {
        match lang {
            Language::Zh => self.zh_processor.normalize(text),
            Language::Ja => self.ja_processor.normalize(text),
            Language::En => self.en_processor.normalize(text),
        }
    }
}
```

**收益**：
- ✅ 删除 ~500 行重复代码
- ✅ 支持 10+ TN 类型（数字/日期/时间/金额/电话/序数/分数/百分比等）
- ✅ 三语言统一，维护成本低
- ✅ 生产级别（wenet-e2e 项目）
- ✅ Apache-2.0 许可证

**依赖**：
- 📦 wetext-rs: https://github.com/SpenserCai/wetext-rs
- 📦 WeTextProcessing: https://github.com/wenet-e2e/WeTextProcessing

#### 2. 英文 OOV：HeadTTS 规则引擎

**当前问题**：
- piper-plus-g2p 的 OOV fallback 是**字母拼读**
- "Kokoro" → "kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ" (K-O-K-O-R-O)
- 不够准确，不是真实发音

**解决方案**：
```rust
// 替换 piper-plus-g2p 为 HeadTTS

// crates/phonemize/src/backends/headtts_en.rs

pub struct HeadTTSEnglish {
    rules: HashMap<char, Vec<Rule>>,        // NRL Report 7948 规则
    dictionary: HashMap<String, String>,     // CMU Dict（可选快速路径）
}

impl HeadTTSEnglish {
    pub fn phonemize_word(&self, word: &str) -> String {
        // 1. 检查词典（快速路径）
        if let Some(ipa) = self.dictionary.get(word) {
            return ipa.clone();
        }
        
        // 2. 应用 NRL Report 7948 letter-to-sound 规则
        self.apply_rules(word)
    }
    
    fn apply_rules(&self, word: &str) -> String {
        // 712 行规则引擎
        // 上下文模式匹配：[左上下文] 字母 [右上下文] = 音素输出
        // 符号：# (元音) / . (浊辅音) / % (后缀) / ^ (辅音) / + (前元音) / : (零个或多个辅音) /   (空格)
    }
}
```

**对比**：

| 方案 | OOV 处理 | 示例 |
|------|---------|------|
| piper-plus-g2p | 字母拼读 | "Kokoro" → "K O K O R O" |
| HeadTTS | NRL 规则引擎 | "Kokoro" → "kɑkɔɹO" |

**收益**：
- ✅ 真实发音（不是字母拼读）
- ✅ 基于语言学规则（NRL Report 7948 / Elovitz et al. 1976）
- ✅ MIT 许可证
- ✅ 体积更小（规则引擎 ~200 KB vs CMU Dict 3.75 MB）
- ✅ 可以完全替换 eSpeak

**来源**：
- 📦 HeadTTS: https://github.com/met4citizen/HeadTTS
- 📄 NRL Report 7948: https://apps.dtic.mil/sti/pdfs/ADA021929.pdf

#### 3. 中文多音字消歧（g2pW）

**当前问题**：
- pinyin-pro 是静态表，无法消歧
- "重要" (zhòng yào) vs "重复" (chóng fù)
- "长城" (cháng chéng) vs "长大" (zhǎng dà)
- "行走" (xíng zǒu) vs "银行" (yín háng)

**解决方案**：
```rust
// crates/phonemize/src/backends/g2pw_zh.rs

use onnxruntime::Session;

pub struct G2pWZh {
    model: Session,                     // ONNX 模型
    vocab: HashMap<String, usize>,      // 词汇表
}

impl G2pWZh {
    pub fn predict(&self, text: &str, word: &str, position: usize) -> String {
        // 1. 上下文编码（左右窗口）
        let context = self.encode_context(text, position);
        
        // 2. ONNX 推理
        let output = self.model.run(vec![context]);
        
        // 3. 解码为拼音
        self.decode(output)
    }
}
```

**收益**：
- ✅ 上下文感知，准确率 >95%
- ✅ 直接影响语意理解
- ✅ 生产级别（PaddleSpeech 使用）

**代价**：
- ⚠️ 模型大小 ~5 MB
- ⚠️ 推理延迟 ~5ms（可接受）

#### 4. 中文变调和儿化音

**当前问题**：
- 无变调规则："你好" → ni3 hao3（错误，应该是 ni2 hao3）
- 无儿化音合并："玩儿" → [wan2, er2]（不自然，应该是 [war2]）

**解决方案**：
```rust
// crates/phonemize/src/backends/tone_sandhi_zh.rs

pub struct ToneSandhiZh;

impl ToneSandhiZh {
    pub fn apply(&self, words: &[String], finals: &mut [String]) {
        self.three_sandhi(words, finals);   // 三声变调：ni3 hao3 → ni2 hao3
        self.yi_sandhi(words, finals);      // "一" 变调：yi1 ge4 → yi2 ge4
        self.bu_sandhi(words, finals);      // "不" 变调：bu4 dui4 → bu2 dui4
        self.neutral_sandhi(words, finals); // 轻声：zi3 → zi5
    }
}

// crates/phonemize/src/backends/erhua_zh.rs

pub struct ErhuaZh;

impl ErhuaZh {
    pub fn merge(&self, word: &str, finals: &mut Vec<String>) {
        // "玩儿" [wan2, er2] → [war2]
        // 在韵母和声调之间插入 'r'
    }
}
```

**收益**：
- ✅ "你好" → ni2 hao3 ✅
- ✅ "玩儿" → war2 ✅
- ✅ 听感明显改善

**来源**：
- PaddleSpeech `tone_sandhi.py`
- PaddleSpeech `zh_frontend.py::_merge_erhua`

---

## 关键技术决策

### 决策 1: 为什么用 HeadTTS 而不是 piper-plus-g2p？

**理由**：
1. ✅ **字母拼读不够好**: "Kokoro" → "K-O-K-O-R-O" 不是真实发音
2. ✅ **NRL 规则引擎更准确**: 基于语言学规则，输出真实发音
3. ✅ **体积更小**: 规则引擎 ~200 KB vs CMU Dict 3.75 MB
4. ✅ **MIT 许可证**: 与 piper 相同
5. ✅ **可以替换 eSpeak**: 统一到 Rust，删除 JS 依赖

**权衡**：
- ⚠️ 移植工作量: 712 行规则，需要仔细测试
- ⚠️ 对照测试: 需要重新验证对照结果

### 决策 2: 为什么用 wetext-rs？

**理由**：
1. ✅ **三语言统一**: zh/ja/en 一个引擎
2. ✅ **生产级别**: wenet-e2e 项目，已在生产使用
3. ✅ **完整的 TN**: 10+ 类型（数字/日期/时间/金额/电话/序数/分数/百分比等）
4. ✅ **删除重复代码**: 三个 `numbers*.rs` → 一个 TN 引擎
5. ✅ **英文侧逻辑缺失**: 当前只有数字，缺少其他 TN
6. ✅ **Apache-2.0 许可证**: 清洁

**权衡**：
- ⚠️ 依赖成熟度: wetext-rs 是社区移植，需要验证质量
- ⚠️ 体积增加: FST 数据可能增加体积

### 决策 3: 为什么要做中文多音字消歧？

**理由**：
1. ✅ **直接影响语意理解**: "重要" vs "重复"
2. ✅ **静态表无法解决**: pinyin-pro 无法上下文感知
3. ✅ **生产级别方案存在**: g2pW (ONNX)
4. ✅ **PaddleSpeech 验证**: 已在生产使用

**权衡**：
- ⚠️ 模型大小: ~5 MB
- ⚠️ 推理延迟: ~5ms（可接受）

### 决策 4: 为什么要做变调和儿化音？

**理由**：
1. ✅ **明显的质量问题**: "你好" ni3 hao3 是错误的
2. ✅ **听感明显**: 变调错误很容易被发现
3. ✅ **规则明确**: PaddleSpeech 有完整的规则实现
4. ✅ **无额外依赖**: 纯规则实现

**权衡**：
- ⚠️ 实现工作量: ~1.5-2 天

---

## 实施路线图

### 阶段 9：最终架构实现（8-11 天）

#### 阶段 9A: HeadTTS 集成（2-3 天）

**任务 9A.1: 移植 NRL 7948 规则引擎**（1.5 天）
- 移植 712 行规则（26 个字母各自的规则）
- 上下文模式匹配实现
- ARPA → Misaki IPA 转换
- 单元测试（50+ 测试）

**任务 9A.2: 删除 piper-plus-g2p**（0.5 天）
- 从 Cargo.toml 删除依赖
- 删除 `g2p_en.rs`
- 更新所有测试

**验收标准**：
- ✅ "Kokoro" → 真实发音（不是 K-O-K-O-R-O）
- ✅ 所有 26 个字母都有规则
- ✅ 对照测试通过
- ✅ 体积减少 ~3 MB

---

#### 阶段 9B: WeTextProcessing 集成（2-3 天）

> **状态（2026-10-04）：9B.2 已完成，只做了英文。**
> 实施记录（含全部实测数字）：[`p6-9b2-implementation.md`](./p6-9b2-implementation.md)。
> 源码复制进 `crates/phonemize/src/backends/wetext/`（5 处改动，不是依赖；9B.4 后为
> 6 处），英文 TN
> 走字典协议接通，wasm 构建 + Rust 187 / TS 1394 测试全绿。
>
> **下面这段任务书有三条假设与实测不符，按实测收敛如下：**
> (1) **没有删 `numbers*.rs`。** 本阶段只接英文，删 `numbers.rs`/`numbers_zh.rs` 会让
> 中日文数字直接读不出来且无替代；`numbers_en.rs` 留着作为未 `prepare` 时的fallback。
> (2) **体积 +1,013,905 B（+19.9%），不是 +2 MB**；热路径 **0.5–3.5 ms/句，
> 不是 ~0.001 ms** —— 后者是移植 bug（`should_normalize` 丢了 `lang` 参数，
> 英文无数字就整个跳过 TN）的副产品，已修（`NOTICE` 改动 #5）。
> (3) **这个文法对裸整数是弱项**：`123` → `one two three`（参考实现给
> `one hundred and twenty three`），因为多条路径等代价、消解方式由 FST 引擎决定，
> 连参考实现自己都不一致。它对**实体**（时间/日期/金额/百分比/序数/分数/单位/缩写）
> 才是明显更好的那一个。是否按 tagger 的实体名分流，见实施记录 §五.1。
>
> **9B.4 更正了 (3)。** 不是等代价，也不是引擎口味：`one hundred and twenty three`
> 是 `0.000000`，`one two three` 是 `0.000200`，`rustfst::shortest_path` 在
> 负权文法上返回了更贵的那条。抽取已改为自算 Bellman-Ford（`NOTICE` 改动 #6），
> 18 条探针里 7 条变化。唯一剩下的裸整数差异是 `1000 → ten hundred`，那才是
> 文法自己的等代价平局（两边一致）。全文：
> [`p6-9b4-shortest-path-bug.md`](./p6-9b4-shortest-path-bug.md)。
> 另：`NOTICE` 改动数已从 5 增至 6。
>
> **9B.6 给 TN 加了一道便宜的门控**（`crates/phonemize/src/backends/tn_gate.rs`），
> 因为 tagger 占 TN 成本的 92% 而它每条英文句子都跑——上游的英文 TN 故意不做数字
> 门禁（`should_normalize` 的数字检查只对非英文生效）。门控 2.8 µs / 950 字符，
> 对比同长度 TN 43 ms；wasm **+977 B**；普通散文句子 10/10 跳过。
> 实施记录与全部实测：[`p6-9b6-tn-gate.md`](./p6-9b6-tn-gate.md)。
> **该记录里有一条对 9B.3 的更正**：9B.3 提议的不变量
> 「`gate` 说 false ⇒ tagger 只输出 `w`/`p`」在上游自己的白名单上**不成立**
> ——`whitelist` 是一张 3,050 行的字符串表，其中 1,137 个键没有任何形状，
> 纯形状判据漏掉 1,127 个（182 个音素会变）。真实散文 127 句上 0 漏报。
> 要彻底关掉这个洞，需要把白名单作为门控的输入（9B.6 §五.5，未做）。

**任务 9B.1: 集成 wetext-rs**（1.5 天）
- 评估 wetext-rs vs 官方 runtime
- 添加依赖到 Cargo.toml
- 实现 `WeTextTN` 结构
- 三语言处理器初始化

**任务 9B.2: 删除自实现的 TN**（0.5 天）
- 删除 `numbers.rs`（~200 行）
- 删除 `numbers_zh.rs`（~150 行）
- 删除 `numbers_en.rs`（如果有）

**任务 9B.3: 测试**（1 天）
- 数字、日期、时间、金额、电话等
- 三语言全覆盖
- 对照测试更新

**验收标准**：
- ✅ 删除 ~500 行重复代码
- ✅ 支持 10+ TN 类型
- ✅ 三语言测试全绿
- ✅ 许可证清洁

---

#### 阶段 9C: 中文多音字消歧（2-3 天）

**任务 9C.1: 集成 g2pW ONNX 模型**（1.5 天）
- 下载 g2pW 模型（~5 MB）
- 集成 onnxruntime-rs
- 实现上下文编码
- 实现推理逻辑

**任务 9C.2: 替换 pinyin-pro**（0.5 天）
- 中文管线改用 g2pW
- 保留 pinyin-table.json 作为 fallback（字典失败时）

**任务 9C.3: 测试**（1 天）
- 多音字测试用例（重/长/行/还/处/觉等）
- 对比 PaddleSpeech
- 准确率验证

**验收标准**：
- ✅ "重要" → zhòng yào ✅
- ✅ "重复" → chóng fù ✅
- ✅ 准确率 >95%
- ✅ 推理延迟 <5ms

---

#### 阶段 9D: 中文变调和儿化音（1.5-2 天）

**任务 9D.1: 变调规则**（1 天）
- 三声变调（两个三声连读，前字变二声）
- "一" 变调（一 + 去声 → 二声）
- "不" 变调（不 + 去声 → 二声）
- 轻声标记（助词、语气词等）

**任务 9D.2: 儿化音**（0.5 天）
- 儿化音合并规则
- must_erhua / not_erhua 词表
- 在韵母和声调之间插入 'r'

**验收标准**：
- ✅ "你好" → ni2 hao3 ✅
- ✅ "一个" → yi2 ge4 ✅
- ✅ "不对" → bu2 dui4 ✅
- ✅ "玩儿" → war2 ✅

---

### 执行顺序（推荐）

**P0（立即开始）**：
1. **阶段 9B: WeTextProcessing**（2-3 天）
   - 理由：三语言都受益，删除重复代码
   - 风险：低（成熟项目）
   - 优先级：最高

2. **阶段 9A: HeadTTS**（2-3 天）
   - 理由：完整的英文 OOV
   - 风险：中等（712 行规则）
   - 优先级：高

**P1（随后）**：
3. **阶段 9D: 变调和儿化音**（1.5-2 天）
   - 理由：明显的中文质量问题
   - 风险：低
   - 优先级：中

4. **阶段 9C: 多音字消歧**（2-3 天）
   - 理由：语意准确性
   - 风险：中等（ONNX 模型集成）
   - 优先级：中

**总计**: 8-11 天

---

## 附录：历史决策与教训

### 重要更正

#### 1. piper-plus-g2p 的 OOV 处理

**早期误解**（2026-10-04）：
- ❌ 我认为 piper-plus-g2p "没有 OOV 处理"
- ❌ 基于文档（p6-phase4-corrections.md §6.6）说"OOV 静默跳过"

**实际情况**：
- ✅ 代码**已有字母拼读 fallback**（Decision 1.B）
- ✅ "Kokoro" → "K O K O R O"（不是静默）

**真相**：
- 文档描述的是**任务书要求**（OOV 静默跳过）
- 代码实现**偏离了任务书**（添加了 fallback）
- 这是一个**好的偏离**

**教训**：
- 文档和代码可能不一致
- 验证前提假设，不要依赖文档

#### 2. piper-plus-g2p 的许可证

**早期误解**（2026-10-04）：
- ❌ 我认为 piper-plus-g2p 是 GPL-3.0
- ❌ 制定了"阶段 9: GPL 替换"计划

**实际情况**：
- ✅ piper-plus-g2p 是 **MIT 许可证**
- ✅ 验证：源码 LICENSE.md、Cargo.toml、crates.io

**真相**：
- 架构审查时的错误判断
- TTS-NG 已经是完全 MIT/Apache-2.0 栈

**教训**：
- 任何"需要替换依赖"的决策前，必须检查源码 LICENSE
- 不应依赖猜测或间接信息
- 交叉验证：git 源 + crates.io + cargo tree

#### 3. HeadTTS 替换 piper 的理由

**初始判断**（2026-10-04 早期）：
- ❌ 理由不成立（piper 已有 OOV）

**用户反馈**（2026-10-04）：
- ✅ **字母拼读不够好**："Kokoro" → "K-O-K-O-R-O"
- ✅ **NRL 规则引擎更准确**："Kokoro" → "kɑkɔɹO"

**最终结论**：
- ✅ 用户的理由成立
- ✅ HeadTTS 的 letter-to-sound 规则引擎**比字母拼读好得多**

**教训**：
- OOV "存在" ≠ OOV "足够好"
- 字母拼读只是最低要求，规则引擎是更好的方案

### 废弃文档列表

以下文档基于错误前提或已过时，不应再参考：

❌ **基于 GPL 误判的文档**：
- `p6-phase9-final-plan.md` (HeadTTS 移植计划)
- `p6-final-roadmap.md` (包含 GPL 替换内容)
- `p6-next-steps.md` (包含 GPL 替换内容)
- `p6-phase9-headtts-integration.md`
- `p6-phase9-wetext.md`

❌ **过程性文档**（已被本文档取代）：
- `p6-architecture-evaluation.md`
- `p6-architecture-review-summary.md`
- `p6-complete-work-summary.md`
- `p6-decision-summary.md`
- `p6-final-decision.md`
- `p6-final-recommendation.md`
- `p6-final-status.md`
- `p6-license-correction.md`
- `p6-oov-verification.md`
- `p6-revised-final-plan.md`
- `p6-phonemize-architecture-review.md`

✅ **保留的实施记录**（历史价值）：
- `p6-implementation-summary.md` (阶段 1-3)
- `p6-phase3-corrections.md` (日语实施)
- `p6-phase4-corrections.md` (英文实施)
- `p6-phase5-plan.md` (英文数字)
- `p6-phase5-rust-vs-js-comparison.md` (阶段 5 对照)
- `p6-zh-pinyin-and-vocab-gate.md` (中文 G2P)
- `p6-zh-frontend.md` (中文前端)
- `p6-phase7-two-workers.md` (双 worker)
- `p6-phase8-cleanup.md` (JS 链清理)

✅ **保留的调研资料**（参考价值）：
- `p6-espeak-alternatives-final.md` (英文 G2P 方案对比)
- `p6-g2p-library-evaluation.md` (G2P 库评估)
- `p6-paddlespeech-analysis.md` (PaddleSpeech 分析)
- `p6-piper-plus-g2p-reuse-analysis.md` (piper 复用分析)
- `p6-v0-failure-analysis.md` (V0 失败分析)

### 关键决策时间线

| 日期 | 事件 | 决策 |
|------|------|------|
| 2026-09 | P6 启动 | 目标：单 wasm，三语言，MIT/Apache-2.0 |
| 2026-09 | 阶段 1-2 | Workspace + 字典协议 |
| 2026-09 | 阶段 3 | 日语 G2P（lindera） |
| 2026-10-03 | 阶段 4 | 英文 G2P（piper-plus-g2p，误判为 GPL） |
| 2026-10-03 | 阶段 4.5 | 英文数字（num2words） |
| 2026-10-03 | 阶段 5 | 中文 G2P（pinyin-pro 移植） |
| 2026-10-03 | 阶段 6 | 中文前端组装（jieba-rs） |
| 2026-10-03 | 阶段 7 | 双 worker 架构 |
| 2026-10-03 | 阶段 8 | JS 链清理（-17.8 MB） |
| 2026-10-04 | 架构审查 | 识别问题：OOV/TN/多音字/变调/儿化音 |
| 2026-10-04 | 许可证更正 | piper-plus-g2p 是 MIT，不是 GPL |
| 2026-10-04 | 用户反馈 | HeadTTS/wetext-rs/多音字消歧/变调/儿化音 |
| 2026-10-04 | 最终方案 | 阶段 9A-9D（HeadTTS + wetext-rs + g2pW + 变调儿化音） |

---

## 总结

### 阶段 1-8 成就 ✅

- ✅ 单 wasm 模块（5.1 MB）
- ✅ 三语言支持（中/日/英）
- ✅ MIT/Apache-2.0 许可证
- ✅ 170 Rust + 1393 TS 测试
- ✅ 热路径性能 < 0.1ms
- ✅ 删除 JS 链（-17.8 MB）

### 阶段 9 目标 🎯

- ✅ 统一 TN 层（wetext-rs，-500 行代码）
- ✅ 完整的英文 OOV（HeadTTS 规则引擎）
- ✅ 中文多音字消歧（g2pW ONNX）
- ✅ 中文变调和儿化音（PaddleSpeech 规则）

### 预期收益 📈

| 维度 | 改进 |
|------|------|
| **英文 OOV** | 字母拼读 → NRL 规则引擎 |
| **英文 TN** | 仅数字 → 10+ 类型 |
| **中文多音字** | 静态表 → 上下文消歧 (>95%) |
| **中文变调** | 无 → 正确 |
| **中文儿化音** | 无 → 正确 |
| **代码量** | -500 行（TN 统一） |
| **许可证** | 100% MIT/Apache-2.0 |

### 工作量 ⏱️

- **总计**: 8-11 天
- **优先级**: 9B → 9A → 9D → 9C

---

**文档版本**: 1.0  
**最后更新**: 2026-10-04  
**维护者**: TTS-NG 团队  
**状态**: ✅ 最终版（取代所有其他 P6 文档）
