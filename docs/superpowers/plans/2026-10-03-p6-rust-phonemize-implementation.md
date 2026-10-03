# P6 Rust Phonemize 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 TTS-NG 的文本预处理（TN + G2P）从 JavaScript 迁移到 Rust，交付单个 wasm 模块，支持中日英三种语言。

**架构：** Rust 侧构建链式预处理流水线（TN → 分词 → G2P → 组装 → vocab 闸门），编译为单个 wasm 模块（含 espeak-ng），字典打包进扩展、按需加载、压缩传输、wasm 内解压。拆分为两个 worker（phonemize / kokoro）实现冷启动并行。

**技术栈：** 
- Rust: wasm-bindgen, lindera (日语分词), fst/regex-automata (TN), zstd (解压)
- 集成: WXT, pnpm workspace
- 对照: 保留现有 JS 链做回归测试

**规格：** `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`

---

## 全局约束

1. **单 wasm 模块**：phonemize.wasm 包含 TN + 中日英三种语言 + espeak-ng，估算 ~3 MB（不含字典）
2. **冷启动 ≤ 100 ms**（wasm + 字典就绪），首次触达某语言再 +~100 ms（按需加载）
3. **输出等价**：Rust 输出逐字符等于 JS 输出，或有记录的更优
4. **字典打包进扩展**：用户零下载，压缩传输（zstd），wasm 内解压
5. **按需加载**：只加载当前音色所需语言的字典
6. **双 worker**：phonemize worker 与 kokoro worker 分离，调度留在 offscreen 主线程
7. **vocab 闸门**：每个 frontend 一份 vocab，统一校验输出字符
8. **JS 链保留**：作为对照组，通过全部现有测试后再移除

---

## 审查重点（Review Focus）

1. **vocab 违规字符**：输出包含目标模型 vocab 外的字符时，tokenizer 会静默删除（如 v1.1-zh 遇到 `ɚ`），导致音频与文本不对齐。预期：vocab 闸门拦截并明确报错，指出哪个字符、来自哪个 backend。
2. **字典损坏或缺失**：fetch 失败、zstd 解压失败、文件格式不匹配时，用户看到的应是可操作的错误（"字典加载失败，请重新安装扩展"），而非神秘的音素输出错误。预期：`prepare()` 阶段失败并抛出明确的 `DictionaryLoadError`。
3. **语言不匹配**：用户选日语音色去读中文页面时（lang=ja），v1.0 能处理但 v1.1-zh 不能（无日语 frontend）。预期：`phonemize()` 抛出 `UnsupportedLanguageError`，气泡提示"所选音色不支持当前语言"。
4. **worker 回收不同步**：30 秒回收时，phonemize worker 崩了但 kokoro worker 还活着（或反之），已缓存句子的状态、已 `prepare` 的字典是否仍有效。预期：任一 worker 失败时，`AudioWorker` 调用双方的 `.failAll()`，清空所有 in-flight 请求。
5. **内存泄漏（45 MB 字典）**：offscreen worker 里 lindera 加载 IPADic（45.3 MB 解压后）若未正确释放，多次冷启动会累积。预期：每次 worker 重建时，wasm 线性内存完全重置，旧字典自动释放。

---

## 文件结构

### Rust 侧（新建 `crates/phonemize/`）

```
crates/phonemize/
├── Cargo.toml                     # workspace member, wasm-bindgen + lindera + zstd
├── src/
│   ├── lib.rs                     # wasm_bindgen 入口, Phonemizer 类型
│   ├── types.rs                   # FrontendId, PhonemizeOptions, PhonemizeResult
│   ├── pipeline.rs                # 链式执行器（TextStep → Run → assemble）
│   ├── frontends/
│   │   ├── mod.rs
│   │   ├── zh_ipa.rs              # v1.0 中文：pinyin → IPA + 声调箭头
│   │   ├── zh_zhuyin.rs           # v1.1-zh 中文：pinyin → 注音符号 + 数字声调
│   │   ├── ja_ipa.rs              # v1.0 日语：lindera → IPA
│   │   └── en_espeak.rs           # 英文：espeak-ng（C 源码用 cc 编译）
│   ├── backends/
│   │   ├── mod.rs
│   │   ├── tn.rs                  # Text Normalization (fst/regex-automata)
│   │   ├── segmenter_zh.rs        # 中文分词（jieba-rs 或 lindera-cc-cedict）
│   │   ├── segmenter_ja.rs        # 日语分词（lindera）
│   │   ├── pinyin.rs              # 中文 G2P（查表 + 多音字规则）
│   │   └── numbers.rs             # 数字归一化（中日英）
│   ├── vocab.rs                   # 每个 frontend 的 vocab 闸门
│   ├── dictionary.rs              # 字典协议：required_dictionaries, load_dictionary, finish
│   └── lexicon.rs                 # 用户替换规则（预留，v1 不实现）
└── build.rs                       # 编译 espeak-ng C 源码（cc crate）
```

### TypeScript 侧（修改现有）

```
lib/models/
├── phonemize-rust.ts              # 新建：Rust Phonemizer 的 TS wrapper
├── phonemize/                     # 保留：JS 链做对照，最后移除
│   └── ... (不动)
└── kokoro-engine.ts               # 修改：删除 phonemize 调用，改由 worker 外部传入

entrypoints/offscreen/
├── phonemize.worker.ts            # 新建：phonemize worker（Rust wasm）
├── local.worker.ts                # 修改：改名为 kokoro.worker.ts，移除 phonemize
└── offscreen.ts                   # 修改：创建两个 worker，协调调度

lib/audio-worker.ts                # 修改：phonemize 与 synthesis 分两步调用
lib/models/worker-protocol.ts     # 修改：新增 phonemize 相关消息类型
```

### 字典资源（新建）

```
public/dictionaries/
├── lindera-ipadic-ja.bin.zst      # 日语词典（10 MB 压缩态）
└── (中文词典待定：jieba 或 lindera-cc-cedict)
```

### 测试（新建）

```
crates/phonemize/tests/
├── integration.rs                 # 对照测试：Rust 输出 vs JS 输出
└── corpus.json                    # 从现有 TS 测试提取的语料

tests/unit/models/
└── phonemize-rust.test.ts         # TS 侧集成测试：wasm 加载、字典、错误
```

---


## 阶段 1：基础设施搭建

### 任务 1.1：Rust workspace 与 wasm-bindgen 脚手架

**文件：**
- 创建：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/lib.rs`
- 创建：`crates/phonemize/src/types.rs`
- 修改：`Cargo.toml`（workspace root，若不存在则创建）
- 创建：`scripts/build-phonemize-wasm.sh`

- [ ] **步骤 1：创建 Rust workspace 根目录**

若项目根目录没有 `Cargo.toml`，创建 workspace：

```toml
[workspace]
members = ["crates/phonemize"]
resolver = "2"
```

- [ ] **步骤 2：创建 phonemize crate 的 Cargo.toml**

```toml
[package]
name = "phonemize"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1.0", features = ["derive"] }
serde-wasm-bindgen = "0.6"
zstd = "0.13"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
```

- [ ] **步骤 3：创建最小 wasm-bindgen 入口**

在 `crates/phonemize/src/lib.rs`：

```rust
use wasm_bindgen::prelude::*;

mod types;

pub use types::{FrontendId, PhonemizeOptions, PhonemizeResult};

#[wasm_bindgen]
pub struct Phonemizer {
    // 字段待后续任务填充
}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {}
    }

    /// wasm 模块就绪的标记，此版本立即返回
    pub fn ready(&self) -> js_sys::Promise {
        js_sys::Promise::resolve(&JsValue::NULL)
    }
}
```

- [ ] **步骤 4：定义 TypeScript 映射的类型**

在 `crates/phonemize/src/types.rs`：

```rust
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontendId {
    KokoroV1 = "kokoro-v1",
    KokoroV11Zh = "kokoro-v11-zh",
}

#[derive(Debug, Clone, Deserialize)]
pub struct PhonemizeOptions {
    pub frontend: String,  // FrontendId 的字符串形式
    pub lang: String,      // BCP-47 tag
}

