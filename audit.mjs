/** Fail closed on unexpected archive contents or local identifying data. */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, hostname, userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { inspectDependents } from './import-audit.mjs';

export const name = '@yudshj/sherpa-onnx-win-arm64';
export const version = '1.13.8-mt.1';
export const upstreamVersion = '1.13.8';
export const wrappers = ['addon-static-import.js', 'addon.js', 'audio-tagg.js', 'keyword-spotter.js',
  'non-streaming-asr.js', 'non-streaming-speaker-diarization.js', 'non-streaming-speech-denoiser.js',
  'non-streaming-tts.js', 'online-speech-denoiser.js', 'punctuation.js', 'resampler.js', 'sherpa-onnx.js',
  'speaker-identification.js', 'spoken-language-identification.js', 'streaming-asr.js', 'types.js', 'vad.js'];
export const binaries = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'];
export const files = [...wrappers, ...binaries, 'package.json', 'README.md', 'LICENSE',
  'LICENSE-node-gyp', 'LICENSE-node-addon-api', 'LICENSE-onnxruntime', 'ThirdPartyNotices-onnxruntime.txt'];

/** Sensitive values are kept in memory and never included in diagnostics. */
export function privateValues(extra = []) {
  const values = [homedir(), userInfo().username, hostname(), process.cwd(), ...extra];
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:token|secret|password|passwd|api.?key|private.?key|credential)/i.test(key) && value?.length >= 8) values.push(value);
  }
  for (const path of [join(homedir(), '.npmrc'), join(homedir(), '.dsh-dev-api'), join(homedir(), '.secrets.env')]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?[^#;=]*(?:token|secret|password|passwd|api.?key|_auth)[^=]*=\s*["']?([^\r\n]+?)["']?\s*$/iu);
      if (match && match[1].length >= 8 && !match[1].includes('${')) values.push(match[1]);
    }
  }
  return [...new Set(values.filter(value => value && value.length >= 4))];
}

export function scanBytes(bytes, sensitive) {
  for (const value of sensitive) {
    for (const variant of [value, value.toLowerCase(), value.toUpperCase(), value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')]) {
      if (bytes.includes(Buffer.from(variant)) || bytes.includes(Buffer.from(variant, 'utf16le'))) {
        throw new Error('Private machine data or configured secret detected (value redacted)');
      }
    }
  }
  for (const text of [bytes.toString('latin1'), bytes.toString('utf16le')]) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|[A-Z]:[\\/]Users[\\/][^\s\x00"<>]+|[\\/]home[\\/][^\s\x00"<>]+/iu.test(text)) {
      throw new Error('Private path or credential pattern detected (value redacted)');
    }
  }
}

export function verifyPe(bytes) {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (offset < 64 || offset > bytes.length - 6 || bytes.toString('ascii', 0, 2) !== 'MZ'
      || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0xaa64) {
    throw new Error('Expected an ARM64 PE binary');
  }
}

export async function auditContents(path, sensitive = privateValues()) {
  scanBytes(readFileSync(path), sensitive);
  const seen = new Set();
  const records = [];
  let failure;
  await tar.t({ file: path, strict: true, onReadEntry(entry) {
    const base = entry.path.slice('package/'.length);
    if (!entry.path.startsWith('package/') || !files.includes(base) || entry.type !== 'File' || seen.has(base)
        || (entry.uid !== undefined && entry.uid !== 0) || (entry.gid !== undefined && entry.gid !== 0) || entry.uname || entry.gname) {
      failure ??= new Error('Unexpected archive file, link, duplicate, or owner metadata');
    }
    seen.add(base);
    const chunks = [];
    entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks);
        scanBytes(bytes, sensitive);
        if (binaries.includes(base)) verifyPe(bytes);
        if (base === 'package.json') {
          const manifest = JSON.parse(bytes.toString('utf8'));
          if (JSON.stringify(manifest) !== JSON.stringify(packageManifest())) throw new Error('Unexpected package manifest');
        }
        records.push({ file: base, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch (error) { failure ??= error; }
    });
  } });
  if (failure) throw failure;
  if (seen.size !== files.length || files.some(file => !seen.has(file))) throw new Error('Incomplete package');
  return { name, version, sha512: createHash('sha512').update(readFileSync(path)).digest('base64'),
    files: records.sort((a, b) => a.file.localeCompare(b.file)) };
}

export function packageManifest() {
  return { name, version, description: 'Windows ARM64 build of the sherpa-onnx Node API, based on upstream 1.13.8 with statically linked MSVC runtime.',
    main: 'sherpa-onnx.js', os: ['win32'], cpu: ['arm64'], engines: { node: '>=18' }, license: 'Apache-2.0',
    files: files.filter(file => file !== 'package.json'), publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } };
}

/** Full publication gate: metadata/privacy checks followed by real import inspection. */
export async function auditTarball(path, sensitive = privateValues()) {
  const report = await auditContents(path, sensitive);
  const work = mkdtempSync(join(tmpdir(), 'sherpa-import-audit-'));
  try {
    await tar.x({ file: path, cwd: work, strict: true });
    report.dependencies = Object.fromEntries(binaries.map(file => [file, inspectDependents(join(work, 'package', file))]));
    return report;
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
}
