# 日语支持实现总结

## 已完成工作

### 1. 调研 Kokoro 的日语 G2P 方案
- **发现**：Kokoro 训练时使用 `misaki` 作为官方 G2P 引擎
- **misaki 日语实现**：
  - 汉字→假名：`pyopenjtalk`（OpenJTalk 的 Python 绑定）
  - 假名→IPA：静态映射表 `M2P`（约90个片假名字符）
  - 参考：https://github.com/hexgrad/misaki/blob/main/misaki/ja.py

### 2. 实现假名→IPA 转换
- **文件**：`lib/models/phonemize/japanese.ts`
- **核心功能**：
  - `KATAKANA_TO_IPA`：片假名到 IPA 的映射表（从 misaki 提取）
  - `HIRAGANA_TO_KATAKANA`：平假名到片假名的转换
  - `kanaToIPA()`：将假名文本转换为 IPA
  - `textToKatakana()`：使用 kuroshiro 将汉字转为假名
  - `phonemizeJapanese()`：完整的日语文本→IPA 管道

### 3. 关键 IPA 映射（匹配 Kokoro 训练数据）
```typescript
'シ': 'ɕi',   // sh sound
'ジ': 'ʥi',   // j sound  
'チ': 'ʨi',   // ch sound
'ツ': 'ʦu',   // ts sound
'ン': 'ɴ',    // n sound
```

**与 `kana2ipa` 的差异**：
- ❌ `kana2ipa`: 'は' → 'ha', 'わ' → 'ɰa'
- ✅ **misaki**: 'は' → 'ha', 'わ' → 'wa'

### 4. 添加日语音色
- **文件**：`lib/providers/kokoro-voices.ts`
- **新增音色**：
  - `jf_alpha` (女 · Alpha)
  - `jf_gongitsune` (女 · Gongitsune)
  - `jf_nezumi` (女 · Nezumi)
  - `jf_tebukuro` (女 · Tebukuro)
  - `jm_kumo` (男 · Kumo)

### 5. 测试
- **文件**：`tests/unit/models/phonemize/japanese.test.ts`
- **覆盖**：
  - ✅ 基础假名转换（平假名、片假名）
  - ✅ 所有假名系列（K/S/T/N/H/M/Y/R/W）
  - ✅ 常用词汇（こんにちは、ありがとう）
  - ✅ 混合假名
  - ✅ 标点保留
  - **16/16 测试通过**

## 依赖

### 已安装
- `kuroshiro@1.2.0` - 汉字→假名转换
- `kuroshiro-analyzer-kuromoji@1.1.0` - 形态分析器（~10MB 词典）

### 词典大小
- Kuromoji 词典：~10MB（需要打包到扩展中）

## 当前状态

### ✅ 已完成
1. Kana→IPA 转换（核心功能）
2. 日语音色列表
3. 测试套件（基础映射）

### ⚠️ 待完善
1. **Kuroshiro 集成调试**
   - 在 Node.js 测试环境中加载失败
   - 需要在实际扩展环境中验证
   - 词典路径配置需调整

2. **特殊情况处理**
   - 促音（ッ）：gemination（辅音加倍）
   - 长音（ー）：vowel lengthening
   - 助词读音：は→wa、へ→e、を→o（需要语法分析）

3. **音高重音（Pitch Accent）**
   - misaki 生成 `^` `-` `_` 标记
   - 当前实现未包含
   - 需要测试 Kokoro 是否必需

## 下一步

### 立即可做
1. **在扩展中集成日语 phonemizer**
   - 在 `phonemize()` 函数中添加日语分支
   - 检测日语文本（`/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/`）
   - 调用 `phonemizeJapanese()`

2. **测试真实听感**
   - 用日语音色合成测试
   - 验证 IPA 格式是否正确
   - 对比 misaki 官方实现的输出

### 如果需要改进
1. **实现 Pitch Accent**
   - 需要 pyopenjtalk 或类似工具
   - 或者测试证明不需要

2. **优化词典加载**
   - Kuromoji 词典较大（~10MB）
   - 考虑按需加载或 CDN

3. **处理特殊情况**
   - 促音、长音
   - 助词特殊读音

## 参考资料

- [hexgrad/misaki](https://github.com/hexgrad/misaki) - Kokoro 官方 G2P
- [polm/cutlet](https://github.com/polm/cutlet) - 日语 romaji 转换
- [pyopenjtalk](https://github.com/r9y9/pyopenjtalk) - OpenJTalk Python 绑定
- [kuroshiro](https://github.com/hexenq/kuroshiro) - 汉字假名转换

## 文件清单

```
lib/models/phonemize/japanese.ts         # 日语 phonemizer
tests/unit/models/phonemize/japanese.test.ts  # 测试
lib/providers/kokoro-voices.ts           # 音色列表（已更新）
```

---

**创建日期**：2026-10-02  
**状态**：核心功能完成，等待扩展集成测试
