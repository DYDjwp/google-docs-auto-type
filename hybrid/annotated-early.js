/* Dev-only best-effort Docs annotation initialization. Pair with the
 * isolated document_start script to use this installation's own ID.
 * Synchronous two-way events support either injection order.
 */
(() => {
  "use strict";
  if (window._docs_annotate_canvas_by_ext) return;
  const REQUEST = "__auto_type_annotation_id_request__";
  const RESPONSE = "__auto_type_annotation_id_response__";
  const receive = event => {
    const id = event.detail;
    if (typeof id !== "string" || !/^[a-p]{32}$/.test(id)) return;
    if (!window._docs_annotate_canvas_by_ext)
      window._docs_annotate_canvas_by_ext = id;
    document.removeEventListener(RESPONSE, receive);
  };
  document.addEventListener(RESPONSE, receive);
  document.dispatchEvent(new Event(REQUEST));
  document.addEventListener("DOMContentLoaded", () => {
    document.removeEventListener(RESPONSE, receive);
  }, {once:true});
})();
