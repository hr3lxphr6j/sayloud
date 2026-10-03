# P6 Rust Phonemize 实施计划摘要

**创建日期**: 2026-10-03  
**完整计划**: `2026-10-03-p6-rust-phonemize-spec.md`（已包含实施计划）

## 概览

将 TTS-NG 的文本预处理（TN + G2P）从 JavaScript 迁移到 Rust，交付单个 wasm 模块，支持中日英三种语言。

## 目标与约束

- **单 wasm 模块**：phonemize.wasm ~3 MB（不含字典）
- **冷启动 ≤ 100 ms**：wasm + 字典就绪
- **输出等价**：Rust 输出 = JS 输出，或有记录的更优
- **字典打包进扩展**：用户零下载，zstd 压缩传输
- **双 worker 架构**：phonemize worker 与 kokoro worker 分离

## 实施路径

### 8 个阶段，24 个任务

1. **基础设施搭建** (2 任务)
   - Rust workspace + wasm-bindgen
   - TypeScript wrapper

2. **字典协议与加载** (2 任务)
   - Rust 字典注册与 zstd 解压
   - TS fetch + 传字节

3. **日语 lindera 集成** (2 任务)
   - lindera 依赖
   - IPADic 下载与加载（10 MB 压缩）

4. **英文 espeak-ng 集成** (2 任务)
   - C 源码通过 cc crate 编译
   - 数据文件打包

5. **中文 G2P 与 vocab 闸门** (2 任务)
   - 拼音表迁移
   - 两个模型的 vocab 校验

6. **前端组装与对照测试** (3 任务)
   - 中文 v1.0 IPA 前端
   - 提取现有 1430 测试的语料
   - 其余 3 个前端（中文 v1.1-zh / 日语 / 英文）

7. **双 worker 架构** (3 任务)
   - 创建 phonemize worker
   - kokoro worker 移除 phonemize
   - offscreen 主线程协调

8. **验证与清理** (6 任务)
   - 对照测试全量通过
   - 性能与内存验证（V8）
   - 错误处理完善
   - 移除 JS 链
   - 文档更新
   - 最终验收

### 最小可验证路径（MVP）

```
1.1-1.2 → 2.1-2.2 → 3.1-3.2 → 5.2 → 6.1 → 7.1-7.3
```

此时可以跑通：选中文音色 → 播放 → 听到声音。

## 技术栈

- **Rust**: wasm-bindgen, lindera (日语), zstd, cc (espeak 编译)
- **字典**: lindera-ipadic (10 MB), espeak-data (~几 MB)
- **测试**: Rust 集成测试 + TS 对照测试 + E2E 内存验证

## 关键验证点

| 验证项 | 任务 | 方法 |
|--------|------|------|
| V1 (部分) | 3.1 | Node 环境验证 lindera 不建索引 |
| V2 | 3.1 | zstd 解压 45 MB 的实际耗时 |
| V8 | 8.2 | offscreen worker 里 lindera 的内存行为 |
| 对照测试 | 8.1 | 1430 测试样本 100% 覆盖 |
| 性能 | 8.2 | 冷启动、单句耗时实测 |

## 成功标准

spec §0.4:

- ✅ 输出等价（对照测试全绿或记录改进）
- ✅ 冷启动 ≤ 100 ms
- ✅ 单 wasm 模块
- ✅ 开箱即用（字典打包）

## 风险与缓解

1. **espeak 文件系统访问** → emscripten 虚拟 FS
2. **lindera 内存（45 MB）** → V8 早期验证
3. **对照测试覆盖率** → 补充 corpus
4. **双 worker 错误同步** → 错误分类 + failAll

## 依赖决策

spec §6 列出 22 条决策，关键的包括：

- #2: espeak 编进同一 wasm
- #6: 传压缩态，wasm 内解压（zstd）
- #9: 字典按需加载
- #16: 双 worker 架构
- #22: 字典在选音色时预取（方案 C）

## 交付物

### 代码

```
crates/phonemize/          # Rust crate
lib/models/phonemize-rust.ts
entrypoints/offscreen/phonemize.worker.ts
entrypoints/offscreen/kokoro.worker.ts
public/dictionaries/       # 字典资源
scripts/build-phonemize-wasm.sh
```

### 文档

```
docs/phonemization-architecture.md  # 重写
docs/superpowers/plans/p6-acceptance.md
docs/superpowers/plans/p6-improvements.md
crates/phonemize/README.md
```

### 测试

```
crates/phonemize/tests/integration.rs
tests/unit/models/phonemize-rust-parity.test.ts
tests/performance/phonemize-benchmark.test.ts
tests/e2e/offscreen-worker-memory.spec.ts
```

## 执行建议

**推荐**: subagent-driven-development

每个任务由独立子代理实现，任务间审查。适合本计划因为：
- 24 个任务，接口明确
- Rust + TS 双侧，子代理隔离语言上下文
- 对照测试是天然的审查点

**备选**: executing-plans

在当前会话按顺序执行。适合快速迭代，但需注意 Rust 工具链配置。

## 下一步

1. 用户审阅此计划
2. 选择执行方式（subagent-driven / executing-plans）
3. 从任务 1.1 开始实施

---

**完整计划**: 3726 行，包含每个任务的详细步骤（测试先行、验证命令、commit 信息）。
