/* Experimental dev-only Annotated Canvas activation.
 * Must run in MAIN at document_start, before Docs initializes. Never replace
 * a flag already supplied by an installed, authorized integration.
 * For a Google-authorized deployment, set the actual authorized extension ID
 * here (not an ID belonging to another extension). Reload the Docs tab.
 */
(() => {
  "use strict";
  const authorizedId = ""; // Optional deployment-specific authorized extension ID.
  if (!window._docs_annotate_canvas_by_ext && authorizedId)
    window._docs_annotate_canvas_by_ext = authorizedId;
})();
