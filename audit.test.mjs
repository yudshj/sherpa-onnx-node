import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { auditContents, scanBytes, files, packageManifest } from './audit.mjs';
import { parseDependents, parseMachine } from './import-audit.mjs';
import { parseEnvironment } from './toolchain.mjs';

test('rejects dynamic MSVC runtime imports, including delay imports and mixed case', () => {
  for (const file of ['MSVCP140.dll', 'MSVCP140_1.dll', 'VCRUNTIME140.dll', 'concrt140.dll', 'VCCORLIB140.DLL']) {
    assert.throws(() => parseDependents(`File Type: DLL\nImage has the following delay load dependencies:\n    ${file}\n    KERNEL32.dll`), /Dynamic MSVC runtime imports/);
  }
  assert.deepEqual(parseDependents('File Type: DLL\n    KERNEL32.dll\n    node.exe\n    sherpa-onnx-c-api.dll'),
    ['KERNEL32.dll', 'node.exe', 'sherpa-onnx-c-api.dll']);
});

test('rejects incomplete or unrecognized dumpbin output', () => {
  assert.throws(() => parseDependents('fatal error: invalid image'), /did not identify/);
  assert.throws(() => parseDependents('File Type: DLL'), /no imports/);
});

test('rejects private values in text and UTF-16 binary strings without echoing them', () => {
  const secret = 'private-test-value-019723';
  for (const encoding of ['utf8', 'utf16le']) {
    assert.throws(() => scanBytes(Buffer.from(`prefix ${secret}`, encoding), [secret]), error =>
      error.message.includes('redacted') && !error.message.includes(secret));
  }
  scanBytes(Buffer.from('public upstream content'), [secret]);
});

test('rejects user paths, npm tokens and private-key headers', () => {
  for (const value of ['C:\\Users\\example\\source.cpp', '/home/example/build',
    `npm_${'x'.repeat(36)}`, '-----BEGIN OPENSSH PRIVATE KEY-----']) {
    for (const encoding of ['utf8', 'utf16le']) assert.throws(() => scanBytes(Buffer.from(value, encoding), []));
  }
});

test('accepts only the ARM64 machine type reported by dumpbin', () => {
  const headers = machine => `File Type: DLL\n\nFILE HEADER VALUES\n            ${machine}\n               7 number of sections`;
  assert.equal(parseMachine(headers('AA64 machine (ARM64)')), 'ARM64');
  assert.throws(() => parseMachine(headers('8664 machine (x64)')), /Expected an ARM64 binary/);
  assert.throws(() => parseMachine(headers('8664 machine (x64) (ARM64X)')), /Expected an ARM64 binary/);
  assert.throws(() => parseMachine('dumpbin : fatal error LNK1106: invalid file'), /did not report a machine type/);
});

test('rejects extra archive files before extraction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-audit-test-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package', '.npmrc'), 'private test config');
    const archive = join(root, 'bad.tgz');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, ['package/.npmrc']);
    await assert.rejects(auditContents(archive, []), /Unexpected archive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('accepts portable metadata and rejects hard links and personal owners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-audit-test-'));
  try {
    mkdirSync(join(root, 'package'));
    for (const file of files) writeFileSync(join(root, 'package', file), file === 'package.json' ? JSON.stringify(packageManifest()) : 'public');
    const archive = join(root, 'valid.tgz');
    const entries = files.map(file => `package/${file}`);
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    assert.equal((await auditContents(archive, [])).files.length, files.length);
    rmSync(join(root, 'package', 'README.md'));
    linkSync(join(root, 'package', 'LICENSE'), join(root, 'package', 'README.md'));
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    await assert.rejects(auditContents(archive, []), /Unexpected archive/);
    rmSync(join(root, 'package', 'README.md'));
    writeFileSync(join(root, 'package', 'README.md'), 'public');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    const raw = gunzipSync(readFileSync(archive));
    raw.write('0002322\0', 108, 8, 'ascii');
    raw.fill(32, 148, 156);
    const checksum = raw.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    raw.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    writeFileSync(archive, gzipSync(raw));
    await assert.rejects(auditContents(archive, []), /Unexpected archive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reads the vcvarsall environment, including values that contain equals signs', () => {
  assert.deepEqual(parseEnvironment('=C:=C:\\work\r\nINCLUDE=C:\\a;C:\\b\r\nVSCMD_ARG_TGT_ARCH=arm64\r\nFLAGS=a=b\r\n'),
    { INCLUDE: 'C:\\a;C:\\b', VSCMD_ARG_TGT_ARCH: 'arm64', FLAGS: 'a=b' });
});

test('declares the source repository required by provenance verification', () => {
  assert.equal(packageManifest().repository.url, 'git+https://github.com/yudshj/sherpa-onnx-win-arm64.git');
});
