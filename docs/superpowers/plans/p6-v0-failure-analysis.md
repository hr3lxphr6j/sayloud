# P6 V0 验证失败分析与下一步方案

**日期**: 2026-10-03  
**验证对象**: `@piper-plus/g2p@0.4.2`  
**结论**: ❌ 不通过  
**执行者**: deepseek-flash subagent  
**详细报告**: `tests/v0/v0-summary.md`

---

## 核心发现（三条决定性问题）

### 1. 中文完全没有 G2P（93.3% vocab 缺失）

**现象**：`你好` → `你好`（原样返回汉字）

**根因**：源码 `ChineseG2P._fallbackPhonemize` 两个分支都是 `tokens.push(char)`——纯字符透传，没有拼音转换。

**影响**：
- 汉字不是音素，无法输入 Kokoro
- 93.3% 字符不在 v1.0 vocab（v1.1-zh 为 77.8%）
- 无法用适配层修复（没有可映射的目标）

### 2. 日语无法初始化（需要外部下载）

**现象**：所有日语样本抛错 `openjtalkModule is required`

**根因**：
- 包内无任何 wasm（332 KB 纯 JS）
- 需要外部 OpenJTalk wasm + 运行时下载 ~55 MB 词典
- 项目现有的 `wasm_open_jtalk` 是 CLI 构建，不兼容

**影响**：违反 P6 spec §0.4「用户零下载」要求

### 3. 英文可用但劣于 espeak（质量退化）

**现象**：
- 5/10 样本与 espeak 不同
- 2/10 样本有硬错误（一词多个主重音）
- `phoneme` → `fˈɑnˈɛmˈɛ`（2 音节读成 3 个）

**影响**：
- Kokoro v1.0 按 espeak 训练，偏离会退化音质
- 虽然快 ~100×，但性能从不是 P6 的理由（spec §0.2）

---

## 根因：定位错位

上游 `piper-plus@0.7.0` 自己标注的：

```js
// Languages that REQUIRE Rust WASM (no functional JS G2P fallback):
//   ja — needs jpreprocess (no JS equivalent)
//   zh — needs pinyin dictionary (JS G2P has no pinyin conversion)
const WASM_REQUIRED_LANGUAGES = new Set(["ja", "zh"]);
```

**`@piper-plus/g2p` 是降级回退层，不是完整实现。**

上游对中日文一律改走它自带的 57 MB Rust wasm。我们把它当「三语现成方案」评估，从前提上就错了。

---

## 决策文档需要更正的部分

| 文档宣称 | 实测结果 |
|---|---|
| 「开箱即用的三语方案」 | 中文无 G2P、日语无法初始化 |
| 「WebAssembly 就绪」 | **包内无 wasm**，纯 JS |
| 「日语 OpenJTalk 完整实现」 | 代码支持，但需外部模块 + ~55 MB 下载 |
| 示例 `g2p('hello','en')` | `TypeError: g2p is not a function` |
| 「V0 通过概率 70-80%」 | 实际 0% |

---

## 唯一的好消息：发现了真正的候选

**`piper-plus@0.7.0`（上游完整包）自带：**

- ✅ **57.3 MB Rust wasm**（`piper_plus_wasm_bg.wasm`）
- ✅ **内置 NAIST-JDIC 词典**（零下载）
- ✅ **8 种语言**（中日英 + 韩/西/法/葡/瑞典）
- ✅ **Rust 编写**
- ✅ **MIT 许可**

**这个形态恰好命中 P6 spec 的目标：**
- 单个 wasm ✅
- 字典打包（内置）✅
- 用户零下载 ✅
- Rust 实现 ✅
- 多语言支持 ✅

**唯一的权衡**：57 MB vs 原计划的 ~3 MB + 字典

---

## 三个候选方案对比

