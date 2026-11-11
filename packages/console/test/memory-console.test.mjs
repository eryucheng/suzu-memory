import assert from "node:assert/strict";
import test from "node:test";
import vm from 'node:vm';

import { getMemoryConsoleAsset, memoryConsolePaths } from "../src/index.mjs";

test("console exposes a self-contained review application without a build step", () => {
  assert.deepEqual(memoryConsolePaths(), [
    "/console",
    "/console/",
    "/console/app.js",
    "/console/styles.css",
    "/console/icon.svg",
  ]);
  const page = getMemoryConsoleAsset("/console/");
  assert.equal(page.contentType, "text/html; charset=utf-8");
  assert.match(page.content.toString("utf8"), /记忆审核台/u);
  const application = getMemoryConsoleAsset("/console/app.js");
  assert.equal(application.contentType, 'text/javascript; charset=utf-8');
  assert.ok(application.content.length > 0);
  assert.equal(getMemoryConsoleAsset("/console/unknown"), null);
});

test('switching reviews preserves the new selection and draft when an old read or action finishes', async () => {
  const elements = new Map(), requests = new Map();
  const detail = id => ({ id, type: 'relation', title: `Candidate ${id}`, permissions: { canAccept: true }, writePreview: {} });
  let draft = null;
  const element = selector => {
    if (selector === '#decision-reason') return draft;
    if (selector.startsWith('meta[')) return null;
    if (!elements.has(selector)) {
      const item = { value: selector === '#state-filter' ? 'pending' : '', addEventListener() {}, classList: { toggle() {} }, append() {} };
      let html = '';
      Object.defineProperty(item, 'innerHTML', { get: () => html, set: value => {
        html = value;
        if (selector === '#review-detail') draft = value.includes('id="decision-reason"') ? { value: '' } : null;
      } });
      elements.set(selector, item);
    }
    return elements.get(selector);
  };
  const context = vm.createContext({ URL, URLSearchParams, location: { href: 'http://console.test/' },
    sessionStorage: { getItem() { return ''; } }, setTimeout() {},
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => ({ remove() {} }) },
    fetch: async (endpoint, options = {}) => {
      const key = `${options.method || 'GET'} ${endpoint}`;
      const result = requests.get(key);
      if (result) requests.delete(key);
      const data = result ? await result : String(endpoint).startsWith('/v1/review-console?')
        ? { agentId: 'owner', reviews: { items: [{ id: 'C', type: 'relation' }], total: 1 } }
        : detail(String(endpoint).split('/').at(-1));
      return { ok: true, json: async () => ({ status: 'success', data }) };
    } });
  const source = getMemoryConsoleAsset('/console/app.js').content.toString('utf8')
    .replace(/loadOverview\(\{ preserveSelection: false \}\);\s*$/u, '');
  vm.runInContext(`${source}\nglobalThis.review = { loadDetail, resolveSelected, state };`, context);
  const { review } = context;
  let rejectRead;
  requests.set('GET /v1/review-console/proposals/relation/A', new Promise((_, reject) => { rejectRead = reject; }));
  const oldRead = review.loadDetail('relation', 'A');
  await review.loadDetail('relation', 'B'); draft.value = 'Unsent B reason';
  rejectRead(new Error('Old A failed')); await oldRead;
  assert.match(element('#review-detail').innerHTML, /Candidate B/);
  assert.equal(draft.value, 'Unsent B reason');
  await review.loadDetail('relation', 'A');
  let resolveAction;
  requests.set('POST /v1/high-level-proposals/relation/A/resolve', new Promise(resolve => { resolveAction = resolve; }));
  const oldAction = review.resolveSelected('accept');
  await review.loadDetail('relation', 'B'); draft.value = 'New B draft';
  resolveAction({ status: 'accepted' }); await oldAction;
  assert.equal(review.state.selected.id, 'B');
  assert.match(element('#review-detail').innerHTML, /Candidate B/);
  assert.equal(draft.value, 'New B draft');
});
