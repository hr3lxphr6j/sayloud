#!/usr/bin/env node
/**
 * 测试 kana2ipa
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const kana2ipaModule = require('kana2ipa');

console.log('=== 测试 kana2ipa ===\n');

// 测试日语文本
const tests = [
  'こんにちは',
  'ありがとう',
  'コンピュータ',
  'せかい',
];

for (const text of tests) {
  console.log(`文本: ${text}`);
  const ipa = kana2ipaModule.kana2ipa(text);
  console.log(`IPA:  ${ipa}`);
  console.log('');
}

// 测试纯假名
console.log('\n=== 纯假名测试 ===');
const kanaTests = [
  'こんにちは',       // ko-n-ni-chi-ha
  'せかい',           // se-ka-i
  'ありがとう',       // a-ri-ga-to-u
  'コンピュータ',     // ko-n-pyu-ta (片假名)
  'にほん',           // ni-ho-n
  'とうきょう',       // to-u-kyo-u
];

for (const text of kanaTests) {
  console.log(`${text} → ${kana2ipaModule.kana2ipa(text)}`);
}

console.log('\n=== 混合测试（汉字会保持原样）===');
const mixedTests = [
  '東京',
  '日本',
  '他に、F値が大きい',
];

for (const text of mixedTests) {
  console.log(`${text} → ${kana2ipaModule.kana2ipa(text)}`);
}

console.log('\n=== 注意 ===');
console.log('kana2ipa 只转换假名，汉字会保持原样。');
console.log('如果要支持汉字，需要先将汉字转换为假名（使用 kuroshiro 等库）。');
