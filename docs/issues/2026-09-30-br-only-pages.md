# Issue: BR-only pages only read title

**Discovered**: 2026-09-30  
**Reporter**: User testing  
**Example URL**: https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193708.htm

## Problem

扩展只读取标题，不读正文。

## Root Cause

页面结构特殊：
- 正文没有 `<p>` 标签包裹
- 全部用 `<br>` 分段（206 个）
- 文字直接是 `<body>` 的文本子节点

```html
<body>
  <p class='title1'>矛盾论</p>
  <p class='date'>（一九三七年八月）</p>
  <br>
  事物的矛盾法则，即对立统一的法则，是唯物辩证法的最根本的法则。<br>
  列宁说："就本来的意义讲，辩证法是研究对象的本质自身中的矛盾。"<br>
  ...（206 行文本，每行以 <br> 结尾）
</body>
```

当前 `lib/extractor.ts` 的逻辑：
1. Readability 失败（无法识别为文章）
2. Fallback 到 `document.body`
3. `collectBlocks()` 只查找 `BLOCK_SELECTOR`（P、H1-H6、LI、BLOCKQUOTE）
4. 只找到 2 个 `<p>`（标题 + 日期）
5. 正文的 206 行文本被完全忽略

## Impact

**High**: 影响所有类似结构的旧网站：
- Marxists.org 中文档案（大量马列文献）
- 早期 HTML 4.01 静态站
- 简单 CMS 生成的页面

这些页面在 Speechify / Read Aloud 等竞品中都能正常朗读。

## Solution

### Option A: Treat `<br>`-separated text as implicit blocks (推荐)

在 `collectBlocks()` 的 fallback 路径中，如果 `BLOCK_SELECTOR` 返回空或极少（< 3 个），则：

1. 按 `<br>` 或 `\n\n` 切分 `body.textContent`
2. 为每个段落创建一个虚拟 Block，`rangeFor()` 基于文本偏移定位到 DOM

**优点**：
- 覆盖所有 BR-only 页面
- 不破坏现有逻辑

**缺点**：
- 虚拟 Block 的 `rangeFor()` 需要遍历全部文本节点（性能可接受，只在点击时触发）

### Option B: Extend `BLOCK_SELECTOR` to include `<br>` parents

将 `<body>` 或 `<div>` 等容器元素也视为 block。

**缺点**：
- 会把整个 body 当一个 block，失去段落边界
- 需要复杂的启发式判断（是否包含 `<br>`）

### Option C: Improve Readability compatibility

调整 Readability 配置，让它能识别这种页面。

**缺点**：
- Readability 的 heuristics 很难覆盖所有边缘情况
- 我们仍需 fallback 处理

## Recommendation

**Option A**，在 P2 前修复（工作量 2 分 / 1.5 小时）：

1. 修改 `extractBlocks()`：
   ```typescript
   const blocks = collectBlocks(...);
   if (blocks.length < 3) {
     // Fallback: treat <br>-separated text as implicit blocks
     return extractTextBlocks(liveRoot);
   }
   ```

2. 实现 `extractTextBlocks()`：
   - 提取 `root.textContent`，按 `<br>` / `\n\n` 切分
   - 为每段创建虚拟 Block，`rangeFor()` 用 TreeWalker 定位

3. 添加单元测试：
   ```typescript
   it('extracts BR-separated paragraphs', () => {
     document.body.innerHTML = `
       <p>Title</p>
       Text line 1<br>
       Text line 2<br>
       Text line 3<br>
     `;
     const blocks = extractBlocks();
     expect(blocks.length).toBeGreaterThan(1); // not just "Title"
   });
   ```

## Timeline

- **P1**: 记录 issue，不修复（浏览器语音已可用，用户可先测试主流网站）
- **P2 前**: 实施 Option A，确保云端 TTS 也能处理此类页面

## Workaround (P1)

用户可以手动选中正文，使用"划词朗读"功能（P4 实现）。

---

**Status**: Open  
**Priority**: High  
**Assignee**: TBD  
**Milestone**: P2
