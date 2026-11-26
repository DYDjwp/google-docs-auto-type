/* Supply only this installed extension's own ID at document_start. */
(() => {
  "use strict";
  const id = chrome.runtime.id;
  if (typeof id !== "string" || !/^[a-p]{32}$/.test(id)) return;
  const REQUEST = "__auto_type_annotation_id_request__";
  const RESPONSE = "__auto_type_annotation_id_response__";
  const send = () => document.dispatchEvent(new CustomEvent(RESPONSE, {detail:id}));
  document.addEventListener(REQUEST, send);
  send();
  document.addEventListener("DOMContentLoaded", () => {
    document.removeEventListener(REQUEST, send);
  }, {once:true});
})();
