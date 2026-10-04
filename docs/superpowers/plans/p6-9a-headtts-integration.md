# P6 阶段 9A：英文 OOV 的 NRL 7948 规则引擎

**日期**：2026-10-04
**前置**：`p6-phase4-corrections.md`（阶段 4 的英文 G2P 决定）、
`p6-9b2-implementation.md`（阶段 9B 的英文 TN）、`p6-piper-plus-g2p-reuse-analysis.md`
**来源**：HeadTTS `@met4citizen/headtts` 1.3.0 `modules/language-en-us.mjs`
（rev `c08f4ca8b3253b3e908e501486a1e068e606be5c`），MIT，© 2025 Mika Suominen；
规则本身改写自 NRL Report 7948（1976）。署名与改动清单见
`crates/phonemize/src/backends/headtts_en/{LICENSE,NOTICE}`。

**结论**：OOV（词典外词）从**字母拼读**换成了**规则读音**，质量提升是实测的、也是有限的。
`Kokoro` 从 `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ` 变成 `kɑkɔɹoʊ`，`TypeScript` 从十个字母
变成一个词。wasm **+17,385 B**（6,071,361 → 6,088,746），Rust 测试 **250 → 280**，
TS 1394 全绿、只改了 1 条期望值。

**但任务书有六处前提与实测不符**，先说这六条，因为它们决定了这个阶段的范围：

1. **规则不是 7948 条，是 309 条。** 「7948」是 NRL **报告的编号**，不是规则条数。
   任务书另一处写「712 行规则」——**712 是整个 `language-en-us.mjs` 文件的行数**
   （`wc -l` 实测；`rules` 对象字面量本身只有 168 行）。实测
   `Object.values(lang.rules).flat().length === 309`。体积因此从「可能几百 KB」
   变成 **+17 KB**。
2. **许可证这件事本来就不成立。** 「piper-plus-g2p 是 GPL」是阶段 9 早期的误判，
   `Cargo.toml` 里那段长注释记的是同一件事的另一半——它的许可证与 HeadTTS 相同。
   本阶段因此**没有**「为了许可证替换」，只有「为了 OOV 质量加一层」。
3. **piper 不能删，也删不掉。** 任务书要求「删除 piper-plus-g2p / 删除 `g2p_en.rs`」。
   但 piper 提供的是 **CMU Dict + ARPAbet→IPA**，也就是词典命中那一路——`hello`/`world`/
   `Python`/`JavaScript` 这些词的读音全部来自它，而规则只在词典没有该词时才发生。
   HeadTTS 的规则
   表**没有**能给 CMU Dict 的替代品（它自己的 125,829 词词典是同一件事的第二份答案）。
   删掉 piper 等于把英文退回「每个字都按规则读」，那是**倒退**。所以本阶段是
   「词典 → 规则 → 字母」三层，piper 留在第一层。
4. **任务书点名的「OOV 例子」大多不是 OOV。** `tough` `through` `thorough` `thought`
   `bought` `though` `cough` `slough` `Shakespeare` `Einstein` `Manhattan` 全都在 CMU Dict
   里，从来不走 OOV 路径（实测见 §四）。真正走规则的是**混合大小写的专名与产品名**：
   `Kokoro` `OpenAI` `GitHub` `ChatGPT` `TypeScript` `PyTorch` `YouTube` `iPhone`
   `localhost` `kubectl` `nginx` `DevOps` `OAuth` …
5. **`xyz` / `http` / `json` 这类缩写不该「不再字母拼读」。** 任务书把它列为验收项，
   但实测规则给的是 `xyz` → `sɪz`、`http` → `ttp`、`sql` → `skl`——**比字母拼读差**。
   全大写的那几个（`HTTP`/`JSON`/`SQL`/`XYZ`）本来就先被管线的大小写规则拦下去拼字母，
   不受影响；小写的必须显式挡住，见 §五。
6. **「44 条测试期望值会变」不成立。** `tests/en_g2p.rs` 实际有 7 条，
   `tests/wetext_en.rs` 7 条，它们句子里的每个词都在 CMU Dict 里——**逐条实测，一条都没变**。
   全仓库真正变了的期望值只有 **2 条**（Rust 1 条、TS 1 条，都是同一条 `Kokoroを使う`），
   外加 1 条测试改名。本阶段因此没有「更新 44 条期望值」，而是**新增**了 OOV 的用例。

