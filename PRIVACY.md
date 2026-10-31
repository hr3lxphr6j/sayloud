# SayLoud Privacy Policy

_Last updated: 2026-10-31_

SayLoud is a Chrome extension that reads web pages aloud. It has no backend
server, no account system, and no analytics. Nothing you read is sent to the
developer.

This policy explains what stays on your device, what can leave it, and who
receives it. It applies to the SayLoud extension distributed through the Chrome
Web Store and through GitHub releases.

## Summary

- **No collection by the developer.** SayLoud has no servers and sends no
  telemetry, crash reports, usage statistics, or advertising identifiers.
- **Browser voices and on-device models run locally.** The text being read never
  leaves your browser in those modes.
- **Cloud voices are optional and use your own credentials.** If you configure a
  cloud service, the text SayLoud is reading is sent directly from your browser
  to that service, authenticated with the API key you entered, and to nowhere
  else.
- **Everything is stored locally** — settings, credentials, cached audio, and
  downloaded models — and is removed when you clear the extension's data or
  uninstall it.

## What SayLoud handles

### Page content

When you click SayLoud's toolbar icon, the extension reads the page you are
looking at to extract the article text and inject the reading controls. This
uses Chrome's `activeTab` permission: the extension only sees the tab you
invoked it on, only after you click, and it has no standing access to any site.

The extracted text is used to render the reader, to highlight the current
sentence, and — only if you chose a cloud voice — to request speech from the
service you configured.

### Settings and credentials

Your preferences and the API keys or subscription keys you enter are stored in
Chrome's extension storage (`chrome.storage.local`) on your device. Keys are
sent only to the service they belong to, as part of that service's own
authentication. The developer never receives them.

### Cached audio and downloaded models

To make repeated playback fast, SayLoud can cache synthesized audio in the
browser's storage. For on-device voices it downloads a speech model and its
dictionaries.

- Cached audio is stored locally. You can limit its size or clear it at any time
  from the extension's settings.
- Model files are downloaded from the source you choose — Hugging Face,
  ModelScope, or a mirror you configure — and stored in the browser's Cache
  Storage. Those requests go to that host, which may see your IP address and
  user agent, as any download would. The model source's own privacy policy
  applies to that download.
- The text being read is **not** included in model-download requests. It is
  processed entirely on your device.

### No other data

SayLoud does not read your browsing history, bookmarks, cookies, tabs you did
not invoke it on, form data, passwords, or files. It does not use analytics,
advertising, or fingerprinting, and it does not sell or share data with anyone.

## Third-party services

SayLoud ships with adapters for the following services. A service is contacted
only if you configure it and choose one of its voices.

| Service | Operated by | What is sent |
| --- | --- | --- |
| Browser voices | Your browser / operating system | Nothing over the network |
| On-device models | Hugging Face, ModelScope, or your mirror (download only) | Model file requests, no page text |
| DashScope | Alibaba Cloud | Text to synthesize, your API key |
| Volcengine Speech | ByteDance | Text to synthesize, your API key |
| OpenAI or a compatible endpoint | OpenAI or the endpoint you configure | Text to synthesize, your API key |
| ElevenLabs | ElevenLabs | Text to synthesize, your API key |
| Azure AI Speech | Microsoft | Text to synthesize, your subscription key |

Each provider handles the text it receives under its own privacy policy and
terms. Because the request is made directly from your browser, the provider sees
your IP address as it would for any direct API call.

If you enter a custom base URL or a custom model mirror, requests go to the host
you specified instead.

## Data retention and deletion

SayLoud keeps data only on your device:

- **Settings and credentials** remain in `chrome.storage.local` until you change
  them, clear the extension's data, or uninstall the extension.
- **Cached audio** remains until it is evicted under the size limit you set,
  cleared from the settings panel, or removed with the extension.
- **Downloaded models and dictionaries** remain in the browser's Cache Storage
  until you clear them or uninstall the extension.

Uninstalling SayLoud removes the extension's local storage and caches. Data
already received by a third-party service is governed by that service's
retention policy; SayLoud cannot delete it on your behalf.

## Permissions

SayLoud asks for the minimum it needs to read a page aloud:

- `activeTab` and `scripting` — inject the reader into the tab you clicked,
  without standing access to any site.
- `storage` — save your settings and credentials locally.
- `tts` — use Chrome's built-in system voices.
- `offscreen` — play cloud-generated audio in an offscreen document, because a
  service worker cannot play audio.
- `sidePanel` — show the reading controls and settings.
- Optional host access for `https://openspeech.bytedance.com/*` — requested only
  when you configure Volcengine, whose CORS preflight rejects the
  `X-Api-Key` header. It is never granted at install time and can be revoked at
  any time in Chrome's extension settings.

## Children

SayLoud is a general-purpose reading tool and is not directed at children. It
does not knowingly collect personal information from anyone.

## Limited Use

SayLoud's use of information received from Chrome APIs adheres to the Chrome Web
Store User Data Policy, including the Limited Use requirements. Data is used
only to provide the reading features described above, is not transferred to
third parties except as described in this policy (the service you explicitly
configure), and is not used for advertising or sold.

## Changes

If this policy changes, the updated version will be published in this repository
with a new "Last updated" date. Material changes will be noted in the
extension's release notes.

## Contact

Questions about this policy or SayLoud's data handling can be raised at:

https://github.com/hr3lxphr6j/sayloud/issues

SayLoud is open source; the code that implements everything described here is
available in the same repository.
