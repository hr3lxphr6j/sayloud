# 中文发音试听页（P5 spec 的 V24 / V27）

**Status: throwaway spike.** 它的产出是「哪一项改动真的听得出来」这个答案，
不是要留下的代码。结论进 P5 spec 后删除。

## 它回答什么

用的是**用户报告的真实例句**（P5 spec §1.8），不是合成的 —— 合成的那些
（§1.2 的 s1/s2/s3）后来被证明听不出差别，真实例句才有诊断价值。

| 问题 | 对应验证点 |
|---|---|
| 用户报的「人设/曾经 中间有停顿」，「只修 A」修好了吗？ | **V24** |
| 用户报的「得读成二声」，「补丁表」修好了吗？ | **V24** |
| 换成 v1.1-zh 之后整体如何？ | **V27** |

4 句 × 6 个 clip（5 个 v1.0 变体 + 1 个 v1.1-zh），共 24 个。

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

音频写到 `/tmp/kokoro-zh-samples-out`，清单写到 `samples.json`。

## 四个让它可信的设计

**1. `现状` 变体不是手写的，是断言出来的。**
`gen-variants.mjs` 里的参数化实现必须与**真实的** `hanToIpa` / `mapPunctuation` /
`splitRuns` 输出逐字符相同，否则脚本直接退出。

**2. 每个 clip 记录 tokenizer 之后的 id 摘要。**
两行 id 相同 → **必然听不出差别**，页面标「token 相同」并淡化。

**3. 「训练目标」由一个独立进程产生。**
`legacy_phonemes.py` 不 import misaki，因为 `ZHFrontend.__init__` 会调
`large_pinyin.load()` —— 那会**改写 pypinyin 的全局词典**，而 `large_pinyin` 存的是
变调后的读音。这个对照样本已经被这类问题毁过两次。

**4. 音素串字符集断言。**
`Tokenizer.encode` 断言「normalizer 剥掉的字符只能是已知的组合符」。混进全角标点、
数字或汉字都会让脚本失败，而不是产出缺东西的 clip。

## 已经被这个页面测出来的结论

- **偏差 D（U+032F）是 no-op**（id 逐位相同，normalizer 会剥掉它）。
- **偏差 C（变调）不是偏差，已撤销** —— pypinyin 内置词典里「一/不 + 字」的
  两字词条 **294 条，56% 变调、44% 原调，分布任意**，所以没有任何 `toneSandhi`
  设置能对齐 legacy。
- **格式对齐（A/B/D）在合成语料上听不出差别**（§1.7）。
- **补丁表是唯一买到对齐的东西**：s3 上「对齐 + 补丁」与 `legacy 参考` 的 ids
  **逐位相同**。
- **jieba-wasm 是 Python jieba 的忠实替代**（`cut(text, true)` 24/24 一致），
  但 **`hmm` 不能省**。

## 两个相关性指标都不能替代耳朵（重要）

| 指标 | 用户说「听不出」的两组 clip | 结论 |
|---|---|---|
| 原始波形 corr | `-0.087` / `+0.135` / `-0.046` ≈ 0 | 这个模型对微小时序极敏感 → **没有感知意义** |
| 能量包络 corr | 0.976 / 0.963 / 0.872 | 用它校准的阈值**预测 +0.414 应该听得出来，实际听不出** |

自动化指标只能定位「哪里变了」，不能断言「变了多少」。

## 为什么没有「2a 式」变体了

原本每个句子还有一个「2a 式」clip（我们自己的读音编成注音符号），用来预览
阶段 2a 会离官方前端多远。**已删除**：它需要一张覆盖**全部读音**的
音节→注音符号表，而枚举 pypinyin 的单字词典只得到**默认读音**，所以「得」的
`děi` 直接缺失、脚本报 `no bopomofo for syllable 'dei'`。pypinyin 的 heteronym API
能给出其余读音，但它的三个 style 对同一个字的**列表长度不一致**
（`NORMAL` 给 `['de','dei']`，`FINALS_TONE3` 给 `['e2','e5','ei3']`），
按索引对齐也不安全。

正确的表是 T6（阶段 2a）的产出，该像 `pinyin-table.json` 一样认真生成，
不该为一个预览页临时糊一个。

## 怎么听

**先听三个最可能有差别的：**

1. **r1 / r2** 的 `现状` vs `只修 A 词边界（jieba）` —— 你报的「人设/曾经 中间有停顿」
   是否消失。（我量不出来，那个停顿不像静音间隙，更像韵律重置。）
2. **r1** 的 `对齐 A+B+D` vs `对齐 A+B+D + 补丁` —— 「得」从 `tɤ↗`（dé）变成
   `tei↓`（děi）、`lei↘tɤ`（lèi de）。这一对**应该明显听得出来**。
3. **r3** 的 `现状` vs `对齐 A+B+D` —— 逗号停顿。预期：**没变化**（v1.0 不响应标点）。

**最后听阶段 2**：v1.1-zh 换了模型和音色，只判断自然度与读音，不要拿音色比。

页面上按空格键重放当前 clip。