---

## 一、放在管线哪里

```text
normalize → WeText TN → 分段 → ┌ Latin ─→ CMU Dict ─命中─→ IPA
                              │            └─未命中─→ NRL 7948 规则 ─→ IPA
                              │                        └─无元音字母─→ 字母拼读
                              └ Other ─→ keep_punctuation
```

三层，顺序是**词典 → 规则 → 字母**。第三层是阶段 4 的行为原样保留，作为「什么都没读出来」
的兜底：本阶段不允许把任何原本会发声的词变成静音。

新模块：

| 文件 | 内容 | 行数 |
|---|---|---|
| `backends/headtts_en/mod.rs` | 公开 API：`phonemize`（IPA）、`phonemize_native`（HeadTTS 记法）、`to_ipa`、`normalize`、`trace` | 78 |
| `backends/headtts_en/engine.rs` | 循环（`Language#phonemizeWord` 的移植）、正则缓存、记法转换 | 415 |
| `backends/headtts_en/rules.rs` | **生成物**：309 条规则，`&'static [Rule]` | 415 |
| `backends/headtts_en/{LICENSE,NOTICE}` | MIT 全文 + 取了什么/没取什么/改了 4 处 | — |
| `backends/g2p_en.rs` | 接线：三层顺序 + `has_vowel_letter` 闸门 | 改 |
| `tests/headtts_en.rs` | 14 条（含 296 词逐字符对照、309 条规则逐字段对照、覆盖度） | 378 |
| `tests/fixtures/headtts-en-parity.json` | 对照语料，58 KB | 新 |
| `scripts/headtts-parity.mjs` | 从 upstream 检出 dump 语料（开发工具，CI 不跑） | 新 |
| `scripts/gen-headtts-rules.mjs` | 把语料转写成 `rules.rs`，带 `--check` | 新 |

## 二、规则数据：从 upstream 到 Rust

**没有手抄 JavaScript。** 链条是：

1. `scripts/headtts-parity.mjs` `import` upstream 的 `Language` 类，取它**自己构造函数算出来的**
   三个字段——`rule.regex.source`（`new RegExp(exp)` 展开后的正则）、`rule.move`
   （模式长度）、`rule.phonemes`（ARPAbet→IPA→misaki 之后的音素串）——连同 provenance
   （包版本、模块 SHA-256、git rev）写进 `tests/fixtures/headtts-en-parity.json`。

   这一步绕开了整个「`#` 是一个元音串、`%` 是 ER|E|ES|ED|ING|ELY、`^` 是一个辅音」的
   算子表：**那层展开由 upstream 自己做**，所以移植**不可能**在「某个算子是什么意思」上
   和 HeadTTS 分歧，只可能在「正则怎么匹配」上分歧——而那正是 `tests/headtts_en.rs`
   逐字段对照的 309 条 × 3 字段。

2. `scripts/gen-headtts-rules.mjs` 把语料转写成 `rules.rs`。纯转写：`--check` 模式验证
   提交的文件与重新生成的一致，CI 里跑（`pnpm check:headtts`）。

一次性的覆盖度挑选：语料候选是 HeadTTS 词典的 125,829 个词 + `/usr/share/dict/words`，
按「这个词触发了几条还没被触发的规则」降序贪心挑选，得到 **296 个词覆盖 309 条中的 305 条**。
剩下 4 条**不可能触发**（被同组更靠前的规则遮蔽，已在 `rules.rs` 头部写明：
`E#12 [EVEN]` 输给 `[E]^%=IY`，`E#20 #:[EMENT]` 输给同一条，`I#10 [IE]` 输给 `[I]%=IY`，
`O#10 [O]^EN` 输给 `[O]^%=OW`），测试断言「未被覆盖的**恰好**是这四条」——
少一条是语料变窄，多一条是规则被改。

## 三、引擎：循环怎么照抄，正则缓存在哪里

`phonemizeWord` 的循环逐字移植。两个细节是承重的：

