/** Prove the release import gate rejects every binary shipped in the dynamically linked 1.13.8 release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { binaries } from './audit.mjs';
import { inspectDependents } from './import-audit.mjs';

const url = 'https://registry.npmjs.org/@yudshj/sherpa-onnx-win-arm64/-/sherpa-onnx-win-arm64-1.13.8.tgz';
const integrity = 'nHTPuj4tZ1+eRc8t5nr5gYt1svzh/xPJPhWO1a1J81qBeFx8U/RbNWYZjwzBz9L55Ca9dtTGTXFbeswAJr1IeA==';
const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
if (!response.ok) throw new Error(`1.13.8 download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha512').update(bytes).digest('base64'), integrity, '1.13.8 registry integrity mismatch');

const evidence = join(import.meta.dirname, 'dist', 'evidence');
mkdirSync(evidence, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'sherpa-negative-control-'));
const output = {};
try {
  const archive = join(work, 'old.tgz');
  writeFileSync(archive, bytes);
  await tar.x({ file: archive, cwd: work, strict: true });
  for (const file of binaries) {
    assert.throws(() => inspectDependents(join(work, 'package', file)), error => {
      assert.match(error.message, /^Dynamic MSVC runtime imports:/u);
      output[file] = { rejected: true, reason: error.message };
      return true;
    });
  }
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
writeFileSync(join(evidence, 'negative-control.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
