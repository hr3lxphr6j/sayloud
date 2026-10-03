# P6 G2P 库选型评估

**日期**: 2026-10-03  
**目的**: 基于调研结果，重新评估预处理方案选型

---

## 候选方案对比

### 1. piper-plus-g2p

**简介**: 多语言 G2P 库，MIT 许可，无 GPL 依赖

**支持语言**: 8 种（日/英/中/韩/西/法/葡/瑞典）

**特性**:
- ✅ **已有 npm 包** (`@piper-plus/g2p`)，直接可用
- ✅ **WebAssembly 就绪**，浏览器原生运行
- ✅ **MIT 许可**，无 espeak-ng GPL 问题
- ✅ **日语完整支持**：基于 OpenJTalk，含音高重音和韵律
- ✅ **中英日三语覆盖**
- ✅ **规则驱动**：每种语言独立的规则表
- ✅ **多平台**：Python/JS/C#/Rust/Go/C++/Swift/Kotlin

**架构**:
```
piper-plus
├── G2P 组件 (@piper-plus/g2p)
│   ├── Japanese: OpenJTalk 完整实现
│   ├── Chinese: 规则表
│   ├── English: 规则表（非 espeak）
│   └── ... 其他语言
└── VITS 合成引擎
```

**尺寸**: 未知（需实测 wasm 大小）

**使用示例** (npm):
```javascript
import { g2p } from '@piper-plus/g2p';
const phonemes = g2p('こんにちは', 'ja');
```

---

### 2. jpreprocess

**简介**: OpenJTalk 的 Rust 重写

**支持语言**: 仅日语

**特性**:
- ✅ **Rust 原生**，适合编译到 wasm
- ✅ **MIT 许可**
- ✅ **OpenJTalk 兼容**，完整 TTS 预处理管线
- ✅ **包含 TN + 形态分析 + G2P + 韵律**
- ❌ **仅日语**，中英需要其他方案

**用途**: 
- 如果只需要日语且要完整控制
- 作为 lindera 的替代品（功能更全）

---

### 3. haqumei

**简介**: 轻量级日语 G2P 库（Rust）

**支持语言**: 仅日语

**特性**:
- ✅ **Rust 原生**
- ✅ **MIT 许可**
- ✅ **轻量级**：只做 G2P，不含 TN 和韵律
- ❌ **仅日语**
- ❌ **功能比 jpreprocess 少**（无韵律）

**用途**:
- 最小化依赖
- 只需要基本的假名转音素

---

### 4. 原方案（P6 实施计划）

**组合**:
- 日语: lindera + 手工映射表
- 中文: pinyin 表 + jieba/lindera-cc-cedict
- 英文: espeak-ng（GPL，需编译 C 代码）

**特性**:
- ✅ 完全自主控制
- ❌ espeak-ng GPL 许可
- ❌ espeak 编译复杂（build.rs + C 源码）
- ❌ 三种语言分别实现，维护成本高
- ❌ 日语映射表需要手工维护

---

## 决策矩阵

| 维度 | piper-plus-g2p | jpreprocess | haqumei | 原方案 |
|------|----------------|-------------|---------|--------|
| **中英日覆盖** | ✅ 8 种语言 | ❌ 仅日语 | ❌ 仅日语 | ✅ 中英日 |
| **许可证** | ✅ MIT | ✅ MIT | ✅ MIT | ❌ GPL (espeak) |
| **浏览器就绪** | ✅ npm + wasm | ⚠️ 需编译 | ⚠️ 需编译 | ⚠️ 需编译 |
| **日语韵律** | ✅ OpenJTalk | ✅ 完整 | ❌ 无 | ❌ 手工实现 |
| **集成复杂度** | ✅ 直接引用 npm | ⚠️ Rust dep | ⚠️ Rust dep | ❌ 高（C + Rust） |
| **维护成本** | ✅ 上游维护 | ⚠️ 中 | ⚠️ 中 | ❌ 高（三套代码） |
| **冷启动** | ❓ 待测 | ❓ 待测 | ✅ 轻量 | ⚠️ espeak 数据 |
| **Kokoro 兼容** | ❓ 输出格式待验证 | ❓ | ❓ | ✅ 已验证 |

