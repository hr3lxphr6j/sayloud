// Test kuroshiro in offscreen context (not worker)
// Add this temporarily to entrypoints/offscreen/offscreen.ts

import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

async function testKuroshiro() {
  console.log('[TEST] Starting kuroshiro test in offscreen document...');
  
  try {
    const kuroshiro = new Kuroshiro();
    console.log('[TEST] Kuroshiro instance created');
    
    await kuroshiro.init(new KuromojiAnalyzer({
      dictPath: '/kuromoji-dict/',
    }));
    console.log('[TEST] Kuroshiro initialized successfully');
    
    const result = await kuroshiro.convert('日本語', {
      to: 'katakana',
      mode: 'normal',
    });
    console.log('[TEST] Conversion result:', result);
  } catch (error) {
    console.error('[TEST] Kuroshiro test failed:', error);
    if (error instanceof Error) {
      console.error('[TEST] Stack:', error.stack);
    }
  }
}

// Run test after a delay to ensure everything is loaded
setTimeout(() => {
  testKuroshiro();
}, 2000);
