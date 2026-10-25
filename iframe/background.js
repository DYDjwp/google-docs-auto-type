"use strict";

/**
 * Bridges privileged Chrome APIs for the current Google Docs tab.
 * The default build contains no debugger permission and never attaches CDP.
 * The separate Hybrid build enables CDP, but only after iframe fails or the
 * user deliberately selects it.
 */
const HAS_CDP = chrome.runtime.getManifest().permissions.includes("debugger");
const attachedTabs = new Set();
const pendingAttach = new Map();
const isDocs = url => /^https:\/\/docs\.google\.com\/document\//.test(url || "");

async function attach(tabId) {
  if (!HAS_CDP) throw new Error("CDP is unavailable in the iframe-only build");
  if (attachedTabs.has(tabId)) return;
  if (pendingAttach.has(tabId)) return pendingAttach.get(tabId);
  const promise = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isDocs(tab.url)) throw new Error("Google Docs tabs only");
    await chrome.debugger.attach({tabId}, "1.3");
    attachedTabs.add(tabId);
  })();
  pendingAttach.set(tabId, promise);
  try { await promise; }
  finally { pendingAttach.delete(tabId); }
}

async function detach(tabId) {
  if (!HAS_CDP) return;
  if (pendingAttach.has(tabId)) {
    try { await pendingAttach.get(tabId); } catch { /* Not attached. */ }
  }
  if (!attachedTabs.delete(tabId)) return;
  try { await chrome.debugger.detach({tabId}); }
  catch { /* The tab or debugger has already closed. */ }
}

async function pressKey(tabId, key, keyCode) {
  await attach(tabId);
  const target = {tabId};
  const base = {key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode};
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {type: "keyDown", ...base});
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {type: "keyUp", ...base});
}

async function insertCharacter(tabId, char) {
  if (char === "\n") return pressKey(tabId, "Enter", 13);
  await attach(tabId);
  await chrome.debugger.sendCommand({tabId}, "Input.insertText", {text: char});
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || !String(message.type).startsWith("AT_BG_")) return false;
  const tabId = sender.tab?.id;
  if (!tabId || !isDocs(sender.tab?.url)) {
    reply({ok: false, error: "This action requires a Google Docs tab"});
    return false;
  }
  (async () => {
    switch (message.type) {
      case "AT_BG_PREPARE_IFRAME":
        await chrome.scripting.executeScript({
          target: {tabId}, files: ["main-bridge.js"], world: "MAIN"
        });
        break;
      case "AT_BG_INSERT":
        if (typeof message.char !== "string" || [...message.char].length !== 1)
          throw new Error("Expected one character");
        await insertCharacter(tabId, message.char);
        break;
      case "AT_BG_BACKSPACE":
        await pressKey(tabId, "Backspace", 8);
        break;
      case "AT_BG_DETACH":
        await detach(tabId);
        break;
      case "AT_BG_WAIT": {
        // Keep pacing independent of the Docs tab's background timer budget.
        const ms = Number(message.ms);
        if (!Number.isFinite(ms) || ms < 0 || ms > 250)
          throw new Error("Invalid wait duration");
        await new Promise(resolve => setTimeout(resolve, ms));
        break;
      }
      case "AT_BG_BADGE":
        await chrome.action.setBadgeText({tabId, text: String(message.badge || "").slice(0, 4)});
        await chrome.action.setBadgeBackgroundColor({tabId, color: "#2f5f51"});
        break;
      default:
        throw new Error("Unknown command");
    }
    reply({ok: true});
  })().catch(error => reply({ok: false, error: error?.message || String(error)}));
  return true;
});

if (HAS_CDP) {
  chrome.debugger.onDetach.addListener(({tabId}) => attachedTabs.delete(tabId));
  chrome.tabs.onRemoved.addListener(tabId => {
    attachedTabs.delete(tabId);
    pendingAttach.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || (changeInfo.url && !isDocs(changeInfo.url))) {
      void detach(tabId);
    }
  });
}
