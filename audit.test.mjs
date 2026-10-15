import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { auditContents, scanBytes } from './audit.mjs';
import { checkMachO, parseLoadCommands } from './macos-audit.mjs';
import { manifest, packageFiles, packageName, platforms, version } from './targets.mjs';
import { parseEnvironment } from './toolchain.mjs';
import { checkClosure, checkMicrosoftSignatures, checkRuntimeVersions, parseDependents, parseHeaders } from './windows-audit.mjs';

const writePackage = (root, target, contents = () => 'public') => {
  mkdirSync(join(root, 'package'), { recursive: true });
  for (const file of packageFiles(target)) {
    writeFileSync(join(root, 'package', file), file === 'package.json' ? JSON.stringify(manifest(target)) : contents(file));
  }
  return packageFiles(target).map(file => `package/${file}`);
};

test('reads direct and delay-load imports from dumpbin', () => {
  assert.deepEqual(parseDependents('File Type: DLL\n  Image has the following dependencies:\n    sherpa-onnx-c-api.dll\n    KERNEL32.dll\n'
    + '  Image has the following delay load dependencies:\n    node.exe'), ['KERNEL32.dll', 'node.exe', 'sherpa-onnx-c-api.dll']);
});

test('requires every import to be bundled, the Node host, or part of Windows', () => {
  const ort = { imports: ['KERNEL32.dll', 'MSVCP140.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'dxgi.dll'] };
  checkClosure({ 'onnxruntime.dll': ort, 'sherpa-onnx.node': { imports: ['node.exe', 'sherpa-onnx-c-api.dll'] } },
    ['onnxruntime.dll', 'sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'msvcp140.dll', 'vcruntime140.dll']);
  assert.throws(() => checkClosure({ 'onnxruntime.dll': ort }, ['onnxruntime.dll', 'vcruntime140.dll']),
    /onnxruntime\.dll imports libraries that are neither bundled nor part of Windows: MSVCP140\.dll$/);
  assert.throws(() => checkClosure({ 'sherpa-onnx.node': { imports: ['KERNEL32.dll', 'libnode.dll'] } }, ['sherpa-onnx.node']), /libnode\.dll/);
});

test('requires valid Microsoft Corporation signatures on Microsoft binaries', () => {
  const microsoft = { status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' };
  checkMicrosoftSignatures({ 'onnxruntime.dll': microsoft }, ['onnxruntime.dll']);
  for (const signature of [{ status: 'NotSigned', subject: '' }, { status: 'HashMismatch', subject: microsoft.subject },
    { status: 'Valid', subject: 'CN=Microsoft Corporation Impostor, O=Example' }, undefined]) {
    assert.throws(() => checkMicrosoftSignatures({ 'onnxruntime.dll': signature }, ['onnxruntime.dll']), /Microsoft Corporation Authenticode/);
  }
});

test('requires the bundled C++ runtime to cover every linker version', () => {
  const dependencies = { 'onnxruntime.dll': { linker: '14.44' }, 'sherpa-onnx.node': { linker: '14.38' } };
  checkRuntimeVersions(dependencies, { 'msvcp140.dll': '14.44.35211.0', 'vcruntime140.dll': '14.51.36247.0' });
  assert.throws(() => checkRuntimeVersions(dependencies, { 'msvcp140.dll': '14.38.33135.0' }), /older than the newest bundled linker/);
  assert.throws(() => checkRuntimeVersions(dependencies, { 'msvcp140.dll': undefined }), /older/);
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

test('accepts only the native machine type reported by dumpbin and reads the linker version', () => {
  const headers = machine => `File Type: DLL\n\nFILE HEADER VALUES\n            ${machine}\n               7 number of sections\n`
    + 'OPTIONAL HEADER VALUES\n             20B magic # (PE32+)\n           14.44 linker version';
  assert.deepEqual(parseHeaders(headers('AA64 machine (ARM64)'), 'arm64'), { machine: 'ARM64', linker: '14.44' });
  assert.deepEqual(parseHeaders(headers('8664 machine (x64)'), 'x64'), { machine: 'x64', linker: '14.44' });
  assert.throws(() => parseHeaders(headers('8664 machine (x64)'), 'arm64'), /Expected a native arm64 binary/);
  assert.throws(() => parseHeaders(headers('AA64 machine (ARM64)'), 'x64'), /Expected a native x64 binary/);
  assert.throws(() => parseHeaders(headers('8664 machine (x64) (ARM64X)'), 'x64'), /Expected a native x64 binary/);
  assert.throws(() => parseHeaders('dumpbin : fatal error LNK1106: invalid file', 'arm64'), /did not report a machine type/);
  assert.throws(() => parseHeaders('FILE HEADER VALUES\n AA64 machine (ARM64)', 'arm64'), /did not report a linker version/);
});

test('reads Mach-O load commands and allows only system libraries, bundled files and @loader_path', () => {
  const output = ['Load command 3', '          cmd LC_ID_DYLIB', '         name @rpath/libsherpa-onnx-c-api.dylib (offset 24)',
    'Load command 9', '      cmd LC_BUILD_VERSION', '  platform 1', '    minos 11.0', '      sdk 15.0',
    'Load command 12', '          cmd LC_LOAD_DYLIB', '         name @rpath/libonnxruntime.dylib (offset 24)',
    'Load command 13', '          cmd LC_LOAD_DYLIB', '         name /usr/lib/libc++.1.dylib (offset 24)',
    'Load command 14', '          cmd LC_RPATH', '         path @loader_path (offset 12)'].join('\n');
  const commands = parseLoadCommands(output);
  assert.deepEqual(commands, { id: '@rpath/libsherpa-onnx-c-api.dylib', minos: '11.0', dependencies: ['@rpath/libonnxruntime.dylib', '/usr/lib/libc++.1.dylib'], rpaths: ['@loader_path'] });
  const bundled = ['sherpa-onnx.node', 'libsherpa-onnx-c-api.dylib', 'libonnxruntime.dylib'];
  checkMachO('libsherpa-onnx-c-api.dylib', commands, bundled, '14.0');
  assert.throws(() => checkMachO('x', { ...commands, dependencies: ['@rpath/libonnxruntime.1.dylib'] }, bundled, '14.0'), /neither bundled nor part of macOS: @rpath\/libonnxruntime\.1\.dylib/);
  assert.throws(() => checkMachO('x', { ...commands, dependencies: ['/opt/homebrew/lib/libz.dylib'] }, bundled, '14.0'), /neither bundled/);
  assert.throws(() => checkMachO('x', { ...commands, rpaths: ['@loader_path', '/Users/runner/work/lib'] }, bundled, '14.0'), /run paths outside the package/);
  assert.throws(() => checkMachO('x', { ...commands, minos: '15.0' }, bundled, '14.0'), /requires macOS 15\.0, newer than 14\.0/);
});

test('rejects extra archive files before extraction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-audit-test-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package', '.npmrc'), 'private test config');
    const archive = join(root, 'bad.tgz');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, ['package/.npmrc']);
    await assert.rejects(auditContents(archive, 'main', []), /Unexpected archive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('accepts portable metadata and rejects hard links and personal owners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-audit-test-'));
  try {
    const entries = writePackage(root, 'main');
    const archive = join(root, 'valid.tgz');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    assert.equal((await auditContents(archive, 'main', [])).files.length, entries.length);
    rmSync(join(root, 'package', 'README.md'));
    linkSync(join(root, 'package', 'LICENSE'), join(root, 'package', 'README.md'));
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    await assert.rejects(auditContents(archive, 'main', []), /Unexpected archive/);
    rmSync(join(root, 'package', 'README.md'));
    writeFileSync(join(root, 'package', 'README.md'), 'public');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    const raw = gunzipSync(readFileSync(archive));
    raw.write('0002322\0', 108, 8, 'ascii');
    raw.fill(32, 148, 156);
    const checksum = raw.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    raw.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    writeFileSync(archive, gzipSync(raw));
    await assert.rejects(auditContents(archive, 'main', []), /Unexpected archive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reads the vcvarsall environment, including values that contain equals signs', () => {
  assert.deepEqual(parseEnvironment('=C:=C:\\work\r\nINCLUDE=C:\\a;C:\\b\r\nVSCMD_ARG_TGT_ARCH=arm64\r\nFLAGS=a=b\r\n'),
    { INCLUDE: 'C:\\a;C:\\b', VSCMD_ARG_TGT_ARCH: 'arm64', FLAGS: 'a=b' });
});

test('requires pinned upstream binaries and skips only them and signed runtime libraries in the privacy scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-audit-test-'));
  try {
    const archive = join(root, 'platform.tgz');
    const upstream = file => /onnxruntime|sherpa-onnx-c-api/u.test(file) ? 'built on /Users/cloudtest/vss/_work/1/s' : 'public';
    let entries = writePackage(root, 'darwin-arm64', upstream);
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    await assert.rejects(auditContents(archive, 'darwin-arm64', []), /differs from the pinned upstream file/);
    rmSync(join(root, 'package'), { recursive: true });
    entries = writePackage(root, 'win-arm64', file => file === 'sherpa-onnx.node' ? 'C:\\Users\\runneradmin\\work' : 'public');
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true }, entries);
    await assert.rejects(auditContents(archive, 'win-arm64', []), /differs from the pinned upstream file|Private path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publishes one version: the main package depends on every platform package and declares the repository', () => {
  const main = manifest('main');
  assert.deepEqual(main.optionalDependencies, Object.fromEntries(Object.keys(platforms).map(platform => [packageName(platform), version])));
  assert.equal(main.repository.url, 'git+https://github.com/yudshj/sherpa-onnx-node.git');
  assert.equal(main.os, undefined);
  for (const platform of Object.keys(platforms)) {
    assert.deepEqual([manifest(platform).os, manifest(platform).cpu], [[platforms[platform].os], [platforms[platform].cpu]]);
    assert.equal(manifest(platform).main, undefined);
  }
  assert.deepEqual(packageFiles('darwin-arm64').filter(file => /\.(?:node|dylib)$/u.test(file)),
    ['sherpa-onnx.node', 'libsherpa-onnx-c-api.dylib', 'libonnxruntime.dylib']);
});
