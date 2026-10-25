(() => {
  "use strict";
  if (globalThis.__AUTO_TYPE_V13_LOADED__) return;
  globalThis.__AUTO_TYPE_V13_LOADED__ = true;

  const HAS_CDP = chrome.runtime.getManifest().permissions.includes("debugger");
  let job = null;
  let overlay = null;
  let keyboardLockController = null;
  const PRESETS = {slow: 180, medium: 300, fast: 520};
  const NEIGHBORS = {
    a:"sqwz", b:"vghn", c:"xdfv", d:"sferxc", e:"wrsd", f:"drtgvc", g:"ftyhbv",
    h:"gyujnb", i:"uojk", j:"huikmn", k:"jiolm", l:"kop", m:"njk", n:"bhjm",
    o:"ipkl", p:"ol", q:"wa", r:"etdf", s:"awedxz", t:"ryfg", u:"yihj",
    v:"cfgb", w:"qase", x:"zsdc", y:"tugh", z:"asx"
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  const randomInt = (min, max) => Math.round(min + Math.random() * Math.max(0, max - min));
  const isActive = task => !task.stopped && job === task;

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
      showOverlay: !advancedMode || o.showOverlay !== false
    };
  }

  function getStatus() {
    if (!job) return {state: "idle", index: 0, total: 0, mode: "", error: ""};
    return {
      state: job.state, index: job.index, total: job.chars.length,
      mode: job.mode, error: job.error || ""
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

  function bridgeRequest(action, payload = {}) {
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
      }, 1500);
      document.dispatchEvent(new CustomEvent(BRIDGE_REQUEST, {
        detail: JSON.stringify({id, action, ...payload})
      }));
    });
  }

  async function prepareIframe() {
    // Install into already-open documents on demand. This executes in MAIN,
    // not the default ISOLATED world of content.js.
    await sendToBackground("AT_BG_PREPARE_IFRAME");
    await bridgeRequest("probe");
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
    const response = await chrome.runtime.sendMessage({type, ...data});
    if (!response?.ok) throw new Error(response?.error || "Background connection failed");
  }

  // A Docs tab's timers are throttled after it becomes backgrounded.
  // Schedule short waits in the extension service worker instead. Each
  // round trip also keeps the worker active during an ongoing session.
  async function backgroundWait(milliseconds) {
    await sendToBackground("AT_BG_WAIT", {ms: Math.ceil(milliseconds)});
  }

  async function pauseAwareWait(task, timeMs) {
    let left = Math.max(0, timeMs);
    while (isActive(task) && (left > 0 || task.paused)) {
      const step = task.paused ? 100 : Math.min(180, left);
      const started = performance.now();
      await backgroundWait(step);
      if (!task.paused) left -= performance.now() - started;
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
      paused: `Paused · ${status.index} / ${status.total}`,
      done: `Sent ${status.total} characters · verify your doc`,
      stopped: `Stopped · ${status.index} / ${status.total}`,
      error: `Error: ${status.error || "typing failed"}`,
      idle: "Ready"
    };
    overlay.status.textContent = labels[status.state] || "preparing";
    overlay.fill.style.width = `${progress}%`;
    overlay.toggle.textContent = status.state === "paused" ? "Resume" : "Pause";
    overlay.toggle.disabled = !["paused", "running"].includes(status.state);
    overlay.stop.disabled = !["paused", "running"].includes(status.state);
    overlay.toggle.style.opacity = overlay.toggle.disabled ? ".45" : "1";
    overlay.stop.style.opacity = overlay.stop.disabled ? ".45" : "1";
  }

  // Keyboard lock is local to the Docs tab. Our synthetic iframe events
  // remain untrusted, so this listener does not block the extension itself.
  function enableKeyboardLock(task) {
    if (!task.options.keyboardLock) return;
    disableKeyboardLock();
    const watched = new Set();
    const onKey = event => {
      if (job !== task || task.state !== "running" || !event.isTrusted || task.cdpKeyInFlight) return;
      if (event.type === "keydown" && event.key === "Escape") pause();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const watch = node => {
      if (!node || watched.has(node)) return;
      for (const type of ["keydown", "keypress", "keyup"])
        node.addEventListener(type, onKey, true);
      watched.add(node);
    };
    watch(document);
    const poll = () => {
      const frame = document.querySelector("iframe.docs-texteventtarget-iframe");
      try { watch(frame?.contentDocument); } catch { /* cross-origin */ }
    };
    poll();
    const interval = setInterval(poll, 1000);
    keyboardLockController = () => {
      clearInterval(interval);
      for (const node of watched) {
        for (const type of ["keydown", "keypress", "keyup"])
          node.removeEventListener(type, onKey, true);
      }
    };
  }
  function disableKeyboardLock() {
    if (keyboardLockController) keyboardLockController();
    keyboardLockController = null;
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

  async function sendCharacter(task, character) {
    if (task.mode === "iframe") {
      try { await insertViaIframe(character, task.options.enterStrategy); return; }
      catch (e) {
        if (task.options.mode === "iframe") throw e;
        if (!HAS_CDP) throw e;
        task.mode = "CDP";
      }
    }
    const info = frameTarget();
    if (info) focusFrame(info);
    task.cdpKeyInFlight = true;
    try { await sendToBackground("AT_BG_INSERT", {char: character}); }
    finally { task.cdpKeyInFlight = false; }
  }

  async function sendBackspace(task) {
    // In iframe mode, corrections use exactly the verified Backspace sequence.
    if (task.mode === "iframe") {
      try { await bridgeRequest("backspace"); return; }
      catch (error) {
        if (!HAS_CDP || task.options.mode === "iframe") throw error;
        task.mode = "CDP";
      }
    }
    const info = frameTarget();
    if (info) focusFrame(info);
    task.cdpKeyInFlight = true;
    try { await sendToBackground("AT_BG_BACKSPACE"); }
    finally { task.cdpKeyInFlight = false; }
  }
  function pause() {
    if (!job || job.state !== "running") return;
    job.paused = true;
    job.state = "paused";
    updateOverlay();
    notifyBadge(job, true);
  }
  function resume() {
    if (!job || job.state !== "paused") return;
    job.paused = false;
    job.state = "running";
    updateOverlay();
    notifyBadge(job, true);
  }
  function stop() {
    if (!job || !["running", "paused"].includes(job.state)) return;
    job.stopped = true;
    job.paused = false;
    job.state = "stopped";
    updateOverlay();
    notifyBadge(job, true);
    // The typing loop handles debugger cleanup in its finally block.
  }

  async function run(task) {
    try {
      task.mode = task.options.mode === "cdp" ? "CDP" : "iframe";
      if (task.options.mode !== "cdp") {
        try { await prepareIframe(); }
        catch (error) {
          if (task.options.mode === "iframe") throw error;
          if (!HAS_CDP) throw error;
          task.mode = "CDP";
        }
      }
      if (!isActive(task)) return;
      enableKeyboardLock(task);
      if (task.options.showOverlay) ensureOverlay();
      else if (overlay?.host?.isConnected) overlay.host.remove();
      updateOverlay();
      await pauseAwareWait(task, task.options.startDelay * 1000);
      task.nextRestAt = randomInt(
        Math.min(task.options.restMinChars, task.options.restMaxChars),
        Math.max(task.options.restMinChars, task.options.restMaxChars));

      for (let i = 0; i < task.chars.length && isActive(task); i++) {
        while (task.paused && isActive(task)) await backgroundWait(100);
        if (!isActive(task)) break;

        const character = task.chars[i];
        const accidental = wrongLetter(character);
        const correction = accidental && task.options.fixTypo &&
          Math.random() * 100 < task.options.fixChance;
        const leaveTypo = accidental && !correction && task.options.typo &&
          Math.random() * 100 < task.options.typoChance;

        if (correction) {
          await sendCharacter(task, accidental);
          // Even if Stop is pressed during the pause, undo the temporary
          // wrong character before stopping so the Doc is not left corrupted.
          await pauseAwareWait(task, task.options.fixPauseMs);
          await sendBackspace(task);
          await pauseAwareWait(task, Math.min(250, task.options.fixPauseMs / 2));
          if (isActive(task)) await sendCharacter(task, character);
        } else {
          await sendCharacter(task, leaveTypo ? accidental : character);
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
      task.state = "error";
    } finally {
      disableKeyboardLock();
      try { await sendToBackground("AT_BG_DETACH"); } catch { /* no attached debugger */ }
      updateOverlay();
      notifyBadge(task, true);
    }
  }

  function start(message) {
    if (job && ["running", "paused"].includes(job.state))
      return {ok: false, error: "A typing session is already running. Stop it first."};
    const text = String(message.text || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (!text.trim()) return {ok: false, error: "Paste some text first."};
    if (text.length > 200000) return {ok: false, error: "Maximum 200,000 characters per session."};
    const options = normalize(message.options);
    job = {
      chars: Array.from(text), index: 0, state: "running", stopped: false,
      paused: false, options, mode: "", error: "", sinceRest: 0,
      nextRestAt: 0, lastBadgeAt: 0, cdpKeyInFlight: false
    };
    if (job.options.showOverlay) ensureOverlay();
    else if (overlay?.host?.isConnected) overlay.host.remove();
    updateOverlay();
    void run(job);
    return {ok: true, status: getStatus()};
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || !String(message.type || "").startsWith("AT_PAGE_")) return false;
    switch (message.type) {
      case "AT_PAGE_STATUS": respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_START": respond(start(message)); break;
      case "AT_PAGE_PAUSE": pause(); respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_RESUME": resume(); respond({ok: true, status: getStatus()}); break;
      case "AT_PAGE_STOP": stop(); respond({ok: true, status: getStatus()}); break;
      default: respond({ok: false, error: "Unknown action"});
    }
    return false;
  });
})();
