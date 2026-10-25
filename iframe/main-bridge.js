/**
 * Runs in the page's MAIN world so synthetic events are created beside
 * Google Docs' own event handlers (not in the extension's isolated world).
 *
 * This uses a private Docs input target and may break after a Docs update.
 * The return value confirms delivery to the target, NOT document acceptance.
 */
(() => {
  "use strict";

  const VERSION = "v3";
  const MARKER = `__AUTO_TYPE_BRIDGE_${VERSION}__`;
  if (window[MARKER]) return;
  window[MARKER] = true;

  const REQUEST = `__auto_type_main_request_${VERSION}__`;
  const RESPONSE = `__auto_type_main_response_${VERSION}__`;

  let previousTarget = null;

  function getTarget() {
    const frame = document.querySelector("iframe.docs-texteventtarget-iframe");
    const doc = frame?.contentDocument;
    if (!doc) {
      throw new Error("Google Docs input iframe is unavailable. Click the document and try again.");
    }
    // Once a tab becomes inactive, activeElement may fall back to <body>.
    // Retain the last valid input node without trying to refocus the tab.
    const active = doc.activeElement;
    const remembered = previousTarget?.isConnected && previousTarget.ownerDocument === doc
      ? previousTarget : null;
    const target = active && active !== doc.body ? active : (remembered || active || doc.body);
    if (!target?.dispatchEvent) {
      throw new Error("Google Docs input target is unavailable. Click the document and try again.");
    }
    previousTarget = target;
    return target;
  }

  // Use Event, not KeyboardEvent: this matches the manually verified Docs code.
  function legacyKey(target, type, key, code, modifiers = {}) {
    const event = new Event(type, {bubbles: true, cancelable: true});
    event.key = key;
    event.code = key === "Enter" || key === "Backspace" ? key : "";
    event.keyCode = code;
    event.which = code;
    event.shiftKey = Boolean(modifiers.shiftKey);
    target.dispatchEvent(event);
  }

  function typeCharacter(char) {
    legacyKey(getTarget(), "keypress", char, char.codePointAt(0));
  }

  function enter(strategy) {
    const target = getTarget();
    if (strategy !== "keypress") legacyKey(target, "keydown", "Enter", 13);
    if (strategy !== "keydown") legacyKey(target, "keypress", "Enter", 13);
    legacyKey(target, "keyup", "Enter", 13);
  }

  function backspace() {
    const target = getTarget();
    legacyKey(target, "keydown", "Backspace", 8);
    legacyKey(target, "keyup", "Backspace", 8);
  }

  document.addEventListener(REQUEST, event => {
    let request;
    let result = {ok: false, error: "Invalid bridge request"};
    try {
      request = JSON.parse(event.detail);
      if (!Number.isSafeInteger(request?.id)) throw new Error("Invalid request ID");
      switch (request.action) {
        case "probe":
          getTarget();
          break;
        case "type":
          if (typeof request.char !== "string" || [...request.char].length !== 1)
            throw new Error("Expected one Unicode character");
          typeCharacter(request.char);
          break;
        case "enter":
          if (!["keydown", "keypress", "both"].includes(request.strategy))
            throw new Error("Invalid Enter strategy");
          enter(request.strategy);
          break;
        case "backspace":
          backspace();
          break;
        default:
          throw new Error("Unknown bridge action");
      }
      result = {ok: true};
    } catch (error) {
      result = {ok: false, error: error?.message || String(error)};
    }
    if (Number.isSafeInteger(request?.id)) {
      document.dispatchEvent(new CustomEvent(RESPONSE, {
        detail: JSON.stringify({id: request.id, ...result})
      }));
    }
  });
})();