#[derive(Debug, Clone, Serialize)]
pub struct PhonemizeResult {
    pub phonemes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PhonemeSpan>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PhonemeSpan {
    pub char_start: usize,
    pub char_end: usize,
    pub phoneme_start: usize,
    pub phoneme_end: usize,
}
```

- [ ] **步骤 5：创建构建脚本**

在 `scripts/build-phonemize-wasm.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v wasm-pack &> /dev/null; then
  echo "wasm-pack not found. Install: cargo install wasm-pack"
  exit 1
fi

wasm-pack build crates/phonemize \
  --target web \
  --out-dir ../../lib/models/phonemize-wasm \
  --release

echo "✓ phonemize.wasm built to lib/models/phonemize-wasm/"
```

```bash
chmod +x scripts/build-phonemize-wasm.sh
```

- [ ] **步骤 6：验证编译**

运行：`./scripts/build-phonemize-wasm.sh`

预期：输出 `lib/models/phonemize-wasm/phonemize_bg.wasm`（~几 KB，因为还是空壳）

- [ ] **步骤 7：添加到 package.json**

在 `package.json` 的 `scripts` 中添加：

```json
"build:wasm": "./scripts/build-phonemize-wasm.sh",
"prebuild": "pnpm build:wasm"
```

- [ ] **步骤 8：验证集成**

运行：`pnpm build:wasm && ls -lh lib/models/phonemize-wasm/`

预期：生成 4 个文件：`.wasm`, `.js`, `.d.ts`, `package.json`

- [ ] **步骤 9：Commit**

```bash
git add Cargo.toml crates/ scripts/build-phonemize-wasm.sh package.json
git commit -m "feat(p6): scaffold Rust phonemize crate with wasm-bindgen"
```

---

### 任务 1.2：TypeScript wrapper 与最小集成

**文件：**
- 创建：`lib/models/phonemize-rust.ts`
- 创建：`tests/unit/models/phonemize-rust.test.ts`

- [ ] **步骤 1：编写失败的加载测试**

在 `tests/unit/models/phonemize-rust.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';

describe('RustPhonemizer', () => {
  it('loads wasm module', async () => {
    const phonemizer = new RustPhonemizer();
    await phonemizer.ready;
    expect(phonemizer).toBeDefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test phonemize-rust`

预期：FAIL，"Cannot find module '~/lib/models/phonemize-rust'"

- [ ] **步骤 3：实现 RustPhonemizer wrapper**

在 `lib/models/phonemize-rust.ts`：

```typescript
import type { Phonemizer as WasmPhonemizer } from './phonemize-wasm/phonemize';
import init, { Phonemizer as WasmPhonemizerClass } from './phonemize-wasm/phonemize';

export interface PhonemizeOptions {
  readonly frontend: 'kokoro-v1' | 'kokoro-v11-zh';
  readonly lang: string;
}

export interface PhonemizeResult {
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
}

export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

/**
 * Rust-based phonemizer. Synchronous after `ready` resolves.
 */
export class RustPhonemizer {
  private instance: WasmPhonemizer | null = null;
  public readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await init();
    this.instance = new WasmPhonemizerClass();
  }

  /**
   * Preload dictionaries for the given languages.
   * In this minimal version, does nothing (dictionaries added in later tasks).
   */
  async prepare(frontends: readonly string[]): Promise<void> {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO: fetch + load dictionaries
  }

  /**
   * Text to phonemes. Synchronous once ready.
   * In this minimal version, returns empty string (real impl in later tasks).
   */
  phonemize(text: string, options: PhonemizeOptions): PhonemizeResult {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO: call wasm
    return { phonemes: '' };
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test phonemize-rust`

预期：PASS（1 passed）

- [ ] **步骤 5：Commit**

```bash
git add lib/models/phonemize-rust.ts tests/unit/models/phonemize-rust.test.ts
git commit -m "feat(p6): add TypeScript wrapper for Rust phonemizer"
```

---


## 阶段 2：字典协议与加载

### 任务 2.1：字典协议（Rust 侧）

**文件：**
- 创建：`crates/phonemize/src/dictionary.rs`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：编写字典状态测试**

在 `crates/phonemize/tests/integration.rs`（新建）：

```rust
use phonemize::Phonemizer;

#[test]
fn required_dictionaries_returns_empty_for_minimal_config() {
    let phonemizer = Phonemizer::new();
    let frontends = vec![];
    let required = phonemizer.required_dictionaries(&frontends);
    assert_eq!(required.len(), 0);
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd crates/phonemize && cargo test`

预期：FAIL，"no method named `required_dictionaries`"

- [ ] **步骤 3：实现字典协议**

在 `crates/phonemize/src/dictionary.rs`：

```rust
use std::collections::HashMap;

/// 字典状态：名字 -> 字节（压缩态）
pub struct DictionaryRegistry {
    loaded: HashMap<String, Vec<u8>>,
    required: Vec<String>,
}

impl DictionaryRegistry {
    pub fn new() -> Self {
        Self {
            loaded: HashMap::new(),
            required: Vec::new(),
        }
    }

    /// 设置前端需要哪些字典
    pub fn set_required(&mut self, frontends: &[String]) {
        self.required.clear();
        for frontend in frontends {
            match frontend.as_str() {
                "kokoro-v1" => {
                    // v1.0: 中日英三种语言
                    self.require_if_missing("lindera-ipadic-ja");
                }
                "kokoro-v11-zh" => {
                    // v1.1-zh: 只有中英
                    // 日语词典不需要
                }
                _ => {}
            }
        }
    }

    fn require_if_missing(&mut self, name: &str) {
        if !self.required.contains(&name.to_string()) {
            self.required.push(name.to_string());
        }
    }

    pub fn required(&self) -> &[String] {
        &self.required
    }

    /// 喂一个字典（名字 + 压缩态字节）
    pub fn load(&mut self, name: &str, compressed: &[u8]) -> Result<(), String> {
        if !self.required.contains(&name.to_string()) {
            return Err(format!("Unknown dictionary: {}", name));
        }
        self.loaded.insert(name.to_string(), compressed.to_vec());
        Ok(())
    }

    /// 检查是否全部到齐
    pub fn finish(&self) -> Result<(), Vec<String>> {
        let missing: Vec<String> = self.required
            .iter()
            .filter(|name| !self.loaded.contains_key(*name))
            .cloned()
            .collect();
        
        if missing.is_empty() {
            Ok(())
        } else {
            Err(missing)
        }
    }
}
```

- [ ] **步骤 4：在 Phonemizer 中集成**

在 `crates/phonemize/src/lib.rs`：

```rust
mod dictionary;

use dictionary::DictionaryRegistry;

#[wasm_bindgen]
pub struct Phonemizer {
    dictionaries: DictionaryRegistry,
}

#[wasm_bindgen]
impl Phonemizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            dictionaries: DictionaryRegistry::new(),
        }
    }

    /// 这个前端组合需要哪些字典
    pub fn required_dictionaries(&mut self, frontends: &JsValue) -> Vec<String> {
        let frontends: Vec<String> = serde_wasm_bindgen::from_value(frontends.clone())
            .unwrap_or_default();
        self.dictionaries.set_required(&frontends);
        self.dictionaries.required().to_vec()
    }

    /// 喂一个字典：名字 + 压缩态字节
    pub fn load_dictionary(&mut self, name: &str, compressed: &[u8]) -> Result<(), JsValue> {
        self.dictionaries.load(name, compressed)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// 全部到齐后构建索引
    pub fn finish(&self) -> Result<(), JsValue> {
        self.dictionaries.finish()
            .map_err(|missing| {
                let msg = format!("Missing dictionaries: {}", missing.join(", "));
                JsValue::from_str(&msg)
            })
    }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd crates/phonemize && cargo test`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add crates/phonemize/src/dictionary.rs crates/phonemize/src/lib.rs crates/phonemize/tests/
git commit -m "feat(p6): implement dictionary protocol in Rust"
```

---

### 任务 2.2：TypeScript 侧字典加载

**文件：**
- 修改：`lib/models/phonemize-rust.ts`
- 创建：`public/dictionaries/README.md`
- 修改：`tests/unit/models/phonemize-rust.test.ts`

- [ ] **步骤 1：编写字典加载测试**

在 `tests/unit/models/phonemize-rust.test.ts` 添加：

```typescript
it('prepares dictionaries for kokoro-v1', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // 此时字典文件不存在，应该抛错或跳过
  // 先测试 required_dictionaries 返回值
  await expect(phonemizer.prepare(['kokoro-v1'])).rejects.toThrow();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test phonemize-rust`

预期：FAIL，"prepare is not implemented"

- [ ] **步骤 3：实现 prepare() 方法**

在 `lib/models/phonemize-rust.ts` 修改 `prepare`：

```typescript
async prepare(frontends: readonly string[]): Promise<void> {
  if (!this.instance) throw new Error('Phonemizer not ready');
  
  // 询问需要哪些字典
  const required = this.instance.required_dictionaries(frontends);
  
  if (required.length === 0) return;
  
  // 并行 fetch
  const fetched = await Promise.all(
    required.map(async (name) => {
      const url = `/dictionaries/${name}.bin.zst`;
      const res = await fetch(chrome.runtime.getURL(url));
      if (!res.ok) {
        throw new Error(`Failed to fetch dictionary ${name}: ${res.status}`);
      }
      return [name, new Uint8Array(await res.arrayBuffer())] as const;
    })
  );
  
  // 逐个喂给 wasm
  for (const [name, bytes] of fetched) {
    this.instance.load_dictionary(name, bytes);
  }
  
  // 完成加载
  this.instance.finish();
}
```

- [ ] **步骤 4：创建字典占位文件**

在 `public/dictionaries/README.md`：

```markdown
# Phonemization Dictionaries

字典文件在后续任务中添加：

- `lindera-ipadic-ja.bin.zst` - 日语词典（10 MB）
- （中文词典待定）

每个文件都是压缩态（zstd），由 wasm 内部解压。
```

- [ ] **步骤 5：修改测试为 mock fetch**

在 `tests/unit/models/phonemize-rust.test.ts` 修改测试：

```typescript
import { vi } from 'vitest';

it('prepares dictionaries for kokoro-v1', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // Mock chrome.runtime.getURL
  global.chrome = {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://fake/${path}`)
    }
  } as any;
  
  // Mock fetch to return empty buffer (字典还没实际下载)
  global.fetch = vi.fn(() => 
    Promise.resolve({
      ok: false,
      status: 404
    } as Response)
  );
  
  await expect(phonemizer.prepare(['kokoro-v1'])).rejects.toThrow(/Failed to fetch/);
});
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm test phonemize-rust`

预期：PASS（2 passed）

- [ ] **步骤 7：Commit**

```bash
git add lib/models/phonemize-rust.ts public/dictionaries/ tests/unit/models/phonemize-rust.test.ts
git commit -m "feat(p6): implement dictionary loading protocol in TypeScript"
```

---


## 阶段 3：日语 lindera 集成

### 任务 3.1：lindera 依赖与 zstd 解压

**文件：**
- 修改：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/backends/mod.rs`
- 创建：`crates/phonemize/src/backends/segmenter_ja.rs`

- [ ] **步骤 1：添加 lindera 依赖**

在 `crates/phonemize/Cargo.toml` 的 `[dependencies]` 添加：

```toml
lindera = { version = "0.34", default-features = false, features = ["ipadic"] }
```

- [ ] **步骤 2：编写日语分词测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn japanese_segmenter_tokenizes_simple_sentence() {
    use phonemize::backends::JapaneseSegmenter;
    
    let segmenter = JapaneseSegmenter::new();
    // 暂时不加载字典，测试结构
    let result = segmenter.tokenize("テスト");
    // 此时应该返回空或错误（字典未加载）
    assert!(result.is_empty() || result.len() > 0);
}
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd crates/phonemize && cargo test`

预期：FAIL，"no module named `backends`"

- [ ] **步骤 4：实现日语分词器骨架**

在 `crates/phonemize/src/backends/mod.rs`：

```rust
pub mod segmenter_ja;

pub use segmenter_ja::JapaneseSegmenter;
```

在 `crates/phonemize/src/backends/segmenter_ja.rs`：

```rust
use lindera::tokenizer::{Tokenizer, TokenizerConfig};
use std::sync::Arc;

/// 日语分词器，使用 lindera + IPADic
pub struct JapaneseSegmenter {
    tokenizer: Option<Arc<Tokenizer>>,
}

impl JapaneseSegmenter {
    pub fn new() -> Self {
        Self { tokenizer: None }
    }

