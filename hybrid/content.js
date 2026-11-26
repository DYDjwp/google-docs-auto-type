(() => {
  "use strict";
  if (globalThis.__AUTO_TYPE_V13_LOADED__) return;
  globalThis.__AUTO_TYPE_V13_LOADED__ = true;

  const HAS_CDP = chrome.runtime.getManifest().permissions.includes("debugger");
  let job = null;
  let overlay = null;
  let noticeHost = null;
  const PRESETS = {slow: 180, medium: 300, fast: 520};
  const NEIGHBORS = {
    a:"sqwz", b:"vghn", c:"xdfv", d:"sferxc", e:"wrsd", f:"drtgvc", g:"ftyhbv",
    h:"gyujnb", i:"uojk", j:"huikmn", k:"jiolm", l:"kop", m:"njk", n:"bhjm",
    o:"ipkl", p:"ol", q:"wa", r:"etdf", s:"awedxz", t:"ryfg", u:"yihj",
    v:"cfgb", w:"qase", x:"zsdc", y:"tugh", z:"asx"
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  const randomInt = (min, max) => Math.round(min + Math.random() * Math.max(0, max - min));
  const isActive = task => job === task && ["running", "paused"].includes(task.state);

  function normalize(options) {
    const o = options || {};
    const advancedMode = Boolean(o.advancedMode);
    const preset = PRESETS[o.speed] || PRESETS.medium;
    return {
      advancedMode,
      cpm: advancedMode ? clamp(o.cpm, 30, 1800) : preset,
      jitter: clamp(o.jitter ?? 18, 0, 90),
      punctuationMs: clamp(o.punctuationMs ?? 220, 0, 3000),
      newlineMs: clamp(o.newlineMs ?? 400, 0, 5000),
      rest: Boolean(o.rest),
      restMinChars: clamp(o.restMinChars ?? 80, 5, 10000),
      restMaxChars: clamp(o.restMaxChars ?? 150, 5, 10000),
      restMinMs: clamp(o.restMinMs ?? 900, 0, 60000),
      restMaxMs: clamp(o.restMaxMs ?? 2300, 0, 60000),
      microChance: clamp(o.microChance ?? 3, 0, 100),
      microMinMs: clamp(o.microMinMs ?? 150, 0, 10000),
      microMaxMs: clamp(o.microMaxMs ?? 600, 0, 10000),
      startDelay: clamp(o.startDelay ?? 1, 0, 15),
      mode: HAS_CDP && ["auto", "iframe", "cdp"].includes(o.mode) ? o.mode : "iframe",
      enterStrategy: ["keydown", "keypress", "both"].includes(o.enterStrategy) ? o.enterStrategy : "keydown",
      typo: Boolean(o.typo), fixTypo: Boolean(o.fixTypo), deepRest: Boolean(o.deepRest),
      typoChance: clamp(o.typoChance ?? 1.5, 0, 35),
      fixChance: clamp(o.fixChance ?? 3, 0, 35),
      fixPauseMs: clamp(o.fixPauseMs ?? 400, 0, 3000),
      deepRestAt: ["word", "sentence", "both"].includes(o.deepRestAt) ? o.deepRestAt : "both",
      deepChance: clamp(o.deepChance ?? 14, 0, 100),
      deepMinMs: clamp(o.deepMinMs ?? 1300, 0, 120000),
      deepMaxMs: clamp(o.deepMaxMs ?? 3600, 0, 120000),
      keyboardLock: advancedMode && Boolean(o.keyboardLock),
      mouseLock: advancedMode && Boolean(o.mouseLock),
      showOverlay: !advancedMode || o.showOverlay !== false,
      notifications: o.notifications !== false
    };
  }

  function getStatus() {
    if (!job) return {state: "idle", index: 0, total: 0, mode: "", error: "", readyToStart: true};
    return {
      state: job.state, index: job.index, total: job.chars.length,
      mode: job.mode, error: job.error || "", pauseReason: job.pauseReason || "", notice: job.notice || "", restoring: !!job.restoring,
      // "stopped", "done" and "error" may be reported while asynchronous
      // waits, debugger detach, and event-listener cleanup remain in flight.
      // Only a finalized task can safely be replaced with a new task.
      readyToStart: job.finalized && !["running", "paused"].includes(job.state)
    };
  }

  function frameTarget() {
    const frame = document.querySelector("iframe.docs-texteventtarget-iframe");
    if (!frame) return null;
    try {
      const innerDoc = frame.contentDocument;
      if (!innerDoc) return null;
      const active = innerDoc.activeElement;
      const editable = innerDoc.querySelector('[contenteditable="true"], textarea, input');
      const target = editable || active || innerDoc.body;
      if (!target || !target.dispatchEvent) return null;
      return {frame, doc: innerDoc, target};
    } catch {
      return null;
    }
  }

  function focusFrame(info) {
    try { window.focus(); } catch { /* browser may refuse window focus */ }
    try { info.frame.contentWindow.focus(); } catch { /* harmless */ }
    try { info.target.focus?.({preventScroll: true}); } catch { /* harmless */ }
  }

  // Execute Docs' legacy keypress snippet in MAIN world, where the
  // DevTools Console runs. DOM events provide a narrow bridge; the MAIN
  // bridge cannot access chrome.runtime or the extension's settings.
  const BRIDGE_REQUEST = "__auto_type_main_request_v3__";
  const BRIDGE_RESPONSE = "__auto_type_main_response_v3__";
  let bridgeSequence = 0;

  function bridgeRequest(action, payload = {}, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const id = ++bridgeSequence;
      let timer;
      const onResponse = (event) => {
        let data;
        try { data = JSON.parse(event.detail); }
        catch { return; }
        if (data?.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener(BRIDGE_RESPONSE, onResponse);
        if (data.ok) resolve(data);
        else reject(new Error(data.error || "iframe input failed"));
      };
      document.addEventListener(BRIDGE_RESPONSE, onResponse);
      timer = setTimeout(() => {
        document.removeEventListener(BRIDGE_RESPONSE, onResponse);
        reject(new Error("MAIN-world input bridge did not respond"));
      }, timeoutMs);
      document.dispatchEvent(new CustomEvent(BRIDGE_REQUEST, {
        detail: JSON.stringify({id, action, ...payload})
      }));
    });
  }

  async function prepareIframe() {
    // The popup installs main-bridge.js directly using chrome.scripting.
    // Probe before contacting the service worker so iframe typing works
    // even when Chrome cannot deliver a message to the background listener.
    let firstError;
    try { return await bridgeRequest("probe"); }
    catch (error) { firstError = error; }

    const message = firstError?.message || "";
    if (/MAIN-world input bridge did not respond/.test(message)) {
      // Compatibility path for callers other than the popup.
      // If this throws, we report the missing background receiver explicitly.
      await sendToBackground("AT_BG_PREPARE_IFRAME");
    } else if (!/Google Docs input (?:iframe|target) is unavailable/.test(message)) {
      throw firstError;
    }
    // Retry a temporary Docs iframe replacement without relying on the worker.
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await bridgeRequest("probe"); }
      catch (error) {
        const transient = /Google Docs input (?:iframe|target) is unavailable/.test(error?.message || "");
        if (!transient || attempt === 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  async function insertViaIframe(character, strategy) {
    if (character === "\n") {
      await bridgeRequest("enter", {strategy});
    } else {
      await bridgeRequest("type", {char: character});
    }
    // A successful response means dispatchEvent ran, not that Docs saved it.
    return true;
  }

  async function sendToBackground(type, data = {}) {
    let response;
    try { response = await chrome.runtime.sendMessage({type, ...data}); }
    catch (error) {
      throw new Error(`Background message ${type} failed: ${error?.message || String(error)}`);
    }
    if (!response?.ok) throw new Error(`Background message ${type} failed: ${response?.error || "No reply"}`);
  }
  // Only retry missing/closed receivers. API errors and invalid commands
  // must still surface immediately instead of being silently swallowed.
  const transientBackgroundFailure = error =>
    /Could not establish connection\. Receiving end does not exist\.|(?:message (?:port|channel)|response channel) closed before a response was received/i
      .test(error?.message || "");

  // Chrome normally wakes an idle MV3 worker on incoming extension events.
  // A failed message may be transient (e.g. during extension reload/startup).
  // Do not keep the worker alive unnecessarily; retry, then degrade gracefully.
  const BACKGROUND_RETRY_DELAYS_MS = [0, 120, 260];
  const BACKGROUND_RECOVERY_INTERVAL_MS = 5000;
  const localWait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let localWaitFallback = false;
  let nextBackgroundProbeAt = 0;

  async function backgroundWait(milliseconds) {
    const delay = Math.max(0, Math.ceil(milliseconds));
    if (localWaitFallback && performance.now() < nextBackgroundProbeAt) {
      await localWait(delay);
      return;
    }

    // Three attempts on the first failure; only one probe per recovery
    // interval. A failing worker must not be spammed on every keystroke.
    const attempts = localWaitFallback ? 1 : BACKGROUND_RETRY_DELAYS_MS.length;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await localWait(BACKGROUND_RETRY_DELAYS_MS[attempt]);
      try {
        await sendToBackground("AT_BG_WAIT", {ms: delay});
        if (localWaitFallback) {
          console.info("[Auto Type] Background timing restored; switching back to service worker.", {
            command: "AT_BG_WAIT"
          });
          localWaitFallback = false;
          nextBackgroundProbeAt = 0;
        }
        return;
      } catch (error) {
        if (!transientBackgroundFailure(error)) throw error;
        lastError = error;
      }
    }

    // CDP cannot type when the worker is unavailable: fail explicitly.
    if (job?.mode === "CDP") throw lastError;
    if (!localWaitFallback) {
      console.warn("[Auto Type] Background timing unavailable; switching to local timing and retrying recovery periodically.", {
        command: "AT_BG_WAIT",
        attempts,
        reason: lastError?.message || "No background message receiver"
      });
    }
    localWaitFallback = true;
    nextBackgroundProbeAt = performance.now() + BACKGROUND_RECOVERY_INTERVAL_MS;
    // Local timers are subject to Chrome background-tab throttling.
    await localWait(delay);
  }

  async function pauseAwareWait(task, timeMs) {
    let left = Math.max(0, timeMs);
    while (isActive(task) && (left > 0 || (task.state === "paused"))) {
      const step = (task.state === "paused") ? 100 : Math.min(180, left);
      const started = performance.now();
      await backgroundWait(step);
      if (!(task.state === "paused")) left -= performance.now() - started;
    }
  }

  function notifyBadge(task, force = false) {
    const now = Date.now();
    if (!force && now - (task.lastBadgeAt || 0) < 900) return;
    task.lastBadgeAt = now;
    const badge = task.state === "running"
      ? `${Math.round(100 * task.index / Math.max(1, task.chars.length))}%`
      : task.state === "paused" ? "Ⅱ"
      : task.state === "done" ? "✓" : "";
    void chrome.runtime.sendMessage({type: "AT_BG_BADGE", badge}).catch(() => {});
  }

  function ensureOverlay() {
    if (overlay?.host?.isConnected) return overlay;
    const host = document.createElement("div");
    host.id = "auto-type-widget-root";
    host.style.cssText = "all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483646";
    const root = host.attachShadow({mode: "closed"});
    root.innerHTML = `
      <style>
        *{box-sizing:border-box} .panel{width:270px;padding:14px;border-radius:16px;
        border:1px solid #dfe5ef;background:#fff;color:#1e2636;
        box-shadow:0 14px 42px rgba(21,37,70,.24);font:13px/1.5 system-ui,-apple-system,sans-serif}
        .top{display:flex;align-items:center;justify-content:space-between}
        .brand{font-size:12px;font-weight:700;letter-spacing:0}
        .label{font-size:11px;color:#68776c;margin-top:8px}
        .bar{height:3px;border-radius:3px;background:#dce7df;overflow:hidden;margin-top:9px}
        .fill{height:100%;width:0;background:#327455;transition:width .18s;border-radius:2px}
        .buttons{display:flex;gap:7px;margin-top:11px}
        button{cursor:pointer;border:1px solid #dce3dc;border-radius:6px;font:600 11px system-ui;padding:8px 11px}
        #toggle{color:white;background:#31684d;border-color:#31684d;flex:1}
        #stop{color:#56695d;background:#fff;flex:1}
        #close{background:transparent;border:0;color:#8b978b;padding:0 5px;font-size:17px}
      </style>
      <div class="panel">
        <div class="top"><span class="brand">Auto Type</span><button id="close" title="Hide panel">×</button></div>
        <div class="label" id="status">Ready to type</div>
        <div class="bar"><div class="fill" id="fill"></div></div>
        <div class="buttons"><button id="toggle">Pause</button><button id="stop">Stop</button></div>
      </div>`;
    (document.body || document.documentElement).append(host);
    overlay = {
      host,
      status: root.querySelector("#status"),
      fill: root.querySelector("#fill"),
      toggle: root.querySelector("#toggle"),
      stop: root.querySelector("#stop")
    };
    // Mouse-operated controls must not steal the document's text focus.
    for (const button of [overlay.toggle, overlay.stop, root.querySelector("#close")]) {
      button.addEventListener("mousedown", event => event.preventDefault());
    }
    overlay.toggle.addEventListener("click", () => {
      if (!job) return;
      if (job.state === "paused") resume();
      else if (job.state === "running") pause();
    });
    overlay.stop.addEventListener("click", stop);
    root.querySelector("#close").addEventListener("click", () => host.remove());
    updateOverlay();
    return overlay;
  }

  function updateOverlay() {
    if (!overlay?.host?.isConnected) return;
    const status = getStatus();
    const progress = status.total ? Math.round(status.index * 100 / status.total) : 0;
    const labels = {
      running: `Typing · ${status.index} / ${status.total} · ${status.mode || "preparing"}`,
      paused: `Paused · ${status.index} / ${status.total}${status.pauseReason ? " · " + status.pauseReason : ""}`,
      done: `Sent ${status.total} characters · verify your doc`,
      stopped: `Stopped · ${status.index} / ${status.total}${status.error ? " · " + status.error : ""}`,
      error: `Error: ${status.error || "typing failed"}`,
      idle: "Ready"
    };
    overlay.status.textContent = (labels[status.state] || "preparing") + (status.notice && ["running","done"].includes(status.state) ? " · " + status.notice : "");
    overlay.fill.style.width = `${progress}%`;
    overlay.toggle.textContent = status.restoring ? "Restoring…" : status.state === "paused" ? "Resume" : "Pause";
    overlay.toggle.disabled = status.restoring || !["paused", "running"].includes(status.state);
    overlay.stop.disabled = !["paused", "running"].includes(status.state);
    overlay.toggle.style.opacity = overlay.toggle.disabled ? ".45" : "1";
    overlay.stop.style.opacity = overlay.stop.disabled ? ".45" : "1";
  }

  function showNotice(task, message) {
    if (!task.options.notifications || !message || task.lastNotice === message || !document.createElement) return;
    task.lastNotice = message;
    try {
      noticeHost?.remove();
      const host = document.createElement("div");
      host.id = "auto-type-notice-root";
      host.style.cssText = "all:initial;position:fixed;top:24px;right:24px;z-index:2147483647";
      const root = host.attachShadow({mode:"closed"});
      root.innerHTML = `<style>:host{all:initial}.notice{box-sizing:border-box;width:320px;max-width:90vw;background:white;color:#202124;padding:16px;border:1px solid #dadce0;border-radius:12px;box-shadow:0 8px 32px #0003;font:14px/1.5 system-ui}.title{font-weight:650}.message{margin:8px 0 12px;overflow-wrap:anywhere}button{font:inherit;border:1px solid #dadce0;border-radius:6px;background:#fff;padding:5px 12px;cursor:pointer}</style><div class="notice" role="alert"><div class="title">Auto Type</div><div class="message" id="message"></div><button id="dismiss">Dismiss</button></div>`;
      root.querySelector("#message").textContent = message;
      root.querySelector("#dismiss").addEventListener("mousedown", e=>e.preventDefault());
      root.querySelector("#dismiss").addEventListener("click",()=>{host.remove();if(noticeHost===host)noticeHost=null;});
      (document.body || document.documentElement).append(host);
      noticeHost = host;
    } catch (error) {console.warn("[Auto Type] Notice could not be displayed",error);}
  }
  function isOverlayEvent(event) {
    return [overlay?.host,noticeHost].some(host=>Boolean(host?.isConnected && (
      event.composedPath?.().includes(host) || event.target === host ||
      (event.target?.nodeType && host.contains?.(event.target))
    )));
  }

  const validSelection = s => s && Number.isInteger(s.start) && Number.isInteger(s.end) &&
    s.start >= 0 && s.end >= s.start;
  const sameSelection = (a,b) => validSelection(a) && validSelection(b) &&
    a.start === b.start && a.end === b.end;
  async function readSelection() {
    try {
      const result = await bridgeRequest("selection", {}, 300);
      return validSelection(result.selection) ? result.selection : null;
    } catch { return null; }
  }
  // One input guard per running task. Both top document and live editor
  // iframe are observed; paused/stopped tasks never intercept input.
  const POINTER_EVENTS = ["pointermove", "mousemove", "pointerdown", "pointerup",
    "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu",
    "dragstart", "drag", "dragend", "drop", "selectstart", "wheel"];
  const KEY_EVENTS = ["keydown", "keypress", "keyup"];
  const INPUT_EVENTS = [...POINTER_EVENTS, ...KEY_EVENTS];
  function installInputGuard(task) {
    if (task.guard || task.state !== "running") return;
    const watched = new Set();
    let closed = false, frame = null, timer, observer;
    let innerDoc = null, innerWindow = null;
    const swallow = event => {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onInput = event => {
      if (closed || job !== task || task.state !== "running" ||
          !event.isTrusted || isOverlayEvent(event)) return;
      const type = event.type;
      if (KEY_EVENTS.includes(type)) {
        // Optional keyboard lock is independent from caret monitoring.
        if (task.mode === "CDP" && task.cdpKeyInFlight &&
            task.cdpKeyKind === "Enter" && (event.key === "Enter" || event.keyCode === 13)) return;
        if (task.options.keyboardLock) {
          swallow(event);
          if (type === "keydown" && event.key === "Escape") pause("Escape");
        }
        return;
      }
      if (task.options.mouseLock && (!["pointermove","mousemove"].includes(type) || event.buttons))
        swallow(event);
    };
    const unwatch = node => {
      watched.delete(node);
      for (const type of INPUT_EVENTS) {
        try { node.removeEventListener(type, onInput, true); }
        catch (error) { console.warn("[Auto Type] Input listener cleanup failed", error); }
      }
    };
    const sync = () => {
      if (closed) return;
      const next = document.querySelector("iframe.docs-texteventtarget-iframe");
      if (frame !== next) {
        frame?.removeEventListener?.("load", sync, true);
        frame = next;
        frame?.addEventListener?.("load", sync, true);
      }
      innerDoc = innerWindow = null;
      try { innerDoc = frame?.contentDocument; innerWindow = frame?.contentWindow; }
      catch { /* inaccessible frame; the top document remains protected */ }
      const targets = new Set([window, document, innerWindow, innerDoc]
        .filter(node => node?.addEventListener && node?.removeEventListener));
      for (const node of watched) if (!targets.has(node)) unwatch(node);
      for (const node of targets) {
        if (watched.has(node)) continue;
        watched.add(node);
        for (const type of INPUT_EVENTS)
          node.addEventListener(type, onInput, {capture:true, passive:false});
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      task.guard = null;
      if (timer !== undefined) clearInterval(timer);
      observer?.disconnect();
      try { frame?.removeEventListener?.("load", sync, true); }
      catch (error) { console.warn("[Auto Type] Frame listener cleanup failed", error); }
      for (const node of watched) unwatch(node);
    };
    const refresh = () => {
      try { sync(); }
      catch (error) { console.warn("[Auto Type] Input guard refresh failed", error); stop("Input protection unavailable"); }
    };
    task.guard = {sync, close};
    try {
      sync();
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(records => {
          // Only iframe changes matter, not every Docs canvas mutation.
          const selector = "iframe.docs-texteventtarget-iframe";
          const relevant = node => node?.nodeType === 1 &&
            (node === frame || node.matches?.(selector) || node.querySelector?.(selector));
          if (records.some(record => record.type === "attributes" ? relevant(record.target) :
              [...(record.addedNodes || []), ...(record.removedNodes || [])].some(relevant))) refresh();
        });
        observer.observe(document.documentElement || document,
          {childList:true,subtree:true,attributes:true,attributeFilter:["src","class"]});
      }
      timer = setInterval(() => {refresh();void checkCaret(task);}, 250);
    } catch (error) { close(); throw error; }
  }

  function wrongLetter(char) {
    const candidates = NEIGHBORS[char.toLowerCase()];
    if (!candidates) return null; // avoid corrupting non-Latin text
    const replacement = candidates[randomInt(0, candidates.length - 1)];
    return char === char.toUpperCase() ? replacement.toUpperCase() : replacement;
  }
  function isRestBoundary(char, next, at) {
    const sentence = /[.!?。！？]/u.test(char) || char === "\n";
    const word = /\s/u.test(char) && char !== "\n" && Boolean(next) && !/\s/u.test(next);
    return at === "sentence" ? sentence : at === "word" ? word : sentence || word;
  }

  // Compare logical document offsets, never mouse or keyboard events.
  // The same check runs during rests and immediately before the next input.
  async function checkCaret(task) {
    if (job !== task || task.state !== "running" || task.sending || task.correcting ||
        task.restoring || !task.selectionAvailable || !task.bookmark) return true;
    if (task.caretCheck) return task.caretCheck;
    const expected = task.bookmark;
    const pending = (async () => {
      const actual = await readSelection();
      if (job !== task || task.state !== "running" || task.sending || task.correcting ||
          task.restoring || task.bookmark !== expected) return true;
      if (!actual) {
        // A transient unavailable model is not evidence of movement. Stop only
        // after repeated failures, rather than firing a false movement alert.
        if (++task.caretFailures >= 3) {pause("Document caret verification unavailable");return false;}
        return true;
      }
      task.caretFailures=0;
      if (!sameSelection(actual,expected)) {pause("Document caret moved");return false;}
      return true;
    })();
    task.caretCheck = pending;
    try {return await pending;} finally {if (task.caretCheck === pending)task.caretCheck=null;}
  }
  async function waitForTurn(task) {
    while (isActive(task)) {
      if (task.state === "paused") {await pauseAwareWait(task,0);continue;}
      if (!await checkCaret(task)) continue;
      if (task.state === "running") return true;
    }
    return false;
  }
  async function sendCharacter(task, character) {
    if (!await waitForTurn(task)) return false;
    task.guard?.sync();
    task.sending = true;
    const previous = task.bookmark;
    let sent = false;
    try {
    if (task.mode === "iframe") {
      try { await insertViaIframe(character, task.options.enterStrategy); sent = true; return true; }
      catch (error) {
        // Only retry explicit pre-dispatch failures; a lost reply may mean
        // the character has already been delivered.
        if (task.options.mode === "iframe" || !HAS_CDP ||
            !/Google Docs input (?:iframe|target) is unavailable/.test(error?.message || "")) throw error;
        task.mode = "CDP";
      }
    }
    // A pause may arrive while an explicit pre-dispatch iframe failure
    // is being returned. Do not hold the in-flight flag across Resume.
    if (task.state === "paused") {
      task.sending = false;
      await pauseAwareWait(task,0);
      return isActive(task) ? await sendCharacter(task,character) : false;
    }
    if (!isActive(task)) return false;
    const info = frameTarget();
    if (info) focusFrame(info);
    task.guard?.sync();
    task.cdpKeyInFlight = true;
    task.cdpKeyKind = character === "\n" ? "Enter" : null;
    try { await sendToBackground("AT_BG_INSERT", {char:character, sessionId:task.sessionId}); }
    finally { task.cdpKeyKind = null; task.cdpKeyInFlight = false; }
    sent = true;
    return true;
    } finally {
      if (sent && task.selectionAvailable && previous && isActive(task)) {
        const expected = {start:previous.start + character.length,end:previous.start + character.length};
        // Docs may apply the keystroke asynchronously. Accept only the
        // expected forward offset; never adopt a manually moved caret.
        let actual = await readSelection();
        for (let i=0;i<3 && isActive(task) && !sameSelection(actual,expected);i++) {
          await new Promise(resolve=>setTimeout(resolve,40));
          actual = await readSelection();
        }
        if (isActive(task)) {
          if (sameSelection(actual,expected)) task.bookmark = expected;
          else {
            task.bookmark = null;
            if (task.state === "running") pause("Input position could not be confirmed");
          }
        }
      }
      task.sending = false;
    }
  }

  function pause(reason = "") {
    if (!job || job.state !== "running") return;
    if (job.correcting) {
      stop("Correction interrupted. A temporary typo may remain; review the document.");
      return;
    }
    job.state = "paused";
    job.pauseReason = typeof reason === "string" ? reason : "";
    if (!job.bookmark && !job.sending) job.pauseReason += (job.pauseReason ? " · " : "") +
      "Automatic caret restoration unavailable";
    if (job.pauseReason) showNotice(job,job.pauseReason);
    job.guard?.close();
    updateOverlay();
    notifyBadge(job, true);
  }
  function resume() {
    const task = job;
    if (!task || task.state !== "paused" || task.restoring) return;
    const activate = () => {
      if (job !== task || task.state !== "paused") return;
      task.state = "running";
      task.pauseReason = "";
      try { installInputGuard(task); }
      catch (error) {
        stop("Input protection could not be restored: " + (error?.message || String(error)));
        return;
      }
      updateOverlay();
      notifyBadge(task, true);
    };
    if (task.sending) {
      task.pauseReason = "Input still finishing; restoring when ready.";
    }
    task.restoring = true;
    updateOverlay();
    void (async () => {
      try {
        while (task.sending && job === task && task.state === "paused")
          await new Promise(resolve=>setTimeout(resolve,40));
        if (job !== task || task.state !== "paused") return;
        if (!task.bookmark) throw new Error("No confirmed bookmark");
        const answer = await bridgeRequest("restoreSelection", {selection:task.bookmark,sessionId:task.sessionId}, 1500);
        if (job !== task || task.state !== "paused") return;
        if (!answer.restored) throw new Error("Selection did not match");
        activate();
      } catch {
        if (job === task && task.state === "paused") {
          void bridgeRequest("cancelOperation",{sessionId:task.sessionId},300).catch(()=>{});
          stop("Automatic caret restoration failed. Review the document before starting a new task.");
        }
      } finally {
        task.restoring = false;
        if (job === task) updateOverlay();
      }
    })();
  }
  function stop(reason = "") {
    if (!job || !isActive(job)) return;
    if (job.correcting || job.restoring) void bridgeRequest("cancelOperation",{sessionId:job.sessionId},300).catch(()=>{});
    job.error = typeof reason === "string" && reason ? reason :
      (job.correcting ? "Correction interrupted. A temporary typo may remain; review the document." : job.error);
    job.state = "stopped";
    if (job.error) showNotice(job,job.error);
    job.guard?.close();
    updateOverlay();
    notifyBadge(job, true);
  }
  async function fixCharacter(task, wrong, correct) {
    if (!await waitForTurn(task)) return null;
    if (!task.bookmark) return false;
    task.guard?.sync();
    task.correcting = true;
    try {
      const result = await bridgeRequest("correct", {
        sessionId:task.sessionId, selection:task.bookmark, wrong, correct, delay:task.options.fixPauseMs
      },7000);
      if (result.corrected && isActive(task)) {
        task.bookmark = validSelection(result.selection) ? result.selection : null;
        return true;
      }
      if (result.skipped && isActive(task)) {
        task.notice = "Fix typo skipped: model verification unavailable";
        showNotice(task,task.notice);
        return false;
      }
      if (isActive(task)) stop("Correction not confirmed. Check the document before restarting.");
      return null;
    } catch {
      if (isActive(task)) stop("Correction not confirmed. A temporary typo may remain; review the document.");
      return null;
    } finally { task.correcting = false; }
  }

  async function run(task) {
    try {
      task.phase = "preparing input iframe";
      task.mode = task.options.mode === "cdp" ? "CDP" : "iframe";
      installInputGuard(task);
      if (task.options.mode !== "cdp") {
        try { await prepareIframe(); }
        catch (error) {
          if (task.options.mode === "iframe") throw error;
          if (!HAS_CDP) throw error;
          task.mode = "CDP";
        }
      }
      if (!isActive(task)) return;
      task.phase = "typing";
      if (task.state === "running") {
        const initial = await readSelection();
        if (task.state === "running") {task.bookmark = initial; task.selectionAvailable = !!initial;}
      }
      if (!task.selectionAvailable) {
        task.notice = "Document Selection API unavailable. Automatic caret detection and recovery are unavailable.";
        showNotice(task,task.notice);
      } else if (task.options.fixTypo && task.mode !== "iframe") {
        task.notice = "Fix typo unavailable in CDP mode";
        showNotice(task,task.notice);
      }
      if (task.options.showOverlay) ensureOverlay();
      else if (overlay?.host?.isConnected) overlay.host.remove();
      updateOverlay();
      await pauseAwareWait(task, task.options.startDelay * 1000);
      task.nextRestAt = randomInt(
        Math.min(task.options.restMinChars, task.options.restMaxChars),
        Math.max(task.options.restMinChars, task.options.restMaxChars));

      for (let i = 0; i < task.chars.length && isActive(task); i++) {
        while ((task.state === "paused") && isActive(task)) await backgroundWait(100);
        if (!isActive(task)) break;

        const character = task.chars[i];
        const accidental = wrongLetter(character);
        const wantsFix = task.options.fixTypo && task.selectionAvailable && task.mode === "iframe" &&
          accidental && Math.random() * 100 < task.options.fixChance;
        if (!await waitForTurn(task)) break;
        // Never rebase a lost bookmark onto an arbitrary current caret.
        let fixed = false;
        if (wantsFix && task.bookmark) {
          fixed = await fixCharacter(task,accidental,character);
          if (fixed === null || !isActive(task)) break;
        }
        if (!fixed) {
          const leaveTypo = !wantsFix && accidental && task.options.typo &&
            Math.random() * 100 < task.options.typoChance;
          if (!await sendCharacter(task,leaveTypo ? accidental : character)) break;
        }
        task.index = i + 1;
        task.sinceRest += 1;
        updateOverlay();
        notifyBadge(task);
        if (i + 1 === task.chars.length || !isActive(task)) break;

        let duration = 60000 / task.options.cpm;
        const scale = task.options.jitter / 100;
        duration *= 1 + (Math.random() * 2 - 1) * scale;
        if (character === "\n") duration += task.options.newlineMs;
        else if (/[,.!?;:，。！？；：、]/u.test(character))
          duration += task.options.punctuationMs;
        if (task.options.rest) {
          if (Math.random() * 100 < task.options.microChance) {
            duration += randomInt(
              Math.min(task.options.microMinMs, task.options.microMaxMs),
              Math.max(task.options.microMinMs, task.options.microMaxMs));
          }
          if (task.sinceRest >= task.nextRestAt) {
            duration += randomInt(
              Math.min(task.options.restMinMs, task.options.restMaxMs),
              Math.max(task.options.restMinMs, task.options.restMaxMs));
            task.sinceRest = 0;
            task.nextRestAt = randomInt(
              Math.min(task.options.restMinChars, task.options.restMaxChars),
              Math.max(task.options.restMinChars, task.options.restMaxChars));
          }
        }
        if (task.options.deepRest && isRestBoundary(character, task.chars[i + 1], task.options.deepRestAt)
            && Math.random() * 100 < task.options.deepChance) {
          duration += randomInt(
            Math.min(task.options.deepMinMs, task.options.deepMaxMs),
            Math.max(task.options.deepMinMs, task.options.deepMaxMs));
        }
        await pauseAwareWait(task, Math.max(0, duration));
      }
      if (task.state !== "stopped") task.state = "done";
    } catch (error) {
      task.error = error?.message || String(error);
      if (task.state !== "stopped") {task.state = "error";showNotice(task,task.error); }
      // Diagnostic metadata only; never log source text or typed characters.
      let frame = {present: false};
      try {
        const element = document.querySelector("iframe.docs-texteventtarget-iframe");
        const doc = element?.contentDocument;
        frame = {present: !!element, accessible: !!doc, activeTag: doc?.activeElement?.tagName || null};
      } catch (e) { frame = {present: true, accessible: false, reason: e?.name || "unknown"}; }
      console.error("[Auto Type] session failed", {
        phase: task.phase, index: task.index, total: task.chars.length,
        mode: task.mode, error: task.error, frame
      });
    } finally {
      try {
        task.guard?.close();
        if (HAS_CDP && task.mode === "CDP") {
          try { await sendToBackground("AT_BG_DETACH", {sessionId: task.sessionId}); }
          catch { /* debugger may already be detached */ }
        }
      } finally {
        task.finalized = true;
        try { updateOverlay(); }
        catch (error) { console.warn("[Auto Type] overlay update failed", error); }
        try { notifyBadge(task, true); }
        catch (error) { console.warn("[Auto Type] badge update failed", error); }
      }
    }
  }

  function start(message) {
    if (job && ["running", "paused"].includes(job.state))
      return {ok: false, error: "A typing session is already running. Stop it first."};
    if (job && !job.finalized)
      return {ok: false, error: "Previous typing session is still cleaning up. Try again shortly."};
    const text = String(message.text || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (!text.trim()) return {ok: false, error: "Paste some text first."};
    const chars = Array.from(text);
    if (chars.length > 200000) return {ok: false, error: "Maximum 200,000 characters per session."};
    const options = normalize(message.options);
    noticeHost?.remove();noticeHost=null;
    localWaitFallback = false;
    nextBackgroundProbeAt = 0;
    job = {
      chars, sessionId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}-${++bridgeSequence}`, index: 0, state: "running", pauseReason: "", notice: "", options, mode: "", error: "", sinceRest: 0,
      nextRestAt: 0, lastBadgeAt: 0, cdpKeyInFlight: false, cdpKeyKind: null, finalized: false,
      guard: null, sending: false, bookmark: null, selectionAvailable: false, correcting: false, restoring: false, caretCheck:null, caretFailures:0, lastNotice:""
    };
    if (job.options.showOverlay) ensureOverlay();
    else if (overlay?.host?.isConnected) overlay.host.remove();
    updateOverlay();
    void run(job);
    return {ok: true, status: getStatus()};
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || !String(message.type || "").startsWith("AT_PAGE_")) return false;
    const currentDoc = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(globalThis.location?.href || "")?.[1];
    if (message.documentId && globalThis.location && currentDoc !== message.documentId) {
      respond({ok:false,error:"Document changed; reopen Auto Type"});
      return false;
    }
    switch (message.type) {
      case "AT_PAGE_STATUS": respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_CDP_VALIDATE":
        respond({ok: Boolean(job && isActive(job) && job.mode === "CDP" && job.sessionId === message.sessionId)});
        break;
      case "AT_PAGE_START": respond(start(message)); break;
      case "AT_PAGE_PAUSE": pause(); respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_RESUME": resume(); respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_TOGGLE_PAUSE":
        if (job?.state === "running") pause();
        else if (job?.state === "paused") resume();
        respond({ok: true, status: getStatus()});
        break;
      case "AT_PAGE_STOP": stop(); respond({ok: true, status: getStatus()}); break;
      default: respond({ok: false, error: "Unknown action"});
    }
    return false;
  });
})();
