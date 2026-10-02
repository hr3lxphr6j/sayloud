# 中文发音试听页（P5 spec 的 V24 / V27）

**Status: throwaway spike.** 它的产出是「哪一项改动真的听得出来」这个答案，
不是要留下的代码。结论进 P5 spec 后删除。

## 它回答什么

用的是**用户报告的真实例句**（P5 spec §1.8），不是合成的 —— 合成的那些
（§1.2 的 s1/s2/s3）后来被证明听不出差别，真实例句才有诊断价值。

| 问题 | 对应验证点 |
|---|---|
| 用户报的「人设/曾经 中间有停顿」，「只改词边界」修好了吗？ | **V24** |
| 用户报的「得读成二声」，「补丁表」修好了吗？ | **V24（补丁表已暂缓）** |
| 换成 v1.1-zh 之后整体如何？ | **V27** |
| 换成空格会不会有停顿？ | 标点组 |

**这个词边界修复已经上线**，所以页面上的「现在发布的版本」就是线上代码。
4 个句子 + 3 组，共 31 个 clip。

> ## ⚠️ 页面的数据落后于线上代码（2026-10-02）
>
> 本目录里的 `variants.json` / `samples.json` / 音频是**逗号→句号与拉丁字符分流上线之前**
> 生成的，所以：
>
> - 页面上的「现在发布的版本」里的标点是 `, `，而线上现在发 `. `（P5 spec §3.8）；
> - 页面里没有含拉丁字符的句子，`Agent` 被逐字母读这个缺陷看不到（§3.9）；
> - 音频在 `/tmp/kokoro-zh-samples-out/`，重启即失效。
>
> **这是刻意的：用户 2026-10-02 说不再试听、直接落地**，所以没有重跑。
> 重跑只需依次执行 `gen-variants.mjs` 与 `make-samples.py` —— harness 自身的逻辑
> 是好的，anchor 在改动后的代码上仍然通过（4 句全过）。**不要只重跑一半**：
> 只跑第一个会让音素串描述一个音频里不存在的行为。

## 怎么跑

```bash
# 依赖（见 P5 spec 与 poc/kokoro-v11zh-webgpu/README.md）
#   /tmp/zhvenv        python + pypinyin/pypinyin-dict/jieba/cn2an/addict/ordered-set/numpy/onnxruntime
#   /tmp/misakizh      misaki 的 zh 前端（从 GitHub 原始文件拼装）
#   /tmp/kokoro-v10    v1.0 的 model.onnx + tokenizer.json + voices/<V10_VOICE>.bin
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

**音色是 `make-samples.py` 顶部的两个常量**（`V10_VOICE = 'zf_xiaoyi'`、`V11_VOICE = 'zf_001'`），
切换只改一行。v1.0 的 8 个中文音色（`zf_xiaobei`/`zf_xiaoni`/`zf_xiaoxiao`/`zf_xiaoyi`/
`zm_yunjian`/`zm_yunxi`/`zm_yunxia`/`zm_yunyang`）与 v1.1-zh 的命名（`zf_001..zf_100`）**没有对应关系**，
所以两阶段的音色不可能一致 —— 页面上会把实际音色显示在标题里。

## 四个让它可信的设计

**1. anchor 断言「试听页描述的就是线上代码」。**
2026-10-02 之前它断言的是「`现状` == 产物输出」。产物改了之后那句话就反了，
所以 anchor 跟着搬家而不是被删掉：现在断言 `对齐 A+B+D` **逐字符等于真实的
`ChinesePhonemizer`**，**并且**「修复前」与它不同。

两句都要，缺一不可 —— 只断言前者的话，有人把间距改回去（两边一起改）也能通过；
只断言后者的话，页面可能在描述一条已经不存在的管线。

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
- **格式对齐在合成语料上听不出差别，在用户的真实例句上是「最明显的优化」** ——
  测试材料比测试方法更能决定结论（P5 spec §1.7）。**这就是上线的那一项。**
- **补丁表是唯一买到逐字符对齐的东西**：s3 上「对齐 + 补丁」与 `legacy 参考`
  的 ids **逐位相同**。补丁表本身已暂缓。
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

1. **r1 / r2** 的 `修复前` vs `只改词边界（jieba）` —— 用户报的「人设/曾经 中间有停顿」
   是否消失。（我量不出来，那个停顿不像静音间隙，更像韵律重置。）
2. **r3** 的 `修复前` vs `现在发布的版本` —— 逗号停顿。预期：**没变化**
   （v1.0 不响应标点，见标点组）。
3. **r1** 的 `现在发布的版本` vs `发布版 + 补丁` —— 「得」从 `tɤ↗`（dé）变成
   `tei↓`（děi）、`lei↘tɤ`（lèi de）。这一项**已暂缓**，听一下可以判断值不值得做。

**最后听阶段 2**：v1.1-zh 换了模型和音色，只判断自然度与读音，不要拿音色比。

页面上按空格键重放当前 clip。
