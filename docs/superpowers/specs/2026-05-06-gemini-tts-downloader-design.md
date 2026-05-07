# Gemini TTS Downloader — Design

**Date:** 2026-05-06
**Type:** Chrome Manifest V3 browser extension
**Goal:** Add a "Download" item to the per-message 3-dot menu on `gemini.google.com` that saves the message's TTS ("Listen") audio as a file, without requiring the user to wait through real-time playback.

## User-facing decisions (locked in)

| Choice | Decision |
|---|---|
| Browser target | Chrome (Manifest V3) |
| Download trigger location | Inside the existing 3-dot menu, alongside "Listen" |
| Filename format | `{conversation-title}-{message-index}.{ext}` |
| Error UI | Small in-page toast (no Chrome notifications) |
| Debug logging | Toggled via `localStorage.geminiTTSDebug = '1'` |

## Architectural approach

**Approach A — capture the existing Listen network response, with mute suppression and stream `tee()`-based capture so playback is silent and download speed is bounded by network, not playback duration.**

Alternatives considered and rejected:
- **Approach B (replay TTS API directly):** Brittle — Google can change internal request shape at any time.
- **Approach C (MediaSource buffer capture):** More complex; only needed if Approach A turns out to use MSE rather than a single fetch. Documented as fallback.
- **MediaRecorder of audio output:** Always equal to playback duration. Last resort.

## Three-context architecture (Manifest V3)

| Context | File | Purpose |
|---|---|---|
| Service worker | `service-worker.js` | Holds `chrome.downloads` API; receives final blob URLs from content script and triggers file save. |
| Content script (isolated world) | `content-script.js` | Watches Gemini DOM via MutationObserver, injects "Download" items into 3-dot menus, brokers messages between page world and service worker. |
| Page-world script (main world) | `injected.js` | Runs in Gemini's JS realm. Monkey-patches `window.fetch` so we can `tee()` TTS response streams. Required because content scripts run in an isolated world and can't see the page's `fetch` calls. |

Communication:
- page-world ↔ content script: `window.postMessage` + `window.addEventListener('message', ...)`
- content script ↔ service worker: `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`

## File layout

```
gemini-tts-downloader/
├── manifest.json
├── service-worker.js
├── content-script.js
├── injected.js
├── filename.js          # pure helper, also unit-tested
├── icons/{16,48,128}.png
├── README.md            # how to load unpacked
└── tests/
    └── filename.test.js
```

## Data flow

```
[1] User clicks "Download" in injected 3-dot menu item
      │
      ▼
[2] content-script.js:
      • reads conversation title from sidebar (fallback: document.title)
      • computes message index (Nth assistant message in chat, 1-based)
      • composes filename via filename.js
      • postMessage({type:'GEMINI_TTS_ARM', requestId, filename}) → page world
      • programmatically clicks the message's existing "Listen" button
      │
      ▼
[3] injected.js (already running, fetch is monkey-patched):
      • sees ARM message → arms internal flag with requestId + 30s timeout
      • next fetch with audio/* response Content-Type → response.body.tee()
        ─ branch A → original consumer (audio plays normally in page)
        ─ branch B → accumulates Uint8Array chunks
      • simultaneously: MutationObserver catches new <audio> element → sets .muted=true
      • when branch B's stream ends → assemble Blob → URL.createObjectURL
      • postMessage({type:'GEMINI_TTS_READY', requestId, blobUrl, mimeType}) → content
      │
      ▼
[4] content-script.js:
      • receives READY message
      • chrome.runtime.sendMessage({type:'DOWNLOAD', blobUrl, filename})
      │
      ▼
[5] service-worker.js:
      • chrome.downloads.download({url: blobUrl, filename, saveAs: false})
      • on completion → revoke blob URL via message back to page world
```

## Manifest permissions

- `downloads` — chrome.downloads API
- `host_permissions: ["https://gemini.google.com/*"]`
- `web_accessible_resources: [{resources: ["injected.js"], matches: ["https://gemini.google.com/*"]}]` — so the content script can load the page-world script via `<script src=chrome-extension://...>`

NOT requested:
- `webRequest` — MV3 cannot read response bodies anyway
- `tabs` — not needed
- `notifications` — using in-page toast instead

## Audio capture — load-bearing details

```js
// injected.js (runs in page world)
const origFetch = window.fetch;
window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    if (!armed || !isAudioResponse(response)) return response;

    const [pageBranch, ourBranch] = response.body.tee();
    captureBlob(ourBranch, response.headers.get('content-type'));

    return new Response(pageBranch, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
};
```

Three subtleties:

1. **`response.body.tee()`** splits a `ReadableStream` into two independently-consumable streams without buffering the whole thing. Both branches advance at the speed of the slower consumer; backpressure is browser-managed. This is how we capture without breaking playback or waiting for `.blob()`.

2. **Identifying "the right" fetch.** The content script sets an "armed" flag (with a requestId) before clicking Listen. The page-world fetch wrapper only captures responses while armed, AND only those whose `Content-Type` starts with `audio/`. This avoids capturing other audio assets the page may load. Armed flag clears on first capture or after 30s timeout.

3. **Mute suppression.** A `MutationObserver` watches for `<audio>` elements being added to the DOM and immediately sets `.muted = true` while in download mode. There is a tiny race window between element creation and `src` being set, but in practice we win it because `src` is set asynchronously after element creation.

## Filename composition (`filename.js`)

Pure module, exported functions:

