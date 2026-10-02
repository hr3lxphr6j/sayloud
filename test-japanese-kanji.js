/**
 * Test script to verify Japanese Kanji → Kana → IPA conversion.
 * 
 * Run with: node test-japanese-kanji.js
 */

import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

// Handle default exports
const KuroshiroClass = Kuroshiro.default || Kuroshiro;
const KuromojiAnalyzerClass = KuromojiAnalyzer.default || KuromojiAnalyzer;

// Test cases with expected readings
const testCases = [
  { text: '日本語', expected: 'ニホンゴ' },
  { text: '東京', expected: 'トウキョウ' },
  { text: 'こんにちは', expected: 'コンニチハ' },
  { text: '日本', expected: 'ニホン' },
  { text: '私', expected: 'ワタシ' },
  { text: '学校', expected: 'ガッコウ' },
  { text: '先生', expected: 'センセイ' },
  { text: '友達', expected: 'トモダチ' },
];

async function test() {
  console.log('Initializing kuroshiro...');
  const kuroshiro = new KuroshiroClass();
  
  await kuroshiro.init(
    new KuromojiAnalyzerClass({
      dictPath: './public/kuromoji-dict/',
    })
  );
  
  console.log('✓ Kuroshiro initialized\n');

  console.log('Testing Kanji → Katakana conversion:\n');
  
  for (const { text, expected } of testCases) {
    const katakana = await kuroshiro.convert(text, {
      to: 'katakana',
      mode: 'normal',
    });
    
    const match = katakana === expected ? '✓' : '✗';
    console.log(`${match} "${text}" → "${katakana}" (expected: "${expected}")`);
  }
}

test().catch(console.error);
