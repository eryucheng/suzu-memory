import fs from 'node:fs';
import { createMemoryService } from '../../src/index.mjs';
const { options, ready, stopPhase, scope } = JSON.parse(process.argv[2]);
createMemoryService(options).eraseEventSources({ id: 'os-interrupt', scope, onProgress(job) {
  if (job.phase !== stopPhase) return;
  fs.writeFileSync(ready, job.phase);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} });
