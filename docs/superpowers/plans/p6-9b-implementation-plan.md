# P6 阶段 9B 实施方案：直接复制源码

**日期**: 2026-10-04  
**决策**: 不依赖 wetext-rs crate，将源码复制到仓库并直接修改

---

## 🎯 方案优势

### vs. 依赖 crate
- ❌ 依赖：需要维护 fork，上游 9 star 不可靠
- ✅ 复制：完全掌控，无上游风险

### vs. vendor fork
- ❌ fork：仍然是外部代码，需要跟踪上游
- ✅ 复制：成为项目代码，按项目规范维护

### vs. 自研
- ❌ 自研：需要实现 FST 解析 + TN 规则（>1000 行）
- ✅ 复制：复用已验证代码（~500 行）+ rustfst 依赖

---

## 📋 实施步骤

### 1. 复制源码到项目 (0.5h)

```bash
# 目标位置
crates/phonemize/src/backends/wetext/
├── mod.rs                  # 公开 API
├── text_normalizer.rs      # FST 应用层
├── normalizer.rs           # 主入口
├── contractions.rs         # 英文缩写
└── error.rs                # 错误类型
```

**来源**: wetext-rs 0.1.2 (crates.io)

**修改内容**:
1. 移除 `std::fs` API，只保留 `from_bytes`
2. 修复 `full_to_half` 顺序（挪到 preprocess）
3. 简化 API（移除 embedded-fsts 等未实现特性）
4. 添加 getrandom cfg 到 `.cargo/config.toml`

**代码量**: ~500 行（wetext 逻辑）+ rustfst 依赖

---

### 2. 添加依赖 (0.1h)

```toml
# crates/phonemize/Cargo.toml

[dependencies]
rustfst = "1.0"  # FST 解析（MIT/Apache-2.0）
regex = "1.0"
unicode-segmentation = "1.10"

# 已有依赖，无需新增
anyhow = "1.0"
once_cell = "1.19"
```

```toml
# .cargo/config.toml（新增）

[target.wasm32-unknown-unknown]
rustflags = ['--cfg', 'getrandom_backend="wasm_js"']
```

---

### 3. 实现 API (1h)

```rust
// crates/phonemize/src/backends/wetext/mod.rs

mod contractions;
mod error;
mod normalizer;
mod text_normalizer;

pub use error::WeTextError;
pub use normalizer::{Normalizer, NormalizerConfig};

// 简化的公开 API
pub struct WeTextTN {
    zh: Option<Normalizer>,
    ja: Option<Normalizer>,
    en: Option<Normalizer>,
}

impl WeTextTN {
    /// 从字典协议加载（按语言延迟初始化）
    pub fn new() -> Self {
        Self {
            zh: None,
            ja: None,
            en: None,
        }
    }
    
    /// 初始化某个语言的 TN（在 prepare 时调用）
    pub fn prepare(&mut self, lang: Language, fsts: &FstAssets) -> Result<(), WeTextError> {
        match lang {
            Language::En => {
                let config = NormalizerConfig::english();
                self.en = Some(Normalizer::from_bytes(config, [
                    ("en/tn/tagger.fst".to_string(), fsts.en_tagger),
                    ("en/tn/verbalizer.fst".to_string(), fsts.en_verbalizer),
                ])?);
            }
            Language::Zh => {
                let config = NormalizerConfig::chinese();
                self.zh = Some(Normalizer::from_bytes(config, [
                    ("zh/tn/tagger.fst".to_string(), fsts.zh_tagger),
                    ("zh/tn/verbalizer.fst".to_string(), fsts.zh_verbalizer),
                    ("full_to_half.fst".to_string(), fsts.full_to_half),
                ])?);
            }
            Language::Ja => {
                let config = NormalizerConfig::japanese();
                self.ja = Some(Normalizer::from_bytes(config, [
                    ("ja/tn/tagger.fst".to_string(), fsts.ja_tagger),
                    ("ja/tn/verbalizer.fst".to_string(), fsts.ja_verbalizer),
                    ("full_to_half.fst".to_string(), fsts.full_to_half),
                ])?);
            }
        }
        Ok(())
    }
    
    /// 规范化文本
    pub fn normalize(&mut self, text: &str, lang: Language) -> Result<String, WeTextError> {
        match lang {
            Language::En => self.en.as_mut()
                .ok_or(WeTextError::NotInitialized("en".into()))?
                .normalize(text),
            Language::Zh => self.zh.as_mut()
                .ok_or(WeTextError::NotInitialized("zh".into()))?
                .normalize(text),
            Language::Ja => self.ja.as_mut()
                .ok_or(WeTextError::NotInitialized("ja".into()))?
                .normalize(text),
        }
    }
}

/// 从字典协议加载的 FST 资产
pub struct FstAssets {
    pub en_tagger: &'static [u8],
    pub en_verbalizer: &'static [u8],
    pub zh_tagger: &'static [u8],
    pub zh_verbalizer: &'static [u8],
    pub ja_tagger: &'static [u8],
    pub ja_verbalizer: &'static [u8],
    pub full_to_half: &'static [u8],
}
```

