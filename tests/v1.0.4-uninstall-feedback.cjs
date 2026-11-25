"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const URL = "https://dydjwp.github.io/google-docs-auto-type/uninstall";
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(edition, fail = false) {
  let listener;
  const urls = [], warnings = [];
  const event = {addListener() {}};
  const chrome = {
    runtime: {
      getManifest: () => ({permissions: edition === "hybrid" ? ["debugger"] : []}),
      onInstalled: {addListener(fn) {listener = fn;}},
      onMessage: event,
      async setUninstallURL(url) {
        urls.push(url);
        if (fail) throw new Error("Simulated registration failure");
      }
    },
    tabs: {onRemoved: event, onUpdated: event},
    debugger: {onDetach: event},
    commands: {onCommand: event}
  };
  vm.runInNewContext(fs.readFileSync(edition + "/background.js", "utf8"), {
    chrome, console: {warn: (...args) => warnings.push(args)}, setTimeout
  });
  return {listener, urls, warnings};
}
for (const edition of ["iframe", "hybrid"]) {
  test(edition + ": register exact uninstall feedback URL on install and update", async () => {
    const h = harness(edition);
    assert.equal(typeof h.listener, "function");
    assert.deepEqual(h.urls, []);
    h.listener({reason: "install"});
    h.listener({reason: "update"});
    await flush();
    assert.deepEqual(h.urls, [URL, URL]);
    assert.deepEqual(h.warnings, []);
  });
  test(edition + ": registration failure is handled without disrupting other background events", async () => {
    const h = harness(edition, true);
    h.listener({reason: "install"});
    await flush();
    assert.deepEqual(h.urls, [URL]);
    assert.equal(h.warnings.length, 1);
  });
}