- **只有当前位置的字符被转成小写。** upstream 的构造函数把每条规则模式的**首字母**
  小写（`ctxLetters[0].toLowerCase()`），于是「整串里唯一的小写字符」就是**锚点**：
  模式只能对齐到那儿。照抄这一点，就把一个**无锚点**的 `RegExp#match`（搜整串、返回最左命中）
  变成了「这条规则在这个位置成立吗」——而不是反过来去给正则加锚（那是另一个问题）。
- **`advance` 是模式长度，不是 1。** `[TH]` 吃掉两个字符，`[TION]` 四个。这也是为什么
  `kubectl` 的 `e` 不会被读两遍。

`normalize` 是 upstream 的 `normalizeUpper`：大写、保留标点（`-`/`'` 会被**原样回声**，
所以 `well-known` → `wɛl-nOn`）、`ß`→`SS`、`Æ`→`AE`，其余丢弃（数字在 upstream 也是丢弃）。
**唯一没移植的是变音符分支**（`É` 在这里是丢弃，upstream 是剥掉符再留 `E`）：管线里的
Latin run 是 `segment_text` 的 `[A-Za-z]+`，不可能有重音字母，而移植它要把一张 Unicode
分解表带进 wasm。已在 `NOTICE` 与函数文档里写明，不装作一样。

### 正则缓存：一个把自己坑了 30 倍的设计

规则是 309 条，每条一个正则。**不**在 `prepare` 里全编译（那是给一个可能永不出现的
英文 OOV 词付毫秒级的钱），而是第一次用到某条规则时编译、然后留下。

第一版实现是 `HashMap<&'static str, Regex>` + 每次命中 `regex.clone()` 交出去。**这是错的，
而且错得很隐蔽**：`regex::Regex` 的 `Clone` 克隆编译好的程序、**不克隆它内部的 lazy DFA 缓存**，
于是每次 `is_match` 都从冷缓存重建 DFA。同一 pattern、同一 13 字节 haystack，实测：

| | 每次 `is_match` |
|---|---|
| 同一个 handle 反复用 | **34–62 ns** |
| 每次 clone 一个新 handle | **3,549 ns** |

一个词平均要试 **92 条规则**（实测 41–170 条），所以 clone 版本是
**184 µs/词**，改成交出 `&'static Regex`（首次编译 `Box::leak`，上限 309 条）之后是
**6.2 µs/词**——**30 倍**。这个数字是本阶段唯一一处「实现写得不好而不是设计取舍」的地方，
所以写在 `compiled()` 的文档里而不是只写在本文里。首个 OOV 词要付一次正则编译，
实测 **813 µs**（一次性、发生在 phonemize worker 上，不在 `prepare`）。

性能小结（host、release；wasm 未单独测）：

| | 每次调用 |
|---|---|
| 词典命中的词 | **0.65 µs** |
| OOV 词（词典未命中 + 规则 + 转换） | **6.2 µs** |
| 其中规则引擎本身 | 6.3 µs |
| 首个 OOV 词（含正则编译） | 813 µs |

## 四、质量对比：具体例子

「之前」= 字母拼读（阶段 4 的兜底）；「之后」= 规则。全部是 `EnglishG2p::phonemize` 的
实测输出：