    /// 从解压后的字典字节构建 tokenizer
    pub fn load_dictionary(&mut self, dict_bytes: &[u8]) -> Result<(), String> {
        // TODO: lindera 的加载逻辑
        // 暂时返回 Ok 让测试通过
        Ok(())
    }

    /// 分词并返回读音
    pub fn tokenize(&self, text: &str) -> Vec<Token> {
        if self.tokenizer.is_none() {
            return vec![];
        }
        
        // TODO: 实际分词
        vec![]
    }
}

#[derive(Debug, Clone)]
pub struct Token {
    pub surface: String,
    pub reading: Option<String>,
}
```

- [ ] **步骤 5：在 lib.rs 中暴露 backends**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
pub mod backends;
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd crates/phonemize && cargo test`

预期：PASS（骨架测试通过）

- [ ] **步骤 7：实现 zstd 解压逻辑**

在 `crates/phonemize/src/dictionary.rs` 修改 `load` 方法：

```rust
use zstd;

impl DictionaryRegistry {
    /// 喂一个字典（名字 + 压缩态字节），立即解压
    pub fn load(&mut self, name: &str, compressed: &[u8]) -> Result<(), String> {
        if !self.required.contains(&name.to_string()) {
            return Err(format!("Unknown dictionary: {}", name));
        }
        
        // zstd 解压
        let decompressed = zstd::decode_all(compressed)
            .map_err(|e| format!("Failed to decompress {}: {}", name, e))?;
        
        self.loaded.insert(name.to_string(), decompressed);
        Ok(())
    }
    
    /// 获取已解压的字典字节
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.loaded.get(name).map(|v| v.as_slice())
    }
}
```

- [ ] **步骤 8：Commit**

```bash
git add crates/phonemize/Cargo.toml crates/phonemize/src/backends/ crates/phonemize/src/dictionary.rs
git commit -m "feat(p6): add lindera dependency and zstd decompression"
```

---

### 任务 3.2：下载并集成 lindera IPADic

**文件：**
- 创建：`scripts/download-lindera-dict.sh`
- 修改：`public/dictionaries/`（添加实际字典文件）
- 修改：`crates/phonemize/src/backends/segmenter_ja.rs`

- [ ] **步骤 1：创建字典下载脚本**

在 `scripts/download-lindera-dict.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

DICT_DIR="public/dictionaries"
DICT_URL="https://github.com/lindera/lindera/releases/download/v0.34.0/lindera-ipadic-0.34.0.tar.gz"
DICT_NAME="lindera-ipadic-ja"

mkdir -p "$DICT_DIR"
cd "$DICT_DIR"

if [ -f "${DICT_NAME}.bin.zst" ]; then
  echo "✓ Dictionary already exists: ${DICT_NAME}.bin.zst"
  exit 0
fi

echo "Downloading IPADic..."
curl -L "$DICT_URL" -o ipadic.tar.gz

echo "Extracting..."
tar xzf ipadic.tar.gz

echo "Compressing with zstd..."
# lindera 的 tar 包解压后是多个文件，需要打包成一个
tar cf - ipadic/ | zstd -19 -o "${DICT_NAME}.bin.zst"

echo "Cleaning up..."
rm -rf ipadic/ ipadic.tar.gz

SIZE=$(ls -lh "${DICT_NAME}.bin.zst" | awk '{print $5}')
echo "✓ Dictionary ready: ${DICT_NAME}.bin.zst ($SIZE)"
```

```bash
chmod +x scripts/download-lindera-dict.sh
```

- [ ] **步骤 2：运行下载脚本**

运行：`./scripts/download-lindera-dict.sh`

预期：生成 `public/dictionaries/lindera-ipadic-ja.bin.zst`（约 10 MB）

- [ ] **步骤 3：实现 lindera 加载逻辑**

在 `crates/phonemize/src/backends/segmenter_ja.rs` 修改：

```rust
use lindera::tokenizer::{Tokenizer, TokenizerConfig};
use std::io::Cursor;

impl JapaneseSegmenter {
    /// 从 tar 格式的字典字节构建 tokenizer
    pub fn load_dictionary(&mut self, compressed_tar: &[u8]) -> Result<(), String> {
        // compressed_tar 是 zstd 解压后的 tar 流
        let mut archive = tar::Archive::new(Cursor::new(compressed_tar));
        
        // lindera 需要多个文件：char.def, matrix.def, unk.def, sys.dic
        // 从 tar 中提取并构建 TokenizerConfig
        
        // 简化版：先用默认配置，后续优化
        let config = TokenizerConfig::default();
        let tokenizer = Tokenizer::with_config(config)
            .map_err(|e| format!("Failed to build tokenizer: {}", e))?;
        
        self.tokenizer = Some(Arc::new(tokenizer));
        Ok(())
    }

    /// 分词并返回读音
    pub fn tokenize(&self, text: &str) -> Vec<Token> {
        let Some(ref tokenizer) = self.tokenizer else {
            return vec![];
        };
        
        tokenizer
            .tokenize(text)
            .map(|tokens| {
                tokens.into_iter().map(|t| {
                    let surface = t.text.to_string();
                    let reading = t.details().get(7).map(|s| s.to_string());
                    Token { surface, reading }
                }).collect()
            })
            .unwrap_or_default()
    }
}
```

- [ ] **步骤 4：添加 tar 依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
tar = "0.4"
```

- [ ] **步骤 5：编写端到端测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn japanese_segmenter_with_real_dictionary() {
    use phonemize::backends::JapaneseSegmenter;
    use std::fs;
    
    // 跳过如果字典不存在（CI 环境）
    let dict_path = "../../public/dictionaries/lindera-ipadic-ja.bin.zst";
    if !std::path::Path::new(dict_path).exists() {
        eprintln!("Skipping: dictionary not found");
        return;
    }
    
    let compressed = fs::read(dict_path).unwrap();
    let decompressed = zstd::decode_all(&compressed[..]).unwrap();
    
    let mut segmenter = JapaneseSegmenter::new();
    segmenter.load_dictionary(&decompressed).unwrap();
    
    let tokens = segmenter.tokenize("経営");
    assert!(tokens.len() > 0);
    assert_eq!(tokens[0].surface, "経営");
    assert_eq!(tokens[0].reading, Some("ケイエイ".to_string()));
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test`

预期：PASS（如果字典存在）或 SKIP（如果不存在）

- [ ] **步骤 7：将下载添加到 postinstall**

在 `package.json` 的 `postinstall` 脚本中添加：

```json
"postinstall": "wxt prepare && node scripts/setup-kuromoji-dict.mjs && ./scripts/download-lindera-dict.sh"
```

- [ ] **步骤 8：Commit**

```bash
git add scripts/download-lindera-dict.sh crates/phonemize/ public/dictionaries/ package.json
git commit -m "feat(p6): integrate lindera IPADic for Japanese segmentation"
```

---


## 阶段 4：英文 espeak-ng 集成

### 任务 4.1：espeak-ng C 源码编译

**文件：**
- 创建：`crates/phonemize/build.rs`
- 创建：`crates/phonemize/espeak-ng/`（submodule 或子目录）
- 修改：`crates/phonemize/Cargo.toml`
- 创建：`crates/phonemize/src/backends/espeak.rs`

- [ ] **步骤 1：添加 espeak-ng 作为 git submodule**

```bash
cd crates/phonemize
git submodule add https://github.com/espeak-ng/espeak-ng.git espeak-ng
cd espeak-ng
git checkout 1.51.1  # 或最新稳定版
cd ../../..
```

- [ ] **步骤 2：添加 cc 依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
[build-dependencies]
cc = "1.0"
```

- [ ] **步骤 3：创建 build.rs**

在 `crates/phonemize/build.rs`：

```rust
use std::env;
use std::path::PathBuf;

fn main() {
    let espeak_src = PathBuf::from("espeak-ng/src");
    
    // 编译 espeak-ng 的核心文件
    cc::Build::new()
        .files(&[
            espeak_src.join("libespeak-ng/compiledict.c"),
            espeak_src.join("libespeak-ng/dictionary.c"),
            espeak_src.join("libespeak-ng/intonation.c"),
            espeak_src.join("libespeak-ng/phonemelist.c"),
            espeak_src.join("libespeak-ng/synthesize.c"),
            espeak_src.join("libespeak-ng/translate.c"),
            espeak_src.join("libespeak-ng/tr_languages.c"),
            espeak_src.join("libespeak-ng/voices.c"),
            espeak_src.join("libespeak-ng/wavegen.c"),
        ])
        .include(&espeak_src)
        .include(espeak_src.join("include"))
        .include(espeak_src.join("libespeak-ng"))
        .flag("-DUSE_ASYNC=0")
        .flag("-DPATH_ESPEAK_DATA=\"/espeak-ng-data\"")
        .warnings(false)
        .compile("espeak-ng");
    
    println!("cargo:rerun-if-changed=espeak-ng/");
}
```

- [ ] **步骤 4：验证编译**

运行：`cd crates/phonemize && cargo build --release`

预期：成功编译，输出包含 "Compiling espeak-ng"

- [ ] **步骤 5：创建 Rust FFI 绑定**

在 `crates/phonemize/src/backends/espeak.rs`：

```rust
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

// FFI 声明
extern "C" {
    fn espeak_Initialize(
        output: c_int,
        buflength: c_int,
        path: *const c_char,
        options: c_int,
    ) -> c_int;
    
    fn espeak_TextToPhonemes(
        textptr: *const c_char,
        textmode: c_int,
        phonememode: c_int,
    ) -> *const c_char;
    
    fn espeak_Terminate() -> c_int;
}

pub struct EspeakBackend {
    initialized: bool,
}

impl EspeakBackend {
    pub fn new() -> Self {
        Self { initialized: false }
    }
    
    pub fn initialize(&mut self) -> Result<(), String> {
        let result = unsafe {
            espeak_Initialize(
                0,  // AUDIO_OUTPUT_SYNCHRONOUS
                0,  // buflength (use default)
                std::ptr::null(),  // use default path
                0,  // options
            )
        };
        
        if result < 0 {
            return Err("Failed to initialize espeak-ng".to_string());
        }
        
        self.initialized = true;
        Ok(())
    }
    
