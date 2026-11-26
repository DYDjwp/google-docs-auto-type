"use strict";

/**
 * Bridges privileged Chrome APIs for the current Google Docs tab.
 * The default build contains no debugger permission and never attaches CDP.
 * The separate Hybrid build enables CDP, but only after iframe fails or the
 * user deliberately selects it.
 */
const HAS_CDP = chrome.runtime.getManifest().permissions.includes("debugger");
const UNINSTALL_URL = "https://dydjwp.github.io/google-docs-auto-type/uninstall";

// Chrome persists the URL across service-worker restarts. Register it on
// install and update; opening the page alone does not submit any feedback.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.setUninstallURL(UNINSTALL_URL).catch(error => {
    console.warn("[Auto Type] Unable to register uninstall feedback URL:", error?.message || String(error));
  });
});
const attachedTabs = new Set();
const pendingAttach = new Map();
const pendingDetach = new Map();
const generations = new Map();
const owners = new Map();
const generation = tabId => generations.get(tabId) || 0;
const invalidate = tabId => generations.set(tabId, generation(tabId) + 1);
const documentKey = url => /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(url || "")?.[1] || null;
const isDocs = url => /^https:\/\/docs\.google\.com\/document\//.test(url || "");

async function attach(tabId) {
  if (!HAS_CDP) throw new Error("CDP is unavailable in the iframe-only build");
  if (pendingDetach.has(tabId)) await pendingDetach.get(tabId);
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
  if (pendingDetach.has(tabId)) return pendingDetach.get(tabId);
  if (!attachedTabs.delete(tabId)) return;
  const promise = (async () => {
    try { await chrome.debugger.detach({tabId}); }
    catch { /* The tab or debugger has already closed. */ }
  })();
  pendingDetach.set(tabId, promise);
  try { await promise; }
  finally { pendingDetach.delete(tabId); }
}

async function insertCharacter(tabId, char, sender, sessionId) {
  if (sender.frameId !== 0 || !sender.documentId || typeof sessionId !== "string" || !sessionId)
    throw new Error("CDP requires a current document session; reload Google Docs");
  const key = documentKey(sender.url || sender.tab?.url);
  if (!key) throw new Error("No Google Docs document");
  const epoch = generation(tabId);
  const owner = sender.documentId + ":" + sessionId;
  const validate = async () => {
    const tab = await chrome.tabs.get(tabId);
    if (documentKey(tab.url) !== key || generation(tabId) !== epoch)
      throw new Error("Google Docs document changed");
    // Target the exact originating document, not whichever script is now in this tab.
    const result = await chrome.tabs.sendMessage(tabId, {type:"AT_PAGE_CDP_VALIDATE", sessionId},
      {documentId:sender.documentId});
    if (!result?.ok || generation(tabId) !== epoch || owners.get(tabId) !== owner)
      throw new Error("CDP typing session is no longer active");
  };
  const current = owners.get(tabId);
  if (current && current !== owner) throw new Error("Another CDP session owns this tab");
  owners.set(tabId, owner);
  await validate();
  await attach(tabId);
  await validate();
  // No additional awaited operation between validation and dispatch.
  const target = {tabId};
  if (char === "\n") {
    const base = {key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13};
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {type:"keyDown", ...base});
    await validate();
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {type:"keyUp", ...base});
  } else {
    await chrome.debugger.sendCommand(target, "Input.insertText", {text:char});
  }
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
        await insertCharacter(tabId, message.char, sender, message.sessionId);
        break;
      case "AT_BG_BACKSPACE":
        // Compatibility guard for old content scripts left open after update.
        // Do not allow any tab-focused CDP destructive correction.
        throw new Error("CDP Backspace is disabled to protect document content");
      case "AT_BG_DETACH":
        if (owners.get(tabId) === sender.documentId + ":" + message.sessionId) {
          owners.delete(tabId);
          invalidate(tabId);
          await detach(tabId);
        }
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
  chrome.debugger.onDetach.addListener(({tabId}) => { attachedTabs.delete(tabId); });
  chrome.tabs.onRemoved.addListener(tabId => {
    invalidate(tabId);
    owners.delete(tabId);
    attachedTabs.delete(tabId);
    pendingAttach.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url) {
      invalidate(tabId);
      owners.delete(tabId);
      void detach(tabId);
    }
  });
}


// Remove session-only drafts when their tab closes. Register this at top
// level in both editions, not only when Chrome debugger permission exists.
const draftKeyForTab = tabId => `autoTypeDraft:${tabId}`;
chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const prefix = draftKeyForTab(tabId);
    const stored = await chrome.storage.session.get(null);
    const keys = Object.keys(stored).filter(key => key === prefix || key.startsWith(prefix + ":"));
    if (keys.length) await chrome.storage.session.remove(keys);
  })().catch(error => console.warn("[Auto Type] Draft cleanup failed for closed tab", tabId, error));
});

// Browser-level shortcuts work even when the popup is closed and while Docs
// is receiving ordinary keystrokes. Find the active task rather than blindly
// controlling the currently selected tab; typing may continue in background.
const SHORTCUT_COMMANDS = Object.freeze({
  "auto-type-toggle-pause": "AT_PAGE_TOGGLE_PAUSE",
  "auto-type-cancel": "AT_PAGE_STOP"
});

async function getShortcutTarget(commandTab) {
  const tabs = await chrome.tabs.query({url: "https://docs.google.com/document/*"});
  const running = (await Promise.all(tabs.map(async tab => {
    if (!Number.isInteger(tab.id) || !isDocs(tab.url)) return null;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {type: "AT_PAGE_STATUS"});
      return result?.ok && ["running", "paused"].includes(result.status?.state) ? tab : null;
    } catch {
      // Tabs without a live content script do not participate.
      return null;
    }
  }))).filter(Boolean);

  if (!running.length) return null;
  const [foreground] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  // Chrome may supply a command tab that is not running a task.
  // Fall back to the last focused window's active tab before considering
  // cross-tab routing; never choose an arbitrary task when several run.
  const candidateIds = [commandTab?.id, foreground?.id]
    .filter(id => Number.isInteger(id));
  const preferred = candidateIds.map(id => running.find(tab => tab.id === id)).find(Boolean);
  if (preferred) return preferred;

  if (running.length === 1) return running[0];
  // Multiple off-screen tasks are ambiguous; never cancel an arbitrary one.
  console.warn("[Auto Type] Shortcut ignored: multiple background typing sessions.");
  return null;
}

chrome.commands.onCommand.addListener((command, tab) => {
  const type = SHORTCUT_COMMANDS[command];
  if (!type) return;
  void (async () => {
    const target = await getShortcutTarget(tab);
    if (!target) return;
    const response = await chrome.tabs.sendMessage(target.id, {type});
    if (!response?.ok) throw new Error(response?.error || "Shortcut command rejected");
  })().catch(error => console.warn("[Auto Type] Shortcut failed:", command, error?.message || String(error)));
});
