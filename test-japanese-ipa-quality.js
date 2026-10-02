#!/usr/bin/env node
/**
 * 对比不同日语 G2P 方案的 IPA 输出质量
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const kana2ipaModule = require('kana2ipa');

console.log('=== 日语 IPA 质量测试 ===\n');

// 测试句子（纯假名）
const testSentences = [
  {
    kana: 'こんにちは、せかい',
    meaning: '你好，世界',
  },
  {
    kana: 'とうきょうはにほんのしゅとです',
    meaning: '东京是日本的首都',
  },
  {
    kana: 'ありがとうございます',
    meaning: '非常感谢',
  },
];

console.log('=== kana2ipa 输出 ===\n');
for (const { kana, meaning } of testSentences) {
  const ipa = kana2ipaModule.kana2ipa(kana);
  console.log(`假名: ${kana}`);
  console.log(`含义: ${meaning}`);
  console.log(`IPA:  ${ipa}`);
  console.log(`长度: ${ipa.length} 个字符\n`);
}

console.log('=== Kokoro 期望的 IPA 格式 ===');
console.log('Kokoro 接受的是标准 IPA 音素序列。');
console.log('kana2ipa 输出的 IPA 应该与 Kokoro 的训练数据兼容。');
console.log('\n如果需要验证，我们需要：');
console.log('1. 用 kana2ipa 生成 IPA');
console.log('2. 用 Kokoro 日语音色合成音频');
console.log('3. 听听效果是否正确');