---

## 推荐方案

### 方案 A：piper-plus-g2p 为主（推荐）

**理由**:
1. **现成的多语言方案**：中英日都支持，一个库搞定
2. **MIT 许可**：避免 GPL 传染
3. **npm 包开箱即用**：`@piper-plus/g2p`，无需编译 C 代码
4. **日语质量高**：OpenJTalk 完整实现，含韵律
5. **维护成本低**：上游主动维护，多平台测试

**架构调整**:
```
entrypoints/offscreen/
└── phonemize.worker.ts
    └── import { g2p } from '@piper-plus/g2p'

不再需要：
- crates/phonemize/（整个 Rust crate）
- espeak-ng submodule
- lindera 集成
- 手工拼音/假名映射表
```

**待验证** (V0):
1. piper-plus-g2p 的输出格式是否与 Kokoro 兼容
2. wasm 大小（目标 < 5 MB）
3. 冷启动时间（目标 < 100 ms）
4. 与现有 JS 链的输出对比

**实施路径**:
1. 安装 `@piper-plus/g2p`
2. 编写对照测试（piper vs 现有 JS）
3. 若输出格式不兼容，写适配层
4. 性能验证
5. 替换现有 phonemize 目录

**风险**:
- 输出格式可能与 Kokoro 的 vocab 不完全匹配 → 需要适配层
- 依赖上游更新（但项目活跃，2024 年持续更新）

---

### 方案 B：混合方案（备选）

如果 piper-plus-g2p 在 Kokoro 上表现不理想：

```
日语: jpreprocess（Rust，MIT，OpenJTalk 兼容）
中文: piper-plus-g2p 的中文部分（或保留 pinyin 表）
英文: piper-plus-g2p 的英文部分（规则驱动，MIT）
```

**优点**:
- 每种语言用最佳方案
- 避免 espeak GPL

**缺点**:
- 维护三套代码
- 集成复杂度高

---

### 方案 C：保留原方案（不推荐）

仅当以下情况考虑：
- piper-plus-g2p 实测性能/质量不达标
- 必须完全自主控制每个细节
- GPL 许可可接受（或找到 espeak 的 MIT 替代）

---

## 下一步行动

### 立即执行（V0 验证）

1. **安装测试** piper-plus-g2p
   ```bash
   npm install @piper-plus/g2p
   ```

2. **编写对照脚本**
   ```typescript
   import { g2p } from '@piper-plus/g2p';
   import { ChinesePhonemizer } from '~/lib/models/phonemize/chinese';
   
   const samples = ['你好', 'こんにちは', 'hello'];
   
   for (const text of samples) {
     const piperOutput = g2p(text, detectLang(text));
     const currentOutput = await currentPhonemize(text);
     console.log({ text, piper: piperOutput, current: currentOutput });
   }
   ```

3. **检查 vocab 兼容性**
   - 对照 piper 输出与 Kokoro v1.0 / v1.1-zh 的 vocab
   - 记录需要适配的字符（如 `ɚ` → `əɹ`）

4. **性能基准测试**
   - wasm 加载时间
   - 单句 phonemize 耗时
   - 内存占用

### 决策点

**若 V0 通过**（输出兼容 + 性能达标）：
→ 采用方案 A，放弃原 P6 计划（24 任务），改为：
  - 任务 1: 集成 piper-plus-g2p
  - 任务 2: 适配层（若需要）
  - 任务 3: 对照测试
  - 任务 4: 移除旧代码

**若 V0 部分通过**（某语言不理想）：
→ 采用方案 B，混合集成

**若 V0 失败**：
→ 回到原 P6 计划

---

## 附：piper-plus-g2p 技术细节待调研

1. API 接口：`g2p(text, lang)` 的完整签名
2. 输出格式：IPA / ARPABET / 自定义？
3. 错误处理：非法输入、不支持语言
4. 配置选项：是否可调整韵律、声调
5. wasm 内存管理：字典是否内置、尺寸多大
6. 浏览器兼容性：是否需要 COOP/COEP
7. npm 包版本稳定性：最新版本、更新频率

