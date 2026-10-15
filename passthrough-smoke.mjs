/** Load the binding through the unchanged upstream loader from an upstream passthrough package installed under its alias. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageName, passthrough, sherpaVersion, tarballName } from './targets.mjs';

const platform = `${process.platform}-${process.arch}`;
const entry = passthrough[platform];
if (!entry) throw new Error(`${platform} is not a passthrough platform; expected one of ${Object.keys(passthrough).join(', ')}`);
const tarball = resolve(import.meta.dirname, 'dist', tarballName('main'));
const work = mkdtempSync(join(tmpdir(), 'sherpa-passthrough-'));
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'passthrough-smoke', private: true, version: '0.0.0' }));
  // The main package's own optional dependencies may not be published yet; install this platform's alias exactly as the
  // manifest declares it, so the layout the upstream loader searches is the one under test.
  const npm = args => execFileSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org/'], { cwd: work, stdio: 'inherit' });
  npm(['install', tarball, '--omit=optional']);
  npm(['install', `@yudshj/sherpa-onnx-${platform}@npm:${entry.package}@${sherpaVersion}`]);
  const script = `const assert=require('node:assert/strict'); const path=require('node:path'); const s=require(${JSON.stringify(packageName('main'))});
    assert.equal(typeof s.OfflineRecognizer,'function'); assert.equal(typeof s.Vad,'function');
    assert.equal(new s.LinearResampler(16000,8000).flush(new Float32Array(1600)).length,800);
    const binding=process.report.getReport().sharedObjects.find(p=>path.basename(p)==='sherpa-onnx.node');
    assert.ok(binding.includes(path.join('@yudshj','sherpa-onnx-${platform}')), 'binding loaded from '+binding);
    console.log('Passthrough smoke passed on ${platform}: upstream ${entry.package}@${sherpaVersion} loaded through the alias');`;
  execFileSync(process.execPath, ['-e', script], { cwd: work, stdio: 'inherit' });
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