| 词 | 之前 | 之后 | 判断 |
|---|---|---|---|
| `Kokoro` | `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ` | `kɑkɔɹoʊ` | **大幅改善** |
| `OpenAI` | `ˈoʊ pˈiː ˈiː ˈɛn ə aɪ` | `oʊpɛneɪ` | **改善**（open-A） |
| `TypeScript` | `tˈiː wˈaɪ pˈiː ˈiː ˈɛs sˈiː ˈɑːɹ aɪ pˈiː tˈiː` | `tɪpɛskɹɪpt` | **大幅改善** |
| `PyTorch` | `pˈiː wˈaɪ tˈiː ˈoʊ ˈɑːɹ sˈiː ˈeɪtʃ` | `paɪtɔɹtʃ` | **大幅改善** |
| `YouTube` | `wˈaɪ ˈoʊ jˈuː tˈiː jˈuː bˈiː ˈiː` | `jutub` | **大幅改善** |
| `iPhone` | `aɪ pˈiː ˈeɪtʃ ˈoʊ ˈɛn ˈiː` | `ɪfoʊn` | **大幅改善** |
| `localhost` | `ˈɛl ˈoʊ sˈiː ə ˈɛl ˈeɪtʃ ˈoʊ ˈɛs tˈiː` | `lˈoʊkɔlhoʊst` | **大幅改善** |
| `kubectl` | `kˈeɪ jˈuː bˈiː ˈiː sˈiː tˈiː ˈɛl` | `kjubɛktl` | **大幅改善** |
| `nginx` | `ˈɛn dʒˈiː aɪ ˈɛn ˈɛks` | `ŋɡɪnks` | **改善**（engine-x） |
| `yaml` | `wˈaɪ ə ˈɛm ˈɛl` | `jæml` | **改善** |
| `DevOps` | `dˈiː ˈiː vˈiː ˈoʊ pˈiː ˈɛs` | `dˈɪvɑps` | **改善** |
| `GitHub` | `dʒˈiː aɪ tˈiː ˈeɪtʃ jˈuː bˈiː` | `ɡɪθəb` | 改善，但 θ 是错的（应 /t/） |
| `OAuth` | `ˈoʊ ə jˈuː tˈiː ˈeɪtʃ` | `oʊəθ` | 改善，但仍然不对 |
| `ChatGPT` | `sˈiː ˈeɪtʃ ə tˈiː dʒˈiː pˈiː tˈiː` | `tʃætɡpt` | **两半都错**：`tʃæt` 对了，`ɡpt` 无元音 |
| `xyz` | `ˈɛks wˈaɪ zˈiː` | 规则给 `sɪz`，**被闸门挡住，仍是字母** | 规则更差 |
| `http` | `ˈeɪtʃ tˈiː tˈiː pˈiː` | 规则给 `ttp`，**被闸门挡住，仍是字母** | 规则更差 |
| `sql` | `ˈɛs kjˈuː ˈɛl` | 规则给 `skl`，**被闸门挡住，仍是字母** | 规则更差 |
| `json` | `dʒˈeɪ ˈɛs ˈoʊ ˈɛn` | `dʒsən` | 有 `o`，过闸门；勉强（j-son） |
| `laugh` | （词典有，不走规则） | 规则给 `lɔ`（**错**，应 /læf/） | 规则错，但词典永远先赢 |

### 任务书点名的「OOV」其实都在词典里

实测 `EnglishG2p::phonemize`（走的是词典）：

| 词 | 词典输出 | 词 | 词典输出 |
|---|---|---|---|
| `tough` | `tˈʌf` | `thought` | `θˈɔːt` |
| `through` | `θɹuː` | `bought` | `bˈɑt` |
| `thorough` | `θˈɜːoʊ` | `though` | `ðˈoʊ` |
| `Shakespeare` | `ʃˈeɪkspˌiːɹ` | `cough` | `kˈɑf` |
| `Einstein` | `ˈaɪnstaɪn` | `slough` | `slˈʌf` |
| `Manhattan` | `mænhˈætən` | `JavaScript` | `dʒˈɑvəskɹˌɪpt` |

规则**自己**给这些词什么（`tests/headtts_en.rs` 钉着）：
`tough`→`təf`、`through`→`θɹu`、`thorough`→`θɜɹoʊ`、`thought`→`θɔt`、`bought`→`bɔt`、
`though`→`ðoʊ`、`cough`→`kəf`、`slough`→`sləf`、`Shakespeare`→`ʃækɛspiɹ`、
`Einstein`→`instin`、`Manhattan`→`mænhættæn`。
**`-ough` 家族规则读得基本都对**（`laugh` 是例外），这确实是规则引擎的价值——
但在本仓库的管线里它几乎用不上，因为那些词都在词典里。规则真正救的是
**词典没有的专名**，也就是 §四第一张表。

### 规则引擎已知读错的词（钉着，不修）

`tests/headtts_en.rs::readings_that_are_wrong_and_are_kept_anyway`：
`laugh`→`lɔ`、`psychology`→`psɪtʃɑlɑdʒi`（`p` 发声）、`window`→`waɪndoʊ`、
`orange`→`ɔɹeɪndʒ`。这是一张 1976 年的规则表，不是词典；把它当词典用会失望。
本阶段的选择是**把错的钉成已知成本**，而不是继续加启发式。

