import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".playwright-cli",
  "coverage",
  "dist",
  "node_modules",
  "runtime",
]);

function collectModuleFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...collectModuleFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

const repositoryRoot = path.resolve(process.cwd());
const modules = collectModuleFiles(repositoryRoot).sort();
const failures = [];

for (const filePath of modules) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push({
      filePath: path.relative(repositoryRoot, filePath),
      output: String(result.stderr || result.stdout || "syntax check failed").trim(),
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    process.stderr.write(`${failure.filePath}\n${failure.output}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed for ${modules.length} .mjs files.\n`);
}
