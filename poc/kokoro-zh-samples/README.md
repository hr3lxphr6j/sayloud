# 中文发音试听页（P5 spec 的 V24 / V27）

**Status: throwaway spike.** 它的产出是「哪一项改动真的听得出来」这个答案，
不是要留下的代码。结论进 P5 spec 后删除。

## 它回答什么

| 问题 | 对应验证点 |
|---|---|
| 格式对齐（spec §1.2 的 A–D）这个方向对不对？哪一项在起作用？ | **V24** |
| 换成 v1.1-zh 之后，自然度与读音是否明显更好？ | **V27** |
| 「2a 式」（无儿化、无 `large_pinyin`）离官方 `ZHFrontend` 有多远？ | **V27 的关键子问题** |

三句话 × 两组，共 28 个 clip。

## 怎么跑

```bash
# 依赖（见 P5 spec 与 poc/kokoro-v11zh-webgpu/README.md）
#   /tmp/zhvenv        python + pypinyin/pypinyin-dict/jieba/cn2an/addict/ordered-set/numpy/onnxruntime
#   /tmp/misakizh      misaki 的 zh 前端（从 GitHub 原始文件拼装）
#   /tmp/kokoro-v10    v1.0 的 model.onnx + tokenizer.json + voices/zf_xiaobei.bin
#   /tmp/kokoro-poc-models  v1.1-zh 的 model.onnx + tokenizer.json + voices/zf_001.bin + misakizh

# 1. 生成音素串（用真实 TS 代码做锚点校验）
npx jiti poc/kokoro-zh-samples/gen-variants.mjs

# 2. 合成音频（v1.0 与 v1.1-zh 各自的模型 + tokenizer）
/tmp/zhvenv/bin/python poc/kokoro-zh-samples/make-samples.py

# 3. 起服务
node poc/kokoro-zh-samples/server.mjs      # http://127.0.0.1:8914/
```

音频写到 `/tmp/kokoro-zh-samples-out`（5 MB，不进仓库），清单写到 `samples.json`。

## 两个让它可信的设计

**1. `现状` 变体不是手写的，是断言出来的。**
`gen-variants.mjs` 里的参数化实现必须与**真实的** `hanToIpa` / `mapPunctuation` /
`splitRuns` 输出逐字符相同，否则脚本直接退出。这样「现状」这一栏不会因为
产品代码漂移或重写误差而悄悄标错，别的变体都是相对它定义的。

参数化重写之所以存在，只是因为真实实现把那几个开关写死了。

**2. 每个 clip 记录 tokenizer 之后的 id 摘要。**
两行 id 相同 → **必然听不出差别**，页面会标「token 相同」并淡化。
这既是给耳朵省时间，也是这套试听方法本身的自检：如果它连一个已知的
no-op 都识别不出来，那它说「有差别」也不可信。

已经据此得出的两个结论：

- **偏差 D（U+032F）在 token 层面是 no-op** —— 三句话全部与「现状」id 逐位相同。
  normalizer 的保留集合里没有 `̯`，所以它被剥掉。这用数字证实了 P4 的假设，
  也说明这一项不需要听。
- **`只修 C 变调` 对第三句是 no-op** —— 那句话里没有「一」也没有「不」。
  这是预期行为，不是 bug。

## 怎么听

1. 每句先听三个：**现状 → 全部对齐 → legacy 参考**。最后一个是训练目标。
2. 有差别再听 **只修 A / B / C / D**，定位是哪一项。
3. 最后听**阶段 2**。v1.1-zh 换了模型和音色，声音本身就不同，
   只判断自然度与读音，不要拿音色跟上面比。

页面上按空格键重放当前 clip（A/B 对比时有用）。