| 维度 | piper-plus Rust wasm | 原 P6 计划 | @piper-plus/g2p |
|------|---------------------|-----------|-----------------|
| **中英日覆盖** | ✅ 8 语言 | ✅ 3 语言 | ❌ 仅英文可用 |
| **字典方式** | 内置（57 MB） | 压缩传输（~10 MB） | N/A |
| **用户下载** | 零 | 零 | ❌ 需 ~55 MB |
| **开发时间** | ~0.5-1 天验证 | 2-3 周自建 | N/A |
| **维护成本** | 上游维护 | 自维护 | N/A |
| **许可证** | MIT | ⚠️ GPL (espeak) | MIT |
| **已验证** | ❌ 待测 | ❌ 未开始 | ✅ 不通过 |

---

## 下一步建议

### 方案 A：验证 piper-plus Rust wasm（强烈推荐）

**理由**：
1. 形态完美命中 P6 目标（单 wasm + 内置字典 + Rust + 多语言）
2. 比自建节省 2-3 周开发时间
3. 上游维护，避免 espeak GPL
4. 已知它工作良好（piper-plus 是成熟的生产级 TTS）

**投入**：半天验证
1. 安装 `piper-plus@0.7.0`
2. 提取 Rust wasm（57 MB）
3. 测试 API（中日英各 10 样本）
4. Vocab 兼容性检查
5. 性能基准

**决策点**：
- ✅ 通过 → 直接集成（预计 1-2 天）
- ⚠️ 部分通过 → 写适配层
- ❌ 失败 → 回到原 P6 计划

**风险**：
- 57 MB 可能影响扩展包体积 → 可接受（Chrome 扩展无硬上限，实测中）
- 输出格式可能不兼容 → V1 验证会暴露

### 方案 B：回到原 P6 计划（24 任务）

**理由**：
- 完全自主控制
- 可以优化到 ~3 MB wasm + ~10 MB 压缩字典

**代价**：
- 2-3 周开发时间
- espeak GPL 风险
- 长期维护成本高

**时机**：仅当方案 A 验证失败

### 方案 C：混合方案（不推荐）

保留现有 JS 链 + 部分替换：
- 英文：保留 espeak（或用 piper 降级）
- 中文：自建拼音表
- 日语：jpreprocess 或 lindera

**问题**：复杂度最高，维护成本最高

---

## 成本效益对比（更新）

| 方案 | 开发时间 | 体积 | 许可证 | 维护 | 推荐度 |
|------|---------|------|--------|------|--------|
| **piper-plus Rust** | 1-2 天 | 57 MB | MIT | 上游 | ⭐⭐⭐⭐⭐ |
| **原 P6 计划** | 2-3 周 | ~13 MB | GPL | 自建 | ⭐⭐ |
| **@piper-plus/g2p** | — | 332 KB | MIT | — | ❌ 不可用 |

---

## V0 交付物清单

subagent 已完成以下文件（`tests/v0/` 目录）：

1. ✅ `v0-summary.md` - 完整验证报告
2. ✅ `install-report.md` - 安装与 API 分析
3. ✅ `piper-comparison.json` - 30 条样本对比
4. ✅ `vocab-check.json` - 双 vocab 兼容性
5. ✅ `performance-results.json` - 性能基准
6. ✅ `js-chain-performance.json` - 现有链路基线
7. ✅ `kokoro-vocabs.json` - 实测词表（可复现）
8. ✅ `comparison.test.ts` - 对比脚本
9. ✅ `performance-benchmark.mjs` - 性能脚本

**验证完整性**：
- ✅ 项目测试套件 1430/1430 通过
- ✅ biome check 通过（192 文件）
- ✅ tsc --noEmit 通过
- ✅ 仅新增文件，无修改现有代码

---

## 下一步行动

**立即决定**：

1. **执行方案 A**（推荐）
   - 启动新的 subagent 验证 `piper-plus@0.7.0` Rust wasm
   - 估算时间：半天验证 + 1-2 天集成（若通过）
   - 总计：1.5-2.5 天 vs 原计划 2-3 周

2. **直接开始原 P6 计划**
   - 按 24 任务执行（spec 已完整定义）
   - 承担 espeak GPL 风险
   - 2-3 周完成

3. **暂停等待更多信息**
   - 评估 57 MB 对扩展包体积的影响
   - 调研其他备选方案

---

**建议**：强烈推荐先执行方案 A 的验证（半天）。投入极小，若通过则节省 2 周 + 避免 GPL + 降低维护成本。

