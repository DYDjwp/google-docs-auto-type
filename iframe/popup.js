"use strict";

const DEFAULTS = {
  speed: "medium", advancedMode: false, cpm: 300, jitter: 18,
  punctuationMs: 220, newlineMs: 400, rest: false,
  restMinChars: 80, restMaxChars: 150, restMinMs: 900, restMaxMs: 2300,
  microChance: 3, microMinMs: 150, microMaxMs: 600,
  startDelay: 1, mode: "auto", enterStrategy: "keydown",
  typo: false, fixTypo: false, deepRest: false,
  typoChance: 1.5, fixChance: 3, fixPauseMs: 400,
  deepRestAt: "both", deepChance: 14, deepMinMs: 1300, deepMaxMs: 3600,
  keyboardLock: false, mouseLock: false, showOverlay: true
};
const PRESETS = {slow: 180, medium: 300, fast: 520};
const FIELDS = ["cpm", "jitter", "punctuationMs", "newlineMs", "restMinChars",
  "restMaxChars", "restMinMs", "restMaxMs", "microChance", "microMinMs",
  "microMaxMs", "startDelay", "typoChance", "fixChance", "fixPauseMs",
  "deepChance", "deepMinMs", "deepMaxMs"];
const TOGGLES = ["rest", "advancedMode", "keyboardLock", "mouseLock", "showOverlay"];
const FEATURES = ["typo", "fixTypo", "deepRest"];
const $ = id => document.getElementById(id);
const manifest = chrome.runtime.getManifest();
const HAS_CDP = manifest.permissions.includes("debugger");
// The manifest is the single source of truth, including prerelease names.
const displayVersion = manifest.version_name || manifest.version;
$("extensionVersion").textContent = displayVersion ? `v${displayVersion}` : "";
let options = {...DEFAULTS};
let activeTabId = null;
let activeDocumentId = null;
const documentIdFromUrl = url => /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(url || "")?.[1] || null;
const normalizedText = text => text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
let currentState = "idle";
let currentReadyToStart = false; // Waiting for the first authoritative page status.
let timer = null;
let statusRevision = 0;
let controlPending = false;
let configReady = false;
let configBusy = false;
let settingsSaveTail = Promise.resolve();
const isDocs = url => /^https:\/\/docs\.google\.com\/document\//.test(url || "");

