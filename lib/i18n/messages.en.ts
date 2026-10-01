/**
 * The English copy, and the source of truth for every message key.
 *
 * Keys are `<area>.<control>[.<state>]`, all lower case and dot-separated. The
 * area is where the words appear — `sideplayer` is the bar on the page,
 * `panel` the side panel's shell and Reading tab, `provider` the service
 * list and its form, `field` a label shared by several providers, `voice` the
 * voice picker, `error` anything a user is told went wrong, `settings` a
 * preference row (the language, the cache, the volume — the Reading tab and
 * the Settings tab both carry some). Translations live in `messages.zh.ts`,
 * which is typed against this table so a new key fails `pnpm typecheck` until
 * it is translated too.
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
  'panel.tab-models': 'Models',
  'panel.loading': 'Loading…',
  // The <h1> of the full-page voice picker, next to its back arrow.
  'panel.back': 'Back',

  // --- the Reading tab ------------------------------------------------------
  'panel.no-provider': 'No provider is configured. Open Settings to choose one.',
  // Choosing the browser voice is an action, so it gets its own words: the line
  // above would read as if the choice had not taken effect.
  'panel.browser-voice':
    'No cloud service is configured. SayLoud is reading with the browser voice.',
  'panel.configure': 'Configure a service',
  'panel.voice.change': 'Change',
  'panel.default-voice': 'Default voice',
  'panel.voice.none': 'No voice selected',
  'panel.voice.none-meta': 'Reading in the browser voice for now',
  'panel.section.session': 'Reading session',
  'panel.sentence-progress': 'Sentence {index} of {total} at {rate}×',
  'panel.progress-label': '{percent} percent of the article read',
  'panel.progress-text': '{percent}% of the article read.',
  'panel.nothing-reading':
    'Nothing is being read. Click the SayLoud toolbar icon on a page to start.',
  'panel.highlight.words': 'Word by word',
  'panel.highlight.sentences': 'Sentence by sentence',
  'panel.highlight.unknown': 'Unknown',
  // Shown when the on-device model has not been downloaded, which is the one
  // configuration where pressing play cannot work at all. It leads the tab and
  // takes the reader straight to the download rather than explaining it twice.
  'panel.model-missing': 'Model not downloaded yet',
  'panel.model-missing.action': 'Go to model settings ›',
  // Measured: ≈1.1–1.45× real time without a GPU against ≈0.15 with one. Says
  // what will happen rather than promising a number the machine may not hit.
  'panel.local-slow':
    'This device has no GPU acceleration, so local voices will be slower. A cloud service or the browser voice will be quicker.',

  // --- the settings rows ----------------------------------------------------
  // Volume, rate and the caption switch are preferences like the language, so
  // they share the `settings` area even though they live on the Reading tab.
  'settings.volume.label': 'Volume',
  // Only the browser voice has a ceiling; a cloud voice plays through a gain
  // node and can be pushed past 100%.
  'settings.volume.browser-cap': 'The browser voice tops out at 100%.',
  'settings.rate.label': 'Speed',
  'settings.caption.label': 'Caption window',
  'settings.caption.help': 'Turn it on here, then open it from the bar on the page.',
  'settings.caption.unsupported': 'This browser cannot show a caption window.',
  'settings.language.label': 'Interface language',
  'settings.language.auto': 'Follow the browser',
  'settings.language.en': 'English',
  'settings.language.zh': '中文',

  // --- the cache card -------------------------------------------------------
  'settings.cache.title': 'Cache',
  'settings.cache.persist': 'Keep synthesized audio',
  'settings.cache.persist-help':
    'Off deletes the saved audio and stops new audio from being written.',
  'settings.cache.max': 'Limit',
  'settings.cache.used': 'Used {size} · {count} clips',
  // Says what is *not* counted as well as what is: on-device models are a
  // separate store, managed on the model tab, and clearing this one cannot
  // make room for them.
  'settings.cache.note': 'Audio only. On-device models are stored separately.',
  'settings.cache.unavailable': 'The cache could not be read.',
  'settings.cache.clear': 'Clear cache',
  'settings.cache.clear-confirm': 'Clear',
  'settings.cache.cancel': 'Cancel',
  'settings.cache.cleared': 'Cache cleared.',

  // --- the about line -------------------------------------------------------
  'settings.about.line': 'SayLoud {version} · MIT · Audio goes only to the service you configure.',
  // For the tests, which have no manifest to read a version from.
  'settings.about.plain': 'SayLoud · MIT · Audio goes only to the service you configure.',

  // --- the provider list and its form ---------------------------------------
  'provider.section.title': 'Voice services',
  // The list is a single choice, and the circle is how it is made; the row's own
  // button only opens a form. Both are said out loud here because a dot nobody
  // understands is a dot nobody presses.
  'provider.list.label': 'Which service SayLoud reads with',
  'provider.list.hint': 'The circle beside a service picks which one SayLoud reads with.',
  'provider.use': 'Use {service}',
  'provider.active': 'Active',
  'provider.configured': 'Configured · {voice}',
  'provider.console-link': 'Open the {name} console',
  'provider.browser-notice':
    'SayLoud reads with the browser voice while its circle is selected. Keys saved for other providers are kept.',
  'provider.test': 'Test Connection',
  'provider.testing': 'Testing…',
  'provider.saving': 'Saving…',
  'provider.delete': 'Delete saved key',
  'provider.test-succeeded': 'Connection succeeded.',
  'provider.saved': 'Saved.',
  // Saving does not switch providers, and saying only "Saved." would leave the
  // user waiting for something to happen.
  'provider.saved-not-active':
    'Saved, but not in use. Use the circle beside the name to switch to it.',
  'provider.deleted': 'Saved key removed.',
  // Saving happens when a field loses focus, and a form that fails validation
  // writes nothing at all. The line has to say so, or a half-typed key looks
  // stored; the fields themselves carry the reason.
  'provider.not-saved': 'Not saved: {detail}',
  'provider.not-saved-invalid': 'Not saved: fix the highlighted fields.',
  'provider.delete-failed': 'Could not remove: {detail}',
  'provider.access-declined':
    'SayLoud needs access to this host to reach the service. Allow it in the prompt to continue.',
  'provider.access-needed': 'Access to this host is not granted yet.',
  'provider.grant-access': 'Grant access',
  'provider.timings-exact':
    'This configuration reports word timings, so words highlight as they are spoken.',
  'provider.timings-none':
    'This configuration reports no word timings, so SayLoud highlights whole sentences.',

  // Provider names. The order of `PROVIDER_SCHEMAS` is the picker's order.
  'provider.browser.label': 'Browser voice',
  'provider.browser.summary': 'Uses the voices Chrome already has installed. Nothing to configure.',
  'provider.local.label': 'On this device',
  'provider.local.summary':
    'Runs in the browser, so the text never leaves your machine. Needs a one-time model download.',
  // The form for this provider has no fields on purpose: what it configures is
  // a download, and the Models tab is where download state can be shown.
  'provider.local.notice':
    'The model, its tier and the device it runs on are chosen in the Models tab.',
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
  'field.model-id': 'On-device model',
  'field.tier': 'Model tier',
  'field.device': 'Device',
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
  'provider.local.device.auto': 'Automatic',
  'provider.local.device.webgpu': 'WebGPU',
  'provider.local.device.wasm': 'WASM (CPU)',

  // --- the voice picker -----------------------------------------------------
  'voice.section': 'Voice',
  'voice.browser-note':
    'The browser voice is the one Chrome has installed. There is nothing to choose here.',
  'voice.search': 'Search voices',
  'voice.loading': 'Loading…',
  'voice.load-failed': 'Could not fetch the voice list: {detail}',
  'voice.selected': 'Selected:',
  // Two keys rather than a plural rule: English inflects, Chinese does not, and
  // the count is always known at the call site.
  'voice.count-one': '{count} voice.',
  'voice.count-many': '{count} voices.',
  'voice.none-returned': 'This provider returned no voices. Check the model, and the base URL.',
  'voice.id-label': 'Voice id',
  'voice.id-placeholder': 'Any voice id the service accepts',
  'voice.use-id': 'Use this id',
  'voice.saved': 'Voice saved: {voice}',
  'voice.save-failed': 'Could not save the voice: {detail}',
  'voice.filter-label': 'Filter voices',
  // Two keys for the same reason the counts above have two: English inflects and
  // Chinese does not, and the count is known here.
  'voice.filter-one': 'Filter the voice by name, id or language',
  'voice.filter-many': 'Filter {count} voices by name, id or language',
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

  // --- on-device failures ---------------------------------------------------
  // The local provider's own codes. They read differently from the cloud ones
  // on purpose: the fix is never a key or a quota, it is a download or a
  // setting, and every one of them points at something the user can do here.
  'error.model-missing': 'This model has not been downloaded yet. Download it in the Models tab.',
  'error.model-host-unreachable':
    'Neither download source could be reached. Pick one manually in the Models tab.',
  'error.model-download-failed': 'The download did not finish. Try again.',
  'error.model-load-failed':
    'The model could not be loaded. It may be incomplete — delete and download it again.',
  'error.device-unavailable': 'This machine has no WebGPU. Switch the device setting to WASM.',

  // --- the bar on the page --------------------------------------------------
  'sideplayer.play': 'Play',
  'sideplayer.pause': 'Pause',
  'sideplayer.previous': 'Previous sentence',
  'sideplayer.next': 'Next sentence',
  'sideplayer.rate': 'Playback speed {rate}',
  'sideplayer.caption': 'Caption window',
  'sideplayer.settings': 'Settings',
  'sideplayer.progress': 'Reading progress {percent} percent',
  'sideplayer.progress-remaining': 'Reading progress {percent} percent, {remaining}',
  'sideplayer.hint.no-content.title': 'Nothing to read',
  'sideplayer.hint.no-content.message': 'SayLoud found no readable text on this page.',
  'sideplayer.hint.no-voice.title': 'No browser voice',
  'sideplayer.hint.no-voice.message': 'Chrome has no voice installed for this page.',
  'sideplayer.hint.tts-error.title': 'Voice failed',
  'sideplayer.hint.tts-error.message': 'Chrome could not speak this page.',
  'sideplayer.hint.orphaned.title': 'SayLoud was reloaded',
  'sideplayer.hint.orphaned.message':
    'Refresh this page to keep reading — the extension was updated underneath it.',

  // --- the caption window ---------------------------------------------------
  'caption.counter': 'Sentence {index} of {total}',

  // --- the bubble card ------------------------------------------------------
  'bubble.scrolled-away': 'You scrolled away from the sentence being read.',
  'bubble.back-to-position': 'Back to position',
  'bubble.remaining': '{time} left',

  // --- on-device models -----------------------------------------------------
  // Only the names the registry itself carries: the model and its tiers. The
  // rest of the model tab's copy is added with the tab.
  'model.kokoro-82m': 'Kokoro 82M',
  'model.tier.light': 'Light',
  'model.tier.standard': 'Standard',
  'model.tier.hifi': 'High fidelity',

  // --- the Models tab -------------------------------------------------------
  // The tab manages files rather than preferences, so every line here is about
  // state — what is downloaded, where from, and what it costs in space.
  'model.source.title': 'Download source',
  'model.source.label': 'Download source',
  'model.source.help': 'Auto will pick a reachable mirror and remember it.',
  'model.source.auto': 'Auto (recommended)',
  'model.source.huggingface': 'Hugging Face',
  'model.source.modelscope': 'ModelScope',
  'model.source.custom': 'Custom mirror',
  'model.source.custom-label': 'Mirror URL',
  'model.source.custom-invalid': 'Enter a complete https:// URL.',
  'model.source.saved': 'Source saved.',
  'model.source.save-failed': 'Could not save the source: {detail}',

  'model.in-use': 'In use',
  'model.set-active': 'Set as active',
  'model.download': 'Download',
  'model.cancel': 'Cancel',
  'model.delete': 'Delete',
  'model.delete-confirm': 'Delete anyway',
  'model.delete-warning': "After deleting, you'll need to download again to read aloud.",
  'model.downloading': 'Downloading {tier} · {percent}%',
  'model.download-failed': 'Failed to download. Check your connection.',
  'model.download-cancelled': 'Download cancelled.',
  'model.read-failed': 'The downloaded models could not be read.',
  // Two keys rather than one "Recommended": what is recommended depends on the
  // machine, and a badge that does not say which machine is a badge that means
  // nothing when the user reads it on the other one.
  'model.recommended': 'Recommended for WebGPU',
  'model.recommended-cpu': 'Recommended without a GPU',
  'model.requires-missing': 'This GPU cannot run it — the audio would be distorted',
  'model.license': 'Licence: {name}',
  'model.voice-count': '{count} voices',
  'model.timings': 'Sentence highlighting',

  'model.storage.title': 'Device and space',
  'model.storage.label': 'Storage used',
  // Says what is *not* counted, for the same reason the audio cache's note does
  // (spec §4.5): the two numbers are separate on purpose.
  'model.storage.note': 'Models and voices. The audio cache is counted on the Settings tab.',
  // Voices are fetched one at a time, when a voice is first used; there is no
  // "download them all" control yet, and a line saying so beats a dead button.
  'model.voices.note': 'Voices are downloaded on demand, the first time each one is used.',
  'model.device.not-loaded': 'Not loaded',
  'model.device.wasm': 'WASM (no GPU)',
  'model.device.webgpu': 'WebGPU',
  'model.device.webgpu-named': 'WebGPU · {adapter}',
  // What the line means, so "WebGPU" before anything has been loaded does not
  // read as a claim that a model is already running there.
  'model.device.help': 'Used the next time the model loads.',
  'model.device.resolved': 'Will run on',
  'model.device.option-auto': 'Choose automatically (recommended)',
  'model.device.option-webgpu': 'WebGPU — this machine’s graphics',
  'model.device.option-wasm': 'CPU — slower, always works',
} as const;

/** Every message the UI can ask for. */
export type MessageKey = keyof typeof en;
