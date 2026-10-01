/**
 * The Chinese copy.
 *
 * Typed as `Record<MessageKey, string>` on purpose: a key added to the English
 * catalogue turns into a `pnpm typecheck` failure here, which is the only way a
 * missing translation can be caught before it reaches a user. Every message
 * keeps the placeholders its English original has — a test checks that, since
 * the type only guarantees the key exists.
 *
 * Typography follows the repo's Chinese convention: a space between Chinese and
 * Latin or digits, full-width punctuation for Chinese prose, and half-width
 * punctuation kept inside the technical strings it was copied from. Voice names
 * and provider product names are not translated.
 */
import type { MessageKey } from './messages.en';

export const zh: Record<MessageKey, string> = {
  // --- the side panel shell -------------------------------------------------
  'panel.sections': 'SayLoud 分区',
  'panel.tab.reading': '朗读',
  'panel.tab.settings': '设置',
  'panel.tab-models': '模型',
  'panel.loading': '加载中…',
  // The <h1> of the full-page voice picker, next to its back arrow.
  'panel.back': '返回',

  // --- the Reading tab ------------------------------------------------------
  'panel.section.session': '朗读会话',
  'panel.default-voice': '默认音色',
  'panel.configure': '配置服务',
  'panel.voice.change': '更换',
  'panel.no-provider': '尚未配置任何服务。打开「设置」选择一项。',
  'panel.browser-voice': '尚未配置云端服务，当前使用浏览器语音朗读。',
  'panel.sentence-progress': '第 {index} / {total} 句，语速 {rate}×',
  'panel.progress-label': '已朗读全文的 {percent}%',
  'panel.progress-text': '已朗读全文的 {percent}%。',
  'panel.nothing-reading': '当前没有正在朗读的内容。在网页上点击 SayLoud 工具栏图标即可开始。',
  'panel.highlight.words': '逐词高亮',
  'panel.highlight.sentences': '逐句高亮',
  'panel.highlight.unknown': '未知',
  'panel.model-missing': '模型尚未下载',
  'panel.model-missing.action': '前往模型设置 ›',
  'panel.local-slow': '这台机器没有 GPU 加速，本地语音会比较慢。云端服务或浏览器语音会更快。',

  // --- the settings rows ----------------------------------------------------
  'settings.volume.label': '音量',
  'settings.volume.browser-cap': '浏览器语音最高 100%。',
  'settings.rate.label': '语速',
  'settings.caption.label': '悬浮窗字幕',
  'settings.caption.help': '在这里打开，然后在网页竖条上点字幕按钮。',
  'settings.caption.unsupported': '当前浏览器不支持悬浮窗字幕。',
  'settings.language.label': '界面语言',
  'settings.language.auto': '跟随浏览器',
  'settings.language.en': 'English',
  'settings.language.zh': '中文',

  // --- the cache card -------------------------------------------------------
  'settings.cache.title': '缓存',
  'settings.cache.persist': '保存合成音频',
  'settings.cache.persist-help': '关闭会清除已保存的音频，之后也不再写入。',
  'settings.cache.max': '上限',
  'settings.cache.used': '已用 {size} · {count} 段',
  'settings.cache.note': '仅统计合成音频；端侧模型单独存放。',
  'settings.cache.unavailable': '无法读取缓存占用。',
  'settings.cache.clear': '清除缓存',
  'settings.cache.clear-confirm': '确认清除',
  'settings.cache.cancel': '取消',
  'settings.cache.cleared': '缓存已清除。',

  // --- the about line -------------------------------------------------------
  'settings.about.line': 'SayLoud {version} · MIT · 音频仅发送至你配置的服务商。',
  'settings.about.plain': 'SayLoud · MIT · 音频仅发送至你配置的服务商。',

  // --- the provider list and its form ---------------------------------------
  'provider.section.title': '语音服务',
  'provider.list.label': 'SayLoud 使用的语音服务',
  'provider.list.hint': '点击服务前的圆圈，即可切换 SayLoud 使用的语音服务。',
  'provider.use': '使用 {service}',
  'provider.active': '使用中',
  'provider.configured': '已配置 · {voice}',
  'provider.console-link': '打开 {name} 控制台',
  'provider.browser-notice':
    '选中浏览器语音前的圆圈后，SayLoud 会用它朗读。为其他服务保存的密钥会保留。',
  'provider.test': '测试连接',
  'provider.testing': '测试中…',
  'provider.saving': '保存中…',
  'provider.delete': '删除已保存的密钥',
  'provider.test-succeeded': '连接成功。',
  'provider.saved': '已保存。',
  'provider.saved-not-active': '已保存，但尚未启用。点击名称前的圆圈即可切换。',
  'provider.deleted': '已移除保存的密钥。',
  'provider.not-saved': '未保存：{detail}',
  'provider.not-saved-invalid': '未保存：请修正标出的字段。',
  'provider.delete-failed': '移除失败：{detail}',
  'provider.access-declined': 'SayLoud 需要访问该主机的权限才能连接服务。请在弹窗中允许后继续。',
  'provider.access-needed': '尚未获得该主机的访问权限。',
  'provider.grant-access': '授权访问',
  'provider.timings-exact': '当前配置会上报词级时间戳，朗读时会逐词高亮。',
  'provider.timings-none': '当前配置不上报词级时间戳，SayLoud 会逐句高亮。',

  'provider.browser.label': '浏览器语音',
  'provider.browser.summary': '使用 Chrome 已安装的语音，无需配置。',
  'provider.local.label': '本地语音（浏览器内运行）',
  'provider.local.summary': '浏览器内运行，文字不出本机。首次使用需要下载模型。',
  'provider.local.notice': '模型、档位和运行设备在「模型」标签页里选择。',
  'provider.dashscope.label': '阿里云百炼',
  'provider.dashscope.summary':
    '阿里云百炼（Model Studio）。CosyVoice v3 及之后的模型会上报词级时间戳。',
  'provider.volcengine.label': '火山引擎豆包',
  'provider.volcengine.summary': '火山引擎豆包。seed-tts-1.0 资源会上报词级时间戳。',
  'provider.openai-compat.label': 'OpenAI 兼容',
  'provider.openai-compat.summary':
    '任何 /v1/audio/speech 端点，包括本地部署的 Kokoro-FastAPI 服务。',
  'provider.elevenlabs.label': 'ElevenLabs',
  'provider.elevenlabs.summary': '词级时间戳来自 with-timestamps 端点。',
  'provider.azure.label': 'Azure 语音',
  'provider.azure.summary': '通过 Speech SDK WebSocket 使用 Azure AI 语音。',

  // --- field labels ---------------------------------------------------------
  'field.api-key': 'API 密钥',
  'field.base-url': '基础 URL',
  'field.model': '模型',
  'field.model-id': '端侧模型',
  'field.tier': '模型档位',
  'field.device': '运行设备',
  'field.region': '区域',
  'field.workspace-id': '业务空间 ID',
  'field.resource-id': '资源 ID',
  'field.subscription-key': '订阅密钥',
  'field.output-format': '输出格式',
  'field.language-hint': '语言提示',
  'field.captioned-speech': '使用 /dev/captioned_speech',
  'field.extra-headers': '额外请求头',
  'field.default-option': '默认',

  // --- per-provider help and option copy ------------------------------------
  'provider.volcengine.api-key.help':
    '来自新版控制台，通过 X-Api-Key 请求头发送。不支持旧版控制台的 app id + access token 组合。',
  'provider.volcengine.resource-id.help': '资源 ID 同时决定模型版本和计费方式。',
  'provider.volcengine.resource-id.option.seed-tts-1.0': 'seed-tts-1.0（词级时间戳）',
  'provider.volcengine.resource-id.option.seed-tts-2.0': 'seed-tts-2.0（仅句级）',
  'provider.volcengine.base-url.help': '只填主机名，不含 /api/v3/…，例如走代理时使用。',
  'provider.dashscope.workspace-id.help': '仅当密钥限定在某个业务空间时需要填写，否则留空。',
  'provider.dashscope.region.help':
    'CosyVoice 和 Qwen-Audio-TTS 只在 cn-beijing 提供，新加坡区域提供 Qwen-TTS 系列模型。',
  'provider.dashscope.region.option.cn-beijing': '中国（cn-beijing）',
  'provider.dashscope.region.option.ap-southeast-1': '新加坡（ap-southeast-1）',
  'provider.dashscope.model.help':
    '词级时间戳需要 cosyvoice-v3 或更新的模型；适配器会自动发送 word_timestamp_enabled。',
  'provider.dashscope.base-url.help': '覆盖区域主机，例如走代理时使用。',
  'provider.openai-compat.api-key.help': '本地服务无需鉴权时留空。',
  'provider.openai-compat.captioned-speech.help':
    '仅 Kokoro-FastAPI 支持。会返回词级时间戳，标准端点不会。',
  'provider.openai-compat.extra-headers.help': '每行一个 Name: Value 对，用于自建网关。',
  'provider.azure.region.help': '语音资源的区域 slug，不是它的显示名称。',
  'provider.azure.output-format.option.mp3_24khz_48k': 'MP3 24 kHz 48 kbit/s（默认）',
  'provider.azure.output-format.option.mp3_16khz_32k': 'MP3 16 kHz 32 kbit/s',
  'provider.azure.output-format.option.wav_24khz_16bit': 'WAV 24 kHz 16-bit',
  'provider.azure.output-format.option.ogg_16khz_opus': 'OGG 16 kHz Opus',
  'provider.azure.language-hint.help': '当音色 ID 无法体现语言时，用它来列出音色。',
  'provider.local.device.auto': '自动',
  'provider.local.device.webgpu': 'WebGPU',
  'provider.local.device.wasm': 'WASM（CPU）',

  // --- the voice picker -----------------------------------------------------
  'voice.section': '音色',
  'voice.browser-note': '浏览器语音由 Chrome 提供，无需选择。',
  'voice.search': '搜索音色',
  'voice.loading': '加载中…',
  'voice.load-failed': '没能获取音色列表：{detail}',
  'voice.selected': '已选：',
  'voice.count-one': '{count} 个音色。',
  'voice.count-many': '{count} 个音色。',
  'voice.none-returned': '该服务未返回任何音色。请检查模型和基础 URL。',
  'voice.id-label': '音色 ID',
  'voice.id-placeholder': '服务支持的任何音色 ID',
  'voice.use-id': '使用此 ID',
  'voice.saved': '已保存音色：{voice}',
  'voice.save-failed': '保存音色失败：{detail}',
  'voice.filter-label': '筛选音色',
  'voice.filter-one': '按名称、ID 或语言筛选',
  'voice.filter-many': '按名称、ID 或语言筛选 {count} 个音色',
  'voice.no-match': '没有匹配「{query}」的音色。',
  'voice.badge-timings': '词级时间戳',

  // --- form validation ------------------------------------------------------
  'error.required': '{field}为必填项。',
  'error.invalid-url': '请输入完整 URL，例如 http://localhost:8880/v1。',
  'error.invalid-select': '请从列表中选择一项。',
  'error.invalid-header-line': '第 {line} 行：应为 "Name: Value" 格式。',
  'error.invalid-header-name': '第 {line} 行："{name}" 不是有效的请求头名称。',

  // --- provider failures ----------------------------------------------------
  'error.invalid-key': 'API 密钥被拒绝。请确认已完整复制。',
  'error.not-activated': '该密钥未被授予所选的模型或资源。请在服务商控制台开通，或改选其他模型。',
  'error.service-unavailable': '服务当前不可用，请稍后重试。',
  'error.voice-mismatch': '所选音色不属于当前资源 ID，两者必须匹配。请从该资源中选择音色。',
  'error.rate-limit': '该密钥正被限流，请稍后重试。',
  'error.no-quota': '该账号的这项服务额度已用尽。',
  'error.network-error': '请求无法连接到服务。请检查 URL 和网络连接。',
  'error.unknown': '服务拒绝了该请求。',
  'error.cancelled': '请求已取消。',
  'error.unexpected': '意外错误：{detail}。',
  'error.no-response': '{seconds} 秒内没有响应。',

  // --- on-device failures ---------------------------------------------------
  'error.model-missing': '该模型尚未下载。请到「模型」标签页下载。',
  'error.model-host-unreachable': '两个下载源都连不上。请在「模型」标签页手动选择一个源。',
  'error.model-download-failed': '下载未能完成，请重试。',
  'error.model-load-failed': '模型加载失败，文件可能不完整——请删除后重新下载。',
  'error.device-unavailable': '这台机器没有 WebGPU。请把设备设置改为 WASM。',

  // --- the bar on the page --------------------------------------------------
  'sideplayer.play': '播放',
  'sideplayer.pause': '暂停',
  'sideplayer.previous': '上一句',
  'sideplayer.next': '下一句',
  'sideplayer.rate': '播放速度 {rate}',
  'sideplayer.caption': '悬浮窗字幕',
  'sideplayer.settings': '设置',
  'sideplayer.progress': '朗读进度 {percent}%',
  'sideplayer.progress-remaining': '朗读进度 {percent}%，{remaining}',
  'sideplayer.hint.no-content.title': '没有可读内容',
  'sideplayer.hint.no-content.message': 'SayLoud 在这个页面上没有找到可读的正文。',
  'sideplayer.hint.no-voice.title': '没有可用的浏览器语音',
  'sideplayer.hint.no-voice.message': 'Chrome 没有安装适用于这个页面的语音。',
  'sideplayer.hint.tts-error.title': '语音失败',
  'sideplayer.hint.tts-error.message': 'Chrome 无法朗读这个页面。',
  'sideplayer.hint.orphaned.title': 'SayLoud 已重新加载',
  'sideplayer.hint.orphaned.message': '扩展在页面打开期间更新了，刷新本页即可继续朗读。',

  // --- the caption window ---------------------------------------------------
  'caption.counter': '第 {index} / {total} 句',

  // --- the bubble card ------------------------------------------------------
  'bubble.scrolled-away': '已经滚动到当前朗读句子之外了。',
  'bubble.back-to-position': '回到朗读位置',
  'bubble.remaining': '剩余 {time}',

  // --- on-device models -----------------------------------------------------
  'model.kokoro-82m': 'Kokoro 82M',
  'model.tier.light': '轻量',
  'model.tier.standard': '标准',
  'model.tier.hifi': '高保真',

  // --- the Models tab -------------------------------------------------------
  'model.source.title': '下载源',
  'model.source.label': '下载源',
  'model.source.help': '自动会选一个连得上的镜像，并记住它。',
  'model.source.auto': '自动（推荐）',
  'model.source.huggingface': 'Hugging Face',
  'model.source.modelscope': 'ModelScope',
  'model.source.custom': '自定义镜像',
  'model.source.custom-label': '镜像 URL',
  'model.source.custom-invalid': '请输入完整的 https:// URL。',
  'model.source.saved': '下载源已保存。',
  'model.source.save-failed': '保存下载源失败：{detail}',

  'model.in-use': '使用中',
  'model.set-active': '设为使用',
  'model.download': '下载',
  'model.cancel': '取消',
  'model.delete': '删除',
  'model.delete-confirm': '确认删除',
  'model.delete-warning': '删除后需要重新下载才能朗读。',
  'model.downloading': '正在下载 {tier} · {percent}%',
  'model.download-failed': '下载失败，请检查网络连接。',
  'model.download-cancelled': '下载已取消。',
  'model.read-failed': '无法读取已下载的模型。',
  'model.recommended': '推荐用于 WebGPU',
  'model.recommended-cpu': '推荐用于无 GPU 的设备',
  'model.license': '许可：{name}',
  'model.voice-count': '{count} 个音色',
  'model.timings': '仅句级高亮',

  'model.storage.title': '设备与存储',
  'model.storage.label': '占用空间',
  'model.storage.note': '仅统计模型与音色；音频缓存在「设置」标签页里统计。',
  'model.voices.note': '音色按需下载：第一次用到某个音色时才下载。',
  'model.device.not-loaded': '未加载',
  'model.device.wasm': 'WASM（无 GPU）',
  'model.device.webgpu': 'WebGPU',
  'model.device.webgpu-named': 'WebGPU · {adapter}',
  'model.device.help': '下次加载模型时使用。',
};
