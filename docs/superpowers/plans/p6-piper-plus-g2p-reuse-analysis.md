# piper-plus/g2p 代码复用分析报告

## 📊 项目结构概览

```
@piper-plus/g2p@0.4.2 (283.8 KB, MIT)
├── src/
│   ├── en/index.js          (18.1 KB) - 英文 G2P，内置词典
│   ├── ja/
│   │   ├── index.js         (6.2 KB)  - 日语 G2P，需 OpenJTalk WASM
│   │   └── phoneme-extract.js (6.0 KB) - 韵律标注提取
│   ├── zh/index.js          (5.5 KB)  - 中文 G2P（空壳，仅透传字符）
│   ├── detect.js            (15.8 KB) - Unicode 范围语言检测
│   ├── pua-map.js           (7.5 KB)  - PUA 映射表（99 项）
│   ├── ssml.js              (12.7 KB) - SSML 解析器
│   ├── encode.js            (5.0 KB)  - Phoneme ID 编码
│   └── [其他语言: es/fr/ko/pt/sv/latin-common]
├── data/
│   └── sv_function_words.json (485 B)
└── types/index.d.ts
```

---

## ✅ P6 可复用的模块

### 1. **日语韵律提取逻辑** ⭐⭐⭐⭐⭐（强烈推荐）

**文件**: `src/ja/phoneme-extract.js` (6 KB, 约 200 行)

**核心价值**:
- ✅ 完整的日语韵律标注提取（A1/A2/A3 → Kurihara 标记）
- ✅ N 音变规则（N_m / N_n / N_ng / N_uvular）
- ✅ PUA 映射（与 P6 spec §1.3 词表定义完全一致）
- ✅ 纯函数，零依赖，可直接移植

**关键函数**:
```javascript
// 从 OpenJTalk 全上下文标注提取音素 + 韵律
export function extractPhonemesFromLabels(labels)
  → { tokens: string[], prosody: (ProsodyInfo | null)[] }

// N 音变规则（上下文相关）
export function applyNPhonemeRules(tokens)

// PUA 映射（多字符 → 单字符）
export function mapToPUA(tokens)
```

**复用方案**:
1. **直接移植** `extractPhonemesFromLabels` 到 Rust
   - 正则提取 A1/A2/A3：`/\/A:([\d-]+)\+/` 等
   - 韵律标记插入逻辑（`[` / `]` / `#`）
   - pau → `_`、sil → `^` / `$` 映射

2. **N 音变规则** 已实现且经过生产验证
   - 向前查找下一个非标记音素
   - 按下一音素特征分类（双唇/齿龈/软腭/小舌）

3. **PUA 映射表** 与 P6 spec §1.3 词表定义一致
   - `a:` → `\uE000`、`ky` → `\uE006` 等
   - 省去自己维护映射表的工作

**节省工作量**: ⏱️ 2-3 天（韵律标注 + N 音变 + PUA 映射）

---

### 2. **PUA 映射表** ⭐⭐⭐⭐（推荐）

**文件**: `src/pua-map.js` (7.5 KB)

**核心价值**:
- ✅ 99 项 PUA 映射（日语 28 + 中文 48 + 共享 + 其他语言）
- ✅ 版本兼容性检查机制
- ✅ 正反向映射（token ↔ PUA）

**定义**:
```javascript
export const PUA_MAP = {
  // 日语（28 项）
  "a:": "\uE000", "i:": "\uE001", "u:": "\uE002", "e:": "\uE003", "o:": "\uE004",
  "cl": "\uE005", "ky": "\uE006", "kw": "\uE007", "gy": "\uE008", "gw": "\uE009",
  "ty": "\uE00A", "dy": "\uE00B", "py": "\uE00C", "by": "\uE00D", "ch": "\uE00E",
  "ts": "\uE00F", "sh": "\uE010", "zy": "\uE011", "hy": "\uE012", "ny": "\uE013",
  "my": "\uE014", "ry": "\uE015", "?!": "\uE016", "?.": "\uE017", "?~": "\uE018",
  "N_m": "\uE019", "N_n": "\uE01A", "N_ng": "\uE01B", "N_uvular": "\uE01C",
  
  // 中文（48 项，声母 + 韵母）
  // ... 省略 ...
  
  // 其他语言
  "rr": "\uE01D", "y_vowel": "\uE01E", // ...
};

export const PUA_COMPAT_VERSION = 2;
```