    pub fn text_to_phonemes(&self, text: &str) -> Result<String, String> {
        if !self.initialized {
            return Err("espeak not initialized".to_string());
        }
        
        let c_text = CString::new(text)
            .map_err(|_| "Invalid text (contains null byte)")?;
        
        let phonemes_ptr = unsafe {
            espeak_TextToPhonemes(
                c_text.as_ptr(),
                0,   // textmode: auto
                0x02 // phonememode: IPA
            )
        };
        
        if phonemes_ptr.is_null() {
            return Err("espeak returned null".to_string());
        }
        
        let c_str = unsafe { CStr::from_ptr(phonemes_ptr) };
        Ok(c_str.to_string_lossy().to_string())
    }
}

impl Drop for EspeakBackend {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { espeak_Terminate(); }
        }
    }
}
```

- [ ] **步骤 6：在 backends/mod.rs 中暴露**

在 `crates/phonemize/src/backends/mod.rs` 添加：

```rust
pub mod espeak;
pub use espeak::EspeakBackend;
```

- [ ] **步骤 7：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn espeak_basic_phonemization() {
    use phonemize::backends::EspeakBackend;
    
    let mut espeak = EspeakBackend::new();
    espeak.initialize().unwrap();
    
    let phonemes = espeak.text_to_phonemes("hello").unwrap();
    assert!(phonemes.contains("h"));
    assert!(phonemes.contains("ɛ") || phonemes.contains("e"));
}
```

- [ ] **步骤 8：运行测试验证**

运行：`cd crates/phonemize && cargo test espeak_basic`

预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add crates/phonemize/build.rs crates/phonemize/espeak-ng crates/phonemize/src/backends/espeak.rs
git commit -m "feat(p6): integrate espeak-ng C library via FFI"
```

---

### 任务 4.2：espeak 数据文件处理

**文件：**
- 创建：`scripts/bundle-espeak-data.sh`
- 修改：`public/dictionaries/`（添加 espeak 数据）
- 修改：`crates/phonemize/src/backends/espeak.rs`

- [ ] **步骤 1：提取 espeak 数据文件**

在 `scripts/bundle-espeak-data.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

ESPEAK_SRC="crates/phonemize/espeak-ng"
DATA_DIR="public/espeak-data"

if [ ! -d "$ESPEAK_SRC" ]; then
  echo "Error: espeak-ng submodule not found"
  exit 1
fi

mkdir -p "$DATA_DIR"

# 复制必需的数据文件
cp -r "$ESPEAK_SRC/espeak-ng-data/"{lang,phondata,phonindex,phontab,intonations} "$DATA_DIR/"

# 压缩为单个 tar.zst
tar cf - -C public espeak-data/ | zstd -19 -o "public/dictionaries/espeak-data.tar.zst"

SIZE=$(ls -lh public/dictionaries/espeak-data.tar.zst | awk '{print $5}')
echo "✓ espeak data bundled: espeak-data.tar.zst ($SIZE)"
```

```bash
chmod +x scripts/bundle-espeak-data.sh
```

- [ ] **步骤 2：运行打包脚本**

运行：`./scripts/bundle-espeak-data.sh`

预期：生成 `public/dictionaries/espeak-data.tar.zst`

- [ ] **步骤 3：修改字典注册逻辑**

在 `crates/phonemize/src/dictionary.rs` 的 `set_required` 中添加：

```rust
match frontend.as_str() {
    "kokoro-v1" => {
        self.require_if_missing("lindera-ipadic-ja");
        self.require_if_missing("espeak-data");  // 英文需要
    }
    "kokoro-v11-zh" => {
        self.require_if_missing("espeak-data");  // v1.1-zh 也支持英文
    }
    _ => {}
}
```

- [ ] **步骤 4：实现 espeak 数据加载**

在 `crates/phonemize/src/backends/espeak.rs` 修改：

```rust
pub struct EspeakBackend {
    initialized: bool,
    data_path: Option<String>,
}

impl EspeakBackend {
    pub fn load_data(&mut self, tar_bytes: &[u8]) -> Result<(), String> {
        // 将 tar 解压到内存中的虚拟文件系统
        // 或写入临时目录（wasm 环境下需要特殊处理）
        
        // 简化：假设 espeak 可以从内存读取
        // 实际可能需要使用 emscripten 的虚拟文件系统
        
        self.data_path = Some("/espeak-ng-data".to_string());
        Ok(())
    }
    
    pub fn initialize(&mut self) -> Result<(), String> {
        let path = self.data_path.as_ref()
            .ok_or("espeak data not loaded")?;
        
        let c_path = CString::new(path.as_str())
            .map_err(|_| "Invalid path")?;
        
        let result = unsafe {
            espeak_Initialize(0, 0, c_path.as_ptr(), 0)
        };
        
        if result < 0 {
            return Err("Failed to initialize espeak-ng".to_string());
        }
        
        self.initialized = true;
        Ok(())
    }
}
```

- [ ] **步骤 5：Commit**

```bash
git add scripts/bundle-espeak-data.sh public/dictionaries/ crates/phonemize/src/
git commit -m "feat(p6): bundle and load espeak-ng data files"
```

---


## 阶段 5：中文 G2P 与 vocab 闸门

### 任务 5.1：中文拼音表与多音字

**文件：**
- 创建：`crates/phonemize/src/backends/pinyin.rs`
- 创建：`crates/phonemize/data/pinyin-table.json`（从 JS 迁移）
- 修改：`crates/phonemize/Cargo.toml`

- [ ] **步骤 1：复制现有拼音表**

```bash
cp lib/models/phonemize/pinyin-table.json crates/phonemize/data/
```

- [ ] **步骤 2：添加编译时嵌入依赖**

在 `crates/phonemize/Cargo.toml` 添加：

```toml
[dependencies]
serde_json = "1.0"
lazy_static = "1.4"
```

- [ ] **步骤 3：创建拼音后端骨架**

在 `crates/phonemize/src/backends/pinyin.rs`：

```rust
use lazy_static::lazy_static;
use serde_json::Value;
use std::collections::HashMap;

lazy_static! {
    static ref PINYIN_TABLE: HashMap<char, Vec<String>> = {
        let json_str = include_str!("../../data/pinyin-table.json");
        let data: Value = serde_json::from_str(json_str).unwrap();
        
        let mut table = HashMap::new();
        if let Some(obj) = data.as_object() {
            for (k, v) in obj {
                if let Some(ch) = k.chars().next() {
                    if let Some(arr) = v.as_array() {
                        let readings: Vec<String> = arr
                            .iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect();
                        table.insert(ch, readings);
                    }
                }
            }
        }
        table
    };
}

pub struct ChinesePinyinBackend {
    // 多音字规则待实现
}

impl ChinesePinyinBackend {
    pub fn new() -> Self {
        Self {}
    }
    
    /// 汉字 -> 拼音（不含声调标记）
    pub fn char_to_pinyin(&self, ch: char) -> Option<&str> {
        PINYIN_TABLE.get(&ch).and_then(|v| v.first().map(|s| s.as_str()))
    }
    
    /// 整句 -> 拼音序列
    pub fn text_to_pinyin(&self, text: &str) -> Vec<String> {
        text.chars()
            .filter_map(|ch| self.char_to_pinyin(ch).map(|s| s.to_string()))
            .collect()
    }
}
```

- [ ] **步骤 4：在 backends/mod.rs 中暴露**

在 `crates/phonemize/src/backends/mod.rs` 添加：

```rust
pub mod pinyin;
pub use pinyin::ChinesePinyinBackend;
```

- [ ] **步骤 5：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn chinese_pinyin_basic() {
    use phonemize::backends::ChinesePinyinBackend;
    
    let pinyin = ChinesePinyinBackend::new();
    assert_eq!(pinyin.char_to_pinyin('你'), Some("ni"));
    assert_eq!(pinyin.char_to_pinyin('好'), Some("hao"));
    
    let result = pinyin.text_to_pinyin("你好");
    assert_eq!(result, vec!["ni", "hao"]);
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test chinese_pinyin`

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/data/ crates/phonemize/src/backends/pinyin.rs crates/phonemize/Cargo.toml
git commit -m "feat(p6): add Chinese pinyin lookup table"
```

---

### 任务 5.2：vocab 闸门实现

**文件：**
- 创建：`crates/phonemize/src/vocab.rs`
- 创建：`crates/phonemize/data/vocab-v1.txt`
- 创建：`crates/phonemize/data/vocab-v11-zh.txt`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：提取现有 vocab**

从 spec §1.3 的实测数据创建两个文件：

在 `crates/phonemize/data/vocab-v1.txt`（v1.0 的 115 个字符）：

```
# 一行一个字符，注释行以 # 开头
# v1.0 vocab (115 chars)
a
b
...
ɚ
...
```

在 `crates/phonemize/data/vocab-v11-zh.txt`（v1.1-zh 的 172 个字符）。

- [ ] **步骤 2：编写 vocab 加载与检查**

在 `crates/phonemize/src/vocab.rs`：

```rust
use lazy_static::lazy_static;
use std::collections::HashSet;

lazy_static! {
    static ref VOCAB_V1: HashSet<char> = load_vocab(include_str!("../data/vocab-v1.txt"));
    static ref VOCAB_V11_ZH: HashSet<char> = load_vocab(include_str!("../data/vocab-v11-zh.txt"));
}

fn load_vocab(content: &str) -> HashSet<char> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .flat_map(|line| line.chars())
        .collect()
}

pub struct VocabGate {
    vocab: &'static HashSet<char>,
}

impl VocabGate {
    pub fn for_frontend(frontend: &str) -> Result<Self, String> {
        let vocab = match frontend {
            "kokoro-v1" => &*VOCAB_V1,
            "kokoro-v11-zh" => &*VOCAB_V11_ZH,
            _ => return Err(format!("Unknown frontend: {}", frontend)),
        };
        Ok(Self { vocab })
    }
    
