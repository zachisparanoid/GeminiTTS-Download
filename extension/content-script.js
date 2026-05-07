// Content script. Runs in the isolated world. Responsibilities:
//   1. Inject the page-world script (injected.js) so it can monkey-patch fetch.
//   2. Watch the DOM for the 3-dot message menu opening and add a Download item.
//   3. On Download click: arm the page world, then programmatically click Listen.
//   4. Receive bytes from the page world, forward to service worker for download.
//   5. Show in-page toast on errors.
//
// All Gemini-specific selectors live in SELECTORS at the top so they can be
// updated in one place when Google's DOM evolves. Selectors are intentionally
// loose (text-content + role) since class names are hashed and unstable.

(function () {
  // ---------------------------------------------------------------- config

  const DEBUG_KEY = "geminiTTSDebug";
  const debugOn = () => {
    try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
  };
  const log = (...args) => { if (debugOn()) console.log("[gemini-tts:cs]", ...args); };

  const SELECTORS = {
    // Opened 3-dot menu container. Gemini uses Material-style overlays.
    menu: '[role="menu"]',
    // Items inside an opened menu — could be button or div with menuitem role.
    menuItem: '[role="menuitem"], button',
    // Heuristic for the Listen item: text content equals or contains "Listen".
    listenItemText: /^\s*listen\s*$/i,
    // Heuristic for the 3-dot trigger button. We use this to capture which
    // message a menu belongs to BEFORE the menu opens (Material menus render
    // in a portal, detached from the owning message in the DOM tree).
    moreOptionsButtonAria: /more options|more actions|show more|message options/i,
    // Container for an assistant turn (used to compute message index).
    assistantTurn: '[data-message-author-role="assistant"], message-content, model-response',
    // Active conversation entry in the sidebar (for filename title).
    activeConversation: '[aria-current="page"], [aria-selected="true"], .selected',
  };

  const ARM_TIMEOUT_MS = 30000;

  // ---------------------------------------------------------- pending state

  /**
   * Map of requestId -> { title, messageIndex, timeoutHandle }
   * Filled when we ARM and consumed when READY/ERROR comes back.
   */
  const pending = new Map();

  // -------------------------------------------------------- inject page script

  function injectPageScript() {
    if (document.getElementById("gemini-tts-injected")) return;
    const s = document.createElement("script");
    s.id = "gemini-tts-injected";
    s.src = chrome.runtime.getURL("injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    log("injected page-world script");
  }
  injectPageScript();

  // ---------------------------------------------------------- toast UI

  function ensureToastHost() {
    let host = document.getElementById("gemini-tts-toasts");
    if (host) return host;
    host = document.createElement("div");
    host.id = "gemini-tts-toasts";
    Object.assign(host.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      pointerEvents: "none",
    });
    document.body.appendChild(host);
    return host;
  }

  function toast(message, kind = "info") {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.textContent = message;
    Object.assign(el.style, {
      pointerEvents: "auto",
      padding: "10px 14px",
      borderRadius: "8px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px",
      color: "white",
      maxWidth: "320px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
      background: kind === "error" ? "#b91c1c" : kind === "success" ? "#15803d" : "#1f2937",
      transition: "opacity 0.3s ease",
    });
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 350);
    }, 4500);
  }

  // -------------------------------------------------------- DOM probes

  function readConversationTitle() {
    // Try the active sidebar entry first.
    const active = document.querySelector(SELECTORS.activeConversation);
    if (active) {
      const txt = (active.textContent || "").trim();
      if (txt) return txt;
    }
    // Fallback: document.title minus app suffix.
    return (document.title || "")
      .replace(/\s*[-—|]\s*Gemini.*$/i, "")
      .trim() || "gemini-tts";
  }

  function computeMessageIndex(messageEl) {
    if (!messageEl) return 1;
    const all = Array.from(document.querySelectorAll(SELECTORS.assistantTurn));
    const idx = all.indexOf(messageEl);
    return idx >= 0 ? idx + 1 : 1;
  }

  // Find the assistant message that owns a given menu trigger / menu element.
  // Walks up from the menu trigger (or the menu itself if it's a popover).
  function findOwningMessage(node) {
    let n = node;
    while (n && n !== document.body) {
      if (n.matches && n.matches(SELECTORS.assistantTurn)) return n;
      n = n.parentElement;
    }
    return null;
  }

  // ---- Track which message owns the next menu --------------------------
  // Material menus render in a portal at the body level, so by the time the
  // menu DOM appears, the parent chain doesn't lead back to the message.
  // We listen for clicks on 3-dot buttons (capture phase) and remember the
  // owning message; the next menu we observe is assumed to belong to it.
  let lastTriggeredMessage = null;

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("button,[role='button']") : null;
    if (!btn) return;
    const label = btn.getAttribute("aria-label") || "";
    const tooltip = btn.getAttribute("data-tooltip") || btn.title || "";
    if (!SELECTORS.moreOptionsButtonAria.test(label) &&
        !SELECTORS.moreOptionsButtonAria.test(tooltip)) {
      return;
    }
    const owning = findOwningMessage(btn);
    if (owning) {
      lastTriggeredMessage = owning;
      log("captured 3-dot trigger for message", { messageIndex: computeMessageIndex(owning) });
    }
  }, true);

  function findListenItem(menu) {
    if (!menu) return null;
    const items = menu.querySelectorAll(SELECTORS.menuItem);
    for (const it of items) {
      const txt = (it.textContent || "").trim();
      if (SELECTORS.listenItemText.test(txt)) return it;
      // Also match accessible label.
      const label = it.getAttribute && it.getAttribute("aria-label");
      if (label && SELECTORS.listenItemText.test(label)) return it;
    }
    return null;
  }

  // -------------------------------------------------------- menu injection

  function injectDownloadItem(menu) {
    // Robust idempotency: the marker lives on the injected element. If the
    // menu re-renders and loses our element, we'll correctly re-inject; if
    // our element survives, we won't duplicate.
    if (menu.querySelector('[data-gemini-tts-download="1"]')) return;

    const listen = findListenItem(menu);
    if (!listen) {
      // Listen item may not be in the DOM yet — observe this menu's children
      // and retry once children appear. One-shot, disconnects after success.
      log("menu opened but no Listen item yet — watching for it");
      const childObs = new MutationObserver(() => {
        if (menu.querySelector('[data-gemini-tts-download="1"]')) {
          childObs.disconnect();
          return;
        }
        if (findListenItem(menu)) {
          childObs.disconnect();
          injectDownloadItem(menu);
        }
      });
      childObs.observe(menu, { childList: true, subtree: true });
      setTimeout(() => childObs.disconnect(), 2000);
      return;
    }

    // Clone for styling but strip data-* / id / aria attributes that the
    // framework might use for event delegation — otherwise the clone may
    // get treated as a second "Listen" by Gemini's handlers.
    const dl = listen.cloneNode(true);
    sanitizeClone(dl);
    dl.dataset.geminiTtsDownload = "1";

    const labelEl = findFirstTextHost(dl);
    if (labelEl) labelEl.textContent = "Download";
    else dl.textContent = "Download";

    listen.insertAdjacentElement("afterend", dl);

    // Use both pointerdown and click to make sure our handler runs whether
    // Gemini's framework binds to one or the other.
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Find the live Listen reference (may have changed since injection).
      const liveListen = findListenItem(menu) || listen;
      onDownloadClick(menu, liveListen);
    };
    dl.addEventListener("pointerdown", handler, true);
    dl.addEventListener("click", handler, true);

    console.log("[gemini-tts] Download menu item injected");
  }

  // Strip framework-internal attributes from a cloned element so it doesn't
  // get treated as the original by event delegation.
  function sanitizeClone(root) {
    const ATTRS_TO_STRIP = /^(id|data-|aria-|jsaction|jslog|ng-|_ng|formcontrolname)/i;
    const walk = (el) => {
      if (!(el instanceof Element)) return;
      // Snapshot attribute names since we mutate during iteration.
      for (const name of [...el.getAttributeNames()]) {
        if (ATTRS_TO_STRIP.test(name)) el.removeAttribute(name);
      }
      for (const child of el.children) walk(child);
    };
    walk(root);
  }

  function findFirstTextHost(root) {
    // Find the deepest single-text-node child to use as the label slot.
    let candidate = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const txt = (node.nodeValue || "").trim();
      if (txt) { candidate = node.parentElement; break; }
    }
    return candidate;
  }

  // -------------------------------------------------------- click handling

  async function onDownloadClick(menu, listenItem) {
    const owningMsg = lastTriggeredMessage
      || findOwningMessage(listenItem)
      || findOwningMessage(menu);
    const title = readConversationTitle();
    const messageIndex = computeMessageIndex(owningMsg);
    const requestId = crypto.randomUUID();

    console.log("[gemini-tts] Download clicked", { requestId, title, messageIndex });

    const timeoutHandle = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        toast("Audio didn't arrive in time — try again", "error");
        console.warn("[gemini-tts] capture timed out");
      }
    }, ARM_TIMEOUT_MS + 2000);

    pending.set(requestId, { title, messageIndex, timeoutHandle, listenItem });

    // ARM/ARMED handshake: send ARM, wait for the page world to ack ARMED
    // before dispatching the click. This avoids a race where the click
    // handler fires the network request synchronously before the page
    // world has processed the queued ARM message.
    window.postMessage(
      { type: "GEMINI_TTS_ARM", requestId, timeoutMs: ARM_TIMEOUT_MS },
      "*"
    );
    console.log("[gemini-tts] ARM posted, waiting for ack before triggering Listen");
  }

  function dispatchListenClickFor(requestId) {
    const ctx = pending.get(requestId);
    if (!ctx) return;
    try {
      simulateUserClick(ctx.listenItem);
      console.log("[gemini-tts] Listen click dispatched");
    } catch (err) {
      clearTimeout(ctx.timeoutHandle);
      pending.delete(requestId);
      toast("Couldn't trigger Listen — Gemini layout may have changed", "error");
      console.error("[gemini-tts] listen click failed", err);
    }
  }

  function simulateUserClick(el) {
    if (!el || !el.isConnected) {
      throw new Error("Listen element is no longer in DOM");
    }
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    // Pointer events first (modern frameworks), then mouse, then click.
    try { el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" })); } catch {}
    try { el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" })); } catch {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    // Fall back to .click() too, in case any of the above were prevented.
    if (typeof el.click === "function") el.click();
  }

  // -------------------------------------------------------- page → CS messages

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "GEMINI_TTS_ARMED") {
      console.log("[gemini-tts] ack received, triggering Listen", msg.requestId);
      dispatchListenClickFor(msg.requestId);
    } else if (msg.type === "GEMINI_TTS_READY") {
      handleReady(msg);
    } else if (msg.type === "GEMINI_TTS_ERROR") {
      handleError(msg);
    }
  });

  function handleReady({ requestId, bytes, mimeType }) {
    const ctx = pending.get(requestId);
    if (!ctx) {
      log("READY for unknown requestId; ignoring", requestId);
      return;
    }
    clearTimeout(ctx.timeoutHandle);
    pending.delete(requestId);

    const filename = geminiTTSFilename.composeFilename({
      title: ctx.title,
      messageIndex: ctx.messageIndex,
      mimeType,
    });

    const size = bytes?.byteLength
      ?? bytes?.length
      ?? (bytes?.size /* Blob */) ?? "unknown";
    console.log("[gemini-tts] saving file", {
      requestId, filename, mimeType, size, bytesType: bytes?.constructor?.name,
    });

    try {
      saveBlobAsFile(bytes, mimeType, filename);
      toast(`Saved ${filename}`, "success");
    } catch (err) {
      console.error("[gemini-tts] save failed:", err);
      toast(`Download failed: ${err.message || err}`, "error");
    }
  }

  // Trigger a browser download for a binary payload by creating a Blob,
  // minting a blob URL, and clicking a hidden anchor. We skip the service
  // worker round-trip entirely — chrome.runtime.sendMessage has a long-
  // standing quirk where ArrayBuffers arrive as plain objects in the SW,
  // breaking instanceof checks. Doing it locally avoids the issue and is
  // simpler.
  function saveBlobAsFile(bytes, mimeType, filename) {
    if (!bytes) throw new Error("no audio data");
    const blob = bytes instanceof Blob
      ? bytes
      : new Blob([bytes], { type: mimeType || "application/octet-stream" });
    if (blob.size === 0) throw new Error("captured audio is empty");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 2000);
  }

  function handleError({ requestId, code, message }) {
    const ctx = pending.get(requestId);
    if (ctx) {
      clearTimeout(ctx.timeoutHandle);
      pending.delete(requestId);
    }
    const friendly = {
      CAPTURE_TIMEOUT: "Audio didn't arrive in time — try again",
      FETCH_FAILED: "Network error while fetching audio",
    }[code] || message || "Download failed";
    toast(friendly, "error");
  }

  // -------------------------------------------------------- DOM observer

  const menuObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (!m.addedNodes) continue;
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches && node.matches(SELECTORS.menu)) {
          injectDownloadItem(node);
        } else {
          // Menu may be nested inside an added overlay container.
          node.querySelectorAll && node.querySelectorAll(SELECTORS.menu).forEach(injectDownloadItem);
        }
      }
    }
  });
  menuObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Catch any menus that already exist when the script loads.
  document.querySelectorAll(SELECTORS.menu).forEach(injectDownloadItem);

  log("content script ready");
})();
