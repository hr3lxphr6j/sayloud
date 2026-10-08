# SayLoud

**English** · [中文](README.zh.md) · [日本語](README.ja.md)

SayLoud reads web pages aloud in Chrome. It highlights the current sentence,
and with voices that support word timings, each word lights up as it's spoken.

![Reading a page with SayLoud](assets/reading.png)

## What it does

- **A slim control bar, not a settings panel.** Click the toolbar icon and a
  28px bar slides out on the right: play/pause, previous/next sentence, speed,
  a progress ring showing time remaining, caption window toggle, and quick
  access to settings.
- **Sentence-level highlighting for all voices, word-level when available.**
  Every voice highlights the current sentence. When a voice provides word
  timings, individual words light up as they're spoken.
- **Start from any sentence.** Click any sentence on the page and reading begins
  right there.
- **Speed 0.5×–3×, volume 0–150%.** Both apply to the sentence playing now.
- **Keeps reading when you leave the tab.** You can work in another tab while it
  reads.
- **Smart auto-scroll.** The page follows along as it reads, but the moment you
  scroll manually, auto-scroll pauses and shows a button to jump back to the
  current sentence.
- **Floating caption window** — displays the current sentence and progress in a
  movable, always-on-top window.
- **Works out of the box.** Browser voices require no account, no API key, and
  no network connection.

## Three ways to be read to

| | Requirements | Privacy | Word highlighting |
|---|---|---|---|
| **Browser voice** | None | Completely local — uses system speech | From browser word events |
| **On-device model** | One-time download | Completely local — runs in browser | Sentence-level only |
| **Cloud service** | Your API key | Sent only to your chosen service | From service timestamps |

### On this device

Download Kokoro 82M once from the Models tab: 41 voices covering English
(en-US, en-GB), Chinese (zh-CN), and Japanese (ja). Choose from three sizes
(92 MB, 163 MB, or 326 MB) and WebGPU or CPU — the tab recommends what works
best for your machine. Individual voices download on first use. Your text never
leaves your computer, and no API key is needed.

<img src="assets/panel-models.png" width="300" alt="The Models tab: download source, model and sizes">

### Cloud services

Use your own API key with OpenAI-compatible servers (including local
Kokoro-FastAPI), ElevenLabs, Azure Speech, DashScope (阿里云百炼) CosyVoice and
Qwen-TTS, or 火山引擎豆包. Services that return word timings enable word-by-word
highlighting; others highlight full sentences. Keys are stored in Chrome's local
storage, and SayLoud only requests site access when you configure a service that
needs it.

<img src="assets/panel-settings.png" width="300" alt="The Settings tab: voice services and their forms">

## Using it

1. Open a web page and click the SayLoud icon in your toolbar. The extension
   injects nothing until you activate it — it has no automatic access to pages
   you visit.
2. The control bar appears on the right edge. Press play, or click any sentence
   to start reading from there.
3. Open the side panel to view progress and adjust voice, cache, and model
   settings.

<img src="assets/panel-reading.png" width="300" alt="The Reading tab: speed, volume, caption switch and progress">

The caption window, opened from the bar, keeps the current sentence on top of
other windows:

<img src="assets/caption.png" width="420" alt="The caption window showing one sentence and its position">

## Settings

- **Voice** — choose from a searchable list for each service, with indicators
  showing which voices support word-level timing. You can also enter a voice ID
  directly.
- **Speed, volume, caption window** — frequently adjusted during playback, so
  they live on the Reading tab for quick access.
- **Interface language** — English, 中文, 日本語, or follow the browser.
- **Cache** — stores synthesized audio locally so repeated sentences play
  instantly. Enabled by default with configurable limits (50 / 100 / 200 /
  500 MB, default 200 MB). Shows current usage and offers one-click clearing.
- **Models** — configure download source (automatic, Hugging Face, ModelScope,
  or custom mirror), model size, and execution device (WebGPU or CPU).

## Privacy

SayLoud has no backend server and collects no data. Browser voices and on-device
models run entirely locally. When you configure a cloud service, text is sent
directly from your browser to that service with your API key — nowhere else.
Site access permissions are requested only when needed for a specific service
and can be revoked anytime in Chrome's extension settings.

## Install

SayLoud isn't on the Chrome Web Store yet. Install the packaged build:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Download `sayloud-<version>-chrome.zip` from the
   [releases](https://github.com/hr3lxphr6j/sayloud/releases) page — it's under
   **Assets** — and drag it onto that page. Chrome unpacks it and installs it as
   an unpacked extension.

If dragging the zip doesn't work, unzip it into a folder of its own and click
**Load unpacked**, selecting that folder — the one with `manifest.json` in it. That
folder has to stay where it is: Chrome loads the extension from it.

To update, download the newer zip and drop it again. This channel has no automatic
updates, and because it is a Developer mode install Chrome keeps showing its
Developer mode notice.

To build from source instead — Node.js 22+, pnpm 9+, a Rust toolchain and
`wasm-pack`, which compiles a small Rust module to WebAssembly — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Works with current Chrome. The caption window requires Chrome 116+; on older
versions all other features work normally and the caption toggle explains the
requirement.

*The Chrome Web Store listing is coming.*

## License

MIT. Development notes — architecture, tests, the data generators — are in
[CONTRIBUTING.md](CONTRIBUTING.md).
