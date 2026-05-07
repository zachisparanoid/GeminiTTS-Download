// Page-world script. Runs in Gemini's own JS realm (NOT the content script's
// isolated world) so it can monkey-patch the page's window.fetch and tee the
// TTS response stream.
//
// Communicates with the content script via window.postMessage. Message types:
//   IN   GEMINI_TTS_ARM     { requestId, timeoutMs? }
//   OUT  GEMINI_TTS_READY   { requestId, bytes, mimeType }
//   OUT  GEMINI_TTS_ERROR   { requestId, code, message }

(function () {
  // Idempotency guard — content script may inject this script more than once
  // across navigations within a SPA.
  if (window.__geminiTTS_injected) return;
  window.__geminiTTS_injected = true;

  const DEBUG_KEY = "geminiTTSDebug";
  const debugOn = () => {
    try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
  };
  const log = (...args) => { if (debugOn()) console.log("[gemini-tts:page]", ...args); };

  // --- State -------------------------------------------------------------

  /** @type {null | { requestId: string, deadline: number, mutedAudio: Set<HTMLMediaElement> }} */
  let armed = null;
  let armTimer = null;

  function clearArm() {
    if (!armed) return;
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    for (const el of armed.mutedAudio) {
      // Pause BEFORE unmuting — otherwise any in-flight playback becomes
      // audible the instant we restore sound. User can manually click play
      // later and it will work normally (armed is null by then, so our
      // play() patch falls through to the original).
      try { el.pause(); } catch {}
      try { el.muted = false; } catch {}
    }
    armed = null;
  }

  function fail(code, message) {
    if (!armed) return;
    const { requestId } = armed;
    console.warn("[gemini-tts] ERROR", code, message);
    window.postMessage({ type: "GEMINI_TTS_ERROR", requestId, code, message }, "*");
    clearArm();
  }

  function succeed(bytes, mimeType) {
    if (!armed) return;
    const { requestId } = armed;
    console.log("[gemini-tts] READY", { requestId, size: bytes.byteLength, mimeType });
    // Transfer the ArrayBuffer to avoid copying. postMessage with transferables
    // moves ownership to the receiver.
    window.postMessage(
      { type: "GEMINI_TTS_READY", requestId, bytes, mimeType },
      "*",
      [bytes]
    );
    clearArm();
  }

  // --- Mute suppression --------------------------------------------------

  function muteAudioElement(el) {
    if (!armed) return;
    try {
      // Disable autoplay so the browser doesn't auto-start when src is set.
      try { el.autoplay = false; } catch {}
      if (!el.muted) {
        el.muted = true;
        armed.mutedAudio.add(el);
        console.log("[gemini-tts] muted audio element", el.tagName, el.src || "(no src yet)");
      }
      // Pause if anything has started playback before our patches kicked in.
      if (!el.paused) {
        try { el.pause(); } catch {}
      }
    } catch {}
  }

  function muteAllExistingAudio() {
    document.querySelectorAll("audio,video").forEach(muteAudioElement);
  }

  // Walk the subtree of an added node looking for audio/video elements.
  function muteWithinSubtree(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node instanceof HTMLMediaElement) muteAudioElement(node);
    node.querySelectorAll && node.querySelectorAll("audio,video").forEach(muteAudioElement);
  }

  const audioObserver = new MutationObserver((mutations) => {
    if (!armed) return;
    for (const m of mutations) {
      m.addedNodes && m.addedNodes.forEach(muteWithinSubtree);
    }
  });
  audioObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Global play() suppression while armed. Avoids the race window where the
  // audio element is sourced and play()ed in the same task (mute/pause via
  // MutationObserver fires too late to prevent the initial blip). Returning
  // a resolved promise keeps Gemini's await-chains happy. Falls through to
  // real play() once armed clears, so user-initiated playback later works.
  const origMediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (armed) {
      console.log("[gemini-tts] suppressed media play() while armed", this.tagName);
      return Promise.resolve();
    }
    return origMediaPlay.apply(this, arguments);
  };

  // --- Fetch monkey-patch ------------------------------------------------

  const origFetch = window.fetch.bind(window);

  function isAudioContentType(ct) {
    if (!ct) return false;
    return /^audio\//i.test(ct.split(";")[0].trim());
  }

  // --- Blob URL capture --------------------------------------------------
  // Gemini delivers TTS by constructing a Blob in JS and minting a blob: URL
  // for the <audio> element. The audio bytes never appear in a network
  // response we can intercept. So we hook URL.createObjectURL — the moment
  // the Blob is registered, we have direct access to its bytes.

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(URL, obj);
    try {
      if (armed && obj instanceof Blob) {
        const isAudio = isAudioContentType(obj.type) || obj.size > 5000;
        console.log("[gemini-tts] createObjectURL while armed:", {
          url, type: obj.type, size: obj.size, willCapture: isAudio,
        });
        if (isAudio) {
          obj.arrayBuffer().then((buf) => {
            succeed(buf, obj.type || "audio/mpeg");
          }).catch((err) => {
            console.error("[gemini-tts] blob.arrayBuffer() failed:", err);
            fail("FETCH_FAILED", "Could not read audio blob");
          });
        }
      }
    } catch (err) {
      console.error("[gemini-tts] createObjectURL hook error:", err);
    }
    return url;
  };

  // Fallback: if Gemini reuses a blob URL minted before we armed, the
  // createObjectURL hook never sees it. Poll audio elements for blob: srcs.
  async function fetchBlobUrl(url) {
    console.log("[gemini-tts] fetching cached blob URL:", url);
    try {
      const r = await origFetch(url);
      const ct = r.headers.get("content-type") || "audio/mpeg";
      const buf = await r.arrayBuffer();
      succeed(buf, ct);
    } catch (err) {
      fail("FETCH_FAILED", `Blob URL fetch failed: ${err.message || err}`);
    }
  }

  function pollAudioForBlobSrc() {
    if (!armed) return;
    const els = document.querySelectorAll("audio, video");
    for (const el of els) {
      if (el.__geminiTtsBlobCaptured) continue;
      const src = el.currentSrc || el.src;
      if (src && src.startsWith("blob:")) {
        el.__geminiTtsBlobCaptured = true;
        fetchBlobUrl(src);
        return;
      }
      // Also check <source> children.
      for (const s of el.querySelectorAll("source")) {
        if (s.src && s.src.startsWith("blob:") && !el.__geminiTtsBlobCaptured) {
          el.__geminiTtsBlobCaptured = true;
          fetchBlobUrl(s.src);
          return;
        }
      }
    }
    setTimeout(pollAudioForBlobSrc, 150);
  }

  // (Previously had an XMLHttpRequest monkey-patch here. Removed — it forced
  // responseType to "arraybuffer" while armed, which corrupted Gemini's
  // non-audio XHRs that expect .responseText. Since the blob-capture path
  // works regardless of how the underlying bytes arrive, we don't need it.)

  async function captureBody(stream, mimeType) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
    } catch (err) {
      fail("FETCH_FAILED", `Stream read error: ${err.message || err}`);
      return;
    }

    // Concatenate into a single ArrayBuffer.
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    succeed(merged.buffer, mimeType);
  }

  window.fetch = async function (input, init) {
    const armedAtStart = !!armed;
    const requestUrl = typeof input === "string" ? input : (input && input.url) || "(unknown)";
    if (armedAtStart) {
      console.log("[gemini-tts] fetch START while armed:", requestUrl);
    }

    let response;
    try {
      response = await origFetch(input, init);
    } catch (err) {
      if (armedAtStart) console.log("[gemini-tts] fetch FAILED while armed:", requestUrl, err.message || err);
      throw err;
    }

    if (!armed || !response.body) return response;

    const ct = response.headers.get("content-type") || "";
    console.log("[gemini-tts] fetch DONE while armed:", {
      url: response.url, contentType: ct, audio: isAudioContentType(ct),
    });

    if (!isAudioContentType(ct)) return response;

    let pageBranch, ourBranch;
    try {
      [pageBranch, ourBranch] = response.body.tee();
    } catch (err) {
      log("tee() failed; passing through", err);
      return response;
    }

    // Drain our branch into a Blob in the background.
    captureBody(ourBranch, ct);

    // Hand the page its own branch wrapped in a fresh Response.
    return new Response(pageBranch, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // --- Message handler ---------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "GEMINI_TTS_ARM") return;

    const { requestId, timeoutMs } = msg;
    if (!requestId) return;

    // If a previous arm is still active, abandon it.
    if (armed) {
      log("re-arming over previous request", armed.requestId);
      clearArm();
    }

    const deadline = Date.now() + (timeoutMs || 30000);
    armed = { requestId, deadline, mutedAudio: new Set() };
    console.log("[gemini-tts] ARMED", { requestId, timeoutMs: timeoutMs || 30000 });

    // Ack so content script knows it's safe to dispatch the click without
    // racing the arm flag.
    window.postMessage({ type: "GEMINI_TTS_ARMED", requestId }, "*");

    // Start polling for cached blob URLs on audio elements (createObjectURL
    // hook handles fresh blobs; this is the fallback for reused ones).
    pollAudioForBlobSrc();

    // Mute anything already on the page so the about-to-be-clicked Listen
    // button can't immediately reuse a pre-existing audio element audibly.
    muteAllExistingAudio();

    armTimer = setTimeout(() => {
      fail("CAPTURE_TIMEOUT", "Audio response did not arrive within timeout");
    }, timeoutMs || 30000);
  });

  log("injected.js loaded; fetch monkey-patched");
})();
