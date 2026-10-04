# Extractor 改进计划

## 背景

当前 extractor（`lib/extractor.ts`）使用 Mozilla Readability 提取正文，但存在两个问题：

1. **读到网页 UI 文字**：通用启发式算法有时会误判导航、侧边栏等为正文
2. **引用标记残留**：`<sup>` 已在 DOM 层跳过，但纯文本形式的引用（如 `[1]`）仍会进入文本流

## 调研结果（2026-10-04）

### 问题 1：针对域名的特化提取

**现状**：没有现成的通用 JS 库支持 per-site CSS/XPath 配置

**可行方案**：配置文件 + 选择器回退模式

```typescript
interface SiteConfig {
  domain: string;
  selectors: {
    title?: string;
    content: string;      // 主内容选择器
    author?: string;
    date?: string;
    skip?: string[];      // 要排除的选择器
  };
}

const configs: SiteConfig[] = [
  {
    domain: 'en.wikipedia.org',
    selectors: {
      content: '#mw-content-text .mw-parser-output',
      skip: ['.reflist', '.navbox', '.infobox', '.thumb']
    }
  },
  {
    domain: 'news.ycombinator.com',
    selectors: {
      content: '.fatitem'
    }
  }
];
```

**实现要点**：
- `domain` 匹配（支持通配符 `*.wikipedia.org`）
- 找到配置后用 `querySelector(content)` 替换 Readability
- 没有配置时回退到现有的 Readability 流程

**参考**：
- Crawl4AI 的 `CSSExtractionStrategy`（Python，逻辑可移植）
- DocSearch 的 hierarchical selector config 模式

**工作量估算**：~200 行 TS，1-2 天

---

### 问题 2：文本清洗（引用标记移除）

**现状**：`<sup>` 标签在 DOM 层已跳过（commit 2a4b7a2），但纯文本形式的引用标记（`[1]` `[2,3]` 等）需要在 extractor 之后清洗

**可行方案**：实现 `lib/text-cleaner.ts` 模块

```typescript
export interface CleanOptions {
  /** 移除引用标记 [1] [2,3] [1-5] */
  citations?: boolean;
  /** 移除所有方括号内容 */
  allBrackets?: boolean;
  /** 移除圆括号内容（慎用，会删掉正常的旁白） */
  parentheses?: boolean;
  /** 规范化空白（多个空格→单个，标点前空格） */
  normalizeWhitespace?: boolean;
  /** 自定义正则列表（在内置规则后执行） */
  customPatterns?: RegExp[];
}

const CITATION_PATTERNS = [
  /\[\d+\]/g,              // [1]
  /\[\d+,\s*\d+\]/g,       // [1, 2]
  /\[\d+-\d+\]/g,          // [1-3]
  /\[[\d,\s-]+\]/g,        // [1, 2, 3-5]
  /\^\d+/g,                // ^1 (上标样式)
];

export function cleanText(text: string, options: CleanOptions = {}): string {
  const {
    citations = true,
    allBrackets = false,
    parentheses = false,
    normalizeWhitespace = true,
    customPatterns = [],
  } = options;

  let cleaned = text;

  if (citations) {
    for (const pattern of CITATION_PATTERNS) {
      cleaned = cleaned.replace(pattern, '');
    }
  }

  if (allBrackets) {
    cleaned = cleaned.replace(/\[.*?\]/g, '');
  }

  if (parentheses) {
    cleaned = cleaned.replace(/\(.*?\)/g, '');
  }

  for (const pattern of customPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  if (normalizeWhitespace) {
    cleaned = cleaned
      .replace(/\s+/g, ' ')                    // 多空格→单空格
      .replace(/\s+([.,;:!?])/g, '$1')        // 标点前的空格
      .replace(/\s+$/gm, '')                   // 行尾空格
      .trim();
  }

  return cleaned;
}
```

**集成点**：在 `extractBlocks()` 返回前清洗每个 `block.text`

```typescript
export function extractBlocks(options?: {
  siteConfig?: SiteConfig;
  cleanText?: CleanOptions;
}): Block[] {
  // ... 现有逻辑 ...
  const blocks = /* ... */;
  
  if (options?.cleanText) {
    return blocks.map(block => ({
      ...block,
      text: cleanText(block.text, options.cleanText)
    }));
  }
  
  return blocks;
}
```

**工作量估算**：半天

---

## 建议的实施顺序

### 阶段 1：文本清洗（优先级：高）

**为什么先做**：
- 解决当前实际遇到的问题（引用标记导致 WeText TN 失败）
- 代码简单，风险低
- 对所有站点都有效