## 五、大小写规则与元音闸门

**全大写 → 拼字母，规则永远看不到它。** 这是阶段 4 的 `is_initialism`（`/^[A-Z]+$/`），
本阶段没动。`HTTP`/`JSON`/`SQL`/`XYZ` 因此仍然拼字母——这正是任务书第 5 条要求反了的地方。

**小写的 `http`/`xyz`/`sql` 必须显式挡。** 它们不是词，是小写写法的缩写，而规则是**拼写
预言机**：给了不是词的一串字母它照样答。答案是 `ttp`（无元音）、`skl`、`sɪz`（一个音节
答三个字母）。闸门 `has_vowel_letter`：**run 里没有 `A`/`E`/`I`/`O`/`U` 就不试规则，
直接拼字母。**

两个判断值得记下来：

- **闸门问的是输入，不是输出。** 「读音里有没有音节」能挡住 `ttp` 和 `skl`，**挡不住 `sɪz`**
  ——它有元音，而它错的原因不是缺少元音。三者的共同点在引擎上游：都没有那五个字母。
  这个判据也更便宜（在试任何规则之前就问完）。
- **`Y` 不算元音字母。** 算的话 `xyz` 会被当词读成 `sɪz`；不算的话 `y` 单独成音节的
  OOV 词（`rhythm`/`myth`/`sylph`/`lynch`）会被拼字母——而它们都在 CMU Dict 里。
  实测 `/usr/share/dict/words` 235,974 个词里 **171 个（0.0725%）** 没有 AEIOU，
  逐条看**全是 `y`**（`by`/`cry`/`crypt`/`cyst`/`dry`…）。两个失败方向里，选错一个词
  的代价小于读错一族缩写。

## 六、期望值到底变了哪几条

| 位置 | 变化 | 原因 |
|---|---|---|
| `crates/phonemize/tests/ja_pipeline.rs` | `warns_about_a_latin_run_the_dictionary_does_not_have` → `reads_a_latin_run_the_dictionary_does_not_have_by_rule`，期望 `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊoɕiu` → `kɑkɔɹoʊoɕiu` | 唯一的真变化 |
| `tests/unit/models/phonemize-rust.test.ts` | 同一条句子的 wasm 边界版本，同步改名改值 | 同一件事的跨边界断言 |
| `crates/phonemize/tests/en_g2p.rs` | **7 条期望值一条没变**，新增 5 条 OOV 用例 | 原句子里每个词都在词典里 |
| `crates/phonemize/tests/wetext_en.rs` | **7 条，一条没变** | TN 的输出仍是词典词 |

改动之前先确认「改之前会失败」：`ja_pipeline.rs` 那条在换引擎后立刻红了
（`kˈeɪ ˈoʊ …` vs `kɑkɔɹoʊoɕiu`），TS 那条同理。

**告警通道现在几乎不可达。** `phonemize_en` 的 warning 是「一个 run 什么都没产出」。
三层兜底之后，一个 ASCII 字母 run 要什么都不产出，需要词典没有、规则没有、且每个字母
都不在词典里——26 个字母全在。所以英文告警是**结构上不可达**的，代码保留（对空 run 与
非字母 run 仍是对的），`ja_pipeline.rs` 那条测试把「无告警」从「碰巧」变成「结构」。

## 七、清理：删掉 2.79 MB 的死资产

`public/dictionaries/headtts-en-us.txt`（**2,792,055 B**）与
`scripts/setup-headtts-dict.sh` 删除。

它们来自阶段 9 早期那次半途而废的 JS 侧尝试（`docs/headtts-completion-report.md`），
阶段 8 删掉 JS 链之后就**没有任何代码读它**。`public/` 里的东西无论有没有人 import
都会被 bundler 复制，所以它是一个 2.79 MB 的**死重量**——比本阶段新加的规则数据大 160 倍。
构建测试的注释里本来就有关于它的警告（「落在 `public/` 的资产会移动这个数字，加的人负责移」），
本阶段按那句话执行。