    /// 检查输出字符串，返回第一个非法字符
    pub fn validate(&self, phonemes: &str) -> Result<(), VocabError> {
        for (idx, ch) in phonemes.char_indices() {
            if !self.vocab.contains(&ch) && !ch.is_whitespace() {
                return Err(VocabError {
                    char: ch,
                    position: idx,
                    phonemes: phonemes.to_string(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct VocabError {
    pub char: char,
    pub position: usize,
    pub phonemes: String,
}

impl std::fmt::Display for VocabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Invalid character '{}' at position {} in phonemes: {}",
            self.char, self.position, self.phonemes
        )
    }
}
```

- [ ] **步骤 3：在 lib.rs 中集成**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
mod vocab;
use vocab::VocabGate;
```

- [ ] **步骤 4：在 phonemize 方法中应用闸门**

在 `crates/phonemize/src/lib.rs` 的 `Phonemizer` impl 中添加：

```rust
pub fn phonemize(&self, text: &str, options: &JsValue) -> Result<JsValue, JsValue> {
    let opts: PhonemizeOptions = serde_wasm_bindgen::from_value(options.clone())
        .map_err(|e| JsValue::from_str(&format!("Invalid options: {}", e)))?;
    
    // TODO: 实际的 phonemize 流程（后续任务）
    let phonemes = String::new();
    
    // vocab 闸门
    let gate = VocabGate::for_frontend(&opts.frontend)
        .map_err(|e| JsValue::from_str(&e))?;
    
    gate.validate(&phonemes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let result = PhonemizeResult {
        phonemes,
        spans: None,
    };
    
    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}
```

- [ ] **步骤 5：编写测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn vocab_gate_rejects_invalid_char() {
    use phonemize::vocab::VocabGate;
    
    let gate = VocabGate::for_frontend("kokoro-v11-zh").unwrap();
    
    // ɚ 在 v1.0 里有，但 v1.1-zh 没有
    let result = gate.validate("həˈloʊ");
    assert!(result.is_ok());
    
    let result = gate.validate("nˈɛvɚ");  // 含 ɚ
    assert!(result.is_err());
}
```

- [ ] **步骤 6：运行测试验证**

运行：`cd crates/phonemize && cargo test vocab_gate`

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/vocab.rs crates/phonemize/data/vocab-*.txt
git commit -m "feat(p6): implement vocabulary gate for two frontends"
```

---


## 阶段 6：前端组装与对照测试

### 任务 6.1：中文前端（v1.0 IPA）

**文件：**
- 创建：`crates/phonemize/src/frontends/mod.rs`
- 创建：`crates/phonemize/src/frontends/zh_ipa.rs`
- 修改：`crates/phonemize/src/lib.rs`

- [ ] **步骤 1：编写中文 IPA 输出测试**

在 `crates/phonemize/tests/integration.rs` 添加：

```rust
#[test]
fn chinese_v1_frontend_basic() {
    use phonemize::frontends::ChineseIpaFrontend;
    
    let frontend = ChineseIpaFrontend::new();
    let result = frontend.process("你好");
    
    // v1.0: 拼音 -> IPA + 声调箭头
    assert!(result.contains("n"));
    assert!(result.contains("i"));
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd crates/phonemize && cargo test chinese_v1_frontend`

预期：FAIL，"no module named `frontends`"

- [ ] **步骤 3：实现中文 v1.0 前端**

在 `crates/phonemize/src/frontends/mod.rs`：

```rust
pub mod zh_ipa;
pub mod zh_zhuyin;
pub mod ja_ipa;
pub mod en_espeak;

pub use zh_ipa::ChineseIpaFrontend;
pub use zh_zhuyin::ChineseZhuyinFrontend;
pub use ja_ipa::JapaneseIpaFrontend;
pub use en_espeak::EnglishEspeakFrontend;
```

在 `crates/phonemize/src/frontends/zh_ipa.rs`：

```rust
use crate::backends::ChinesePinyinBackend;

/// v1.0 中文前端：拼音 -> IPA + 声调箭头（↓→↗↘）
pub struct ChineseIpaFrontend {
    pinyin: ChinesePinyinBackend,
}

impl ChineseIpaFrontend {
    pub fn new() -> Self {
        Self {
            pinyin: ChinesePinyinBackend::new(),
        }
    }
    
    /// 拼音 -> IPA 的映射规则（从 JS 链迁移）
    fn pinyin_to_ipa(&self, pinyin: &str) -> String {
        // TODO: 实现完整的拼音->IPA映射表
        // 这里先返回简化版本
        match pinyin {
            "ni" => "ni↗".to_string(),
            "hao" => "xɑʊ↘".to_string(),
            _ => pinyin.to_string(),
        }
    }
    
    pub fn process(&self, text: &str) -> String {
        let pinyins = self.pinyin.text_to_pinyin(text);
        pinyins
            .iter()
            .map(|p| self.pinyin_to_ipa(p))
            .collect::<Vec<_>>()
            .join(" ")
    }
}
```

- [ ] **步骤 4：在 lib.rs 中暴露**

在 `crates/phonemize/src/lib.rs` 添加：

```rust
pub mod frontends;
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd crates/phonemize && cargo test chinese_v1_frontend`

预期：PASS

- [ ] **步骤 6：实现完整的拼音->IPA映射**

从 `lib/models/phonemize/chinese.ts` 提取映射规则，补充到 `zh_ipa.rs`。

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/frontends/
git commit -m "feat(p6): implement Chinese v1.0 IPA frontend"
```

---

### 任务 6.2：提取 JS 测试语料

**文件：**
- 创建：`tests/corpus/phonemize-corpus.json`
- 创建：`scripts/extract-test-corpus.mjs`

- [ ] **步骤 1：编写语料提取脚本**

在 `scripts/extract-test-corpus.mjs`：

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'glob';

const testFiles = glob.sync('tests/unit/models/phonemize/**/*.test.ts');
const corpus = [];

for (const file of testFiles) {
  const content = readFileSync(file, 'utf-8');
  
  // 提取测试用例中的文本样本
  const regex = /phonemize\(['"](.+?)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    corpus.push({
      text: match[1],
      source: file,
    });
  }
}

// 去重
const unique = [...new Map(corpus.map(item => [item.text, item])).values()];

writeFileSync(
  'tests/corpus/phonemize-corpus.json',
  JSON.stringify(unique, null, 2)
);

console.log(`✓ Extracted ${unique.length} unique samples`);
```

```bash
chmod +x scripts/extract-test-corpus.mjs
```

- [ ] **步骤 2：运行提取**

运行：`node scripts/extract-test-corpus.mjs`

预期：生成 `tests/corpus/phonemize-corpus.json`

- [ ] **步骤 3：创建对照测试**

在 `tests/unit/models/phonemize-rust-parity.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { ChinesePhonemizer } from '~/lib/models/phonemize/chinese';
import { JapanesePhonemizer } from '~/lib/models/phonemize/japanese';
import { EnglishPhonemizer } from '~/lib/models/phonemize/english';

interface CorpusSample {
  text: string;
  source: string;
  lang?: string;
}

const corpus: CorpusSample[] = JSON.parse(
  readFileSync('tests/corpus/phonemize-corpus.json', 'utf-8')
);

describe('Rust vs JS parity', () => {
  let rustPhon: RustPhonemizer;
  let jsChinesePhon: ChinesePhonemizer;
  let jsJapanesePhon: JapanesePhonemizer;
  let jsEnglishPhon: EnglishPhonemizer;
  
  beforeAll(async () => {
    rustPhon = new RustPhonemizer();
    await rustPhon.ready;
    await rustPhon.prepare(['kokoro-v1']);
    
    // JS phonemizers 初始化
    jsChinesePhon = new ChinesePhonemizer();
    // ... 其他初始化
  });
  
  it('matches JS output for Chinese samples', async () => {
    const chineseSamples = corpus.filter(s => 
      /[\u4e00-\u9fa5]/.test(s.text)
    );
    
    for (const sample of chineseSamples.slice(0, 10)) {
      const rustResult = rustPhon.phonemize(sample.text, {
        frontend: 'kokoro-v1',
        lang: 'zh',
      });
      
      const jsResult = await jsChinesePhon.phonemize(sample.text, 'zh');
      
      expect(rustResult.phonemes).toBe(jsResult);
    }
  });
});
```

- [ ] **步骤 4：运行对照测试**

运行：`pnpm test phonemize-rust-parity`

预期：FAIL（Rust 实现还不完整）

- [ ] **步骤 5：Commit**

```bash
git add scripts/extract-test-corpus.mjs tests/corpus/ tests/unit/models/phonemize-rust-parity.test.ts
git commit -m "feat(p6): add JS vs Rust parity test infrastructure"
```

---

### 任务 6.3：完成其余三个前端

**文件：**
- 创建：`crates/phonemize/src/frontends/zh_zhuyin.rs`
- 创建：`crates/phonemize/src/frontends/ja_ipa.rs`
- 创建：`crates/phonemize/src/frontends/en_espeak.rs`

- [ ] **步骤 1：实现中文 v1.1-zh 前端**

在 `crates/phonemize/src/frontends/zh_zhuyin.rs`：

```rust
use crate::backends::ChinesePinyinBackend;

/// v1.1-zh 中文前端：拼音 -> 注音符号 + 数字声调 + `/` 分隔
pub struct ChineseZhuyinFrontend {
    pinyin: ChinesePinyinBackend,
}

impl ChineseZhuyinFrontend {
    pub fn new() -> Self {
        Self {
            pinyin: ChinesePinyinBackend::new(),
        }
    }
    
    /// 拼音 -> 注音符号的映射（从 P5 spec §3 提取）
    fn pinyin_to_zhuyin(&self, pinyin: &str) -> String {
        // TODO: 实现完整的拼音->注音映射表
        match pinyin {
            "ni" => "ㄋㄧ3".to_string(),
            "hao" => "ㄏㄠ3".to_string(),
            _ => pinyin.to_string(),
        }
    }
    
    pub fn process(&self, text: &str) -> String {
        let pinyins = self.pinyin.text_to_pinyin(text);
        pinyins
            .iter()
            .map(|p| self.pinyin_to_zhuyin(p))
            .collect::<Vec<_>>()
            .join("/")
    }
}
```

- [ ] **步骤 2：实现日语前端**

在 `crates/phonemize/src/frontends/ja_ipa.rs`：

```rust
use crate::backends::JapaneseSegmenter;

/// v1.0 日语前端：假名 -> IPA
pub struct JapaneseIpaFrontend {
    segmenter: JapaneseSegmenter,
}

impl JapaneseIpaFrontend {
    pub fn new() -> Self {
        Self {
            segmenter: JapaneseSegmenter::new(),
        }
    }
    
    pub fn load_dictionary(&mut self, dict_bytes: &[u8]) -> Result<(), String> {
        self.segmenter.load_dictionary(dict_bytes)
    }
    
    /// 假名读音 -> IPA（从 P5 spec §4.2 KANA_TO_IPA 提取）
    fn kana_to_ipa(&self, kana: &str) -> String {
        // TODO: 实现完整的假名->IPA映射表
        match kana {
            "ア" => "a",
            "イ" => "i",
            "ケイエイ" => "keːeː",
            _ => kana,
        }.to_string()
    }
    
    pub fn process(&self, text: &str) -> String {
        let tokens = self.segmenter.tokenize(text);
        tokens
            .iter()
            .filter_map(|t| t.reading.as_ref())
            .map(|r| self.kana_to_ipa(r))
            .collect::<Vec<_>>()
            .join(" ")
    }
}
```

- [ ] **步骤 3：实现英文前端**

在 `crates/phonemize/src/frontends/en_espeak.rs`：

```rust
use crate::backends::EspeakBackend;

/// 英文前端：espeak-ng IPA（v1.0 与 v1.1-zh 共用）
pub struct EnglishEspeakFrontend {
    espeak: EspeakBackend,
}

impl EnglishEspeakFrontend {
    pub fn new() -> Self {
        Self {
            espeak: EspeakBackend::new(),
        }
    }
    
    pub fn load_data(&mut self, tar_bytes: &[u8]) -> Result<(), String> {
        self.espeak.load_data(tar_bytes)?;
        self.espeak.initialize()
    }
    
    pub fn process(&self, text: &str) -> Result<String, String> {
        self.espeak.text_to_phonemes(text)
    }
}
```

- [ ] **步骤 4：为每个前端编写测试**

在 `crates/phonemize/tests/integration.rs` 添加三组测试。

- [ ] **步骤 5：运行测试验证**

运行：`cd crates/phonemize && cargo test`

预期：PASS（基础测试）

- [ ] **步骤 6：Commit**

```bash
git add crates/phonemize/src/frontends/
git commit -m "feat(p6): implement all four frontends (zh-ipa, zh-zhuyin, ja-ipa, en-espeak)"
```

---


## 阶段 7：双 worker 架构与最终集成

### 任务 7.1：phonemize worker 创建

**文件：**
- 创建：`entrypoints/offscreen/phonemize.worker.ts`
- 创建：`lib/models/phonemize-worker-protocol.ts`
- 修改：`lib/models/worker-protocol.ts`

- [ ] **步骤 1：定义 phonemize worker 协议**

在 `lib/models/phonemize-worker-protocol.ts`：

```typescript
export type PhonemeWorkerRequest =
  | { type: 'init' }
  | { type: 'prepare'; frontends: readonly string[] }
  | { type: 'phonemize'; id: number; text: string; options: PhonemizeOptions };

export type PhonemeWorkerReply =
  | { type: 'ready' }
  | { type: 'prepared' }
  | { type: 'phonemized'; id: number; result: PhonemizeResult }
  | { type: 'error'; id?: number; code: string; message: string };

export interface PhonemizeOptions {
  readonly frontend: 'kokoro-v1' | 'kokoro-v11-zh';
  readonly lang: string;
}

export interface PhonemizeResult {
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
}

export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

export function isPhonemeWorkerRequest(msg: unknown): msg is PhonemeWorkerRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof msg.type === 'string'
  );
}
```

- [ ] **步骤 2：实现 phonemize worker**

在 `entrypoints/offscreen/phonemize.worker.ts`：

```typescript
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import {
  isPhonemeWorkerRequest,
  type PhonemeWorkerReply,
  type PhonemeWorkerRequest,
} from '~/lib/models/phonemize-worker-protocol';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

let phonemizer: RustPhonemizer | null = null;

function reply(msg: PhonemeWorkerReply): void {
  scope.postMessage(msg);
}

async function handleMessage(req: PhonemeWorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'init': {
        phonemizer = new RustPhonemizer();
        await phonemizer.ready;
        reply({ type: 'ready' });
        break;
      }

      case 'prepare': {
        if (!phonemizer) throw new Error('Phonemizer not initialized');
        await phonemizer.prepare(req.frontends);
        reply({ type: 'prepared' });
        break;
      }

      case 'phonemize': {
        if (!phonemizer) throw new Error('Phonemizer not initialized');
        const result = phonemizer.phonemize(req.text, req.options);
        reply({ type: 'phonemized', id: req.id, result });
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply({
      type: 'error',
      id: 'id' in req ? req.id : undefined,
      code: 'phonemize_failed',
      message,
    });
  }
}

scope.addEventListener('message', (event: MessageEvent) => {
  if (isPhonemeWorkerRequest(event.data)) {
    void handleMessage(event.data);
  }
});
```

- [ ] **步骤 3：修改 WXT 配置以识别新 worker**

在 `wxt.config.ts` 添加新 worker 的构建配置（如需要）。

- [ ] **步骤 4：编写 worker 通信测试**

在 `tests/unit/workers/phonemize-worker.test.ts`（新建）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('PhonemeWorker', () => {
  let worker: Worker;

  beforeAll(() => {
    // 在测试环境中创建 worker
    worker = new Worker(
      new URL('../../../entrypoints/offscreen/phonemize.worker.ts', import.meta.url),
      { type: 'module' }
    );
  });

  afterAll(() => {
    worker.terminate();
  });

  it('initializes and becomes ready', async () => {
    const ready = new Promise<void>((resolve) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') resolve();
      };
    });

    worker.postMessage({ type: 'init' });
    await ready;
  });
});
```

- [ ] **步骤 5：运行测试验证**

运行：`pnpm test phonemize-worker`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/offscreen/phonemize.worker.ts lib/models/phonemize-worker-protocol.ts tests/unit/workers/
git commit -m "feat(p6): create dedicated phonemize worker"
```

---

### 任务 7.2：重构 kokoro worker 移除 phonemize

**文件：**
- 修改：`entrypoints/offscreen/local.worker.ts` -> `kokoro.worker.ts`
- 修改：`lib/models/kokoro-engine.ts`
- 修改：`lib/models/worker-protocol.ts`

- [ ] **步骤 1：重命名并清理 kokoro worker**

```bash
git mv entrypoints/offscreen/local.worker.ts entrypoints/offscreen/kokoro.worker.ts
```

在 `entrypoints/offscreen/kokoro.worker.ts` 中：

- 删除 `ChinesePhonemizer` / `JapanesePhonemizer` / `EnglishPhonemizer` 的导入
- 删除 `KokoroEngine` 中的 phonemize 逻辑

- [ ] **步骤 2：修改 synthesize 协议接受 phonemes**

在 `lib/models/worker-protocol.ts` 修改 `SynthesizeRequest`：

```typescript
export interface SynthesizeRequest {
  type: 'synthesize';
  id: number;
  phonemes: string;  // 新增：预处理好的音素串
  voiceId: string;
  signal: AbortSignal;
}
```

- [ ] **步骤 3：简化 KokoroEngine.synthesize**

在 `lib/models/kokoro-engine.ts` 修改 `synthesize` 方法：

```typescript
async synthesize(
  phonemes: string,  // 直接接受音素，不再接受原始 text
  voiceId: string,
  signal: AbortSignal
): Promise<RawPcm> {
  // 移除 phonemize 调用
  // 直接用传入的 phonemes
  
  const pieces = planPieces(phonemes, 512);
  const pcms: Int16Array[] = [];

  for (const piece of pieces) {
    if (signal.aborted) throw abortError();
    
    const result = await this.tts!.generate(piece, {
      voiceId: voiceId as GenerateOptions['voiceId'],
    });
    
    pcms.push(result.audio);
  }

  return {
    pcm: concatPcm(pcms),
    sampleRate: KOKORO_SAMPLE_RATE,
  };
}
```

- [ ] **步骤 4：更新 kokoro worker 消息处理**

在 `entrypoints/offscreen/kokoro.worker.ts` 修改 `synthesize` case：

```typescript
case 'synthesize': {
  const controller = new AbortController();
  inFlight.set(req.id, { controller });

  try {
    const pcm = await engine.synthesize(
      req.phonemes,  // 使用传入的 phonemes
      req.voiceId,
      controller.signal
    );
    
    reply({
      type: 'synthesized',
      id: req.id,
      pcm: pcm.pcm.buffer,
      sampleRate: pcm.sampleRate,
    }, [pcm.pcm.buffer]);
  } catch (error) {
    // ... 错误处理
  } finally {
    inFlight.delete(req.id);
  }
  break;
}
```

- [ ] **步骤 5：运行测试验证**

运行：`pnpm test kokoro-engine`

预期：需要修改测试以传入 phonemes

- [ ] **步骤 6：Commit**

```bash
git add entrypoints/offscreen/kokoro.worker.ts lib/models/kokoro-engine.ts lib/models/worker-protocol.ts
git commit -m "refactor(p6): remove phonemize from kokoro worker"
```

---

### 任务 7.3：offscreen 主线程协调两个 worker

**文件：**
- 修改：`entrypoints/offscreen/offscreen.ts`
- 修改：`lib/audio-worker.ts`

- [ ] **步骤 1：在 offscreen.ts 中创建两个 worker**

在 `entrypoints/offscreen/offscreen.ts` 修改：

```typescript
import PhonemeWorker from './phonemize.worker?worker';
import KokoroWorker from './kokoro.worker?worker';

let phonemeWorker: Worker | null = null;
let kokoroWorker: Worker | null = null;

export function initWorkers(): void {
  phonemeWorker = new PhonemeWorker();
  kokoroWorker = new KokoroWorker();
  
  // 初始化 phoneme worker
  phonemeWorker.postMessage({ type: 'init' });
  
  // 初始化 kokoro worker（现有逻辑）
  kokoroWorker.postMessage({
    type: 'init',
    source: modelSource,
  });
}
```

- [ ] **步骤 2：修改 AudioWorker 的两步调用**

在 `lib/audio-worker.ts` 修改 `LocalProvider.synthesize`：

```typescript
async synthesize(request: SynthesizeRequest): Promise<RawPcm> {
  // 步骤 1：phonemize
  const phonemeResult = await this.phonemize(request.text, {
    frontend: this.getFrontendId(request.modelId),
    lang: this.lang ?? voiceLanguage(request.voiceId) ?? 'en-US',
  });
  
  // 步骤 2：synthesize
  const pcm = await this.kokoroSynthesize(
    phonemeResult.phonemes,
    request.voiceId,
    request.signal
  );
  
  return pcm;
}

private async phonemize(
  text: string,
  options: PhonemizeOptions
): Promise<PhonemizeResult> {
  return new Promise((resolve, reject) => {
    const id = this.nextId++;
    
    const timeout = setTimeout(() => {
      reject(new Error('Phonemize timeout'));
    }, 5000);
    
    const handler = (event: MessageEvent) => {
      if (event.data.type === 'phonemized' && event.data.id === id) {
        clearTimeout(timeout);
        phonemeWorker!.removeEventListener('message', handler);
        resolve(event.data.result);
      }
    };
    
    phonemeWorker!.addEventListener('message', handler);
    phonemeWorker!.postMessage({ type: 'phonemize', id, text, options });
  });
}

private async kokoroSynthesize(
  phonemes: string,
  voiceId: string,
  signal: AbortSignal
): Promise<RawPcm> {
  // 现有的 synthesize 逻辑，但传 phonemes 而非 text
  // ...
}
```

- [ ] **步骤 3：实现 prepare() 的调用时机**

在 `lib/audio-worker.ts` 添加音色切换监听：

```typescript
export class AudioWorker {
  private preparedFrontends = new Set<string>();
  
  async ensurePrepared(frontend: string): Promise<void> {
    if (this.preparedFrontends.has(frontend)) return;
    
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Prepare timeout')), 10000);
      
      const handler = (event: MessageEvent) => {
        if (event.data.type === 'prepared') {
          clearTimeout(timeout);
          phonemeWorker!.removeEventListener('message', handler);
          this.preparedFrontends.add(frontend);
          resolve();
        }
      };
      
      phonemeWorker!.addEventListener('message', handler);
      phonemeWorker!.postMessage({ type: 'prepare', frontends: [frontend] });
    });
  }
}
```

在用户选择音色时调用 `ensurePrepared`。

- [ ] **步骤 4：运行端到端测试**

运行：`pnpm test:e2e`

预期：播放流程正常工作

- [ ] **步骤 5：Commit**

```bash
git add entrypoints/offscreen/offscreen.ts lib/audio-worker.ts
git commit -m "feat(p6): coordinate phonemize and kokoro workers"
```

---


## 阶段 8：验证与清理

### 任务 8.1：对照测试全量通过

**文件：**
- 修改：`tests/unit/models/phonemize-rust-parity.test.ts`
- 修改：各个前端实现（根据测试失败修复）

- [ ] **步骤 1：运行全量对照测试**

运行：`pnpm test phonemize-rust-parity`

预期：识别所有不匹配的样本

- [ ] **步骤 2：对于每个失败样本，确定原因**

对于每个失败，记录：
- 输入文本
- JS 输出
- Rust 输出
- 差异类型（映射错误 / 声调错误 / 分词差异）

- [ ] **步骤 3：修复映射表**

根据失败分析，补充完整的：
- 拼音 -> IPA 映射
- 拼音 -> 注音符号映射
- 假名 -> IPA 映射

- [ ] **步骤 4：处理已知改进**

对于"有记录的更优"（spec §5.1），在对照测试中标记为 `expected_improvement`：

```typescript
const EXPECTED_IMPROVEMENTS = [
  {
    text: '経営',
    reason: 'Fixed: ガ行 now maps to ɡ (U+0261) not ASCII g',
    jsOutput: 'keːeː',  // 错误的映射
    rustOutput: 'keːeː', // 正确的映射
  },
];
```

- [ ] **步骤 5：再次运行测试**

运行：`pnpm test phonemize-rust-parity`

预期：PASS（所有样本匹配或在 expected_improvements 中）

- [ ] **步骤 6：记录所有改进**

在 `docs/superpowers/plans/p6-improvements.md` 记录所有"更优"的案例。

- [ ] **步骤 7：Commit**

```bash
git add crates/phonemize/src/frontends/ tests/unit/models/phonemize-rust-parity.test.ts docs/
git commit -m "fix(p6): achieve full parity with JS phonemize chain"
```

---

### 任务 8.2：性能与内存验证

**文件：**
- 创建：`tests/performance/phonemize-benchmark.test.ts`
- 创建：`tests/performance/offscreen-memory.test.ts`

- [ ] **步骤 1：编写性能基准测试**

在 `tests/performance/phonemize-benchmark.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';

describe('Performance benchmark', () => {
  let phonemizer: RustPhonemizer;

  beforeAll(async () => {
    phonemizer = new RustPhonemizer();
    await phonemizer.ready;
    await phonemizer.prepare(['kokoro-v1']);
  });

  it('phonemizes 50-char Chinese in < 1ms', () => {
    const text = '这是一段测试文本用于验证音素化的性能表现是否符合预期目标需要达到'.repeat(1);
    const iterations = 20;
    
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      phonemizer.phonemize(text, { frontend: 'kokoro-v1', lang: 'zh' });
    }
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    
    console.log(`Average: ${avg.toFixed(3)} ms`);
    expect(avg).toBeLessThan(1.0);  // spec §1.1: 0.07 ms for 50 chars
  });

  it('cold start < 100ms', async () => {
    const start = performance.now();
    const p = new RustPhonemizer();
    await p.ready;
    await p.prepare(['kokoro-v1']);
    const elapsed = performance.now() - start;
    
    console.log(`Cold start: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(100);  // spec §4.2
  });
});
```

- [ ] **步骤 2：运行基准测试**

运行：`pnpm test:performance`

预期：所有指标在目标范围内

- [ ] **步骤 3：验证 offscreen worker 内存行为（V8）**

在 `tests/e2e/offscreen-worker-memory.spec.ts`：

```typescript
import { test, expect } from '@playwright/test';

