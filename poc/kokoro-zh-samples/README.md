# 中文发音试听页（P5 spec 的 V24 / V27）

**Status: throwaway spike.** 它的产出是「哪一项改动真的听得出来」这个答案，
不是要留下的代码。结论进 P5 spec 后删除。

## 它回答什么

| 问题 | 对应验证点 |
|---|---|
| 格式对齐（spec §1.2 的 A–D）这个方向对不对？哪一项在起作用？ | **V24** |
| 换成 v1.1-zh 之后，自然度与读音是否明显更好？ | **V27** |
| 「2a 式」（无儿化、无 `large_pinyin`）离官方 `ZHFrontend` 有多远？ | **V27 的关键子问题** |

三句话 × 两组，共 31 个 clip。

## 怎么跑

```bash
# 依赖（见 P5 spec 与 poc/kokoro-v11zh-webgpu/README.md）
#   /tmp/zhvenv        python + pypinyin/pypinyin-dict/jieba/cn2an/addict/ordered-set/numpy/onnxruntime
#   /tmp/misakizh      misaki 的 zh 前端（从 GitHub 原始文件拼装）
#   /tmp/kokoro-v10    v1.0 的 model.onnx + tokenizer.json + voices/zf_xiaobei.bin
#   /tmp/kokoro-poc-models  v1.1-zh 的 model.onnx + tokenizer.json + voices/zf_001.bin + misakizh
#   /tmp/jieba-check   npm i jieba-wasm 的临时安装（gen-variants.mjs 从这里 import）

# 1. 生成音素串（用真实 TS 代码做锚点校验；词边界用 jieba-wasm）
npx jiti poc/kokoro-zh-samples/gen-variants.mjs

# 2. 合成音频（v1.0 与 v1.1-zh 各自的模型 + tokenizer）
/tmp/zhvenv/bin/python poc/kokoro-zh-samples/make-samples.py

# 3. 起服务
node poc/kokoro-zh-samples/server.mjs      # http://127.0.0.1:8914/
```

音频写到 `/tmp/kokoro-zh-samples-out`（不进仓库），清单写到 `samples.json`。

## 三个让它可信的设计

**1. `现状` 变体不是手写的，是断言出来的。**
`gen-variants.mjs` 里的参数化实现必须与**真实的** `hanToIpa` / `mapPunctuation` /
`splitRuns` 输出逐字符相同，否则脚本直接退出。这样「现状」这一栏不会因为
产品代码漂移或重写误差而悄悄标错，别的变体都是相对它定义的。

**2. 每个 clip 记录 tokenizer 之后的 id 摘要。**
两行 id 相同 → **必然听不出差别**，页面会标「token 相同」并淡化。
这既是给耳朵省时间，也是这套试听方法本身的自检。

**3. 「训练目标」由一个独立进程产生。**
`legacy_phonemes.py` 不 import misaki，因为 `ZHFrontend.__init__` 会调
`large_pinyin.load()` —— 那会**改写 pypinyin 的全局词典**，而 `large_pinyin` 存的是
变调后的读音。这个对照样本已经被这类问题毁过两次（详见下），现在结构上不可能再发生。

## 已经被这个页面测出来的结论

- **偏差 D（U+032F）在 token 层面是 no-op** —— 三句话全部与「现状」id 逐位相同。
  normalizer 的保留集合里没有 `̯`，所以它被剥掉。P4 的假设现在是被测出来的。
- **偏差 C（变调）不是偏差，已撤销** —— pypinyin 的内置词典里「一/不 + 字」的
  两字词条共 **294 条，56% 变调、44% 原调**，分布任意。所以**没有任何一个
  `toneSandhi` 设置能对齐 legacy**：
  - s1（一个）：保留变调才对齐
  - s2（一石二鸟）：关掉变调才对齐
  - 再叠上「声调箭头几乎不改变音高」，这一项既无收益也无意义
- **真正买到对齐的是补丁表**：s3 上「对齐 A+B+D + 补丁」与 `legacy 参考` 的
  **ids 逐位相同**（`5bfa32d9`）。
- **jieba-wasm 是 Python jieba 的忠实替代**（`cut(text, true)` 24/24 一致），
  但 **`hmm` 不能省**：关掉之后「还书」会被切成「还|书」。

## 两个踩过的坑（同一类）

对照样本必须被钉死，否则它会给出**相反的结论**：

1. `legacy_phonemes` 漏了 `map_punctuation` → 全角 `，`/`。` 不在 vocab 里、
   被 normalizer 静默剥掉 → 那个 clip **丢掉了全部停顿**，根本不是训练目标。
2. 同一个进程里先实例化了 `ZHFrontend` → `large_pinyin` 污染全局词典 →
   「训练目标」算出了变调后的读音（一个 → `i↗`）。

两个都已修，并各加了一条防回归：`Tokenizer.encode` 断言「只有已知组合符可被剥掉」；
legacy 参考改由独立进程产出。

## 怎么听

1. 每句先听三个：**现状 → 对齐 A+B+D → legacy 参考**。最后一个是训练目标。
2. 有差别再听 **只修 A（jieba）/ A（ICU 对照）/ B / D**，定位是哪一项。
3. 最后听**阶段 2**。v1.1-zh 换了模型和音色，声音本身就不同，
   只判断自然度与读音，不要拿音色跟上面比。

页面上按空格键重放当前 clip（A/B 对比时有用）。
