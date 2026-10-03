# P6 阶段 5 实施记录：中文 G2P（pinyin 层）与 vocab 闸门

**日期**: 2026-10-03
**范围**: 计划阶段 5（任务 5.1 中文拼音表与多音字、任务 5.2 vocab 闸门）
**状态**: **已实施**，测试全绿（Rust 89 → 128，TS 1459 → 1461）
**结论**: 任务 5.1 的计划前提有误，已修正后按「忠实移植 `pinyin-pro`」实施；
任务 5.2 实施后**立即抓到 `text.rs` 里的一个真实 bug**（见 §四）。

计划原文：`2026-10-03-p6-rust-phonemize-implementation.md` §阶段 5（1305 行起），
同一份内容也在 spec 文件 1954 行起。

---

## 一、任务 5.1 的前提是错的

计划步骤 1 写的是「复制现有拼音表」，并说它「每个汉字映射到拼音数组（多音字有多个读音）」。
实测 `lib/models/phonemize/pinyin-table.json` **不是**这个形状：

```
$ python3 -c "import json;d=json.load(open('lib/models/phonemize/pinyin-table.json'));print(len(d));print(list(d.items())[:3])"
426
[('a', 'a0'), ('ai', 'ai̯0'), ('an', 'a0n')]
```

它是 **拼音音节 → IPA 模板**（426 条，`0` 是声调占位符），由 `scripts/gen-pinyin-table.py`
从 pypinyin + misaki 生成。**汉字 → 拼音**这一步来自 `pinyin-pro`，运行时是一份 npm 依赖，
不是数据文件。

所以计划里 `char_to_pinyin` / `text_to_pinyin` 的骨架（假定有一份汉字表）不能照抄。
Rust 侧真正需要的是 **`pinyin-pro` 自己的数据**。

## 二、决定：忠实移植 `pinyin-pro`，而不是「取第一个读音」

计划允许「第一版可以取第一个读音，复杂规则留给后续优化」。**没有采用**，因为实测偏离太大：

| 语料 | 汉字数 | 与 `pinyin-pro` 不同的字数 | 比例 |
|---|---|---|---|
| 112 条常用句子 | 421 | 63 | **15.0%** |

典型偏离（前者是「第一个读音」，后者是 `pinyin-pro` 的答案）：

```
行: xing2 → hang2（一行白鹭）    长: chang2 → zhang3（长大了）
乐: le4 → yue4（音乐）           重: zhong4 → chong2（重复）
的: de0 → di4（项目的进度）      了: liao3 → le0（春天来了）
一: yi1 → yi2/yi4（一个/第一）   不: bu4 → bu2（不是）
```

15% 的字符读错是**听得出来**的，而且阶段 6 的验收标准是「中文句子的 Rust 输出 = JS 输出」——
按第一个读音实现，那条验收从第一天起就不可能通过。所以这一阶段做的是移植。

### 算法（`crates/phonemize/src/backends/pinyin.rs`）

`pinyin-pro` 的 `core/pinyin/handle.mjs` 有三步，逐步照搬：

1. **短语匹配**。`DICT2`–`DICT5` + 数字规则表共 **4,186 条**模式，用 Aho-Corasick
   自动机匹配。Rust 侧不建自动机：模式一定是「以当前位置结尾的后缀」，所以从最长模式
   往下逐个查哈希表，得到的**集合与顺序**和失败链一致（顺序会影响同概率分词的选择）。
2. **最大概率分词**（`maxProbability`）。从后往前的 DP，状态是 `(decimal, probability)`——
   概率相乘会在长句上下溢成 0，所以每次乘完若 `< 1e-300` 就乘 `1e300` 并把次数记进
   `decimal`，比较时 `decimal` 优先。**平局给候选者**，这一条也照抄（它决定同概率时读哪套分词）。
3. **一/不/了/々 规则**（`getProcessFuncs`）：一在四声前读 `yí`；叠词之间（看一看）丢声调；
   了前面没有汉字时读 `liǎo`；々 读前一个字。这些**规则表**由生成脚本从 `pinyin-pro` 的
   `toneSandhiMap` / `toneSandhiIgnoreSuffix` 导出，Rust 里没有重写任何语言学常量。

### 数据（`scripts/gen-pinyin-pro-data.mjs`，带 `--check`）