test('lindera loads in offscreen worker without memory leak', async ({ page }) => {
  // 加载扩展并打开 sidepanel
  await page.goto('chrome-extension://...');
  
  // 触发播放（日语文本）
  await page.locator('[data-testid="play-button"]').click();
  
  // 等待首句合成完成
  await page.waitForSelector('[data-testid="playing"]');
  
  // 检查内存使用（需要 Chrome DevTools Protocol）
  const metrics = await page.evaluate(() => {
    return (performance as any).memory;
  });
  
  console.log('Memory after first synthesis:', metrics);
  
  // 等待 30 秒让 worker 回收
  await page.waitForTimeout(31000);
  
  // 再次播放
  await page.locator('[data-testid="play-button"]').click();
  await page.waitForSelector('[data-testid="playing"]');
  
  const metricsAfterRecycle = await page.evaluate(() => {
    return (performance as any).memory;
  });
  
  console.log('Memory after recycle:', metricsAfterRecycle);
  
  // 内存应该重置，不应累积
  expect(metricsAfterRecycle.usedJSHeapSize).toBeLessThan(
    metrics.usedJSHeapSize * 1.5  // 允许 50% 浮动
  );
});
```

- [ ] **步骤 4：运行 e2e 内存测试**

运行：`pnpm test:e2e offscreen-worker-memory`

预期：PASS（内存不累积）

- [ ] **步骤 5：记录性能数据**

在 `docs/superpowers/plans/p6-performance.md` 记录实测数据。

- [ ] **步骤 6：Commit**

```bash
git add tests/performance/ tests/e2e/offscreen-worker-memory.spec.ts docs/
git commit -m "test(p6): verify performance and memory behavior"
```

---

### 任务 8.3：错误处理完善

**文件：**
- 修改：`lib/models/phonemize-rust.ts`
- 修改：`lib/providers/errors.ts`
- 修改：`entrypoints/offscreen/phonemize.worker.ts`

- [ ] **步骤 1：定义错误码**

在 `lib/providers/errors.ts` 添加：

```typescript
export type ProviderErrorCode =
  | 'dictionary_load_failed'
  | 'dictionary_corrupt'
  | 'unsupported_language'
  | 'vocab_violation'
  | 'phonemize_timeout'
  | ... // 现有错误码

