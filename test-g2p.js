#!/usr/bin/env node
/**
 * 测试 @piper-plus/g2p 对日语和中文的支持
 */

async function testG2P() {
  console.log('=== 测试 @piper-plus/g2p ===\n');
  
  try {
    const { G2P } = await import('@piper-plus/g2p');
    
    // 初始化 G2P（支持日语和中文）
    console.log('初始化 G2P...');
    const g2p = await G2P.create({ languages: ['ja', 'zh'] });
    console.log('✅ 初始化完成\n');
    
    // 测试日语
    console.log('1. 日语测试\n');
    const jaTexts = [
      'こんにちは、世界',
      '東京は日本の首都です。',
      '他に、F値が大きいことも、副鏡を小さくすることを可能とし、熱放射の影響を軽減する効果がある。',
    ];
    
    for (const text of jaTexts) {
      console.log(`文本: ${text}`);
      const tokens = g2p.phonemize(text, { language: 'ja' });
      console.log(`音素数组: [${tokens.slice(0, 20).join(', ')}...]`);
      console.log(`音素字符串: ${tokens.join('')}`);
      console.log(`Token 数: ${tokens.length}\n`);
    }
    
    // 测试中文
    console.log('\n2. 中文测试\n');
    const zhTexts = [
      '你好，世界',
      '这是一个测试句子。',
      '今天天气很好。',
    ];
    
    for (const text of zhTexts) {
      console.log(`文本: ${text}`);
      const tokens = g2p.phonemize(text, { language: 'zh' });
      console.log(`音素数组: [${tokens.slice(0, 20).join(', ')}...]`);
      console.log(`音素字符串: ${tokens.join('')}`);
      console.log(`Token 数: ${tokens.length}\n`);
    }
    
    // 测试日语的韵律信息
    console.log('\n3. 日语韵律信息测试\n');
    const { JapaneseG2P } = await import('@piper-plus/g2p/ja');
    const jaG2P = new JapaneseG2P();
    await jaG2P.initialize();
    
    const testText = '東京は日本の首都です。';
    console.log(`文本: ${testText}`);
    const result = jaG2P.phonemizeWithProsody(testText);
    console.log(`带韵律信息:`, JSON.stringify(result, null, 2).substring(0, 500));
    
  } catch (e) {
    console.error('错误:', e.message);
    console.error('Stack:', e.stack);
  }
}

testG2P();