```js
export function composeFilename({ title, messageIndex, mimeType }) → string
export function sanitizeTitle(rawTitle) → string
export function extensionFor(mimeType) → string
```

Rules:
- `sanitizeTitle`: strip filesystem-unsafe chars (`<>:"/\|?*` + control chars), collapse runs of whitespace and dashes, trim, cap at 80 chars, fall back to `gemini-tts` if empty after sanitization
- `extensionFor`: `audio/mpeg` → `.mp3`, `audio/mp3` → `.mp3`, `audio/ogg` → `.ogg`, `audio/wav` → `.wav`, `audio/webm` → `.webm`, default `.bin`
- `composeFilename`: returns `${sanitizeTitle(title)}-${messageIndex}${extensionFor(mimeType)}`
- Collision handling: rely on Chrome's automatic `(1)`, `(2)` suffix in `chrome.downloads.download` (default behavior with `conflictAction: 'uniquify'`)

## Error handling

In-page toast (small fixed-position div injected into body, auto-dismiss after 5s). Error codes:

| Code | When | Toast text |
|---|---|---|
| `LISTEN_BUTTON_NOT_FOUND` | Couldn't find the Listen control inside opened 3-dot menu | "Couldn't find Listen button — Gemini layout may have changed" |
| `CAPTURE_TIMEOUT` | 30s passed since arming and no audio response captured | "Audio didn't arrive in time — try again" |
| `FETCH_FAILED` | The intercepted fetch errored | "Network error while fetching audio" |
| `DOWNLOAD_FAILED` | chrome.downloads.download failed | "Download failed — check Chrome's download permissions" |

All errors also logged to console with `[gemini-tts]` prefix when debug mode is on.

## DOM resilience

- Selectors prefer `[data-test-id]`, `[aria-label]`, semantic roles over class names. Class names in Gemini's DOM are minified hashes that change between deploys.
- All selector definitions live in a `SELECTORS` object at the top of `content-script.js` for one-file updates.
- `MutationObserver` on the conversation container catches new messages so we can inject menu items into them as they appear.
- All selector lookups wrapped in try/catch with `[gemini-tts]` warnings — never throw into the page.

## Debug logging

When `localStorage.geminiTTSDebug === '1'`:
- All three contexts (service worker, content script, page-world) emit structured logs at every stage
- Format: `[gemini-tts:<context>] <event> <data>`
- Off by default to avoid console noise

## Testing & verification

1. **`filename.js` unit tests** — Vitest, runs in node. Cover: emoji titles, slash characters, very long titles, empty after sanitization, all MIME types in the table, unknown MIME type fallback.
2. **Network inspection step at start of implementation** — open DevTools Network on Gemini, click Listen, report URL pattern + response Content-Type + transfer mode (chunked vs not). Confirms Approach A applies.
3. **Manual end-to-end test checklist** documented in `README.md`:
   - Short message (one sentence)
   - Long message (multiple paragraphs)
   - Message containing code blocks
   - Message in middle of long conversation
   - Two downloads in quick succession
   - Download triggered while another audio is already playing
   - First message in a new conversation (no title yet)
   - Conversation with non-ASCII title

## Implementation sequencing (high level)

1. Bare manifest + icons + README load-test
2. `filename.js` + tests
3. Service worker download handler
4. Content script DOM observer + menu injection (no audio yet — just verify menu item appears and clicking logs)
5. Page-world script + fetch monkey-patch + tee + Blob assembly
6. Wire up: arm → Listen click → capture → blob URL → service worker → download
7. Mute suppression
8. Error toast UI
9. Debug logging
10. Manual test pass against checklist

Detailed step-by-step implementation plan to be produced by the writing-plans skill.

---

## Implementation deviations (2026-05-07)

After the initial implementation, three changes from this design were necessary based on findings during testing:

1. **Service worker removed.** The original design forwarded captured audio bytes from the content script to the service worker (which would call `chrome.downloads.download`). Chrome's MV3 runtime messaging has a long-standing quirk where `ArrayBuffer` values arrive at the service worker as plain objects (`{0: byte, 1: byte, ...}`) instead of real `ArrayBuffer`s, breaking the `instanceof` check. The fix: skip the SW entirely and trigger the file save via a hidden `<a download>` click in the content script. The `downloads` permission was removed accordingly.

2. **Audio capture path changed from `fetch.tee()` to `URL.createObjectURL` hook.** Network inspection revealed that Gemini doesn't deliver TTS via a fetchable audio response. Instead, it constructs a `Blob` in JS (from data arriving via some other channel — probably XHR with a non-audio content-type) and mints a `blob:https://gemini.google.com/<uuid>` URL for the `<audio>` element. Intercepting `URL.createObjectURL` lets us tap directly into the Blob the moment it's registered, before the audio element ever loads from it. A poll-based fallback covers the case where the Blob URL was minted before our arm flag was set.

3. **Playback suppression layered defense added.** Initial mute-only suppression still let audio play (silently) — and unmuting after capture made it suddenly audible. Added: (a) global `HTMLMediaElement.prototype.play` patch that returns `Promise.resolve()` while armed (short-circuits playback at the API boundary, no race with element creation), (b) `autoplay = false` on element detection, (c) `pause()` before `unmute()` in `clearArm()` so any in-flight playback is stopped before sound is restored.

Net result: the implementation is simpler than the design — three execution contexts collapsed to two (no SW), and the capture mechanism observes a creation event (`createObjectURL`) instead of mutating request behavior. Permissions footprint dropped from `["downloads"]` to nothing (just host_permissions for gemini.google.com).