| 文件 | 内容 | 大小（UTF-8 字节） |
|---|---|---|
| `pinyin-chars.txt` | `DICT1` 反查：21,134 个汉字，读音按优先级排序 | 212,075 |
| `pinyin-phrases.txt` | 4,186 条短语 + 概率档位（`d`=2e-8 / `r`=1e-12） | 109,676 |
| `pinyin-special.txt` | 一/不/了/々 规则表（25 行） | 429 |
| `pinyin-syllables.txt` | `pinyin-table.json` 的转写（426 条），避免引入 JSON 解析依赖 | 4,890 |
| `pinyin-NOTICE.txt` | pinyin-pro 与 misaki 的 MIT 许可 | 2,176 |

合计 329 KB（下面 §五 会说明：这 329 KB 里目前**只有 4 KB 真的进了 wasm**）。

**声调在生成时就换算好**：`pinyin-pro` 存的是符号声调（`nǐ`），输出时用
`getPinyinWithoutTone` + `getNumOfTone` 两个正则转成数字（`ni3`）。两者都是纯函数，
所以生成脚本用 `pinyin-pro` 自己的函数算好写进文件，Rust 侧不需要知道 `ǎ` 是三声。

**两个刻意的取舍**：

- **姓氏表没进数据**。默认 `surname: 'off'` 时 `acTree.match` 会把 priority 为 `Surname`
  的模式全部过滤掉，那些模式**永远不会被选中**——10 KB 不可达数据。
- **不引入 `serde_json` / `lazy_static`**（计划步骤 2 要求）。音节表转写成文本格式，
  全局表用 `std::sync::OnceLock`（英文 backend 已经在用）。阶段 5 **零新增运行时依赖**。

### 一个上游数据缺陷

`DICT4` 把「枝大于本」拼成了 `"zh dà yú běn"`（应为 `zhī`），于是「枝」的读音是 `zh`。
JS 侧 `syllableToIpa('zh')` 做 `slice(0,-1)` 得到 `z`，查表失败抛错；Rust 侧**报同一个 `z`**
（`split_tone_marker` 与 `split_reading` 是两条不同的规则，见下）。两侧行为一致，已写成测试。

> 这里有一个容易写错的地方，实际写错过一次：读数的「有没有声调」用
> `getNumOfTone` 的规则（末尾是数字才算声调），而 `syllableToIpa` 用的是
> `Number(slice(-1))` + `slice(0,-1)`（末尾**无条件**当声调符）。对 `ni3` 两者一致；
> 对 `zh`、`hng` 这类没有声调的读数就不一致，且决定报错里写哪个音节。
> 两个函数都保留，各自的 doc comment 说明为什么不能合并。

## 三、对照结果

| 语料 | 规模 | pinyin 不一致 | IPA 不一致 |
|---|---|---|---|
| 固定语料 `tests/fixtures/zh-parity.json` | 45 条 | 0 | 0 |
| 真实 Han run（从仓库中文文档抽取） | 3,000 条 / 19,344 字 | 0 | 0 |
| 随机串（1–16 字，7,223 字池，含多音字与特殊字） | 4,000 条 | 0 | 0 |

后两项是一次性验证（临时生成语料 → 跑 Rust 对照 → 恢复固定语料），**没有**提交；
提交的是 45 条固定语料，两侧互相钉住：

- `tests/unit/models/phonemize/zh-parity.test.ts` 检查 JS 侧仍产出 `js` / `jsPinyin`；
- `crates/phonemize/tests/zh_parity.rs` 检查 Rust 侧产出 `rust ?? js` 与同一个 `jsPinyin`。

固定语料**同时记录拼音与 IPA**，因为两者会独立出错：拼音不符是短语表/分词/特殊规则，
拼音相符而 IPA 不符是音节表/声调箭头/`ü` 拼写。只有一条 IPA 字符串的话，报错无法区分。

语料里**只有汉字**，没有标点/数字/拉丁字母——这些是**阶段 6**（前端组装）的事；
`han_to_ipa` 的间距是「一个音节一个空格」，也就是 JS 侧测试用的 `singleSyllableWords`，
**不是**生产间距（生产是 jieba 分词后词间一个空格，也要阶段 6）。

## 四、vocab 闸门，以及它抓到的第一个 bug

### 闸门本身