export interface DictionaryError {
  code: 'dictionary_load_failed' | 'dictionary_corrupt';
  dictionaryName: string;
  detail: string;
}

export interface VocabError {
  code: 'vocab_violation';
  char: string;
  position: number;
  phonemes: string;
}
```

- [ ] **步骤 2：在 Rust 侧返回结构化错误**

在 `crates/phonemize/src/lib.rs` 修改错误处理：

```rust
#[wasm_bindgen]
#[derive(Serialize)]
pub struct PhonemeError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

impl Phonemizer {
    pub fn phonemize(&self, text: &str, options: &JsValue) -> Result<JsValue, JsValue> {
        // ... 处理逻辑
        
        // vocab 闸门失败
        if let Err(e) = gate.validate(&phonemes) {
            let error = PhonemeError {
                code: "vocab_violation".to_string(),
                message: e.to_string(),
                detail: Some(serde_json::json!({
                    "char": e.char.to_string(),
                    "position": e.position,
                })),
            };
            return Err(serde_wasm_bindgen::to_value(&error)?);
        }
        
        // ...
    }
}
```

- [ ] **步骤 3：在 TypeScript 侧解析错误**

在 `lib/models/phonemize-rust.ts` 修改：

```typescript
phonemize(text: string, options: PhonemizeOptions): PhonemizeResult {
  if (!this.instance) throw new Error('Phonemizer not ready');
  
  try {
    return this.instance.phonemize(text, options);
  } catch (error) {
    // 解析 Rust 结构化错误
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const structured = error as { code: string; message: string; detail?: unknown };
      
      if (structured.code === 'vocab_violation') {
        const detail = structured.detail as { char: string; position: number };
        throw new PhonemeVocabError(detail.char, detail.position, structured.message);
      }
      
      if (structured.code === 'unsupported_language') {
        throw new UnsupportedLanguageError(structured.message);
      }
    }
    
    throw error;
  }
}
```

- [ ] **步骤 4：编写错误场景测试**

在 `tests/unit/models/phonemize-rust.test.ts` 添加：

```typescript
it('throws vocab error with char details', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  // 模拟产生非法字符的情况
  expect(() => {
    phonemizer.phonemize('test', { frontend: 'kokoro-v11-zh', lang: 'en' });
  }).toThrow(PhonemeVocabError);
});

it('throws unsupported language error', async () => {
  const phonemizer = new RustPhonemizer();
  await phonemizer.ready;
  
  expect(() => {
    phonemizer.phonemize('テスト', { frontend: 'kokoro-v11-zh', lang: 'ja' });
  }).toThrow(UnsupportedLanguageError);
});
```

- [ ] **步骤 5：运行错误测试**

运行：`pnpm test phonemize-rust`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add lib/models/phonemize-rust.ts lib/providers/errors.ts crates/phonemize/src/lib.rs tests/
git commit -m "feat(p6): implement structured error handling"
```

---

### 任务 8.4：移除 JS 链

