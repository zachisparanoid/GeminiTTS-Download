# Gemini TTS Downloader

Adds a **Download** option to the per-message 3-dot menu on `gemini.google.com`, saving the message's TTS ("Listen") audio as a file. The download is fetched directly from the network response — you don't have to wait for playback to finish.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory in this repo
5. Visit `https://gemini.google.com/`, hover over an assistant message, click the 3-dot menu — **Download** appears next to **Listen**

## How it works

- A **content script** watches the chat DOM and injects a **Download** menu item next to **Listen**.
- A **page-world script** monkey-patches `URL.createObjectURL` so the moment Gemini constructs a Blob for a TTS response, we read its bytes via `blob.arrayBuffer()`. As a fallback, it also polls `<audio>` elements for `blob:` URLs in case the Blob was minted before our arm flag was set.
- While capturing, `HTMLMediaElement.prototype.play` is short-circuited to a no-op so no audio actually plays.
- The captured bytes are passed back to the content script via `window.postMessage` (with a transferable `ArrayBuffer`), wrapped in a Blob, and triggered as a download via a hidden `<a download>` element click. No service worker round-trip — Chrome's runtime messaging mangles `ArrayBuffer`s in MV3, so we sidestep it entirely.
- File is named `<conversation-title>-<message-index>.<ext>`.

## Debug logging

Open DevTools on `gemini.google.com` and run:

```js
localStorage.geminiTTSDebug = '1'
```

Reload the page. All three contexts (page world, content script, service worker) will emit `[gemini-tts:*]` logs at every step.

To disable: `delete localStorage.geminiTTSDebug` and reload.

## Manual test checklist

- [ ] Short message (one sentence) — downloads quickly
- [ ] Long message (multiple paragraphs) — downloads faster than playback duration
- [ ] Message containing code blocks
- [ ] Message in middle of a long conversation (correct message-index in filename)
- [ ] Two downloads in quick succession (no interference)
- [ ] Download triggered while another audio is already playing
- [ ] First message in a brand-new conversation (filename falls back gracefully if no title)
- [ ] Conversation with non-ASCII title (Unicode handled)
- [ ] DevTools Console shows no errors

## Filename module tests

```bash
cd extension
npm install
npm test
```

## Branding and Assets

The extension includes high-quality icons designed to match the Gemini aesthetic. Source SVG files and a full-size logo/banner can be found in the `/design` directory at the project root.

To modify the icons, edit `design/logo.svg` and use an SVG-to-PNG converter to update the files in `extension/icons/`.

## Project layout

```
extension/
├── manifest.json
├── content-script.js     # isolated world — DOM observer, menu injection, toast UI, blob → file save
├── injected.js           # page world — URL.createObjectURL hook + audio play() suppression
├── filename.js           # pure helper used by content-script
├── icons/                # extension icons + generator script
└── tests/
    └── filename.test.js  # unit tests for filename composition
```

## Limitations / known caveats

- If Google renames or restructures the 3-dot menu DOM, the menu-injection selector may need updates. All selectors live in a single `SELECTORS` object at the top of `content-script.js`.
- If Google switches TTS delivery to `MediaSource` chunks instead of a fetch response, the capture path will need a fallback (documented in the design spec under Approach C).
- A 30-second timeout is enforced — if no audio response arrives in that window, the download is abandoned with a toast error.