**交付物**：
1. 创建 `lib/text-cleaner.ts`
2. 在 `extractBlocks()` 里默认启用 `citations: true`
3. 测试：维基百科句子，确认 `[54]` `[55]` 被移除
4. 回归测试：确保现有测试仍通过

**工作量**：半天

---

### 阶段 2：Per-site 配置（优先级：中，按需触发）

**何时做**：
- 发现某些站点 Readability 效果很差（误判导航为正文、漏掉主内容）
- 有具体的高频站点需要优化（Wikipedia、Medium、HN 等）

**交付物**：
1. 创建 `lib/site-configs.ts` 存放配置
2. 修改 `extractBlocks()` 支持配置优先、Readability 回退
3. 添加 2-3 个常用站点配置
4. 文档：如何添加新站点配置

**工作量**：1-2 天

**注意**：Mozilla Readability 本身已经很强（Firefox Reader View 用的就是它），per-site 配置是**增强**而非替代

---

### 阶段 3：配置 UI（优先级：低，用户需求驱动）

**何时做**：
- 用户明确要求自定义站点配置
- 有社区贡献配置的需求

**交付物**：
1. 扩展设置页面
2. 用户可添加/编辑/删除站点配置
3. 配置存储在 `chrome.storage.sync`
4. 导入/导出配置功能

**工作量**：3-5 天

**风险**：
- 配置 UI 是重工程
- 大部分用户不会用
- 维护成本高
- 建议等有明确需求再做

---

## 技术决策

### 为什么不使用现成库？

**Per-site 提取**：
- 没有符合需求的通用库（搜索了 npm、GitHub）
- 现有方案都是特定场景（文档站点、爬虫框架）
- 自己实现逻辑简单清晰（~200 行）

**文本清洗**：
- 需求太特化（学术引用格式）
- 通用文本处理库太重（natural、compromise.js）
- 正则模式足够（~50 行核心逻辑）

### 为什么在 extractor 后清洗？

**层次分离**：
- DOM 层（extractor）：跳过不读的元素（`<sup>`, `<script>`, `<style>`）
- 文本层（cleaner）：清洗已提取文本中的残留标记

**具体案例**：
- `<sup>[54]</sup>` → DOM 层跳过整个元素 ✓
- `Fact[54].` → extractor 看到纯文本，无法判断 `[54]` 是引用还是正常括号 → 需要 cleaner 用正则识别

**好处**：
- extractor 保持通用性
- cleaner 可配置、可扩展
- 不同语言可以有不同的清洗规则

---

## 实测案例

### 问题发现

维基百科句子：
```
The building was listed on the National Register of Historic Places in 1977 
and designated a National Historic Landmark in 2006;[54] the boundaries of 
the designation were expanded to include the Capitol Complex in 2013[55] 
with the capitol as a contributing property.
```

**症状**：1977、2006、2013 三个年份都没有被读出来

**根因**：
1. `<sup>[54]</sup>` 被提取成纯文本 `[54]`
2. WeText 的 tagger 遇到 `[` 字符无法处理
3. WeText 采取保守策略：放弃整个句子，原样返回不做任何规范化
4. 年份没有被 TN 处理成读音形式

### 修复历程

**commit 2a4b7a2**：在 `SKIP_TAGS` 添加 `'SUP'`
- 解决了 DOM 层的 `<sup>` 元素
- 但无法解决纯文本形式的 `[54]`（某些站点不用 `<sup>`，直接写在正文里）

**待实施**：阶段 1 文本清洗
- 在 extractor 后用正则移除 `[数字]` 模式
- 彻底解决引用标记问题
- 对所有引用格式（不限于 `<sup>`）都有效

---

## 参考资料

### 文本提取库生态

**Mozilla Readability**（当前使用）：
- GitHub: https://github.com/mozilla/readability
- Firefox Reader View 底层
- 启发式算法，无需配置
- 对大部分站点效果良好

**其他方案**：
- `readabilitySAX`：SAX 解析器版本，更快但功能少
- `Trafilatura`：Python，学术级文本提取
- `newspaper3k`：Python，新闻站点特化

**结论**：Mozilla Readability 已是最佳选择，只需针对性增强

### Per-site 配置模式参考

- **Crawl4AI**: CSS-based extraction strategies
- **DocSearch configs**: Hierarchical selector patterns (lvl0-lvl5)
- **Custom extractors**: Domain → selectors mapping

### 文本清洗参考

- Stack Overflow: 多个关于移除 wiki 引用的讨论
- 模式成熟，正则足够

---

## 状态

- **调研完成**：2026-10-04
- **待实施**：按优先级顺序执行
- **负责人**：待定
- **相关 commit**：2a4b7a2 (fix: skip `<sup>` tags)
