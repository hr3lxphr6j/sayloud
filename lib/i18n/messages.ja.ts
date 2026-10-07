/**
 * The Japanese copy.
 *
 * Typed as `Record<MessageKey, string>` on purpose: a key added to the English
 * catalogue turns into a `pnpm typecheck` failure here, which is the only way a
 * missing translation can be caught before it reaches a user. Every message
 * keeps the placeholders its English original has — a test checks that, since
 * the type only guarantees the key exists.
 *
 * Typography follows the repo's Japanese convention: no space between Japanese
 * and Latin or digits (unlike the Chinese catalogue, which needs one),
 * full-width punctuation for prose, and half-width punctuation kept inside the
 * technical strings it was copied from. Voice names and provider product names
 * are not translated.
 *
 * Register follows the usual split in Japanese interfaces: controls are
 * 体言止め (`再生`, `設定`, `速度`), while sentences, help text and anything that
 * reports a problem use です・ます.
 */
import type { MessageKey } from './messages.en';

export const ja: Record<MessageKey, string> = {
  // --- the side panel shell -------------------------------------------------
  'panel.sections': 'SayLoudセクション',
  'panel.tab.reading': '読み上げ',
  'panel.tab.settings': '設定',
  'panel.tab-models': 'モデル',
  'panel.loading': '読み込み中…',
  // The <h1> of the full-page voice picker, next to its back arrow.
  'panel.back': '戻る',

  // --- the Reading tab ------------------------------------------------------
  'panel.no-provider': 'プロバイダーが設定されていません。設定を開いて選択してください。',
  // Choosing the browser voice is an action, so it gets its own words: the line
  // above would read as if the choice had not taken effect.
  'panel.browser-voice':
    'クラウドサービスが設定されていません。SayLoudはブラウザの音声で読み上げています。',
  'panel.configure': 'サービスを設定',
  'panel.voice.change': '変更',
  'panel.default-voice': '既定の音声',
  'panel.voice.none': '音声未選択',
  'panel.voice.none-meta': '現在はブラウザの音声で読み上げ',
  'panel.section.session': '読み上げセッション',
  'panel.sentence-progress': '文 {index}/{total}、速度 {rate}×',
  'panel.progress-label': '記事の{percent}%を読み上げ',
  'panel.progress-text': '記事の{percent}%を読み上げました。',
  'panel.nothing-reading':
    '読み上げ中のコンテンツはありません。ページ上のSayLoudツールバーアイコンをクリックして開始してください。',
  'panel.highlight.words': '単語ごと',
  'panel.highlight.sentences': '文ごと',
  'panel.highlight.unknown': '不明',
  // Shown when the on-device model has not been downloaded, which is the one
  // configuration where pressing play cannot work at all. It leads the tab and
  // takes the reader straight to the download rather than explaining it twice.
  'panel.model-missing': 'モデル未ダウンロード',
  'panel.model-missing.action': 'モデル設定へ ›',
  // Measured: ≈1.1–1.45× real time without a GPU against ≈0.15 with one. Says
  // what will happen rather than promising a number the machine may not hit.
  'panel.local-slow':
    'このデバイスにはGPUアクセラレーションがないため、ローカル音声は遅くなります。クラウドサービスまたはブラウザの音声の方が速いです。',

  // --- the settings rows ----------------------------------------------------
  // Volume, rate and the caption switch are preferences like the language, so
  // they share the `settings` area even though they live on the Reading tab.
  'settings.volume.label': '音量',
  // Only the browser voice has a ceiling; a cloud voice plays through a gain
  // node and can be pushed past 100%.
  'settings.volume.browser-cap': 'ブラウザの音声は100%が上限です。',
  'settings.rate.label': '速度',
  'settings.caption.label': '字幕ウィンドウ',
  'settings.caption.help': 'ここでオンにしてから、ページのバーから開きます。',
  'settings.caption.unsupported': 'このブラウザでは字幕ウィンドウを表示できません。',
  'settings.language.label': '表示言語',
  'settings.language.auto': 'ブラウザに従う',
  'settings.language.en': 'English',
  'settings.language.zh': '中文',
  // Each option is written in its own language, so a reader who cannot read
  // the current one can still find theirs.
  'settings.language.ja': '日本語',

  // --- the cache card -------------------------------------------------------
  'settings.cache.title': 'キャッシュ',
  'settings.cache.persist': '合成音声を保持',
  'settings.cache.persist-help':
    'オフにすると保存済み音声を削除し、新しい音声も書き込まれなくなります。',
  'settings.cache.max': '上限',
  'settings.cache.used': '{size}使用中 · {count}クリップ',
  // Says what is *not* counted as well as what is: on-device models are a
  // separate store, managed on the model tab, and clearing this one cannot
  // make room for them.
  'settings.cache.note': '音声のみ。オンデバイスモデルは別に保存されています。',
  'settings.cache.unavailable': 'キャッシュを読み取れませんでした。',
  'settings.cache.clear': 'キャッシュをクリア',
  'settings.cache.clear-confirm': 'クリア',
  'settings.cache.cancel': 'キャンセル',
  'settings.cache.cleared': 'キャッシュをクリアしました。',

  // --- the about line -------------------------------------------------------
  'settings.about.line': 'SayLoud {version} · MIT · 音声は設定したサービスにのみ送信されます。',
  // For the tests, which have no manifest to read a version from.
  'settings.about.plain': 'SayLoud · MIT · 音声は設定したサービスにのみ送信されます。',

  // --- the provider list and its form ---------------------------------------
  'provider.section.title': '音声サービス',
  // The list is a single choice, and the circle is how it is made; the row's own
  // button only opens a form. Both are said out loud here because a dot nobody
  // understands is a dot nobody presses.
  'provider.list.label': 'SayLoudが読み上げに使うサービス',
  'provider.list.hint': 'サービス横の丸印をクリックすると、SayLoudが使うサービスが切り替わります。',
  'provider.use': '{service}を使用',
  'provider.active': '使用中',
  'provider.configured': '設定済み · {voice}',
  'provider.console-link': '{name}コンソールを開く',
  'provider.browser-notice':
    'ブラウザの音声の丸印が選択されている間、SayLoudはそれで読み上げます。他のプロバイダー用に保存されたキーは保持されます。',
  'provider.test': '接続テスト',
  'provider.testing': 'テスト中…',
  'provider.saving': '保存中…',
  'provider.delete': '保存済みキーを削除',
  'provider.test-succeeded': '接続に成功しました。',
  'provider.saved': '保存しました。',
  // Saving does not switch providers, and saying only "Saved." would leave the
  // user waiting for something to happen.
  'provider.saved-not-active':
    '保存しましたが、まだ使用されていません。名前横の丸印をクリックして切り替えてください。',
  'provider.deleted': '保存済みキーを削除しました。',
  // Saving happens when a field loses focus, and a form that fails validation
  // writes nothing at all. The line has to say so, or a half-typed key looks
  // stored; the fields themselves carry the reason.
  'provider.not-saved': '保存されませんでした：{detail}',
  'provider.not-saved-invalid':
    '保存されませんでした：ハイライトされたフィールドを修正してください。',
  'provider.delete-failed': '削除できませんでした：{detail}',
  'provider.access-declined':
    'SayLoudがサービスに接続するにはこのホストへのアクセスが必要です。プロンプトで許可してください。',
  'provider.access-needed': 'このホストへのアクセスがまだ許可されていません。',
  'provider.grant-access': 'アクセスを許可',
  'provider.timings-exact':
    'この設定は単語タイミングを報告するため、発話に合わせて単語がハイライトされます。',
  'provider.timings-none':
    'この設定は単語タイミングを報告しないため、SayLoudは文全体をハイライトします。',

  // Provider names. The order of `PROVIDER_SCHEMAS` is the picker's order.
  'provider.browser.label': 'ブラウザの音声',
  'provider.browser.summary': 'Chromeに既にインストールされている音声を使用します。設定不要です。',
  'provider.local.label': 'このデバイス',
  'provider.local.summary':
    'ブラウザ内で実行されるため、テキストはマシンの外に出ません。初回のモデルダウンロードが必要です。',
  // The form for this provider has no fields on purpose: what it configures is
  // a download, and the Models tab is where download state can be shown.
  'provider.local.notice': 'モデル、そのティア、実行デバイスはモデルタブで選択します。',
  'provider.dashscope.label': 'DashScope（阿里云百炼）',
  'provider.dashscope.summary':
    'Alibaba Cloud Model Studio。CosyVoice v3以降は単語タイミングを報告します。',
  'provider.volcengine.label': '火山引擎豆包TTS',
  'provider.volcengine.summary':
    'Volcano Engine Doubao。seed-tts-1.0リソースは単語タイミングを報告します。',
  'provider.openai-compat.label': 'OpenAI互換',
  'provider.openai-compat.summary':
    '任意の/v1/audio/speechエンドポイント（ローカルKokoro-FastAPIサーバーを含む）。',
  'provider.elevenlabs.label': 'ElevenLabs',
  'provider.elevenlabs.summary': '単語タイミングはwith-timestampsエンドポイントから取得します。',
  'provider.azure.label': 'Azure Speech',
  'provider.azure.summary': 'Speech SDK WebSocketを介したAzure AI Speech。',

  // --- field labels ---------------------------------------------------------
  // Shared by every provider that has the field: the same words in the same
  // widget should not be translated twice.
  'field.api-key': 'APIキー',
  'field.base-url': 'ベースURL',
  'field.model': 'モデル',
  'field.model-id': 'オンデバイスモデル',
  'field.tier': 'モデルティア',
  'field.device': 'デバイス',
  'field.region': 'リージョン',
  'field.workspace-id': 'ワークスペースID',
  'field.resource-id': 'リソースID',
  'field.subscription-key': 'サブスクリプションキー',
  'field.output-format': '出力フォーマット',
  'field.language-hint': '言語ヒント',
  'field.captioned-speech': '/dev/captioned_speechを使用',
  'field.extra-headers': '追加ヘッダー',
  'field.default-option': 'デフォルト',

  // --- per-provider help and option copy ------------------------------------
  // Provider-scoped because the same field means something different in each
  // service: the API key is a header on one and a query parameter on the next.
  'provider.volcengine.api-key.help':
    '新しいコンソールから取得し、X-Api-Keyヘッダーとして送信されます。旧コンソールのapp id + access tokenのペアはサポートされていません。',
  'provider.volcengine.resource-id.help':
    'リソースIDはモデルバージョンと課金モードの両方を決定します。',
  'provider.volcengine.resource-id.option.seed-tts-1.0': 'seed-tts-1.0（単語タイミング）',
  'provider.volcengine.resource-id.option.seed-tts-2.0': 'seed-tts-2.0（文レベルのみ）',
  'provider.volcengine.base-url.help':
    'ホスト名のみで/api/v3/…は含みません。例えばプロキシ経由で接続する場合に使用します。',
  'provider.dashscope.workspace-id.help':
    'キーがビジネススペースに限定されている場合のみ必要です。それ以外は空のままにしてください。',
  'provider.dashscope.region.help':
    'CosyVoiceとQwen-Audio-TTSはcn-beijingからのみ提供されます。シンガポールリージョンはQwen-TTSモデルを提供します。',
  'provider.dashscope.region.option.cn-beijing': '中国（cn-beijing）',
  'provider.dashscope.region.option.ap-southeast-1': 'シンガポール（ap-southeast-1）',
  'provider.dashscope.model.help':
    '単語タイミングにはcosyvoice-v3以降のモデルが必要です。アダプターは自動的にword_timestamp_enabledを送信します。',
  'provider.dashscope.base-url.help':
    'リージョンホストを上書きします。例えばプロキシ経由で接続する場合に使用します。',
  'provider.openai-compat.api-key.help':
    '認証不要のローカルサーバーの場合は空のままにしてください。',
  'provider.openai-compat.captioned-speech.help':
    'Kokoro-FastAPIのみ。単語タイミングを返します。標準エンドポイントは返しません。',
  'provider.openai-compat.extra-headers.help':
    '1行に1つのName: Valueペア。セルフホスト型ゲートウェイ用です。',
  'provider.azure.region.help': 'Speechリソースのリージョンスラッグであり、表示名ではありません。',
  'provider.azure.output-format.option.mp3_24khz_48k': 'MP3 24 kHz 48 kbit/s（デフォルト）',
  'provider.azure.output-format.option.mp3_16khz_32k': 'MP3 16 kHz 32 kbit/s',
  'provider.azure.output-format.option.wav_24khz_16bit': 'WAV 24 kHz 16-bit',
  'provider.azure.output-format.option.ogg_16khz_opus': 'OGG 16 kHz Opus',
  'provider.azure.language-hint.help':
    '音声IDが言語を示していない場合、音声をリストアップするために使用されます。',
  'provider.local.device.auto': '自動',
  'provider.local.device.webgpu': 'WebGPU',
  'provider.local.device.wasm': 'WASM（CPU）',

  // --- the voice picker -----------------------------------------------------
  'voice.section': '音声',
  'voice.browser-note':
    'ブラウザの音声はChromeがインストールしたものです。ここで選択するものはありません。',
  'voice.search': '音声を検索',
  'voice.loading': '読み込み中…',
  'voice.load-failed': '音声リストを取得できませんでした：{detail}',
  'voice.selected': '選択中：',
  // Two keys rather than a plural rule: English inflects, Chinese does not, and
  // the count is always known at the call site.
  'voice.count-one': '{count}個の音声。',
  'voice.count-many': '{count}個の音声。',
  'voice.none-returned':
    'このプロバイダーは音声を返しませんでした。モデルとベースURLを確認してください。',
  'voice.id-label': '音声ID',
  'voice.id-placeholder': 'サービスが受け付ける任意の音声ID',
  'voice.use-id': 'このIDを使用',
  'voice.saved': '音声を保存しました：{voice}',
  'voice.save-failed': '音声を保存できませんでした：{detail}',
  'voice.filter-label': '音声を絞り込み',
  // Two keys for the same reason the counts above have two: English inflects and
  // Chinese does not, and the count is known here.
  'voice.filter-one': '名前、ID、言語で音声を絞り込み',
  'voice.filter-many': '名前、ID、言語で{count}個の音声を絞り込み',
  'voice.no-match': '「{query}」に一致する音声はありません。',
  'voice.badge-timings': '単語タイミング',

  // --- form validation ------------------------------------------------------
  // Keyed by `FieldErrorCode`, so `error.${code}` is the only lookup the form
  // needs. Voice names and everything else the provider returns stay as-is.
  'error.required': '{field}は必須です。',
  'error.invalid-url': '完全なURLを入力してください。例：http://localhost:8880/v1。',
  'error.invalid-select': 'リストされているオプションから1つ選択してください。',
  'error.invalid-header-line': '{line}行目：「Name: Value」ペアが必要です。',
  'error.invalid-header-name': '{line}行目：「{name}」は有効なヘッダー名ではありません。',

  // --- provider failures ----------------------------------------------------
  // Keyed by `ProviderErrorCode`: what the code means is the part the user can
  // act on, so it leads; the service's own message is appended as detail.
  'error.invalid-key': 'APIキーが拒否されました。完全にコピーされているか確認してください。',
  'error.not-activated':
    'このキーには選択したモデルまたはリソースが付与されていません。プロバイダーコンソールで有効にするか、付与されているものを選択してください。',
  'error.service-unavailable': 'サービスは現在利用できません。しばらくしてから再試行してください。',
  'error.voice-mismatch':
    '選択した音声は選択したリソースIDに属していません。両者は一致している必要があります。このリソースから音声を選択してください。',
  'error.rate-limit': 'このキーはレート制限されています。しばらく待ってから再試行してください。',
  'error.no-quota': 'このアカウントはサービスのクォータを使い切っています。',
  'error.network-error':
    'リクエストがサービスに到達できませんでした。URLと接続を確認してください。',
  'error.unknown': 'サービスがリクエストを拒否しました。',
  'error.cancelled': 'リクエストがキャンセルされました。',
  'error.unexpected': '予期しないエラー：{detail}。',
  'error.no-response': '{seconds}秒後も応答がありません。',

  // --- on-device failures ---------------------------------------------------
  // The local provider's own codes. They read differently from the cloud ones
  // on purpose: the fix is never a key or a quota, it is a download or a
  // setting, and every one of them points at something the user can do here.
  'error.model-missing':
    'このモデルはまだダウンロードされていません。モデルタブでダウンロードしてください。',
  'error.model-host-unreachable':
    'どちらのダウンロードソースにも到達できませんでした。モデルタブで手動で選択してください。',
  'error.model-download-failed': 'ダウンロードが完了しませんでした。再試行してください。',
  'error.model-load-failed':
    'モデルを読み込めませんでした。不完全な可能性があります。削除して再度ダウンロードしてください。',
  'error.device-unavailable':
    'このマシンにはWebGPUがありません。デバイス設定をWASMに切り替えてください。',

  // --- the bar on the page --------------------------------------------------
  'sideplayer.play': '再生',
  'sideplayer.pause': '一時停止',
  'sideplayer.previous': '前の文',
  'sideplayer.next': '次の文',
  'sideplayer.rate': '再生速度{rate}',
  'sideplayer.caption': '字幕ウィンドウ',
  'sideplayer.settings': '設定',
  'sideplayer.progress': '読み上げ進行度{percent}%',
  'sideplayer.progress-remaining': '読み上げ進行度{percent}%、{remaining}',
  'sideplayer.hint.no-content.title': '読み上げ可能なコンテンツなし',
  'sideplayer.hint.no-content.message':
    'SayLoudはこのページに読み上げ可能なテキストを見つけられませんでした。',
  'sideplayer.hint.no-voice.title': 'ブラウザの音声なし',
  'sideplayer.hint.no-voice.message': 'Chromeにはこのページ用の音声がインストールされていません。',
  'sideplayer.hint.no-voice-selected.title': '音声未選択',
  'sideplayer.hint.no-voice-selected.message':
    'このプロバイダーを使用するには設定で音声を選択してください。',
  'sideplayer.hint.tts-error.title': '再生に失敗しました',
  // サービス自体が何も返さなかったときだけ表示する。それ以外はカード本文に
  // サービスからのメッセージをそのまま出す。
  'sideplayer.hint.tts-error.message': '音声サービスがエラーを返しました。',
  'sideplayer.hint.orphaned.title': 'SayLoudが再読み込みされました',
  'sideplayer.hint.orphaned.message':
    'このページを更新して読み上げを続けてください。拡張機能が更新されました。',

  // --- the caption window ---------------------------------------------------
  'caption.counter': '文{index}/{total}',

  // --- the bubble card ------------------------------------------------------
  'bubble.scrolled-away': '読み上げ中の文からスクロールで離れました。',
  'bubble.back-to-position': '位置に戻る',
  'bubble.remaining': '残り{time}',

  // --- on-device models -----------------------------------------------------
  // Only the names the registry itself carries: the model and its tiers. The
  // rest of the model tab's copy is added with the tab.
  'model.kokoro-82m': 'Kokoro 82M',
  'model.tier.light': 'ライト',
  'model.tier.standard': '標準',
  'model.tier.hifi': '高忠実度',

  // --- the Models tab -------------------------------------------------------
  // The tab manages files rather than preferences, so every line here is about
  // state — what is downloaded, where from, and what it costs in space.
  'model.source.title': 'ダウンロードソース',
  'model.source.label': 'ダウンロードソース',
  'model.source.help': '自動は到達可能なミラーを選択して記憶します。',
  'model.source.auto': '自動（推奨）',
  'model.source.huggingface': 'Hugging Face',
  'model.source.modelscope': 'ModelScope',
  'model.source.custom': 'カスタムミラー',
  'model.source.custom-label': 'ミラーURL',
  'model.source.custom-invalid': '完全なhttps:// URLを入力してください。',
  'model.source.saved': 'ソースを保存しました。',
  'model.source.save-failed': 'ソースを保存できませんでした：{detail}',

  'model.in-use': '使用中',
  'model.set-active': 'アクティブに設定',
  'model.download': 'ダウンロード',
  'model.cancel': 'キャンセル',
  'model.delete': '削除',
  'model.delete-confirm': '削除する',
  'model.delete-warning': '削除後、読み上げるには再度ダウンロードが必要です。',
  'model.downloading': '{tier}をダウンロード中 · {percent}%',
  'model.download-failed': 'ダウンロードに失敗しました。接続を確認してください。',
  'model.download-cancelled': 'ダウンロードがキャンセルされました。',
  'model.read-failed': 'ダウンロードされたモデルを読み取れませんでした。',
  // Two keys rather than one "Recommended": what is recommended depends on the
  // machine, and a badge that does not say which machine is a badge that means
  // nothing when the user reads it on the other one.
  'model.recommended': 'WebGPU推奨',
  'model.recommended-cpu': 'GPU非搭載時推奨',
  'model.broken-on-device': 'このデバイスで音声が歪むことが確認されています',
  'model.license': 'ライセンス：{name}',
  'model.voice-count': '{count}個の音声',
  'model.timings': '文のハイライト',

  'model.storage.title': 'デバイスとストレージ',
  'model.storage.label': 'ストレージ使用量',
  // Says what is *not* counted, for the same reason the audio cache's note does:
  // the two numbers are separate on purpose.
  'model.storage.note': 'モデルと音声。音声キャッシュは設定タブで集計されます。',
  // Voices are fetched one at a time, when a voice is first used; there is no
  // "download them all" control yet, and a line saying so beats a dead button.
  'model.voices.note':
    '音声はオンデマンドでダウンロードされます。各音声の初回使用時にダウンロードされます。',
  'model.device.not-loaded': '未ロード',
  'model.device.wasm': 'WASM（GPU非搭載）',
  'model.device.webgpu': 'WebGPU',
  'model.device.webgpu-named': 'WebGPU · {adapter}',
  // What the line means, so "WebGPU" before anything has been loaded does not
  // read as a claim that a model is already running there.
  'model.device.help': '次回のモデル読み込み時に使用されます。',
  'model.device.resolved': '実行先',
  'model.device.option-auto': '自動（推奨）',
  'model.device.option-webgpu': 'WebGPU — このマシンのグラフィックス',
  'model.device.option-wasm': 'CPU — 遅いですが常に動作します',
};