**复用方案**:
- **直接复制** PUA 映射表到 Rust（作为常量）
- 省去自己设计 PUA 码位分配的工作

**节省工作量**: ⏱️ 半天

---

### 3. **SSML 解析器** ⭐⭐⭐（可选）

**文件**: `src/ssml.js` (12.7 KB)

**核心价值**:
- ✅ 支持 W3C SSML 子集（`<speak>` / `<break>` / `<prosody>`）
- ✅ DoS 防护（最大 100 KB 输入）
- ✅ 优雅降级（未知标签提取文本内容）

**支持的标签**:
```xml
<speak>
  <break time="500ms"/>          <!-- 静音 500ms -->
  <break strength="medium"/>     <!-- 预定义静音 -->
  <prosody rate="slow">text</prosody>  <!-- 语速控制 -->
</speak>
```

**复用方案**:
- P6 spec §2.5 提到「未来的 SSML 支持」
- 可作为 P6.5 或 P7 的基础代码

**节省工作量**: ⏱️ 1-2 天（如果需要 SSML）

---

### 4. **语言检测器** ⭐⭐（辅助）

**文件**: `src/detect.js` (15.8 KB)

**核心价值**:
- ✅ Unicode 范围语言检测（日语假名 / 韩语 / 中文 CJK / 拉丁字母）
- ✅ 瑞典语特殊字符检测（å / Å）
- ✅ 混合文本分段（中英日混排）

**检测优先级**:
```
假名（平假名/片假名）→ 'ja'
谚文（Hangul）       → 'ko'
CJK 表意文字         → 'ja'（如有假名上下文）或 'zh'
全角拉丁字母         → 默认拉丁语言
CJK 标点             → 'ja'
拉丁字母             → 默认拉丁语言
其他                 → null（空白/数字/标点）
```

**复用方案**:
- P6 spec §2.4「Text normalization」可参考其 Unicode 分类逻辑
- 中英日混排场景的分段策略

**节省工作量**: ⏱️ 半天（作为文本规范化的参考）

---

## ❌ 不可复用的部分

### 1. **英文 G2P** (`src/en/index.js`)
- **原因**: 内置词典只有约 200 个常用词
- **P6 方案**: 用 espeak-ng WASM（13 万词）

### 2. **中文 G2P** (`src/zh/index.js`)
- **原因**: 完全是透传（无拼音转换）
- **P6 方案**: 自建或用现有库

### 3. **日语 G2P 初始化** (`src/ja/index.js`)
- **原因**: 需要外部 OpenJTalk WASM + 55 MB 字典下载
- **P6 方案**: 用 lindera-wasm（45 MB，无需下载）

---

## 🎯 推荐复用优先级

| 优先级 | 模块 | 文件 | 节省工作量 | 复用方式 |
|--------|------|------|-----------|---------|
| **P0** | 日语韵律提取 | `ja/phoneme-extract.js` | 2-3 天 | 直接移植到 Rust |
| **P1** | PUA 映射表 | `pua-map.js` | 半天 | 复制常量 |
| **P2** | N 音变规则 | `ja/phoneme-extract.js` | 1 天 | 移植函数逻辑 |
| **P3** | 语言检测 | `detect.js` | 半天 | 参考 Unicode 分类 |
| **P4** | SSML 解析 | `ssml.js` | 1-2 天 | 作为未来扩展 |

**总节省**: ⏱️ **4-5 天开发时间**

---

## 📝 具体行动建议

### 立即可做（Phase 1）

