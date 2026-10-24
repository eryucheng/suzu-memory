import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function evaluationPreparationKey(value) {
  const revision = value?.codeRevision;
  if (!value?.configSha256 || typeof value.withoutEmbedding !== 'boolean' || !revision
    || (!revision.commit && !revision.workingTreeHash)
    || (revision.dirty !== false && !revision.workingTreeHash)) {
    throw new Error('Missing original memory preparation configuration, overrides or code identity.');
  }
  return JSON.stringify([value.configSha256, value.withoutEmbedding,
    revision.commit, revision.dirty, revision.workingTreeHash]);
}

export function readEvaluationCodeRevision({ repositoryRoot = path.resolve(import.meta.dirname, '../../..') } = {}) {
  const root = path.resolve(repositoryRoot);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const commit = git(['rev-parse', 'HEAD']).trim();
    const scope = ['packages', 'scripts', 'package.json', 'package-lock.json'];
    const dirty = Boolean(git(['status', '--porcelain', '--', ...scope]).trim());
    const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...scope])
      .split('\0').filter(Boolean))].sort();
    const hash = createHash('sha256');
    for (const name of files) {
      const file = path.join(root, name);
      hash.update('\0').update(name).update('\0');
      hash.update(fs.existsSync(file) ? fs.readFileSync(file) : '<deleted>');
    }
    return { commit, dirty, workingTreeHash: hash.digest('hex') };
  } catch { return { commit: '', dirty: null, workingTreeHash: '' }; }
}
