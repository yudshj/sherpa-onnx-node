/** Fail closed on unexpected archive contents, changed upstream files, or local identifying data. */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, hostname, userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { binaries, isWindows, manifest, minimumMacOS, packageFiles, packageName, pinnedFiles, platforms, runtimeLibraries, version } from './targets.mjs';

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
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|[A-Z]:[\\/]Users[\\/][^\s\x00"<>]+|\/(?:home|Users)\/[^\s\x00"<>/]+\//iu.test(text)) {
      throw new Error('Private path or credential pattern detected (value redacted)');
    }
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Check one package tarball without extracting it: exact file set, no links or owner metadata, exact package.json,
 * pinned hashes for repackaged upstream binaries, and a privacy scan of every other file. Upstream binaries carry
 * their publishers' build paths; the pinned hash proves they are unchanged instead. Windows runtime libraries are
 * verified by their Microsoft signatures in auditTarball.
 * @param {string} path Tarball path.
 * @param {string} target Package target.
 * @param {string[]} sensitive Private values that must not appear in generated files.
 * @returns {Promise<{ name: string, version: string, target: string, sha512: string, files: object[] }>} Audit report.
 */
export async function auditContents(path, target, sensitive = privateValues()) {
  const files = packageFiles(target);
  const pinned = pinnedFiles(target);
  const signed = new Set(runtimeLibraries(target));
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
        const digest = sha256(bytes);
        if (pinned[base]) {
          if (digest !== pinned[base]) throw new Error(`${base} differs from the pinned upstream file`);
        } else if (!signed.has(base)) scanBytes(bytes, sensitive);
        if (base === 'package.json' && JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(manifest(target))) {
          throw new Error('Unexpected package manifest');
        }
        records.push({ file: base, bytes: bytes.length, sha256: digest });
      } catch (error) { failure ??= error; }
    });
  } });
  if (failure) throw failure;
  if (seen.size !== files.length || files.some(file => !seen.has(file))) throw new Error('Incomplete package');
  return { name: packageName(target), version, target, sha512: createHash('sha512').update(readFileSync(path)).digest('base64'),
    files: records.sort((a, b) => a.file.localeCompare(b.file)) };
}

/**
 * Full publication gate: tarball checks, then native inspection of every binary on its own platform.
 * @param {string} path Tarball path.
 * @param {string} target Package target.
 * @param {string[]} sensitive Private values that must not appear in generated files.
 * @returns {Promise<object>} Audit report including binary evidence.
 */
export async function auditTarball(path, target, sensitive = privateValues()) {
  const report = await auditContents(path, target, sensitive);
  if (target === 'main') return report;
  const work = mkdtempSync(join(tmpdir(), 'sherpa-binary-audit-'));
  try {
    await tar.x({ file: path, cwd: work, strict: true });
    const directory = join(work, 'package');
    if (isWindows(target)) {
      const { inspectWindowsBinaries } = await import('./windows-audit.mjs');
      return { ...report, ...inspectWindowsBinaries(directory, { arch: platforms[target].cpu, binaries: binaries(target),
        microsoft: binaries(target).filter(file => /^onnxruntime/u.test(file) || runtimeLibraries(target).includes(file)),
        runtime: runtimeLibraries(target) }) };
    }
    const { inspectMacBinaries } = await import('./macos-audit.mjs');
    return { ...report, ...inspectMacBinaries(directory, { binaries: binaries(target), minimum: minimumMacOS }) };
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
}
