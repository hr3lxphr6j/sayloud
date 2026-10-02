// 测试日语音色的语言判断
const voices = [
  { id: 'jf_nezumi', lang: 'ja' },
  { id: 'jf_alpha', lang: 'ja' },
  { id: 'zf_xiaobei', lang: 'zh-CN' },
  { id: 'af_bella', lang: 'en-US' },
];

function isJapanese(lang) {
  return lang === 'ja' || lang.startsWith('ja-');
}

function isChinese(lang) {
  return lang === 'zh' || lang.startsWith('zh-');
}

for (const voice of voices) {
  console.log(`${voice.id} (${voice.lang}):`);
  console.log(`  isJapanese: ${isJapanese(voice.lang)}`);
  console.log(`  isChinese: ${isChinese(voice.lang)}`);
  console.log(`  should use generate_from_ids: ${isJapanese(voice.lang) || isChinese(voice.lang)}`);
  console.log();
}