本阶段同时把 HeadTTS **自己的词典**排除在外：`rules.rs` 只是规则表，英文的词典仍然只有
CMU Dict 一份。加第二份词典是同一问题的第二个答案。

| | 之前 | 之后 | 差 |
|---|---|---|---|
| wasm | 6,071,361 | 6,088,746 | **+17,385 B** |
| `headtts-en-us.txt` | 2,792,055 | 0 | **−2,792,055 B** |
| 扩展产物合计 | 44,408,543（44.41 MB） | 41,615,858（41.62 MB） | **−2,792,685 B** |

`tests/build/build-output.test.ts` 的规模窗口从 43–46 MB 移到 **40–46 MB**（下限压在
41.62 MB 下方一个中文词表的位置，它的用途是抓住「某个词典没被复制进产物」）。

## 八、没做的、以及不确定的

**HeadTTS 有、本阶段没移植的**：

1. **数字/日期/年代/序数/时间的读法**（`partSetText`、`convertNumberToWords`、
   `convertDecade`、`convertOrdinal`、`months`/`days`）。本仓库用 WeText FST 做这件事
   （阶段 9B），且排在词典与规则之前。**没有重复实现。**
2. **`charactersToPhonemes`** 表（`!` → `ˌɛkskləmˈAʃənpˌYnt` 这一类）。那是
   `type: "characters"` 部件的路径，本管线的 `other` run 走 `keep_punctuation`。
3. **HeadTTS 自己的词典与它的「前缀剥离」查询**（`phonemizeWord` 里 `s.length >= 5` 时
   试 `s[0..len-1]`、`s[0..len-2]`）。piper 的形态学兜底（`-ing`/`-ed`/`-s`/`-er`/`-ly`/`-est`）
   在同一位置、更严，所以没有叠加。
4. **`misakiToOculusViseme`**——HeadTTS 是给口型同步用的，本仓库不需要。

**不确定 / 值得复核的**：

1. **`to_ipa` 的七个别名是刻意的偏离。** 规则原样输出 misaki 记法（`A`/`I`/`W`/`Y`/`O`/
   `ʧ`/`ʤ`），本模块转成 IPA（`eɪ`/`aɪ`/`aʊ`/`ɔɪ`/`oʊ`/`tʃ`/`dʒ`），理由是**同一句话里
   词典词与规则词不能混用两套记法**，而且两种记法都在 v1.0 词汇表里、都合法。这是个判断，
   不是事实：如果模型对 misaki 记法的训练更充分，这个转换就是错的。没有听感 A/B。
2. **`ɜɹ` 没动。** 规则把 `ER` 读成 `ɚ`（misaki 写 `ɜ ɹ`），而词典那侧把重读 `ER1` 写成
   `ɜː`（`world` → `wˈɜːld`）。合并需要一个已经把重音决定完的规则引擎，而两个符号模型
   都见过。记录为已知分歧。
3. **`ChatGPT` 是唯一「两半都错」的高频词**：`tʃætɡpt`。规则没有能力把混合大小写的词
   切回「词 + 缩写」，本阶段也没有加。全大写的 `CHATGPT` 反而更好（拼字母）。
4. **没有做 `y` 之外的元音字母判断**（`w` 在某些拼写里成音节，规则表不产出这种）。
5. **wasm 里的性能没测**（host release 测了）。首个 OOV 词 813 µs 是 host 数字；
   在 wasm 里正则编译会慢一些，但同样只付一次。

## 九、验证

```text
cargo test --workspace                 250 → 280 passed
cargo clippy --workspace --all-targets 0 warning
cargo fmt --all                        clean
pnpm test                              1394 passed（1 条期望值更新）
pnpm test:build                        13 passed（wasm 6,088,746 B 钉住）
pnpm typecheck / pnpm lint / pnpm check:manifest   通过
pnpm check:headtts                     通过
```

`tests/headtts_en.rs` 的 296 词对照是**逐字符**对照：期望值全部来自 upstream 的
`Language#phonemizeWord`，不是本仓库的复述；309 条规则对照是**逐字段**对照
（regex / advance / phonemes 三项 + 分组可达性）。两条一起，保证的是
「Rust 的读法与 HeadTTS 的读法在 296 个词上完全一致」，而不是「看起来合理」。
