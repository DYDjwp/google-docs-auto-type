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
  keyboardLock: false, showOverlay: true
};
const PRESETS = {slow: 180, medium: 300, fast: 520};
const FIELDS = ["cpm", "jitter", "punctuationMs", "newlineMs", "restMinChars",
  "restMaxChars", "restMinMs", "restMaxMs", "microChance", "microMinMs",
  "microMaxMs", "startDelay", "typoChance", "fixChance", "fixPauseMs",
  "deepChance", "deepMinMs", "deepMaxMs"];
const TOGGLES = ["rest", "advancedMode", "keyboardLock", "showOverlay"];
const FEATURES = ["typo", "fixTypo", "deepRest"];
const $ = id => document.getElementById(id);
const HAS_CDP = chrome.runtime.getManifest().permissions.includes("debugger");
let options = {...DEFAULTS};
let activeTabId = null;
let currentState = "idle";
let timer = null;
const isDocs = url => /^https:\/\/docs\.google\.com\/document\//.test(url || "");

function setMessage(message, tone = "idle") {
  $("state").textContent = message;
  $("state").className = `state ${tone}`;
}

function renderOptions() {
  for (const key of FIELDS) $(key).value = options[key];
  for (const key of TOGGLES) $(key).checked = Boolean(options[key]);
  for (const key of FEATURES) {
    $(key).setAttribute("aria-pressed", String(Boolean(options[key])));
    $(key).classList.toggle("selected", Boolean(options[key]));
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

async function persist() {
  try { await chrome.storage.local.set({autoTypeSettings: options}); }
  catch (e) { console.warn("Unable to save settings", e); }
}

function sanitize(key, value) {
  const input = $(key);
  if (String(value).trim() === "" || !Number.isFinite(Number(value))) return DEFAULTS[key];
  const min = Number(input.min || 0);
  const max = Number(input.max || 999999);
  return Math.min(max, Math.max(min, Number(value)));
}

async function pageMessage(type, data = {}) {
  if (!activeTabId) throw new Error("No Google Docs tab found");
  const payload = {type, ...data};
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
  const percentage = total ? Math.round(100 * index / total) : 0;
  $("progress").style.width = `${percentage}%`;
  $("percentage").textContent = `${percentage}%`;
  $("pause").disabled = !["paused", "running"].includes(state);
  $("stop").disabled = !["paused", "running"].includes(state);
  $("start").disabled = ["paused", "running"].includes(state);
  $("pause").textContent = state === "paused" ? "Resume" : "Pause";
  const messages = {
    idle: "Ready · Text will be typed into the current Google Doc",
    running: `Typing ${index}/${total} · ${mode || "preparing"}`,
    paused: `Paused at ${index}/${total}`,
    done: `Sent ${total} characters · Please verify the document`,
    stopped: `Stopped at ${index}/${total}`,
    error: `Error: ${error}`
  };
  setMessage(messages[state] || "Ready", state === "error" ? "error" : state === "done" ? "ok" : "idle");
}

async function refresh() {
  if (!activeTabId) return;
  try {
    const answer = await pageMessage("AT_PAGE_STATUS");
    if (answer?.ok) renderStatus(answer.status);
  } catch (e) { setMessage(`Cannot connect to the document: ${e.message}`, "error"); }
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
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab && isDocs(tab.url)) {
    activeTabId = tab.id;
    $("connected").textContent = "Connected";
    await refresh();
    timer = setInterval(refresh, 850);
  } else {
    $("connected").textContent = "No document";
    $("connected").classList.add("bad");
    $("start").disabled = true;
    setMessage("Open a Google Docs document first", "error");
  }
}

$("text").addEventListener("input", () => {
  const value = $("text").value;
  const lines = value.split("\n").length;
  $("count").textContent = `${Array.from(value).length.toLocaleString()} chars · ${lines} ${lines === 1 ? "line" : "lines"}`;
});

for (const button of document.querySelectorAll(".speed")) {
  button.addEventListener("click", async () => {
    options.speed = button.dataset.speed;
    renderOptions();
    await persist();
  });
}
for (const key of FIELDS) {
  $(key).addEventListener("change", async () => {
    options[key] = sanitize(key, $(key).value);
    renderOptions();
    await persist();
  });
}
for (const key of TOGGLES) {
  $(key).addEventListener("change", async () => {
    options[key] = $(key).checked;
    renderOptions();
    await persist();
  });
}
for (const key of FEATURES) {
  $(key).addEventListener("click", async () => {
    options[key] = !options[key];
    renderOptions();
    await persist();
  });
}
for (const key of ["mode", "deepRestAt", "enterStrategy"]) {
  $(key).addEventListener("change", async () => {
    options[key] = $(key).value;
    await persist();
  });
}
$("reset").addEventListener("click", async () => {
  options = {...DEFAULTS, advancedMode: true};
  renderOptions();
  await persist();
  setMessage("Settings restored to defaults", "ok");
});

$("start").addEventListener("click", async () => {
  const text = $("text").value;
  if (!text.trim()) { setMessage("Paste some text first", "error"); return; }
  if (text.length > 200000) { setMessage("Maximum 200,000 characters per session", "error"); return; }
  if (!activeTabId) return;
  $("start").disabled = true;
  try {
    const answer = await pageMessage("AT_PAGE_START", {text, options});
    if (!answer?.ok) throw new Error(answer?.error || "Could not start");
    renderStatus(answer.status);
    window.close();
  } catch (e) { setMessage(e.message, "error"); $("start").disabled = false; }
});
$("pause").addEventListener("click", async () => {
  try {
    const type = currentState === "paused" ? "AT_PAGE_RESUME" : "AT_PAGE_PAUSE";
    const result = await pageMessage(type);
    if (result?.ok) renderStatus(result.status);
  } catch (e) { setMessage(e.message, "error"); }
});
$("stop").addEventListener("click", async () => {
  try {
    const result = await pageMessage("AT_PAGE_STOP");
    if (result?.ok) renderStatus(result.status);
  } catch (e) { setMessage(e.message, "error"); }
});
window.addEventListener("unload", () => { if (timer) clearInterval(timer); });
init().catch(e => setMessage(`Initialization failed: ${e.message}`, "error"));
