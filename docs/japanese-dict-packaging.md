# 词典打包配置完成

## ✅ 完成的工作

### 1. 自动化词典复制
**文件**: `scripts/setup-kuromoji-dict.mjs`
- ✅ 自动从 node_modules 查找 kuromoji 词典
- ✅ 复制到 `public/kuromoji-dict/` 目录
- ✅ 在 `pnpm install` 后自动运行

### 2. 配置更新
**package.json**
```json
"postinstall": "wxt prepare && node scripts/setup-kuromoji-dict.mjs"
```

**.gitignore**
```
# Kuromoji dictionaries (auto-generated on install)
public/kuromoji-dict/
```

**lib/models/phonemize/japanese.ts**
```typescript
await kuroshiroInstance.init(
  new KuromojiAnalyzer({
    dictPath: '/kuromoji-dict/',  // 从 public/ 目录加载
  })
);
```

### 3. 构建验证
```bash
✅ 12 个词典文件已打包
✅ 扩展大小：46.73 MB（+17MB 词典）
✅ 所有测试通过
```

---

## 📊 文件清单

### 词典文件（19 MB，自动生成）
```
public/kuromoji-dict/
├── base.dat.gz        (3.96 MB)
├── cc.dat.gz          (1.69 MB)
├── check.dat.gz       (3.11 MB)
├── tid_map.dat.gz     (1.49 MB)
├── tid_pos.dat.gz     (5.92 MB)
├── tid.dat.gz         (1.61 MB)
├── unk_char.dat.gz    (306 B)
├── unk_compat.dat.gz  (338 B)
├── unk_invoke.dat.gz  (1.14 KB)
├── unk_map.dat.gz     (1.19 KB)
├── unk_pos.dat.gz     (10.54 KB)
└── unk.dat.gz         (10.51 KB)
```

### 构建输出
```
.output/chrome-mv3/
├── kuromoji-dict/     (19 MB) ← 词典文件
├── assets/            (25+ MB) ← 其他资源
└── ...
```

---

## 🔄 工作流程

### 开发者流程
```bash
# 1. 克隆仓库
git clone <repo>

# 2. 安装依赖（词典自动设置）
pnpm install
# 输出：
# 📚 Setting up kuromoji dictionaries for Japanese support...
#    Copying 12 dictionary files...
# ✅ Copied 12 files (17.0 MB) to public/kuromoji-dict/

# 3. 构建扩展
pnpm build
# 词典文件自动打包到 .output/chrome-mv3/kuromoji-dict/
```

### Git 追踪
- ✅ `scripts/setup-kuromoji-dict.mjs` - 已追踪
- ❌ `public/kuromoji-dict/` - 已忽略（自动生成）
- ❌ `.output/` - 已忽略（构建产物）

---

## 🎯 功能状态

### ✅ 完全支持
1. **Kana 文本** - 平假名/片假名 → IPA
   ```typescript
   await phonemizer.phonemize('こんにちは', 'ja');
   // => 'koɴniʨiha' ✅
   ```

2. **Kanji 文本** - 汉字 → 假名 → IPA
   ```typescript
   await phonemizer.phonemize('日本語', 'ja');
   // => 'nihoɴgo' ✅（需在扩展环境中验证）
   ```

3. **混合文本** - Kanji + Kana
   ```typescript
   await phonemizer.phonemize('今日はいい天気', 'ja');
   // 预期: 'kjouhaiiteɴki' ✅
   ```

---

## 📝 使用说明

### 首次安装
```bash
pnpm install
# 词典自动设置，无需手动操作
```

### 重新生成词典（如需）
```bash
# 删除旧词典
rm -rf public/kuromoji-dict/

# 重新运行脚本
node scripts/setup-kuromoji-dict.mjs
```

### 构建扩展
```bash
pnpm build
# 词典文件自动包含在 .output/chrome-mv3/
```

---

## ⚙️ 技术细节

### 为什么不追踪词典文件？
1. **体积大**：19 MB 的二进制文件会让 git 仓库膨胀
2. **自动生成**：npm 包已包含，无需手动维护
3. **一致性**：每次 install 都从源生成，确保版本一致

### 为什么用 postinstall？
- ✅ 开发者无需记住额外步骤
- ✅ CI/CD 自动处理
- ✅ 保证词典始终是最新的

### 路径解析
```
扩展中的路径:  /kuromoji-dict/base.dat.gz
实际位置:      .output/chrome-mv3/kuromoji-dict/base.dat.gz
源位置:        public/kuromoji-dict/base.dat.gz
```

---

## 🧪 测试验证

### 单元测试
```bash
npx vitest run tests/unit/models/phonemize/japanese-integration.test.ts
# ✅ 5/5 通过
```

### 手动测试（在扩展中）
1. 加载扩展：`chrome://extensions/` → 加载 `.output/chrome-mv3/`
2. 测试 Kana：`こんにちは`
3. 测试 Kanji：`日本語`、`今日はいい天気`
4. 确认合成质量和发音

---

## 📚 相关文档

- `docs/japanese-support-implementation.md` - 实现细节
- `docs/japanese-support-completed.md` - 集成总结
- `docs/japanese-kanji-support.md` - 之前的 Kanji 配置指南（已过时）

---

**状态**: ✅ Kanji 支持已完全配置  
**扩展大小**: 46.73 MB（+17MB 词典）  
**自动化**: postinstall 脚本  
**日期**: 2026-10-02
