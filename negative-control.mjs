/** Prove the release import gate rejects every binary shipped in 1.13.8. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binaries } from './audit.mjs';
import { inspectDependents } from './import-audit.mjs';

const directory = join(import.meta.dirname, 'dist', 'evidence');
mkdirSync(directory, { recursive: true });
const output = {};
for (const file of binaries) {
  const path = join(import.meta.dirname, 'dist', 'registry-consumer', 'node_modules', '@yudshj', 'sherpa-onnx-win-arm64', file);
  assert.throws(() => inspectDependents(path), error => {
    assert.match(error.message, /^Dynamic MSVC runtime imports:/u);
    output[file] = { rejected: true, reason: error.message };
    return true;
  });
  const raw = execFileSync(process.env.DUMPBIN, ['/NOLOGO', '/DEPENDENTS', path], { encoding: 'utf8' });
  writeFileSync(join(directory, `old-1.13.8-${file}.dependents.txt`), raw.replace(/^Dump of file.*$/mu, `Dump of file ${file}`));
}
writeFileSync(join(directory, 'negative-control.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
