/**
 * The English copy, and the source of truth for every message key.
 *
 * Keys are `<area>.<control>[.<state>]`, all lower case and dot-separated. The
 * area is where the words appear — `sideplayer` is the bar on the page,
 * `panel` the side panel's shell and Reading tab, `provider` the service
 * picker and its form, `field` a label shared by several providers, `voice` the
 * voice picker, `error` anything a user is told went wrong, `settings` the
 * settings tab's own rows. Translations live in `messages.zh.ts`, which is
 * typed against this table so a new key fails `pnpm typecheck` until it is
 * translated too.
 *
 * `as const` rather than an interface: `MessageKey` is derived from these keys,
 * so a typo in a component is caught by the compiler instead of rendering the
 * key itself.
 */
export const en = {
  // --- the side panel shell -------------------------------------------------
  'panel.sections': 'SayLoud sections',
  'panel.tab.reading': 'Reading',
  'panel.tab.settings': 'Settings',
  'panel.loading': 'Loading…',

  // --- the Reading tab ------------------------------------------------------
  'panel.section.provider': 'Provider',
  'panel.section.session': 'Reading session',
  'panel.fact.service': 'Service',
  'panel.fact.voice': 'Voice',
  'panel.fact.highlight': 'Highlight',
  'panel.default-voice': 'Default voice',
  'panel.no-provider': 'No provider is configured. Open Settings to choose one.',
  'panel.sentence-progress': 'Sentence {index} of {total} at {rate}×',
  'panel.progress-label': '{percent} percent of the article read',
  'panel.progress-text': '{percent}% of the article read.',
  'panel.nothing-reading':
    'Nothing is being read. Click the SayLoud toolbar icon on a page to start.',
  'panel.reported-by':
    'Reported by the service worker. Playback itself is controlled from the player on the page.',
  'panel.highlight.browser': 'Sentence by sentence (browser voice)',
  'panel.highlight.words': 'Word by word',
  'panel.highlight.sentences': 'Sentence by sentence',
  'panel.highlight.unknown': 'Unknown',

  // --- the settings tab -----------------------------------------------------
  'settings.language.label': 'Interface language',
  'settings.language.auto': 'Follow the browser',
  'settings.language.en': 'English',
  'settings.language.zh': '中文',

  // --- the provider picker and its form -------------------------------------
  'provider.picker-label': 'Provider',
  'provider.console-link': 'Open the {name} console',
  'provider.browser-notice':
    'SayLoud will use the voices Chrome already has installed. Keys saved for other providers are kept.',
  'provider.test': 'Test Connection',
  'provider.testing': 'Testing…',
  'provider.save': 'Save',
  'provider.saving': 'Saving…',
  'provider.forget': 'Forget saved key',
  'provider.test-succeeded': 'Connection succeeded.',
  'provider.saved': 'Saved.',
  'provider.forgotten': 'Saved key removed.',
  'provider.save-failed': 'Could not save: {detail}',
  'provider.forget-failed': 'Could not remove: {detail}',
  'provider.access-declined':
    'SayLoud needs access to this host to reach the service. Allow it in the prompt to continue.',
  'provider.timings-exact':
    'This configuration reports word timings, so words highlight as they are spoken.',
  'provider.timings-none':
    'This configuration reports no word timings, so SayLoud highlights whole sentences.',

  // Provider names. The order of `PROVIDER_SCHEMAS` is the picker's order.
  'provider.browser.label': 'Browser voice',
  'provider.browser.summary': 'Uses the voices Chrome already has installed. Nothing to configure.',
  'provider.dashscope.label': 'DashScope (阿里云百炼)',
  'provider.dashscope.summary':
    'Alibaba Cloud Model Studio. CosyVoice v3 and later report word timings.',
  'provider.volcengine.label': '火山引擎豆包 TTS',
  'provider.volcengine.summary':
    'Volcano Engine Doubao. The seed-tts-1.0 resource reports word timings.',
  'provider.openai-compat.label': 'OpenAI-compatible',
  'provider.openai-compat.summary':
    'Any /v1/audio/speech endpoint, including a local Kokoro-FastAPI server.',
  'provider.elevenlabs.label': 'ElevenLabs',
  'provider.elevenlabs.summary': 'Word timings come from the with-timestamps endpoint.',
  'provider.azure.label': 'Azure Speech',
  'provider.azure.summary': 'Azure AI Speech over the Speech SDK WebSocket.',

  // --- field labels ---------------------------------------------------------
  // Shared by every provider that has the field: the same words in the same
  // widget should not be translated twice.
  'field.api-key': 'API key',
  'field.base-url': 'Base URL',
  'field.model': 'Model',
  'field.region': 'Region',
  'field.workspace-id': 'Workspace id',
  'field.resource-id': 'Resource id',
  'field.subscription-key': 'Subscription key',
  'field.output-format': 'Output format',
  'field.language-hint': 'Language hint',
  'field.captioned-speech': 'Use /dev/captioned_speech',
  'field.extra-headers': 'Extra headers',
  'field.default-option': 'Default',

  // --- per-provider help and option copy ------------------------------------
  // Provider-scoped because the same field means something different in each
  // service: the API key is a header on one and a query parameter on the next.
  'provider.volcengine.api-key.help':
    'From the new console, sent as the X-Api-Key header. The old console app id + access token pair is not supported.',
  'provider.volcengine.resource-id.help':
    'The resource id decides both the model version and the billing mode.',
  'provider.volcengine.resource-id.option.seed-tts-1.0': 'seed-tts-1.0 (word timings)',
  'provider.volcengine.resource-id.option.seed-tts-2.0': 'seed-tts-2.0 (sentence-level only)',
  'provider.volcengine.base-url.help':
    'Host only, without /api/v3/… — for example to go through a proxy.',
  'provider.dashscope.workspace-id.help':
    'Only for keys scoped to a business space. Leave empty otherwise.',
  'provider.dashscope.region.help':
    'CosyVoice and Qwen-Audio-TTS are only served from cn-beijing; the Singapore region serves the Qwen-TTS models.',
  'provider.dashscope.region.option.cn-beijing': 'China (cn-beijing)',
  'provider.dashscope.region.option.ap-southeast-1': 'Singapore (ap-southeast-1)',
  'provider.dashscope.model.help':
    'Word timings need a cosyvoice-v3 or later model; the adapter then sends word_timestamp_enabled automatically.',
  'provider.dashscope.base-url.help':
    'Override the region host, for example to go through a proxy.',
  'provider.openai-compat.api-key.help': 'Leave empty for a local server that needs no auth.',
  'provider.openai-compat.captioned-speech.help':
    'Kokoro-FastAPI only. Returns word timings; the standard endpoint does not.',
  'provider.openai-compat.extra-headers.help':
    'One Name: Value pair per line, for a self-hosted gateway.',
  'provider.azure.region.help': 'The region slug of the Speech resource, not its display name.',
  'provider.azure.output-format.option.mp3_24khz_48k': 'MP3 24 kHz 48 kbit/s (default)',
  'provider.azure.output-format.option.mp3_16khz_32k': 'MP3 16 kHz 32 kbit/s',
  'provider.azure.output-format.option.wav_24khz_16bit': 'WAV 24 kHz 16-bit',
  'provider.azure.output-format.option.ogg_16khz_opus': 'OGG 16 kHz Opus',
  'provider.azure.language-hint.help':
    'Used to list voices when the voice id does not imply a language.',

  // --- the voice picker -----------------------------------------------------
  'voice.section': 'Voice',
  'voice.load': 'Load Voices',
  'voice.loading': 'Loading…',
  'voice.selected': 'Selected:',
  // Two keys rather than a plural rule: English inflects, Chinese does not, and
  // the count is always known at the call site.
  'voice.count-one': '{count} voice.',
  'voice.count-many': '{count} voices.',
  'voice.none-returned': 'This provider returned no voices. Check the model, and the base URL.',
  'voice.fill-form-first': 'Fill in the required fields above first.',
  'voice.id-label': 'Voice id',
  'voice.id-placeholder': 'Any voice id the service accepts',
  'voice.use-id': 'Use this id',
  'voice.saved': 'Voice saved: {voice}',
  'voice.save-failed': 'Could not save the voice: {detail}',
  'voice.filter-label': 'Filter voices',
  'voice.filter-placeholder': 'Filter {count} voices by name, id or language',
  'voice.no-match': 'No voice matches “{query}”.',
  'voice.badge-timings': 'word timings',

  // --- form validation ------------------------------------------------------
  // Keyed by `FieldErrorCode`, so `error.${code}` is the only lookup the form
  // needs. Voice names and everything else the provider returns stay as-is.
  'error.required': '{field} is required.',
  'error.invalid-url': 'Enter a full URL, for example http://localhost:8880/v1.',
  'error.invalid-select': 'Choose one of the listed options.',
  'error.invalid-header-line': 'Line {line}: expected a "Name: Value" pair.',
  'error.invalid-header-name': 'Line {line}: "{name}" is not a valid header name.',

  // --- provider failures ----------------------------------------------------
  // Keyed by `ProviderErrorCode`: what the code means is the part the user can
  // act on, so it leads; the service's own message is appended as detail.
  'error.invalid-key': 'The API key was rejected. Check that it was copied in full.',
  'error.not-activated':
    'This key has not been granted the selected model or resource. Enable it in the provider console, or pick one that is.',
  'error.service-unavailable': 'The service is unavailable right now. Try again in a moment.',
  'error.voice-mismatch':
    'The chosen voice does not belong to the selected resource id. The two have to match — pick a voice from this resource.',
  'error.rate-limit': 'The service is rate limiting this key. Wait a moment and retry.',
  'error.no-quota': 'This account has no quota left for the service.',
  'error.network-error':
    'The request could not reach the service. Check the URL and your connection.',
  'error.unknown': 'The service rejected the request.',
  'error.cancelled': 'The request was cancelled.',
  'error.unexpected': 'Unexpected failure: {detail}.',
  'error.no-response': 'No response after {seconds}s.',

  // --- the bar on the page --------------------------------------------------
  'sideplayer.play': 'Play',
  'sideplayer.pause': 'Pause',
  'sideplayer.previous': 'Previous sentence',
  'sideplayer.next': 'Next sentence',
  'sideplayer.rate': 'Playback speed {rate}',
  'sideplayer.settings': 'Settings',
  'sideplayer.progress': 'Reading progress {percent} percent',
  'sideplayer.progress-remaining': 'Reading progress {percent} percent, {remaining}',
  'sideplayer.hint.no-content.title': 'Nothing to read',
  'sideplayer.hint.no-content.message': 'SayLoud found no readable text on this page.',
  'sideplayer.hint.no-voice.title': 'No browser voice',
  'sideplayer.hint.no-voice.message': 'Chrome has no voice installed for this page.',
  'sideplayer.hint.tts-error.title': 'Voice failed',
  'sideplayer.hint.tts-error.message': 'Chrome could not speak this page.',

  // --- the bubble card ------------------------------------------------------
  'bubble.scrolled-away': 'You scrolled away from the sentence being read.',
  'bubble.back-to-position': 'Back to position',
  'bubble.remaining': '{time} left',
} as const;

/** Every message the UI can ask for. */
export type MessageKey = keyof typeof en;
