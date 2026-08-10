import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveAgentDataRoot,
  resolveMemoryDataRoot,
  stableAgentId,
} from "../src/index.mjs";

test("runtime resolves portable storage and stable Agent identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-runtime-"));
  const agentId = stableAgentId(path.join(root, "agent"));
  assert.match(agentId, /^agent-[a-f0-9]{16}$/u);
  assert.equal(resolveMemoryDataRoot({ configuredRoot: path.join(root, "data") }), path.join(root, "data"));
  assert.equal(resolveAgentDataRoot({ dataRoot: path.join(root, "data"), agentId }), path.join(root, "data", "agents", agentId));
});

test("stable Agent identity follows platform path case semantics", () => {
  assert.equal(
    stableAgentId("C:/MemoryProject", { platform: "win32" }),
    stableAgentId("C:/memoryproject", { platform: "win32" }),
  );
  assert.notEqual(
    stableAgentId("/var/lib/MemoryProject", { platform: "linux" }),
    stableAgentId("/var/lib/memoryproject", { platform: "linux" }),
  );
});
