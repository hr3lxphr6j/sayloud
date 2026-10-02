# 日语 Kanji 支持状态

## 当前状态

✅ **Kana 文本完全支持** - 平假名和片假名可以直接转换为 IPA
⚠️ **Kanji 支持需要配置** - Kuroshiro 词典文件（~17MB）未打包

## 降级行为

代码已实现降级策略：
```typescript
try {
  // 尝试使用 Kuroshiro 转换 Kanji → Kana
  const katakana = await textToKatakana(text);
  return kanaToIPA(katakana);
} catch (error) {
  // 降级：假设输入已经是 Kana
  return kanaToIPA(text);
}
```

**结果**：
- ✅ Kana 文本：正常工作
- ⚠️ Kanji 文本：会尝试将 Kanji 字符当作 Kana 处理（失败但不会崩溃）

## 解决方案

### 选项 1：使用 CDN（推荐）

修改 `lib/models/phonemize/japanese.ts`：

```typescript
await kuroshiroInstance.init(new KuromojiAnalyzer({
  dictPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
}));
```

**优点**：
- ✅ 不增加扩展体积
- ✅ 自动更新

**缺点**：
- ⚠️ 需要网络连接
- ⚠️ 首次加载较慢（~17MB）

### 选项 2：打包词典文件

在 `wxt.config.ts` 中添加：

```typescript
export default defineConfig({
  // ...
  vite: {
    publicDir: 'public',
    // 或者使用 copy plugin
  },
});
```

然后将词典复制到 `public/dict/`：

```bash
mkdir -p public/dict
cp -r node_modules/.pnpm/kuromoji@*/node_modules/kuromoji/dict/* public/dict/
```

更新初始化代码：

```typescript
await kuroshiroInstance.init(new KuromojiAnalyzer({
  dictPath: '/dict/',
}));
```

**优点**：
- ✅ 离线工作
- ✅ 加载快

**缺点**：
- ❌ 扩展体积 +17MB

### 选项 3：保持当前状态（最简单）

**适用场景**：
- 用户只需要合成 Kana 文本
- 用户可以在其他地方将 Kanji 转换为 Kana（如 Google 翻译）

**优点**：
- ✅ 零配置
- ✅ 扩展体积最小
- ✅ Kana 文本完全支持

## 推荐方案

### 阶段 1（当前）：保持降级行为
- 先测试 Kana 文本合成
- 验证 IPA 格式和听感
- 确认日语音色工作正常

### 阶段 2：根据需求选择
- **如果 Kana 够用** → 保持现状
- **如果需要 Kanji** → 使用 CDN（选项 1）

## 测试方法

### 测试 Kana 支持（应该工作）
```typescript
const phonemizer = await phonemizerFor('ja');

// 平假名
await phonemizer.phonemize('こんにちは', 'ja');
// 预期: 'koɴniʨiha' ✅

// 片假名
await phonemizer.phonemize('コンニチハ', 'ja');
// 预期: 'koɴniʨiha' ✅
```

### 测试 Kanji 支持（当前会降级）
```typescript
// Kanji
await phonemizer.phonemize('日本語', 'ja');
// 当前: '日本語'（原样返回）
// 期望: 'nihoɴgo'（需要词典）
```

## 相关文件

- `lib/models/phonemize/japanese.ts` - 降级逻辑实现
- `wxt.config.ts` - 构建配置
- `node_modules/.pnpm/kuromoji@*/node_modules/kuromoji/dict/` - 词典文件

---

**建议**：先测试 Kana 文本合成，确认核心功能工作后再决定是否需要 Kanji 支持。
