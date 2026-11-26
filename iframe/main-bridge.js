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

  // Probe v1.6: fresh accessor, UTF-16 positions, read-back verification.
  const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
  let operation = null;
  async function annotated() {
    const fn = window._docs_annotate_getAnnotatedText;
    const flag = window._docs_annotate_canvas_by_ext;
    if (typeof fn !== "function" || !flag) return null;
    return await fn.call(window,flag);
  }
  function selection(api) {
    const raw = api?.getSelection?.();
    const value = Array.isArray(raw) ? raw[0] : raw;
    const a = Number(value?.start ?? value?.anchor ?? value?.base);
    const b = Number(value?.end ?? value?.focus ?? value?.extent);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return null;
    return {start:Math.min(a,b),end:Math.max(a,b)};
  }
  const equal = (a,b) => !!a && !!b && a.start === b.start && a.end === b.end;
  const valid = s => s && Number.isInteger(s.start) && Number.isInteger(s.end) &&
    s.start >= 0 && s.end >= s.start;
  async function readSelection() {return selection(await annotated());}
  const currentFrame = () => document.querySelector("iframe.docs-texteventtarget-iframe")?.contentDocument;
  const locationKey = () => window.location?.pathname || "";
  async function perform(request, action) {
    if (operation) throw Error("Another document operation is still running");
    if (typeof request.sessionId !== "string" || !request.sessionId) throw Error("Missing session ID");
    const op = operation = {sessionId:request.sessionId,cancelled:false,frame:currentFrame(),path:locationKey()};
    const active = () => !op.cancelled && operation === op && op.path === locationKey() && op.frame === currentFrame();
    try {return await action(active);}
    finally {if (operation === op) operation = null;}
  }
  async function restore(request,active) {
    const wanted = request.selection;
    if (!valid(wanted)) return {restored:false};
    const api = await annotated();
    if (!active() || typeof api?.setSelection !== "function" || typeof api.getText !== "function") return {restored:false};
    const text = api.getText();
    if (typeof text !== "string" || wanted.end > text.length) return {restored:false};
    if (!equal(selection(api),wanted)) {
      currentFrame()?.querySelector?.('[contenteditable="true"]')?.focus?.();
      if (!active()) return {restored:false};
      api.setSelection(wanted.start,wanted.end);
      await wait(90);
    }
    return {restored:active() && equal(selection(api),wanted)};
  }
  async function correct(request,active) {
    const {wrong,correct:character,delay} = request;
    if (typeof wrong !== "string" || typeof character !== "string" ||
        [...wrong].length !== 1 || [...character].length !== 1 || wrong === character)
      throw Error("Invalid correction");
    const api = await annotated();
    if (!active()) return {corrected:false};
    if (typeof api?.getText !== "function" || typeof api.setSelection !== "function") return {skipped:true};
    const before = api.getText(), point = selection(api);
    if (typeof before !== "string" || !point || point.start !== point.end || point.end > before.length)
      return {skipped:true};
    if (!equal(point,request.selection)) return {corrected:false};
    const start=point.start,end=start+wrong.length;
    const temporary=before.slice(0,start)+wrong+before.slice(start);
    const expected=before.slice(0,start)+character+before.slice(start);
    if (!active()) return {corrected:false};
    typeCharacter(wrong);
    await wait(Math.max(90,Math.min(3000,Number(delay)||0)));
    if (!active()) return {corrected:false};
    const live=await annotated();
    if (!active() || typeof live?.getText !== "function" || typeof live.setSelection !== "function" ||
        live.getText() !== temporary || !equal(selection(live),{start:end,end})) return {corrected:false};
    live.setSelection(start,end);
    await wait(90);
    if (!active() || live.getText() !== temporary || !equal(selection(live),{start,end})) return {corrected:false};
    typeCharacter(character);
    await wait(90);
    if (!active()) return {corrected:false};
    const final=await annotated();
    const wanted={start:start+character.length,end:start+character.length};
    if (!active() || typeof final?.getText !== "function" || final.getText() !== expected ||
        !equal(selection(final),wanted)) return {corrected:false};
    return {corrected:true,selection:wanted};
  }

  document.addEventListener(REQUEST, event => {
    let request;
    let result = {ok: false, error: "Invalid bridge request"};
    try {
      request = JSON.parse(event.detail);
      if (!Number.isSafeInteger(request?.id)) throw new Error("Invalid request ID");
      if (request.action === "cancelOperation") {
        if (operation?.sessionId === request.sessionId) {operation.cancelled = true;operation = null;}
      } else if (["selection","restoreSelection","correct"].includes(request.action)) {
        const respond = value => document.dispatchEvent(new CustomEvent(RESPONSE,{
          detail:JSON.stringify({id:request.id,ok:true,...value})
        }));
        const work=request.action === "selection" ? readSelection().then(selection=>({selection})) :
          perform(request,active=>request.action === "restoreSelection" ? restore(request,active) : correct(request,active));
        void work.then(respond,()=>respond(request.action === "selection" ? {selection:null} : {}));
        return;
      }
      switch (request.action) {
        case "cancelOperation": break;
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
          throw new Error("Automatic Backspace is disabled: editor acceptance cannot be verified");
        default:
          throw new Error("Unknown bridge action");
      }
      result = {ok: true, verifiedCorrection: false};
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
