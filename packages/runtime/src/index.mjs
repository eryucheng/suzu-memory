import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeProjectRoot(projectRoot) {
  const value = clean(projectRoot);
  return value ? path.resolve(value) : "";
}

export function stableAgentId(identity, { platform = process.platform } = {}) {
  const normalized = normalizeProjectRoot(identity);
  if (!normalized) return "";
  const canonical = clean(platform).toLowerCase() === "win32"
    ? normalized.toLowerCase()
    : normalized;
  return `agent-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export function resolveMemoryDataRoot({
  configuredRoot = process.env.SUZU_MEMORY_DATA_ROOT,
  localAppData = process.env.LOCALAPPDATA,
  xdgDataHome = process.env.XDG_DATA_HOME,
  homeDirectory = os.homedir(),
  platform = process.platform,
} = {}) {
  const configured = clean(configuredRoot);
  if (configured) return path.resolve(configured);

  if (platform === "win32" && clean(localAppData)) {
    return path.join(path.resolve(localAppData), "Suzu Memory");
  }
  if (clean(xdgDataHome)) return path.join(path.resolve(xdgDataHome), "suzu-memory");
  if (clean(homeDirectory)) return path.join(path.resolve(homeDirectory), ".local", "share", "suzu-memory");
  throw new Error("Cannot resolve the memory data directory. Set SUZU_MEMORY_DATA_ROOT.");
}

export function resolveAgentDataRoot({ dataRoot, projectRoot = "", agentId = "" } = {}) {
  const root = clean(dataRoot);
  if (!root) throw new Error("resolveAgentDataRoot requires dataRoot.");
  const identity = clean(agentId) || stableAgentId(projectRoot);
  if (!identity) throw new Error("resolveAgentDataRoot requires agentId or projectRoot.");
  return path.join(path.resolve(root), "agents", identity);
}