`crates/phonemize/src/vocab.rs`：两份 vocab（v1.0 = 115 字符、v1.1-zh = 172 字符）由
`scripts/gen-kokoro-vocab.mjs` 从 `tests/v0/kokoro-vocabs.json`（P4 实测的 `model.vocab`）生成。
`validate_phonemes(phonemes, vocab)` 在 `Phonemizer::phonemize_with` 里对**每一条**路径生效。

三个例外/例外处理，都有明确理由：

- **`\u{032F}` 与 `\u{0329}` 放行**：tokenizer 的 normalizer 会删掉这两个组合符，而两者
  都不在词表里（`xau̯`、`ʂɻ̩`）。不放行等于拒掉所有日语句子。spec §4.2.1 就是这么写的。
- **空白放行**：它是分隔符，不是音素。
- **`ɚ` 被修复而不是拒绝**：v1.1-zh 没有 `ɚ`，espeak 读 `never` 会产出 `nˈɛvɚ`。
  替换成 `əɹ`（两个字符都在词表里）。**只对 v1.1-zh 替换**——v1.0 有 `ɚ`，
  在那里替换等于改动模型训练时用的音素。替换发生在校验**之前**。

### 抓到的 bug：`text.rs` 的 `KOKORO_PUNCTUATION`

```
thread 'splits_a_contraction_because_the_segmenter_does' panicked:
  phonemizes: Vocab(VocabError { vocab: V1_0, characters: ['\''], phonemes: "dˈɑn'tˈiː stˈɑp" })
thread 'sentence_with_large_number' panicked:
  phonemizes: Vocab(VocabError { vocab: V1_0, characters: ['-'], phonemes: "ðə jˈɪɹ tˈuː θˈaʊzənd ənd twˈɛntiː-fˈɔːɹ" })
```

`text.rs` 的 `KOKORO_PUNCTUATION` 里写着 `-` 和 `'`，注释说「Measured against
`tokenizer.json` during P5 verification」。**词表里这两个字符都没有**，三份独立证据：

| 来源 | `-` | `'` |
|---|---|---|
| `tests/unit/models/kokoro-vocab.ts`（P4 抄的 `model.vocab`，115 项） | 无 | 无 |
| `tests/v0/kokoro-vocabs.json`（P4 实测） | 无 | 无 |
| `lib/models/phonemize/chinese.ts` 的 `KEPT_PUNCTUATION` 注释 | 明确写「not」 | 明确写「not」 |

后果：`phonemize("don't stop")` 直接抛错——一个再普通不过的英文输入。这不是「闸门太严」，
而是**闸门正确**：这两个字符会被 tokenizer 的 normalizer 静默删掉，而
`PhonemizeResult::phonemes` 的文档承诺是「Exactly what goes into the tokenizer,
guaranteed to contain only characters the target model's vocabulary keeps」。

**修法**：`KOKORO_PUNCTUATION` 改成实测集合（`$ ; : , . ! ? — … " ( ) “ ”` + 空格），
`tests/vocab.rs` 增加一条测试把这张表**钉在词表上**（每个能存活下来的标点都必须在两份
vocab 里，`-` 与 `'` 必须被丢弃），这样它不能再漂移。

**听感影响：无**。tokenizer 本来就会删掉这两个字符，模型听到的与改动前逐字节相同；
改的是 Rust 侧的输出字符串是否等于模型真正看到的东西。`en_g2p.rs` 的两条断言随之更新：

```
don't stop     : dˈɑn'tˈiː stˈɑp          → dˈɑntˈiː stˈɑp
The year 2024  : … ənd twˈɛntiː-fˈɔːɹ     → … ənd twˈɛntiːfˈɔːɹ
```

> 「`twenty-four` 的连字符读作词边界（空格）而不是丢弃」是一个**改变**模型听感的选项，
> 没有做——本阶段的问题是「输出是否等于 tokenizer 的输入」，不是英文韵律。

## 五、体积与测试

| | 变化 |
|---|---|
| wasm | 4,185,336 → **4,195,046 字节**（+9,710；gzip 1,044,885 → 1,048,365） |
| 扩展构建产物 | 55.35 MB **不变**（phonemize wasm 尚未进包，阶段 7 接线） |
| Rust 测试 | 89 → **128**（+17 pinyin、+4 zh_parity、+18 vocab） |
| TS 测试 | 1459 → **1461**（+2 zh-parity） |
| 新增运行时依赖 | **0** |
| 其他 | `cargo fmt` / `cargo clippy` / `biome` / `tsc` / `check:manifest` 全绿 |

