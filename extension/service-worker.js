// Service worker — owns chrome.downloads and the blob URL lifecycle.
//
// Architectural note: blob URLs are scoped to the context that created them.
// A blob URL minted in the page world cannot be fetched from this service
// worker. So the content script forwards us the raw bytes (ArrayBuffer via
// structured clone), and we mint the blob URL HERE so chrome.downloads can
// resolve it.

const DEBUG_KEY = "geminiTTSDebug";
let debugEnabled = false;

// Map<downloadId, blobUrl> so we can revoke once Chrome finishes with the URL.
const pendingRevocations = new Map();

function log(...args) {
  if (debugEnabled) console.log("[gemini-tts:sw]", ...args);
}

// Best-effort: ask any active content script whether debug mode is on.
// (Service workers can't read the page's localStorage directly.)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SET_DEBUG") {
    debugEnabled = !!msg.enabled;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type !== "DOWNLOAD") return false;

  handleDownload(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => {
      log("download failed", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });

  // Return true to keep the message channel open for async sendResponse.
  return true;
});

async function handleDownload({ bytes, mimeType, filename }) {
  if (!bytes || !(bytes instanceof ArrayBuffer)) {
    throw new Error("DOWNLOAD missing ArrayBuffer payload");
  }
  if (!filename) {
    throw new Error("DOWNLOAD missing filename");
  }

  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  log("blob URL minted", { url, size: blob.size, mimeType, filename });

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    pendingRevocations.set(downloadId, url);
    log("download started", { downloadId });
    return { downloadId };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// Revoke the blob URL once Chrome is done with it (complete OR interrupted).
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  const url = pendingRevocations.get(delta.id);
  if (!url) return;
  URL.revokeObjectURL(url);
  pendingRevocations.delete(delta.id);
  log("revoked blob URL", { downloadId: delta.id, state });
});
