#!/usr/bin/env node
/**
 * POC: 测试 kana2ipa + Kokoro 日语音色
 */

import { createRequire } from 'module';
import { KokoroTTS } from 'kokoro-js';

const require = createRequire(import.meta.url);
const kana2ipaModule = require('kana2ipa');

async function testJapaneseKokoro() {
  console.log('=== Kokoro 日语 POC ===\n');
  
  // 初始化 Kokoro
  console.log('加载 Kokoro 模型...');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'wasm',
  });
  console.log('✅ 模型加载完成\n');
  
  // 测试文本（纯假名）
  const testText = 'こんにちは、せかい';
  console.log(`测试文本: ${testText}`);
  
  // 转换为 IPA
  const ipa = kana2ipaModule.kana2ipa(testText);
  console.log(`生成 IPA: ${ipa}`);
  console.log(`IPA 长度: ${ipa.length} 字符\n`);
  
  // 尝试用 Kokoro 日语音色合成
  console.log('尝试合成...');
  try {
    // 使用 generate_from_ids 直接传入 IPA
    const encoded = tts.tokenizer(ipa, { truncation: false });
    console.log(`Tokenizer 输出维度: ${encoded.input_ids.dims}`);
    console.log(`Token 数量: ${encoded.input_ids.dims[1]}\n`);
    
    // 用日语音色合成
    const audio = await tts.generate_from_ids(encoded.input_ids, { voice: 'jf_alpha' });
    
    console.log('✅ 合成成功！');
    console.log(`音频长度: ${audio.audio.length} 采样点`);
    console.log(`采样率: 24000 Hz`);
    console.log(`时长: ${(audio.audio.length / 24000).toFixed(2)} 秒`);
    
    // 保存音频
    audio.save('test-japanese-kokoro.wav');
    console.log('\n音频已保存到: test-japanese-kokoro.wav');
    
  } catch (e) {
    console.error('❌ 合成失败:', e.message);
    console.error(e.stack);
  }
}

testJapaneseKokoro();
