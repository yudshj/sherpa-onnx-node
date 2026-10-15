/** Prove the release gate rejects both earlier releases: dynamic C++ runtime imports, and an unsigned ONNX Runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { inspectWindowsBinaries } from './windows-audit.mjs';

const earlier = [
  { version: '1.13.8', integrity: 'nHTPuj4tZ1+eRc8t5nr5gYt1svzh/xPJPhWO1a1J81qBeFx8U/RbNWYZjwzBz9L55Ca9dtTGTXFbeswAJr1IeA==',
    rejection: /^sherpa-onnx\.node imports libraries that are neither bundled nor part of Windows: MSVCP140\.dll, VCRUNTIME140\.dll$/u },
  { version: '1.13.8-mt.1', integrity: 'qNrX+IEW+kcMoCbMDYZVMSH2T+jlFGK+UdFadfmGOXvbaSrXG8gAjaDftrz+EINB8E3zP9vSSQ200NVFSOr9YQ==',
    rejection: /^onnxruntime\.dll must carry a valid Authenticode signature from Microsoft Corporation; signtool: NotSigned,/u },
];
const policy = { arch: 'arm64', binaries: ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'],
  microsoft: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'], runtime: [] };

const evidence = join(import.meta.dirname, 'dist', 'evidence');
mkdirSync(evidence, { recursive: true });
const output = {};
for (const { version, integrity, rejection } of earlier) {
  const url = `https://registry.npmjs.org/@yudshj/sherpa-onnx-win-arm64/-/sherpa-onnx-win-arm64-${version}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${version} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha512').update(bytes).digest('base64'), integrity, `${version} registry integrity mismatch`);
  const work = mkdtempSync(join(tmpdir(), 'sherpa-negative-control-'));
  try {
    writeFileSync(join(work, 'package.tgz'), bytes);
    await tar.x({ file: join(work, 'package.tgz'), cwd: work, strict: true });
    assert.throws(() => inspectWindowsBinaries(join(work, 'package'), policy), error => {
      assert.match(error.message, rejection);
      output[version] = { rejected: true, reason: error.message };
      return true;
    });
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
}
writeFileSync(join(evidence, 'negative-control.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
