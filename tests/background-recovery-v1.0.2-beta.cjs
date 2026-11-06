"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function makeTimingHarness(outcomes) {
  let now = 0;
  const calls = [];
  const warnings = [];
  const infos = [];
  const responses = [...outcomes];
  const chrome = {
    runtime: {
      getManifest: () => ({permissions: []}),
      onMessage: {addListener() {}},
      async sendMessage(message) {
        calls.push(message);
        const outcome = responses.shift() || "missing";
        if (outcome === "missing") {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (outcome === "closed") {
          throw new Error("The message channel closed before a response was received.");
        }
        if (outcome === "invalid") return {ok: false, error: "Invalid wait duration"};
        if (outcome === "ok") return {ok: true};
        throw new Error("Unexpected outcome " + outcome);
      }
    }
  };
  const source = fs.readFileSync("iframe/content.js", "utf8");
  const needle = "  chrome.runtime.onMessage.addListener((message, sender, respond) => {";
  assert.equal(source.split(needle).length, 2, "test hook anchor must remain unique");
  const injected = source.replace(needle,
    "  globalThis.__timingTest = {backgroundWait, fallback: () => localWaitFallback, " +
    "nextProbe: () => nextBackgroundProbeAt, setCDP: () => {job = {mode: 'CDP'};}};\n" + needle);
  const context = {
    chrome,
    document: {addEventListener() {}},
    window: {},
    performance: {now: () => now},
    setTimeout(callback, ms) {
      now += ms;
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    setInterval() {return 1;},
    clearInterval() {},
    console: {warn: (...args) => warnings.push(args), info: (...args) => infos.push(args)},
    Event: class {}, CustomEvent: class {}
  };
  vm.runInNewContext(injected, context);
  return {
    backgroundWait: context.__timingTest.backgroundWait,
    fallback: context.__timingTest.fallback,
    nextProbe: context.__timingTest.nextProbe,
    setCDP: context.__timingTest.setCDP,
    calls, warnings, infos,
    get now() {return now;},
    advanceTime(ms) {now += ms;}
  };
}

test("retries an absent service worker up to three times, with backoff, before succeeding", async () => {
  const h = makeTimingHarness(["missing", "closed", "ok"]);
  await h.backgroundWait(70);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map(call => call.type), ["AT_BG_WAIT", "AT_BG_WAIT", "AT_BG_WAIT"]);
  assert.equal(h.now, 380, "bounded retry delays of 120ms + 260ms");
  assert.equal(h.fallback(), false);
  assert.equal(h.warnings.length, 0);
});

test("after three missing receivers, local timing is used and probes are rate limited", async () => {
  const h = makeTimingHarness(["missing", "missing", "missing", "ok"]);
  await h.backgroundWait(80);
  assert.equal(h.calls.length, 3);
  assert.equal(h.fallback(), true);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][1].command, "AT_BG_WAIT");
  assert.equal(h.warnings[0][1].attempts, 3);
  const next = h.nextProbe();
  assert.equal(next - h.now, 4920, "recovery scheduled 5 seconds from start of local wait");
  await h.backgroundWait(60);
  assert.equal(h.calls.length, 3, "fallback should not spam worker per character");
  h.advanceTime(5000);
  await h.backgroundWait(30);
  assert.equal(h.calls.length, 4, "one probe tries worker again");
  assert.equal(h.fallback(), false);
  assert.equal(h.infos.length, 1, "logs restoration once");
  assert.equal(h.warnings.length, 1);
});

test("failed recovery probe stays in local mode and re-arms another interval", async () => {
  const h = makeTimingHarness(["missing", "missing", "missing", "missing", "ok"]);
  await h.backgroundWait(50);
  const firstProbe = h.nextProbe();
  h.advanceTime(firstProbe - h.now + 1);
  await h.backgroundWait(50);
  assert.equal(h.calls.length, 4, "recovery probing is single-attempt");
  assert.equal(h.fallback(), true);
  assert.equal(h.warnings.length, 1, "avoid noisy repeated warnings");
  const secondProbe = h.nextProbe();
  h.advanceTime(secondProbe - h.now + 1);
  await h.backgroundWait(50);
  assert.equal(h.calls.length, 5);
  assert.equal(h.fallback(), false);
  assert.equal(h.infos.length, 1);
});

test("unexpected service worker errors are never treated as missing receiver", async () => {
  const h = makeTimingHarness(["invalid"]);
  await assert.rejects(h.backgroundWait(50), /Invalid wait duration/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.fallback(), false);
});

test("CDP requires a working worker and will not claim a local-only fallback", async () => {
  const h = makeTimingHarness(["missing", "missing", "missing"]);
  h.setCDP();
  await assert.rejects(h.backgroundWait(50), /Receiving end does not exist/);
  assert.equal(h.calls.length, 3);
  assert.equal(h.warnings.length, 0);
});

test("the two editions carry identical timing logic", () => {
  assert.equal(
    fs.readFileSync("iframe/content.js", "utf8"),
    fs.readFileSync("hybrid/content.js", "utf8")
  );
});