// Preserve unfinished input per document tab for this browser session.
// The popup is destroyed when Start is pressed or the popup is dismissed.
let draftSaveTail = Promise.resolve();
let draftRevision = 0;
let savedDraftRevision = 0;
let draftDirty = false;
let draftLoaded = false;
let clearingDraft = false;
let starting = false;
let popupClosing = false;
function draftKey() { return activeTabId && activeDocumentId ? `autoTypeDraft:${activeTabId}:${activeDocumentId}` : null; }
function saveDraft(value, revision = draftRevision) {
  const key = draftKey();
  if (!key) return Promise.resolve();
  // Serialize the entire recovery, not just the initial write. A stale
  // retry must never run after a newer edit or Clear draft.
  draftSaveTail = draftSaveTail.catch(() => {}).then(async () => {
    if (revision !== draftRevision) return;
    try {
      await chrome.storage.session.set({[key]: value});
    } catch (firstError) {
      if (revision !== draftRevision) return;
      if (!popupClosing) showDraftSaveError(
        "Draft not saved yet. Recovering storage; copy your text before closing.");
      await reclaimClosedTabDrafts();
      if (revision !== draftRevision) return;
      await chrome.storage.session.set({[key]: value});
    }
    if (revision === draftRevision) {
      savedDraftRevision = revision;
      if (!popupClosing) hideDraftSaveError();
    }
  });
  return draftSaveTail;
}
function removeDraft() {
  const key = draftKey();
  if (!key) return Promise.resolve();
  draftSaveTail = draftSaveTail.catch(() => {}).then(() =>
    chrome.storage.session.remove(key));
  return draftSaveTail;
}
function updateTextCount() {
  const value = normalizedText($("text").value);
  const lines = value.split("\n").length;
  $("count").textContent = `${Array.from(value).length.toLocaleString()} chars · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

// On a quota error, reclaim drafts belonging to tabs that no longer exist.
// Only our own namespace is removed; active tab drafts and user settings stay.
async function reclaimClosedTabDrafts() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(null)
  ]);
  const live = new Set(tabs.map(tab => tab.id));
  const stale = Object.keys(stored).filter(key => {
    const match = /^autoTypeDraft:(\d+)(?::[^:]+)?$/.exec(key);
    return match && !live.has(Number(match[1]));
  });
  if (stale.length) await chrome.storage.session.remove(stale);
  return stale.length;
}

async function saveDraftForStart(text, revision = draftRevision) {
  try {
    await saveDraft(text, revision);
  } catch (error) {
    // Do not close the popup or start typing without making the data-loss
    // risk explicit. The textarea remains available for copying the input.
    const failure = new Error(
      "Draft could not be saved. Session storage may be full or unavailable. " +
      "Close unused tabs or clear old drafts, then retry. " +
      "Your text is still in this popup: copy it before closing. " +
      `Details: ${error?.message || String(error)}`
    );
    failure.code = "DRAFT_SAVE_FAILED";
    throw failure;
  }
}

function autosaveDraft(text, revision = draftRevision) {
  return saveDraftForStart(text, revision).catch(error => {
    if (revision === draftRevision && !popupClosing) showDraftSaveError(error.message);
    console.warn("[Auto Type] Draft autosave failed:", error.message);
  });
}

function setMessage(message, tone = "idle") {
  $("state").textContent = message;
  $("state").className = `state ${tone}`;
}

// The session status is polled every 850ms; persistent storage failures
// need their own accessible, multiline notice independent of renderStatus.
function showDraftSaveError(message) {
  $("draftErrorText").textContent = message;
  $("draftError").hidden = false;
}
function hideDraftSaveError() {
  $("draftError").hidden = true;
  $("draftErrorText").textContent = "";
}
$("dismissDraftError").addEventListener("click", hideDraftSaveError);

function renderOptions() {
  for (const key of FIELDS) $(key).value = options[key];
  for (const key of TOGGLES) $(key).checked = Boolean(options[key]);
  for (const key of FEATURES) {
    const enabled = key !== "fixTypo" && Boolean(options[key]);
    $(key).setAttribute("aria-pressed", String(enabled));
    $(key).classList.toggle("selected", enabled);
  }
  $("modeRow").hidden = !HAS_CDP;
  $("mode").value = HAS_CDP ? options.mode : "iframe";
  $("enterStrategy").value = options.enterStrategy;
  $("deepRestAt").value = options.deepRestAt;
  $("advancedPanel").hidden = !options.advancedMode;
  $("presetSection").hidden = options.advancedMode;
  document.querySelectorAll(".speed").forEach(button => {
    button.classList.toggle("active", button.dataset.speed === options.speed);
  });
}

// Serialize settings writes so a delayed field edit cannot overwrite an import.
function writeSettings(value) {
  const snapshot = {...value};
  settingsSaveTail = settingsSaveTail.catch(() => {}).then(() =>
    chrome.storage.local.set({autoTypeSettings: snapshot}));
  return settingsSaveTail;
}
async function persist() {
  try { await writeSettings(options); }
  catch (e) { console.warn("Unable to save settings", e); }
}

function configMessage(message, error = false) {
  $("configStatus").textContent = message;
  $("configStatus").classList.toggle("config-error", error);
}
function syncStartButton() {
  // The page, not its visible state label, owns the cleanup lifecycle.
  $("start").disabled = !currentReadyToStart || !configReady || !draftLoaded ||
    !activeTabId || starting || clearingDraft || controlPending || configBusy;
}
function syncConfigControls() {
  const blocked = !configReady || configBusy;
  $("exportConfig").disabled = blocked;
  $("importConfig").disabled = blocked;
  $("configToken").disabled = blocked;
  $("configFormat").disabled = blocked;
  $("downloadConfig").disabled = blocked;
  $("openConfig").disabled = blocked;
  $("configFile").disabled = blocked;
  // Disable every setting control until initial storage retrieval finishes.
  // Event guards below also block synthetic events during that async window.
  for (const key of [...FIELDS, ...TOGGLES, ...FEATURES, "mode", "deepRestAt", "enterStrategy", "reset"])
    $(key).disabled = blocked || ["fixTypo", "fixChance", "fixPauseMs"].includes(key);
  for (const button of document.querySelectorAll(".speed")) button.disabled = blocked;
  syncStartButton();
}
$("exportConfig").addEventListener("click", async () => {
  if (!configReady || configBusy) return;
  const input = $("configToken");
  try {
    const isJSON = $("configFormat").value === "json";
    const token = isJSON ? AutoTypeConfig.encodeJSON(options) : AutoTypeConfig.encode(options);
    input.value = token;
    try {
      await navigator.clipboard.writeText(token);
      if (input.value === token) configMessage("Copied configuration · " + token.length + " characters");
    } catch {
      if (input.value === token) {
        input.focus();
        input.select();
        configMessage((isJSON ? "JSON" : "Token") + " ready (" + token.length + " characters). Copy it manually.");
      }
    }
  } catch (error) { configMessage(error?.message || String(error), true); }
});
// Format selects the export only. Pasted JSON or tokens are auto-detected.
// Changing format does not replace unsaved/pasted input.
$("configFormat").addEventListener("change", () => {
  if (!configReady || configBusy) return;
  configMessage("");
});
$("configToken").addEventListener("input", () => configMessage(""));
$("downloadConfig").addEventListener("click", () => {
  if (!configReady || configBusy) return;
  let url, anchor;
  try {
    const json = AutoTypeConfig.encodeJSON(options);
    url = URL.createObjectURL(new Blob([json + "\n"], {type:"application/json"}));
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "auto-type-config.json";
    document.body.appendChild(anchor);
    anchor.click();
    configMessage("JSON backup download requested.");
  } catch (error) {
    configMessage("Could not download configuration. " + (error?.message || String(error)), true);
  } finally {
    anchor?.remove();
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
$("openConfig").addEventListener("click", () => {
  if (configReady && !configBusy) $("configFile").click();
});
$("configFile").addEventListener("change", async () => {
  const file = $("configFile").files?.[0];
  // Reset even on error so the same file can be chosen again.
  $("configFile").value = "";
  if (!file || !configReady || configBusy || starting) return;
  if (file.size > AutoTypeConfig.maxJSON) {
    configMessage("JSON backup is too large (16 KB maximum).", true);
    return;
  }
  configBusy = true;
  syncConfigControls();
  try {
    const raw = await file.text();
    // Validate before replacing the editor buffer; do not silently apply.
    AutoTypeConfig.decodeJSON(raw);
    $("configToken").value = raw.trim();
    $("configFormat").value = "json";
    configMessage("JSON file loaded. Click Import to apply the configuration.");
  } catch (error) {
    configMessage(error?.message || String(error), true);
  } finally {
    configBusy = false;
    syncConfigControls();
  }
});
$("importConfig").addEventListener("click", async () => {
  if (!configReady || configBusy || starting) return;
  let next;
  try { next = AutoTypeConfig.decodeAny($("configToken").value); }
  catch (error) { configMessage(error?.message || String(error), true); return; }
  const adjusted = !HAS_CDP && next.mode !== "iframe";
  if (adjusted) next.mode = "iframe";
  configBusy = true;
  syncConfigControls();
  configMessage("Saving configuration…");
  try {
    // Do not apply anything until the validated snapshot has been saved.
    await writeSettings(next);
    options = next;
    renderOptions();
    configMessage(adjusted
      ? "Imported. Input mode adjusted to iframe. Applies to the next typing session."
      : "Configuration imported. Applies to the next typing session.");
  } catch (error) {
    configMessage("Configuration not saved. Previous settings kept. " +
      (error?.message || String(error)), true);
  } finally {
    configBusy = false;
    syncConfigControls();
  }
});

function sanitize(key, value) {
  const input = $(key);
  if (String(value).trim() === "" || !Number.isFinite(Number(value))) return DEFAULTS[key];
  const min = Number(input.min || 0);
  const max = Number(input.max || 999999);
  return Math.min(max, Math.max(min, Number(value)));
}

async function pageMessage(type, data = {}) {
  if (!activeTabId) throw new Error("No Google Docs tab found");
  const payload = {type, documentId: activeDocumentId, ...data};
  try { return await chrome.tabs.sendMessage(activeTabId, payload); }
  catch (error) {
    if (!String(error).includes("Receiving end")) throw error;
    await chrome.scripting.executeScript({target: {tabId: activeTabId}, files: ["content.js"]});
    return await chrome.tabs.sendMessage(activeTabId, payload);
  }
}

function renderStatus(status) {
  if (!status) return;
  const {state, index = 0, total = 0, mode = "", error = ""} = status;
  currentState = state;
  // Missing readiness from an outdated content script fails closed rather
  // than re-enabling Start while its cleanup status is unknown.
  currentReadyToStart = status.readyToStart === true;
  const percentage = total ? Math.round(100 * index / total) : 0;
  $("progress").style.width = `${percentage}%`;
  $("percentage").textContent = `${percentage}%`;
  $("pause").disabled = !["paused", "running"].includes(state);
  $("stop").disabled = !["paused", "running"].includes(state);
  syncStartButton();
  $("pause").textContent = state === "paused" ? "Resume" : "Pause";
  const messages = {
    idle: "Ready · Text will be typed into the current Google Doc",
    running: `Typing ${index}/${total} · ${mode || "preparing"}`,
    paused: `Paused at ${index}/${total}${status.pauseReason ? " · " + status.pauseReason : ""}`,
    done: `Sent ${total} characters · Please verify the document`,
    stopped: `Stopped at ${index}/${total}${error ? " · " + error : ""}`,
    error: `Error: ${error}`
  };
  // Old content scripts can survive an unpacked-extension reload in an
  // already open Docs tab. A missing readiness field is not proof of safety:
  // require a document reload rather than silently leaving Start unusable.
  if (typeof status.readyToStart !== "boolean") {
    setMessage("Auto Type was updated. Reload the Google Docs tab to activate the new typing script.", "error");
    return;
  }
  const cleaning = !currentReadyToStart && ["stopped", "done", "error"].includes(state);
  setMessage((messages[state] || "Ready") + (cleaning ? " · Cleaning up…" : ""),
    state === "error" ? "error" : state === "done" && !cleaning ? "ok" : "idle");
}

async function refresh() {
  if (!activeTabId || starting || controlPending) return;
  const revision = ++statusRevision;
  try {
    const answer = await pageMessage("AT_PAGE_STATUS");
    if (!answer?.ok || !answer.status) throw new Error(answer?.error || "No document status");
    if (!popupClosing && revision === statusRevision) renderStatus(answer.status);
  } catch (e) {
    if (!popupClosing && revision === statusRevision) {
      currentReadyToStart = false;
      syncStartButton();
      setMessage(`Cannot connect to the document: ${e.message}`, "error");
    }
  }
}


async function showShortcutHints() {
  if (!chrome.commands?.getAll) return;
  try {
    const commands = await chrome.commands.getAll();
    if (popupClosing) return;
    const shortcut = name => commands.find(item => item.name === name)?.shortcut || "Unassigned";
    $("shortcutHelp").textContent =
      `Pause / resume: ${shortcut("auto-type-toggle-pause")} · Cancel: ${shortcut("auto-type-cancel")}`;
  } catch (error) {
    console.warn("[Auto Type] Unable to read keyboard shortcuts:", error?.message || String(error));
  }
}

async function init() {
  const saved = await chrome.storage.local.get("autoTypeSettings");
  if (saved.autoTypeSettings && typeof saved.autoTypeSettings === "object") {
    options = {...DEFAULTS, ...saved.autoTypeSettings};
  }
  // Interpret a saved custom-speed value as Advanced mode.
  if (!HAS_CDP) options.mode = "iframe";
  if (options.speed === "custom") {
    options.advancedMode = true;
    options.speed = "medium";
  }
  renderOptions();
  configReady = true;
  syncConfigControls();
  void showShortcutHints();
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab && isDocs(tab.url) && documentIdFromUrl(tab.url)) {
    activeDocumentId = documentIdFromUrl(tab.url);
    activeTabId = tab.id;
    $("connected").textContent = "Connected";
    const key = draftKey();
    const stored = await chrome.storage.session.get(key);
    if (popupClosing) return;
    // Never overwrite a user's edit with a late result from storage.
    if (!draftDirty && typeof stored[key] === "string") {
      $("text").value = stored[key];
      updateTextCount();
    }
    draftLoaded = true;
    $("clearDraft").disabled = false;
    // Input might have been edited while the draft was still loading.
    if (draftDirty && savedDraftRevision !== draftRevision)
      void autosaveDraft($("text").value);
    await refresh();
    if (!popupClosing) timer = setInterval(refresh, 850);
  } else {
    $("connected").textContent = "No document";
    $("connected").classList.add("bad");
    $("start").disabled = true;
    setMessage("Open a Google Docs document first", "error");
  }
}

$("text").addEventListener("input", () => {
  updateTextCount();
  draftDirty = true;
  const revision = ++draftRevision;
  // Queue immediately, reducing the chance of the popup closing before a write.
  if (activeTabId && !clearingDraft && !starting)
    void autosaveDraft($("text").value, revision);
});
$("clearDraft").addEventListener("click", async () => {
  if (!activeTabId || !draftLoaded || clearingDraft || starting) return;
  clearingDraft = true;
  ++draftRevision;
  $("clearDraft").disabled = true;
  $("text").disabled = true;
  const previousText = $("text").value;
  $("text").value = "";
  updateTextCount();
  // A later pagehide must not re-save the now-empty input or the old draft.
  draftDirty = false;
  try {
    await removeDraft();
    savedDraftRevision = draftRevision;
    hideDraftSaveError();
    setMessage("Draft cleared for this document", "ok");
  } catch (error) {
    $("text").value = previousText;
    updateTextCount();
    draftDirty = true;
    setMessage(`Could not clear draft: ${error?.message || String(error)}`, "error");
  } finally {
    clearingDraft = false;
    $("text").disabled = false;
    $("clearDraft").disabled = false;
  }
});

for (const button of document.querySelectorAll(".speed")) {
  button.addEventListener("click", async () => {
    if (!configReady || configBusy) return;
    options.speed = button.dataset.speed;
    renderOptions();
    await persist();
  });
}
for (const key of FIELDS) {
  $(key).addEventListener("change", async () => {
    if (!configReady || configBusy || ["fixChance", "fixPauseMs"].includes(key)) return;
    options[key] = sanitize(key, $(key).value);
    renderOptions();
    await persist();
  });
}
for (const key of TOGGLES) {
  $(key).addEventListener("change", async () => {
    if (!configReady || configBusy) return;
    options[key] = $(key).checked;
    renderOptions();
    await persist();
  });
}
for (const key of FEATURES) {
  $(key).addEventListener("click", async () => {
    if (!configReady || configBusy || key === "fixTypo") return;
    options[key] = !options[key];
    renderOptions();
    await persist();
  });
}
for (const key of ["mode", "deepRestAt", "enterStrategy"]) {
  $(key).addEventListener("change", async () => {
    if (!configReady || configBusy) return;
    options[key] = $(key).value;
    await persist();
  });
}
$("reset").addEventListener("click", async () => {
  if (!configReady || configBusy) return;
  options = {...DEFAULTS, advancedMode: true};
  if (!HAS_CDP) options.mode = "iframe";
  renderOptions();
  await persist();
  setMessage("Settings restored to defaults", "ok");
});

$("start").addEventListener("click", async () => {
  const text = $("text").value;
  if (!text.trim()) { setMessage("Paste some text first", "error"); return; }
  if (Array.from(normalizedText(text)).length > 200000) { setMessage("Maximum 200,000 characters per session", "error"); return; }
  if (!currentReadyToStart || !configReady || !activeTabId || !draftLoaded ||
      clearingDraft || starting || controlPending || configBusy) return;
  starting = true;
  ++statusRevision;
  const startOptions = {...options};
  $("start").disabled = true;
  $("clearDraft").disabled = true;
  $("text").disabled = true;
  try {
    // Always finish saving the source text before this popup can close.
    await saveDraftForStart(text);
    // Install the MAIN-world bridge from the popup, independently of the
    // background service worker. This prevents a missing runtime.onMessage
    // receiver from aborting an otherwise healthy iframe typing session.
    if (!HAS_CDP || startOptions.mode !== "cdp") {
      await chrome.scripting.executeScript({
        target: {tabId: activeTabId},
        files: ["main-bridge.js"],
        world: "MAIN"
      });
    }
    const answer = await pageMessage("AT_PAGE_START", {text, options: startOptions});
    if (!answer?.ok) throw new Error(answer?.error || "Could not start");
    renderStatus(answer.status);
    window.close();
  } catch (e) {
    if (e?.code === "DRAFT_SAVE_FAILED") {
      showDraftSaveError(e.message);
      setMessage("Draft not saved", "error");
    } else {
      setMessage(e.message, "error");
    }
  } finally {
    starting = false;
    $("text").disabled = false;
    $("clearDraft").disabled = !draftLoaded || clearingDraft;
    syncStartButton();
  }
});
async function controlTask(type) {
  if (starting || controlPending || !activeTabId) return;
  controlPending = true;
  ++statusRevision; // Ignore status replies issued before the user action.
  $("pause").disabled = true;
  $("stop").disabled = true;
  $("start").disabled = true;
  try {
    const result = await pageMessage(type);
    if (!result?.ok) throw new Error(result?.error || "Could not control task");
    renderStatus(result.status);
  } catch (e) {
    currentReadyToStart = false;
    setMessage(e.message, "error");
  }
  finally {
    controlPending = false;
    const active = ["paused", "running"].includes(currentState);
    $("pause").disabled = !active;
    $("stop").disabled = !active;
    syncStartButton();
  }
}
$("pause").addEventListener("click", () =>
  controlTask(currentState === "paused" ? "AT_PAGE_RESUME" : "AT_PAGE_PAUSE"));
$("stop").addEventListener("click", () => controlTask("AT_PAGE_STOP"));
window.addEventListener("unload", () => { if (timer) clearInterval(timer); });
window.addEventListener("pagehide", () => {
  popupClosing = true;
  // Closing a popup cannot be cancelled reliably. Retry unsaved edits
  // best-effort; the visible warning is produced while the popup is open.
  if (activeTabId && draftDirty && !clearingDraft &&
      savedDraftRevision !== draftRevision)
    void autosaveDraft($("text").value);
});
// Synchronously lock settings before the first awaited storage operation.
syncConfigControls();
init().catch(e => setMessage(`Initialization failed: ${e.message}`, "error"));