### wasm 只涨了 9.7 KB，而数据文件有 329 KB —— 这不是测量错误

因为**中文拼音表目前是 wasm 里的死代码**：`ChinesePinyin` 只被原生测试调用，
`phonemize_with` 还没有 `zh` 分支（§六），所以 LTO + `wasm-opt` 把整个模块连同它的
329 KB 静态数据一起消除了。在二进制里数一下就知道：

```
$ python3 -c "d=open('lib/models/phonemize-wasm/phonemize_bg.wasm','rb').read();
  print(d.count(b'zhuang1'), d.count(b'xing2'))"
0 0
```

而 vocab 闸门是**活的**（`phonemize_with` 里无条件调用），它的数据在包里：

```
$ python3 -c "d=open('lib/models/phonemize-wasm/phonemize_bg.wasm','rb').read();
  print(d.count(b'vocabulary-mismatch'), d.count('ㄅ'.encode()))"
1 1
```

所以 +9,710 字节 ≈ 两份 vocab（4 KB）+ 闸门代码。**那 329 KB 要等阶段 7 把中文
前端接进 `phonemize_with` 之后才会真的进包**——届时 wasm 预期涨到约 4.5 MB。

> 教训：内嵌数据表只有在**被入口可达**时才会进二进制。用体积变化当「东西加进去了」的
> 证据之前，先确认它可达；否则会得出「329 KB 数据只占 9.7 KB」这种不可能的结论。

`g2p_en.rs` 有 2 行**纯换行**的 rustfmt 重排（HEAD 上就没过 `cargo fmt --check`），
顺手带上；无逻辑改动。

## 六、阶段 6 还缺什么

阶段 5 只做到「汉字串 → 拼音 → IPA」。要让 `phonemize(text, {lang: 'zh'})` 真正跑通，
阶段 6 还要接：

1. **词边界**：jieba（JS 侧 `jieba-wasm`，`hmm: true`），把音节按词分组、词间一个空格。
   候选是 `lindera-cc-cedict`（6.92 MB，spec §1.4 记过）。
2. **数字**：`numbersToHan`（`lib/models/phonemize/numbers.ts`）。
3. **标点**：`mapPunctuation` + `keepPunctuation`（后者 Rust 已有，但集合刚被修正）。
4. **run 切分与拉丁段**：`splitRuns` + 英文 backend（后者已就绪）。
5. **v1.1-zh 前端**（注音 + 数字声调 + `/` + `R`）：JS 侧**也还没有**，属于 P5 阶段 2。

`lib.rs` 里 `zh` 仍然返回 `pipeline-not-implemented`，这是**故意的**：
半接的前端对混排文本会产出错音，比明确报错更糟。

## 七、文件清单

```
scripts/gen-pinyin-pro-data.mjs        新：pinyin-pro 数据导出（--check）
scripts/gen-kokoro-vocab.mjs           新：两份 vocab 导出（--check）
crates/phonemize/data/pinyin-*.txt     新：4 份生成数据
crates/phonemize/data/pinyin-NOTICE.txt 新：MIT 许可
crates/phonemize/data/vocab-v1.txt     新：115 字符
crates/phonemize/data/vocab-v11-zh.txt 新：172 字符
crates/phonemize/src/backends/pinyin.rs 新：中文读音 + 音节表（+17 测试）
crates/phonemize/src/backends/mod.rs   改：导出 pinyin
crates/phonemize/src/vocab.rs          新：vocab 闸门（+18 测试）
crates/phonemize/src/lib.rs            改：闸门接进 phonemize_with
crates/phonemize/src/text.rs           改：修正 KOKORO_PUNCTUATION
crates/phonemize/tests/pinyin.rs       新：读音与 IPA 集成测试
crates/phonemize/tests/zh_parity.rs    新：中文对照语料（+4 测试）
crates/phonemize/tests/vocab.rs        新：闸门测试
crates/phonemize/tests/en_g2p.rs       改：两条断言随标点修正更新
crates/phonemize/tests/fixtures/zh-parity.json 新：45 条对照语料
tests/unit/models/phonemize/zh-parity.test.ts  新：语料生成与 JS 侧钉住
```

#p6 #zh #pinyin #vocab-gate #lesson