1. **复制 PUA 映射表**
   ```rust
   // lib/phonemize/src/pua.rs
   const PUA_MAP: &[(&str, char)] = &[
       ("a:", '\u{E000}'),
       ("i:", '\u{E001}'),
       // ... 从 pua-map.js 复制全部 99 项
   ];
   ```

2. **移植韵律提取逻辑**
   ```rust
   // lib/phonemize/src/ja/prosody.rs
   pub fn extract_phonemes_from_labels(labels: &str)
       -> (Vec<String>, Vec<Option<ProsodyInfo>>)
   {
       // 移植 extractPhonemesFromLabels 函数
       // 正则: /-([\w-]+)\+/  提取音素
       // 正则: /\/A:([\d-]+)\+/  提取 A1
       // 正则: /\+([0-9]+)\+/   提取 A2
       // 正则: /\+([0-9]+)\//   提取 A3
   }
   ```

3. **移植 N 音变规则**
   ```rust
   // lib/phonemize/src/ja/n_variants.rs
   pub fn apply_n_phoneme_rules(tokens: Vec<String>) -> Vec<String> {
       // 移植 applyNPhonemeRules 函数
   }
   ```

### 未来可做（Phase 2+）

4. **参考语言检测逻辑**（P6 §2.4 文本规范化时）
5. **评估 SSML 解析器**（P6.5 或 P7 韵律控制）

---

## 🔍 关键代码片段

### 韵律标记插入逻辑（JavaScript 原版）

```javascript
// 插入重音核标记 "]"
if (a1 === 0 && a2Next === a2 + 1) {
  tokens.push("]");
  prosody.push(null);
}

// 插入重音短语边界 "#"
if (a2 === a3 && a2Next === 1) {
  tokens.push("#");
  prosody.push(null);
}

// 插入上升标记 "["
if (a2 === 1 && a2Next === 2) {
  tokens.push("[");
  prosody.push(null);
}
```

### N 音变规则（JavaScript 原版）

```javascript
// 查找下一个实际音素（跳过标记）
let nextPhoneme = null;
for (let j = i + 1; j < tokens.length; j++) {
  if (!SKIP_TOKENS.has(tokens[j])) {
    nextPhoneme = tokens[j];
    break;
  }
}

// 根据下一音素分类
if (nextPhoneme === null) {
  result.push("N_uvular");
} else if (["m", "my", "b", "by", "p", "py"].includes(nextPhoneme)) {
  result.push("N_m");  // 双唇音前
} else if (["n", "ny", "t", "ty", "d", "dy", "ts", "ch"].includes(nextPhoneme)) {
  result.push("N_n");  // 齿龈音前
} else if (["k", "ky", "kw", "g", "gy", "gw"].includes(nextPhoneme)) {
  result.push("N_ng"); // 软腭音前
} else {
  result.push("N_uvular");
}
```

---

## 📌 总结

### ✅ 值得复用
1. **日语韵律提取全套逻辑**（核心价值，节省 2-3 天）
2. **PUA 映射表**（直接可用，节省半天）
3. **N 音变规则**（生产验证，节省 1 天）

### ❌ 不需要复用
1. **英文 G2P**（词典太小）
2. **中文 G2P**（只是空壳）
3. **日语 WASM 集成**（依赖外部下载）

### 💡 方法论
这是一个**算法库**而非**完整引擎**：
- **G2P 实现层**不可用（中日文缺失/需外部依赖）
- **辅助算法层**高质量（韵律提取/PUA 映射/N 音变）
- **复用策略**：只取算法逻辑，不取基础设施

### 🎯 与 P6 的关系
- **不改变 P6 总体方案**（仍需自建 G2P）
- **加速特定任务**（日语韵律提取直接可用）
- **降低维护成本**（PUA 映射表已定义）

---

**生成时间**: 2026-10-03  
**分析者**: Claude Code (deepseek-flash)  
**验证依据**: V0 验证报告 (`tests/v0/v0-summary.md`)