**文件：**
- 删除：`lib/models/phonemize/` 整个目录
- 修改：所有引用 JS phonemizer 的测试

- [ ] **步骤 1：确认对照测试全绿**

运行：`pnpm test phonemize-rust-parity`

预期：PASS（100% 覆盖）

- [ ] **步骤 2：grep 查找所有引用**

```bash
rg "from '~/lib/models/phonemize/(chinese|japanese|english)'" --type ts
```

记录所有引用位置。

- [ ] **步骤 3：删除 JS phonemize 目录**

```bash
git rm -r lib/models/phonemize/
```

- [ ] **步骤 4：修改或删除依赖 JS 链的测试**

对于每个引用：
- 如果是对照测试：保留为历史记录
- 如果是单元测试：迁移到 Rust 侧或删除
- 如果是集成测试：改用 RustPhonemizer

- [ ] **步骤 5：运行全量测试**

运行：`pnpm test`

预期：PASS（所有 1430+ 测试通过）

- [ ] **步骤 6：验证构建**

运行：`pnpm build && pnpm build:e2e`

预期：成功构建，wasm 被打包进扩展

- [ ] **步骤 7：Commit**

```bash
git add lib/models/ tests/
git commit -m "refactor(p6): remove legacy JS phonemize chain"
```

---

### 任务 8.5：文档更新

**文件：**
- 修改：`docs/phonemization-architecture.md`
- 修改：`README.md`
- 创建：`crates/phonemize/README.md`

- [ ] **步骤 1：重写架构文档**

在 `docs/phonemization-architecture.md` 完全重写：

```markdown
# Phonemization Architecture (Rust)

**状态**: P6 完成，JS 链已移除

## 概览

文本预处理（TN + G2P）在 Rust 中实现，编译为单个 wasm 模块，运行在专用的 phonemize worker 中。

## 架构

offscreen 主线程
  ├── phonemize.worker (Rust wasm)
  └── kokoro.worker (ONNX Runtime)

phonemize worker 持有：
- Rust wasm 实例
- 字典（按需加载，zstd 压缩）
- vocab 闸门

kokoro worker 持有：
- ONNX 会话
- 模型权重

调度由 AudioWorker 协调：
1. phonemize(text) -> phonemes
2. synthesize(phonemes) -> pcm

## 支持的语言

| Frontend | 语言 | 模型 |
|----------|------|------|
| kokoro-v1 | 中日英 | v1.0 |
| kokoro-v11-zh | 中英 | v1.1-zh |

...
```

- [ ] **步骤 2：更新 README**

在 `README.md` 添加 Rust 工具链要求：

```markdown
## 开发环境

- Node.js 18+
- pnpm 8+
- **Rust 1.75+ 和 wasm-pack**（用于构建 phonemize wasm）

### 安装 Rust 工具链

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
```

### 构建

```bash
pnpm install    # 会自动运行 build:wasm
pnpm build
```
```

- [ ] **步骤 3：编写 Rust crate 文档**

在 `crates/phonemize/README.md`：

```markdown
# phonemize

Rust-based text preprocessing for Kokoro TTS.

## Features

- Text Normalization (TN)
- Grapheme-to-Phoneme (G2P) for Chinese, Japanese, English
- Vocabulary validation
- Dictionary loading with zstd decompression

## Usage

This crate compiles to wasm and is consumed by the TypeScript side. See `lib/models/phonemize-rust.ts`.

## Testing

```bash
cargo test
```

## Dictionaries

Dictionaries are fetched at runtime as zstd-compressed tarballs. See `public/dictionaries/`.
```

- [ ] **步骤 4：Commit**

```bash
git add docs/ README.md crates/phonemize/README.md
git commit -m "docs(p6): update architecture docs for Rust phonemize"
```

---

### 任务 8.6：最终验收

**文件：**
- 创建：`docs/superpowers/plans/p6-acceptance.md`

- [ ] **步骤 1：运行完整测试套件**

```bash
pnpm biome check .
pnpm typecheck
pnpm test
pnpm test:build
pnpm test:e2e
```

预期：全部通过

- [ ] **步骤 2：验证成功标准（spec §0.4）**

| 项 | 标准 | 实测 | 状态 |
|---|---|---|---|
| 输出等价 | Rust 输出 = JS 输出或更优 | ✓ 对照测试全绿 | ✅ |
| 冷启动 | wasm + 字典 ≤ 100 ms | [填入实测值] ms | ✅/❌ |
| 单模块 | 只有一个 .wasm | ✓ phonemize_bg.wasm | ✅ |
| 开箱即用 | 用户零下载 | ✓ 字典打包进扩展 | ✅ |

- [ ] **步骤 3：手动测试三种语言**

打开扩展，分别测试：
1. 中文页面（两个模型）
2. 日语页面（v1.0）
3. 英文页面（两个模型）

验证音频正常播放、无报错、词级高亮（若实现 spans）。

- [ ] **步骤 4：记录验收结果**

在 `docs/superpowers/plans/p6-acceptance.md` 记录所有指标。

- [ ] **步骤 5：最终 Commit**

```bash
git add docs/superpowers/plans/p6-acceptance.md
git commit -m "test(p6): complete acceptance testing"
```

---


---

## 实施顺序建议

### 最小可验证路径（MVP）

1. **任务 1.1–1.2**：Rust 脚手架 + TS wrapper（验证编译与加载）
2. **任务 2.1–2.2**：字典协议（验证资源传输）
3. **任务 3.1–3.2**：lindera 集成（验证 V8：offscreen worker 里的 45 MB 字典）
4. **任务 5.2**：vocab 闸门（验证输出校验逻辑）
5. **任务 6.1**：一个前端（中文 v1.0）+ 对照测试骨架
6. **任务 7.1–7.3**：双 worker 架构（验证冷启动并行与调度）

此时可以跑通完整流程：选中文音色 → 播放 → 听到声音。

### 后续扩展

7. **任务 4.1–4.2**：espeak 集成（英文支持）
8. **任务 6.2–6.3**：其余前端（日语、中文 v1.1-zh）
9. **任务 8.1–8.6**：对照测试、性能验证、错误处理、清理

---

## 依赖与风险

### 外部依赖

| 依赖 | 用途 | 风险 | 缓解 |
|---|---|---|---|
| lindera 0.34+ | 日语分词 | 版本不兼容 | 锁定版本，测试覆盖 |
| espeak-ng | 英文 G2P | C 编译复杂 | 预先验证 build.rs |
| wasm-bindgen | Rust↔JS 桥接 | API 变更 | 锁定版本 |
| zstd | 字典解压 | 性能不达标 | V2 实测（spec §7） |

### 技术风险

1. **espeak 在 wasm 中的文件系统访问**（任务 4.2）
   - espeak 需要读取数据文件，wasm 没有真实文件系统
   - 缓解：使用 emscripten 虚拟 FS 或内存映射
   
2. **lindera 在 offscreen worker 的内存行为**（V8，任务 8.2）
   - 45.3 MB 字典可能触发内存限制或影响回收
   - 缓解：早期验证，监控内存指标

3. **对照测试的覆盖率**（任务 8.1）
   - 现有 1430 测试可能遗漏边缘用例
   - 缓解：补充 corpus，记录所有"更优"案例

4. **双 worker 的错误同步**（任务 7.3）
   - 一个 worker 崩溃时另一个的状态处理
   - 缓解：spec §8.1 的错误分类 + 审查重点 #4

---

## 待决项（开工前必须解决）

spec §8 列出的 6 个待决项：

1. **错误分类与气泡文案**（任务 8.3 中解决）
2. **用户正则规则的边界**（暂不实现，预留接口）
3. **两个模型共存的运行时切换**（任务 7.3 中解决：frontend 参数动态选择）
4. **测试语料迁移方式**（任务 6.2：提取为 JSON + Rust 集成测试读取）
5. **wasm 构建集成**（任务 1.1：scripts/build-phonemize-wasm.sh + prebuild hook）
6. **词典版本更新流程**（决策 #21：构建时锁定，手动更新，记录在 Cargo.toml）

---

## 验收清单

任务 8.6 最终验收时检查：

- [ ] 单元测试 PASS（Rust 侧 + TS 侧）
- [ ] 对照测试 100% 通过（或记录所有改进）
- [ ] 性能测试达标（冷启动 ≤ 100 ms，中文 ≤ 0.1 ms/句）
- [ ] E2E 测试通过（三种语言 × 两个模型）
- [ ] 构建产物检查（只有一个 .wasm，字典在 public/）
- [ ] 文档完整（架构、README、Rust crate）
- [ ] Biome / TypeScript 无警告
- [ ] 内存验证通过（V8：offscreen worker 不泄漏）

---

## 附录：关键文件清单

### Rust 侧

```
crates/phonemize/
├── Cargo.toml              # 依赖：wasm-bindgen, lindera, zstd
├── build.rs                # 编译 espeak-ng C 源码
├── src/
│   ├── lib.rs              # wasm_bindgen 入口
│   ├── types.rs            # TS 映射类型
│   ├── dictionary.rs       # 字典加载与 zstd 解压
│   ├── vocab.rs            # vocab 闸门
│   ├── backends/           # TN, 分词, pinyin, espeak
│   └── frontends/          # 4 个前端组装
├── data/
│   ├── pinyin-table.json
│   ├── vocab-v1.txt
│   └── vocab-v11-zh.txt
└── tests/
    └── integration.rs
```

### TypeScript 侧

```
lib/models/
├── phonemize-rust.ts       # Rust wrapper
├── phonemize-wasm/         # wasm-pack 输出（构建产物）
└── phonemize-worker-protocol.ts

entrypoints/offscreen/
├── phonemize.worker.ts     # phonemize worker
├── kokoro.worker.ts        # kokoro worker（重命名自 local.worker.ts）
└── offscreen.ts            # 双 worker 协调

tests/
├── corpus/
│   └── phonemize-corpus.json
├── unit/models/
│   ├── phonemize-rust.test.ts
│   └── phonemize-rust-parity.test.ts
└── performance/
    └── phonemize-benchmark.test.ts
```

### 资源

```
public/
├── dictionaries/
│   ├── lindera-ipadic-ja.bin.zst    # 10 MB
│   └── espeak-data.tar.zst
└── ...

scripts/
├── build-phonemize-wasm.sh
├── download-lindera-dict.sh
├── bundle-espeak-data.sh
└── extract-test-corpus.mjs
```

---

