import fs from "node:fs";
import path from "node:path";
import { aggregateZh4oReports } from "../packages/evaluation/src/zh4o-summary.mjs";

try {
  const args = process.argv.slice(2), files = [];
  let output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--output") {
      output = args[++index];
      if (!output || output.startsWith("--")) throw new Error("--output requires a file.");
    } else if (args[index].startsWith("--")) throw new Error(`Unknown option: ${args[index]}`);
    else files.push(args[index]);
  }
  if (!files.length) throw new Error("Usage: node scripts/summarize-zh4o.mjs <report.json> [report2.json ...] [--output summary.json]");
  const summary = aggregateZh4oReports(files.map(file => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))));
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, text); }
  process.stdout.write(text);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
