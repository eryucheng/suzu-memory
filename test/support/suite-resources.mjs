import { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Loaded before test registration. This suite hook runs after individual test
// hooks, including their asynchronous worker/server shutdown.
const directories = new Set();
const resources = new Set();

export function createTestDirectory(prefix) {
  const directory = fs.mkdtempSync(prefix);
  directories.add(path.resolve(directory));
  return directory;
}

export function closeAfterTests(resource) {
  resources.add(resource);
  return resource;
}

after(async () => {
  const errors = [];
  for (const resource of [...resources].reverse()) {
    try {
      await resource.close();
    } catch (error) {
      // Earlier explicit close is useful for reopen/migration tests.
      if (!(resource instanceof DatabaseSync && error.code === 'ERR_INVALID_STATE'
        && error.message === 'database is not open')) errors.push(error);
    }
  }
  for (const directory of [...directories].reverse()) {
    try {
      if (!fs.existsSync(directory)) continue;
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Test directory was replaced by a link: ${directory}`);
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  resources.clear();
  directories.clear();
  if (errors.length) throw new AggregateError(errors, 'Test resources could not be released.');
});