---

### 4. 集成到 pipeline (1h)

```rust
// crates/phonemize/src/pipeline.rs

use crate::backends::wetext::{WeTextTN, FstAssets};

pub struct PhonemizePipeline {
    wetext_tn: WeTextTN,
    // ... 其他字段
}

impl PhonemizePipeline {
    pub fn prepare(&mut self, lang: Language, dict: &Dictionary) -> Result<()> {
        match lang {
            Language::En => {
                // 加载 WeText FST
                let fsts = FstAssets {
                    en_tagger: dict.load("wetext/en-tn-tagger.fst.zst")?,
                    en_verbalizer: dict.load("wetext/en-tn-verbalizer.fst.zst")?,
                    // ... 其他
                };
                self.wetext_tn.prepare(Language::En, &fsts)?;
            }
            // ... 其他语言
        }
        Ok(())
    }
    
    pub fn phonemize(&mut self, text: &str, lang: Language) -> Result<Vec<String>> {
        // 1. 文本规范化（新增）
        let normalized = self.wetext_tn.normalize(text, lang)
            .unwrap_or_else(|e| {
                warn!("WeText TN failed: {}, using original text", e);
                text.to_string()
            });
        
        // 2. 原有的 phonemize 逻辑
        match lang {
            Language::En => self.phonemize_en(&normalized),
            Language::Zh => self.phonemize_zh(&normalized),
            Language::Ja => self.phonemize_ja(&normalized),
        }
    }
}
```

---

### 5. 删除旧代码 (0.2h)

```bash
rm crates/phonemize/src/backends/numbers.rs
rm crates/phonemize/src/backends/numbers_zh.rs
rm crates/phonemize/src/backends/numbers_en.rs

# 更新 mod.rs
# - pub mod numbers;
# - pub mod numbers_zh;
# - pub mod numbers_en;
# + pub mod wetext;
```

**删除代码**: 849 行（实测）

---

### 6. 字典协议 (0.5h)

```bash
# scripts/setup-wetext-fsts.sh

#!/bin/bash
set -e

# 下载 WeText FST（从 PyPI）
WETEXT_VERSION="0.1.8"
WHEEL_URL="https://files.pythonhosted.org/packages/.../wetext-${WETEXT_VERSION}-py3-none-any.whl"
WHEEL_SHA256="..."  # 计算并钉死

echo "Downloading WeText ${WETEXT_VERSION}..."
curl -sL "$WHEEL_URL" -o /tmp/wetext.whl
echo "$WHEEL_SHA256  /tmp/wetext.whl" | sha256sum -c

# 解压
unzip -q /tmp/wetext.whl -d /tmp/wetext

# 压缩到 public/dictionaries/
mkdir -p public/dictionaries/wetext

for lang in en zh ja; do
  for type in tagger verbalizer; do
    src="/tmp/wetext/wetext/fsts/${lang}/tn/${type}.fst"
    dst="public/dictionaries/wetext/${lang}-tn-${type}.fst.zst"
    
    echo "Compressing ${lang} ${type}..."
    zstd -19 -f "$src" -o "$dst"
    
    echo "  $(du -h "$dst" | cut -f1)"
  done
done

# full_to_half（共享）
zstd -19 -f /tmp/wetext/wetext/fsts/full_to_half.fst \
  -o public/dictionaries/wetext/full-to-half.fst.zst

# 清理
rm -rf /tmp/wetext /tmp/wetext.whl

echo "WeText FSTs ready in public/dictionaries/wetext/"
```

---

### 7. 测试 (1.5h)

```rust
// crates/phonemize/tests/wetext_tn.rs

use phonemize::{PhonemizePipeline, Language};

#[test]
fn test_en_time() {
    let mut pipeline = PhonemizePipeline::new().unwrap();
    pipeline.prepare(Language::En, &mock_dict()).unwrap();
    
    let result = pipeline.phonemize("3:30pm", Language::En).unwrap();
    assert!(result.join("").contains("three thirty"));
}

#[test]
fn test_en_percent() {
    let mut pipeline = PhonemizePipeline::new().unwrap();
    pipeline.prepare(Language::En, &mock_dict()).unwrap();
    
    let result = pipeline.phonemize("50%", Language::En).unwrap();
    assert!(result.join("").contains("fifty percent"));
}

#[test]
fn test_en_ordinal() {
    let mut pipeline = PhonemizePipeline::new().unwrap();
    pipeline.prepare(Language::En, &mock_dict()).unwrap();
    
    let result = pipeline.phonemize("1st", Language::En).unwrap();
    assert!(result.join("").contains("first"));
}

#[test]
fn test_no_digit_early_exit() {
    let mut pipeline = PhonemizePipeline::new().unwrap();
    pipeline.prepare(Language::En, &mock_dict()).unwrap();
    
    // 无数字，早退，不应改变
    let result = pipeline.phonemize("hello world", Language::En).unwrap();
    assert_eq!(result.join(""), original_output);
}

#[test]
fn test_tn_failure_fallback() {
    // FST 加载失败时应该回退到原文
    let mut pipeline = PhonemizePipeline::new().unwrap();
    // 不调用 prepare，FST 未加载
    
    let result = pipeline.phonemize("123", Language::En).unwrap();
    // 应该回退到原有的 numbers.rs 行为（或原文）
}
```

