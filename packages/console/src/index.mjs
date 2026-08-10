import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const ASSETS = Object.freeze({
  "/console": ["index.html", "text/html; charset=utf-8"],
  "/console/": ["index.html", "text/html; charset=utf-8"],
  "/console/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/console/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/console/icon.svg": ["icon.svg", "image/svg+xml; charset=utf-8"],
});

export function getMemoryConsoleAsset(pathname) {
  const definition = ASSETS[String(pathname || "")];
  if (!definition) return null;
  const [fileName, contentType] = definition;
  return {
    fileName,
    contentType,
    content: fs.readFileSync(path.join(ASSET_ROOT, fileName)),
  };
}

export function memoryConsolePaths() {
  return Object.keys(ASSETS);
}
