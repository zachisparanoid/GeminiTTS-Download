<!-- Replace USERNAME and REPONAME placeholders once the GitHub repo exists. -->

<h1 align="center">REPONAME</h1>

<p align="center">
  <strong>Download Google Gemini's "Listen" TTS audio responses as files.</strong><br>
  No waiting through playback. No menu hunting. One click, file in Downloads.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/USERNAME/REPONAME?style=flat-square&color=blue" alt="License"></a>
  <a href="https://github.com/USERNAME/REPONAME/stargazers"><img src="https://img.shields.io/github/stars/USERNAME/REPONAME?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/USERNAME/REPONAME/network/members"><img src="https://img.shields.io/github/forks/USERNAME/REPONAME?style=flat-square&color=orange" alt="Forks"></a>
  <a href="https://github.com/USERNAME/REPONAME/issues"><img src="https://img.shields.io/github/issues/USERNAME/REPONAME?style=flat-square&color=red" alt="Issues"></a>
  <a href="https://github.com/USERNAME/REPONAME/commits/main"><img src="https://img.shields.io/github/last-commit/USERNAME/REPONAME?style=flat-square" alt="Last commit"></a>
  <img src="https://img.shields.io/badge/Manifest-V3-brightgreen?style=flat-square" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Chrome-supported-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome">
</p>

---

## What it does

Gemini's **Listen** feature is buried behind a 3-dot menu, and there's no built-in way to keep a copy of the audio without sitting through real-time playback. This Chrome extension fixes both:

- Adds a **Download** option right inside the 3-dot menu, next to Listen
- Pulls the audio directly out of Gemini's blob URL — typically saves in **2-3 seconds** regardless of how long the clip would take to play
- Saves silently — no audio plays during capture
- Names files `<conversation-title>-<message-index>.mp3` so they're sortable

## Demo

> _Drop a GIF or screenshot here once you record one._

```
   ┌──────────────────────────────┐
   │  [3-dot menu opens]          │
   │  ─────────────────────       │
   │  🔊 Listen                   │
   │  ⬇️  Download   ← injected   │
   │  📋 Copy                     │
   │  ⋮                           │
   └──────────────────────────────┘
```

## Install (developer / unpacked)

The extension is not (yet) on the Chrome Web Store. To install from source:

1. Clone this repo
   ```bash
   git clone https://github.com/USERNAME/REPONAME.git
   cd REPONAME
   ```
2. Open `chrome://extensions` in Chrome
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked**
5. Select the `extension/` directory inside this repo
6. Visit `https://gemini.google.com/`, hover over an assistant message, open the 3-dot menu — **Download** sits right next to **Listen**

For more detail, see [`extension/README.md`](extension/README.md).

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                       gemini.google.com                     │
│                                                             │
│   ┌─────────────────┐    postMessage    ┌─────────────────┐ │
│   │ content script  │ ◄──────────────► │ page-world script│ │
│   │ (isolated world)│                   │   (main world)   │ │
│   └────────┬────────┘                   └────────┬─────────┘ │
│            │                                     │           │
│   - injects "Download"             - patches URL.createObjectURL
│   - tracks 3-dot clicks            - patches HTMLMediaElement.play
│   - builds Blob locally            - mutes/pauses audio
│   - triggers <a download>          - posts captured bytes back
└─────────────────────────────────────────────────────────────┘
```

1. The **content script** watches Gemini's DOM and injects a *Download* item into the per-message 3-dot menu.
2. The **page-world script** monkey-patches `URL.createObjectURL`. The moment Gemini constructs a Blob for a TTS response, we read its bytes via `blob.arrayBuffer()` — no waiting for playback to finish.
3. While capture is in flight, `HTMLMediaElement.prototype.play` is short-circuited so no audio actually plays.
4. The bytes are passed back to the content script (via `window.postMessage` with a transferable ArrayBuffer), wrapped in a Blob, and triggered as a download via a hidden `<a download>` anchor click.

Full design doc: [`docs/superpowers/specs/2026-05-06-gemini-tts-downloader-design.md`](docs/superpowers/specs/2026-05-06-gemini-tts-downloader-design.md)

## Built with

<p>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Chrome%20Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome Extension">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/no--build-needed-success?style=flat-square" alt="no build">
</p>

- Vanilla JavaScript, no bundler, no transpiler
- Manifest V3 service worker (currently inactive — kept for future enhancements)
- Filename module unit tests via Node's built-in `node:test`

## Run tests

```bash
cd extension
npm test
```

## Permissions

- `downloads` — currently unused (download is triggered via anchor click). Will be removed in a future cleanup.
- `host_permissions: https://gemini.google.com/*` — only this origin

That's it. No telemetry, no remote calls, no data leaving your machine.

## Limitations / known caveats

- Gemini's DOM selectors are best-effort. If Google ships a redesign, the menu-injection selectors may need tweaks. They all live in one `SELECTORS` object at the top of [`extension/content-script.js`](extension/content-script.js).
- The capture path assumes Gemini delivers TTS via a `blob:` URL on an `<audio>` element. If that ever changes, the existing `fetch` interception is a fallback path.
- A 30-second timeout is enforced — if no audio response arrives within that window, the download is abandoned with a toast error.

## Contributing

Issues and PRs welcome. The codebase is small (≈700 lines of JS total) and the [design doc](docs/superpowers/specs/2026-05-06-gemini-tts-downloader-design.md) explains every architectural choice.

If a Gemini DOM change breaks the extension, the fix is usually one regex in `SELECTORS` — please open a PR.

## License

[MIT](LICENSE) — © 2026 Zachary Winchester

---

## Star history

<a href="https://star-history.com/#USERNAME/REPONAME&Date">
  <img src="https://api.star-history.com/svg?repos=USERNAME/REPONAME&type=Date" alt="Star History Chart">
</a>
