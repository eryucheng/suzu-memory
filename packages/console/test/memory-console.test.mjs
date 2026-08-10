import assert from "node:assert/strict";
import test from "node:test";

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
  const application = getMemoryConsoleAsset("/console/app.js").content.toString("utf8");
  assert.match(application, /review-console/u);
  assert.doesNotMatch(application, /style=/u);
  assert.equal(getMemoryConsoleAsset("/console/unknown"), null);
});
