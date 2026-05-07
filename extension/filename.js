// Filename composition for downloaded Gemini TTS audio.
// Loaded as a content script (attaches to globalThis) and importable in node tests.

(function () {
  const FORBIDDEN = /[<>:"/\\|?*\x00-\x1F\x7F]/g;
  const WHITESPACE = /\s+/g;
  const DASH_RUN = /-+/g;
  const EDGE_DASH = /^-+|-+$/g;
  const MAX_LEN = 80;
  const FALLBACK = "gemini-tts";

  const MIME_TO_EXT = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
  };

  function sanitizeTitle(raw) {
    if (raw == null) return FALLBACK;
    // Order matters: whitespace -> dash FIRST so that tabs/newlines (which are
    // also in the control-char range of FORBIDDEN) don't get stripped to nothing,
    // collapsing words together. Then strip remaining forbidden chars, then
    // normalize dashes.
    let s = String(raw)
      .replace(WHITESPACE, "-")
      .replace(FORBIDDEN, "")
      .replace(DASH_RUN, "-")
      .replace(EDGE_DASH, "");
    if (s.length > MAX_LEN) {
      s = s.slice(0, MAX_LEN).replace(EDGE_DASH, "");
    }
    return s.length > 0 ? s : FALLBACK;
  }

  function extensionFor(mimeType) {
    if (!mimeType) return ".bin";
    const base = String(mimeType).split(";")[0].trim().toLowerCase();
    return MIME_TO_EXT[base] || ".bin";
  }

  function composeFilename({ title, messageIndex, mimeType }) {
    const safeTitle = sanitizeTitle(title);
    const idx = Number.isFinite(messageIndex) && messageIndex > 0
      ? Math.floor(messageIndex)
      : 1;
    return `${safeTitle}-${idx}${extensionFor(mimeType)}`;
  }

  const api = { sanitizeTitle, extensionFor, composeFilename };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    const root = typeof self !== "undefined" ? self : globalThis;
    root.geminiTTSFilename = api;
  }
})();
