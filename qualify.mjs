/** Qualify the exact audited tarball on native Node and both Electron execution modes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
import { auditTarball, name, version, binaries } from './audit.mjs';

const repo = path.resolve(process.argv[2]);
const assets = path.resolve(process.argv[3]);
const root = import.meta.dirname;
const work = path.join(root, 'dist', 'qualification');
const evidence = path.join(root, 'dist', 'evidence');
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
const archive = path.join(root, 'dist', `yudshj-sherpa-onnx-win-arm64-${version}.tgz`);
const report = await auditTarball(archive);
for (const file of binaries) fs.writeFileSync(path.join(evidence, `${file}.dependents.txt`), report.dependencies[file].dumpbin);
fs.writeFileSync(path.join(evidence, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
const packageDir = path.join(work, 'node_modules', ...name.split('/'));
fs.mkdirSync(packageDir, { recursive: true });
await tar.x({ file: archive, cwd: packageDir, strip: 1, strict: true });

const node24 = path.join(repo, 'apps/desktop/.desktop-build/targets/win-arm64/runtime/primary-runtime/dependencies/node/bin/node.exe');
const electron = process.env.ELECTRON || path.join(repo, 'apps/desktop/node_modules/electron/dist/electron.exe');
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:token|secret|password|passwd|api.?key|private.?key|credential)/iu.test(key) && key !== 'ELECTRON_RUN_AS_NODE'));
const smoke = `const assert=require('node:assert/strict'); const s=require(${JSON.stringify(packageDir)});
assert.equal(process.arch,'arm64'); assert.equal(typeof s.OfflineRecognizer,'function');assert.equal(typeof s.Vad,'function');
const samples=new s.LinearResampler(16000,8000).flush(new Float32Array(1600)).length; assert.equal(samples,800);
const result={node:process.versions.node,electron:process.versions.electron??null,type:process.type??'node',arch:process.arch,OfflineRecognizer:typeof s.OfflineRecognizer,Vad:typeof s.Vad,inputSamples:1600,outputSamples:samples};`;
const results = {};
for (const [label, executable, env] of [['node22', process.execPath, cleanEnvironment],
  ['node24', node24, cleanEnvironment], ['electron-node', electron, { ...cleanEnvironment, ELECTRON_RUN_AS_NODE: '1' }]]) {
  const output = execFileSync(executable, ['-e', `${smoke} console.log(JSON.stringify(result));`], { env, encoding: 'utf8', timeout: 120000 });
  results[label] = JSON.parse(output.trim());
  console.log(`${label}: ${output.trim()}`);
}
assert.match(results.node22.node, /^22\./u); assert.match(results.node24.node, /^24\./u);
assert.equal(results['electron-node'].electron, '44.7.0');
const mainResult = path.join(work, 'main-result.json');
const main = path.join(work, 'smoke-main.cjs');
fs.writeFileSync(main, `const {app}=require('electron'); app.whenReady().then(()=>{try{${smoke}
assert.equal(process.type,'browser');assert.equal(process.versions.electron,'44.7.0');
require('node:fs').writeFileSync(${JSON.stringify(mainResult)},JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1);}});`);
fs.rmSync(mainResult, { force: true });
execFileSync(electron, [main], { env: cleanEnvironment, stdio: 'pipe', timeout: 120000, windowsHide: true });
results['electron-main'] = JSON.parse(fs.readFileSync(mainResult, 'utf8'));
console.log(`electron-main: ${JSON.stringify(results['electron-main'])}`);
fs.writeFileSync(path.join(evidence, 'load-results.json'), JSON.stringify(results, null, 2) + '\n');

// Compile the current provider worker with its normal implementation and native package resolver.
const requireRepo = createRequire(path.join(repo, 'package.json'));
await createRequire(requireRepo.resolve('tsx'))('esbuild').build({ entryPoints: [path.join(repo, 'packages/experimental/speech-to-text-sensevoice/src/worker.ts')],
  outfile: path.join(work, 'worker.mjs'), platform: 'node', format: 'esm', bundle: true, sourcemap: false,
  banner: { js: "import { createRequire as qualificationRequire } from 'node:module'; const require=qualificationRequire(import.meta.url);" } });
const modelLock = JSON.parse(fs.readFileSync(path.join(repo, 'packages/experimental/speech-to-text-sensevoice/runtime/assets.json')));
const modelRecords = [];
for (const asset of [modelLock.models.int8, modelLock.tokens, modelLock.vad]) {
  const bytes = fs.readFileSync(path.join(assets, asset.name));
  assert.equal(bytes.length, asset.bytes); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  modelRecords.push({ name: asset.name, sha256: asset.sha256 });
}
const url = modelLock.models.int8.url.replace('model.int8.onnx', 'test_wavs/zh.wav');
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw Error(`zh.wav download failed: ${response.status}`);
const wave = Buffer.from(await response.arrayBuffer());
assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
let fmt, pcm;
for (let offset = 12; offset + 8 <= wave.length;) {
  const size = wave.readUInt32LE(offset + 4), id = wave.toString('ascii', offset, offset + 4);
  const bytes = wave.subarray(offset + 8, offset + 8 + size);
  if (id === 'fmt ') fmt = bytes; if (id === 'data') pcm = bytes;
  offset += 8 + size + size % 2;
}
assert.ok(fmt && pcm); assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1);
assert.equal(fmt.readUInt32LE(4), 16000); assert.equal(fmt.readUInt16LE(14), 16);
const header = Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36 + pcm.length,4);header.write('WAVEfmt ',8);
header.writeUInt32LE(16,16);fmt.copy(header,20,0,16);header.write('data',36);header.writeUInt32LE(pcm.length,40);
fs.writeFileSync(path.join(work,'zh.wav'),Buffer.concat([header,pcm]));
fs.writeFileSync(path.join(work,'voice-config.json'),JSON.stringify({dataRoot:work,model:path.join(assets,modelLock.models.int8.name),
  tokens:path.join(assets,modelLock.tokens.name),vad:path.join(assets,modelLock.vad.name)}));
fs.copyFileSync(path.join(root,'voice-acceptance.mjs'),path.join(work,'voice-acceptance.mjs'));
for(const [label, executable, env] of [['node24',node24,cleanEnvironment],['electron-node',electron,{...cleanEnvironment,ELECTRON_RUN_AS_NODE:'1'}]]) {
  const output=execFileSync(executable,[path.join(work,'voice-acceptance.mjs')],{env,encoding:'utf8',timeout:180000});
  const result=JSON.parse(output.trim());
  console.log(`transcription-${label}: ${output.trim()}`);
  fs.writeFileSync(path.join(evidence,`transcription-${label}.json`),JSON.stringify(result,null,2)+'\n');
}
fs.writeFileSync(path.join(evidence,'model-inputs.json'),JSON.stringify({models:modelRecords,
  wave:{url,sha256:crypto.createHash('sha256').update(wave).digest('hex'),bytes:wave.length}},null,2)+'\n');