**测试覆盖**:
- 英文 8 类 TN（时间/百分比/序数/分数/逗号/缩写/日期/货币）
- 无数字早退
- 失败回退
- 对照测试更新

---

### 8. 文档 (0.5h)

```markdown
// crates/phonemize/src/backends/wetext/README.md

# WeText Text Normalization

本模块基于 WeTextProcessing（Apache-2.0）实现三语言文本规范化（TN）。

## 来源

- **upstream**: wenet-e2e/WeTextProcessing (Python + pynini)
- **Rust 移植**: wetext-rs 0.1.2 (SpenserCai)
- **本项目**: 复制源码并修改（不依赖 crate）

## 修改内容

1. **wasm 支持**: 移除 `std::fs` API，只保留 `from_bytes`
2. **修复缺陷**: `full_to_half` 从 postprocess 挪到 preprocess
3. **简化 API**: 移除未实现特性（embedded-fsts 等）
4. **集成字典协议**: 按语言延迟加载 FST

## 许可证

- 原始代码: Apache-2.0 (wenet-e2e/WeTextProcessing)
- Rust 移植: Apache-2.0 (wetext-rs)
- rustfst: MIT/Apache-2.0
- 本项目: MIT

## FST 数据

FST 文件从 PyPI `wetext` 0.1.8 wheel 提取，按字典协议加载：

- `public/dictionaries/wetext/en-tn-tagger.fst.zst` (161 KB)
- `public/dictionaries/wetext/en-tn-verbalizer.fst.zst` (546 KB)
- `public/dictionaries/wetext/zh-tn-tagger.fst.zst` (54 KB)
- `public/dictionaries/wetext/zh-tn-verbalizer.fst.zst` (106 KB)
- `public/dictionaries/wetext/ja-tn-tagger.fst.zst` (30 KB)
- `public/dictionaries/wetext/ja-tn-verbalizer.fst.zst` (33 KB)
- `public/dictionaries/wetext/full-to-half.fst.zst` (1 KB)

**总计**: 931 KB (压缩)

## 性能

- **无数字句子**: ~0.001 ms（早退）
- **含数字句子**: ~2 ms
- **首次解析**: 9-52 ms（per language，在 prepare 时）

## 支持的 TN 类型

### 英文
- 数字: `123` → `one hundred twenty three`
- 时间: `3:30pm` → `three thirty PM`
- 百分比: `50%` → `fifty percent`
- 序数: `1st` → `first`
- 分数: `1/2` → `one half`
- 逗号分隔: `2,000` → `two thousand`
- 缩写: `Dr. Smith` → `doctor smith`
- 日期: `10/4/2024` → `the fourth of october twenty twenty four`
- 货币: `$100` → `one hundred dollars`

### 中文
- 数字: `123` → `一百二十三`
- 日期: `2024年10月4日` → `二零二四年十月四日`
- 时间: `3:30` → `三点三十分`
- 货币: `$100` → `一百美元`
- 电话: `13800138000` → `幺三八零零幺三八零零零`

### 日语
- 数字: `123` → `百二十三`
- 百分比: `50%` → `五十パーセント`
- 全角数字: `２０２２年` → `二千二十二年`

## 已知限制

1. **中文 "两百" vs "二百"**: WeText 输出 "两百"，Kokoro 训练用 "二百"
   - 当前策略: 第一步只做英文，中文待定
2. **trim 契约**: WeText 会 trim 输入，中文链当前不 trim
   - 当前策略: 在 normalize 后恢复空白
```

---

## 📊 工作量估算

| 任务 | 预估 |
|------|------|
| 复制源码 + 修改 | 0.5h |
| 添加依赖 | 0.1h |
| 实现 API | 1h |
| 集成 pipeline | 1h |
| 删除旧代码 | 0.2h |
| 字典协议 | 0.5h |
| 测试 | 1.5h |
| 文档 | 0.5h |
| **总计** | **5.3h** |

**更现实的估算**: 1 工作日

---

## ✅ 验收标准

1. ✅ 源码在 `crates/phonemize/src/backends/wetext/`
2. ✅ 不依赖 `wetext-rs` crate
3. ✅ 英文 8 类 TN 全部可用
4. ✅ 删除 `numbers*.rs` (849 行)
5. ✅ 所有测试通过
6. ✅ 体积增加 +2 MB (wasm) + 0.93 MB (FST)
7. ✅ 许可证清洁（Apache-2.0）
8. ✅ 文档完整

---

## 🚀 下一步

你想让我立即启动实施吗？

**任务**: 阶段 9B.2 - 英文 WeText 集成（源码复制方案）

**预估**: 1 工作日

**模型**: deep-seek/deepseek-v4-flash
