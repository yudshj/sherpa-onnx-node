/** Transcribe the upstream Chinese sample with SenseVoice INT8 and Silero VAD through the built packages. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetFile, install, prepareAsset } from './release.mjs';
import { lock, platforms } from './targets.mjs';

const target = process.argv[2];
if (!platforms[target]) throw new Error(`Usage: node accept.mjs <${Object.keys(platforms).join('|')}>`);
const expected = '开饭时间早上9点至下午5点。';
const work = mkdtempSync(join(import.meta.dirname, 'dist', 'accept-'));
try {
  const main = await install(target, work);
  const model = join(work, 'model');
  await prepareAsset('senseVoice', lock.testAssets.senseVoice, model);
  const vad = await assetFile('sileroVad', lock.testAssets.sileroVad);
  // Electron's V8 memory cage rejects external buffers, so waves and VAD segments are copied into V8 memory.
  writeFileSync(join(work, 'transcribe.cjs'), `const s = require(${JSON.stringify(main)});
const recognizer = new s.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { senseVoice: { model: ${JSON.stringify(join(model, 'model.int8.onnx'))}, language: 'auto', useInverseTextNormalization: 1 },
    tokens: ${JSON.stringify(join(model, 'tokens.txt'))}, numThreads: 2, provider: 'cpu', debug: 0 } });
const wave = s.readWave(${JSON.stringify(join(model, 'test_wavs', 'zh.wav'))}, false);
const decode = samples => { const stream = recognizer.createStream(); stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
  recognizer.decode(stream); return recognizer.getResult(stream).text; };
const vad = new s.Vad({ sileroVad: { model: ${JSON.stringify(vad)}, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.5,
  windowSize: 512 }, sampleRate: 16000, debug: 0, numThreads: 1 }, 60);
const segments = [];
const drain = () => { while (!vad.isEmpty()) { segments.push(decode(vad.front(false).samples)); vad.pop(); } };
for (let i = 0; i + 512 <= wave.samples.length; i += 512) { vad.acceptWaveform(wave.samples.subarray(i, i + 512)); drain(); }
vad.flush(); drain();
console.log(JSON.stringify({ runtime: process.versions.electron ? 'electron ' + process.versions.electron : 'node ' + process.versions.node,
  whole: decode(wave.samples), segments }));
`);
  const runtimes = [['node', process.execPath, {}], ...(process.env.ELECTRON ? [['electron', process.env.ELECTRON, { ELECTRON_RUN_AS_NODE: '1' }]] : [])];
  for (const [label, executable, env] of runtimes) {
    const result = JSON.parse(execFileSync(executable, [join(work, 'transcribe.cjs')], { encoding: 'utf8', env: { ...process.env, ...env } }).trim());
    console.log(`${label}: ${JSON.stringify(result)}`);
    assert.equal(result.whole, expected);
    assert.deepEqual(result.segments, [expected]);
  }
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
