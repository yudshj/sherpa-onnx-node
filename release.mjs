/** Build a clean package, audit the exact npm tarball, then optionally publish that tarball. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as tar from 'tar';
import { auditTarball, binaries, files, name, packageManifest, privateValues, repository, scanBytes, version, upstreamVersion, wrappers } from './audit.mjs';
import { systemTar, toolchain } from './toolchain.mjs';

const root = import.meta.dirname;
const lock = JSON.parse(readFileSync(join(root, 'lock.json'), 'utf8'));
const output = join(root, 'dist');
const archive = join(output, `yudshj-sherpa-onnx-win-arm64-${version}.tgz`);
const registry = 'https://registry.npmjs.org/';
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run(command, args, options = {}) {
  const { env: base = process.env, ...rest } = options;
  const env = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/(?:token|secret|password|passwd|api.?key|private.?key|credential)/i.test(key)
    && !/^(?:CL|_CL_|LINK|_LINK_|CFLAGS|CXXFLAGS)$/i.test(key)));
  execFileSync(command, args, { stdio: 'inherit', ...rest, env });
}

async function assetFile(key) {
  const asset = lock.assets[key];
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${key}.archive`);
  if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === asset.sha256) return file;
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if ((asset.bytes !== undefined && bytes.length !== asset.bytes) || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`${key}: checksum mismatch`);
  writeFileSync(file, bytes);
  return file;
}

function mapSourceNames(directory, label) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) mapSourceNames(path, `${label}/${entry.name}`);
    else if (/\.(?:h|hpp|cc|cpp|inl)$/u.test(entry.name)) {
      const bytes = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
      writeFileSync(path, `#line 1 "${label}/${entry.name}"\n${bytes}`);
    }
  }
}

function smoke(directory, executable = process.execPath, electron = false) {
  const script = `const assert=require('node:assert/strict'); const s=require(${JSON.stringify(join(directory, 'sherpa-onnx.js'))});
    assert.equal(typeof s.OfflineRecognizer,'function'); assert.equal(typeof s.Vad,'function');
    const r=new s.LinearResampler(16000,8000); assert.equal(r.flush(new Float32Array(1600)).length,800);
    console.log('Native smoke passed: '+process.arch+'; 1600 -> 800 samples');`;
  run(executable, ['-e', script], electron ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {});
}

async function check() {
  const report = await auditTarball(archive);
  const inspection = mkdtempSync(join(output, 'inspection-'));
  try {
    await tar.x({ file: archive, cwd: inspection, strict: true });
    smoke(join(inspection, 'package'));
  } finally { rmSync(inspection, { recursive: true, force: true, maxRetries: 10 }); }
  writeFileSync(join(output, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Audited ${report.files.length} allowlisted files; no configured private values found.`);
  return report;
}

async function build() {
  if (process.platform !== 'win32' || process.arch !== 'arm64') throw new Error('Build on native Windows ARM64 Node.');
  const vs = toolchain();
  const tarExe = systemTar();
  console.log(`Visual Studio ${vs.version} at ${vs.path}; MSVC ${vs.environment.VCToolsVersion}; Windows SDK ${vs.environment.WindowsSDKVersion.replace(/\\$/u, '')}`);
  mkdirSync(output, { recursive: true });
  const work = mkdtempSync(join(output, 'build-'));
  const sensitive = privateValues([work, root]);
  try {
    for (const key of Object.keys(lock.assets)) {
      const download = await assetFile(key);
      const destination = join(work, key === 'nodeLib' ? 'node.lib' : key);
      if (key === 'nodeLib' || key.startsWith('license')) copyFileSync(download, destination);
      else {
        mkdirSync(destination);
        const selected = key === 'source' ? [`sherpa-onnx-${upstreamVersion}/LICENSE`, `sherpa-onnx-${upstreamVersion}/sherpa-onnx/c-api/c-api.h`,
          `sherpa-onnx-${upstreamVersion}/harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp`] : [];
        run(tarExe, ['-xf', download, '-C', destination, '--strip-components', '1', ...selected]);
      }
    }
    if (JSON.parse(readFileSync(join(work, 'wrapper', 'package.json'), 'utf8')).version !== upstreamVersion) {
      throw new Error('Upstream JavaScript API version mismatch');
    }
    for (const key of ['source', 'api', 'headers', 'gyp']) mapSourceNames(join(work, key), key);
    // Upstream ships the ARM64 runtime DLLs but no Node binding; compile only the binding against them.
    const compiled = join(work, 'compiled');
    mkdirSync(compiled);
    const bindingRoot = join(work, 'source', 'harmony-os', 'SherpaOnnxHar', 'sherpa_onnx', 'src', 'main', 'cpp');
    const sources = readdirSync(bindingRoot).filter(file => file.endsWith('.cc') && file !== 'utils.cc').sort()
      .map(file => join(bindingRoot, file));
    // /EHsc enables node-addon-api C++ exceptions; the delay-loaded host lets Electron's executable provide Node-API.
    run(join(vs.bin, 'cl.exe'), ['/nologo', '/MP', '/O2', '/EHsc', '/MT',
      '/std:c++17', '/utf-8', '/DNDEBUG', '/DNAPI_VERSION=8', '/DHOST_BINARY="node.exe"',
      `/I${join(work, 'source')}`, `/I${join(work, 'api')}`, `/I${join(work, 'headers', 'include', 'node')}`,
      ...sources, join(work, 'gyp', 'src', 'win_delay_load_hook.cc'), '/LD', '/Fesherpa-onnx.node',
      '/link', '/DEBUG:NONE', '/PDBALTPATH:sherpa-onnx.pdb', '/INCREMENTAL:NO', '/DELAYLOAD:node.exe',
      join(work, 'node.lib'), join(work, 'libraries', 'lib', 'sherpa-onnx-c-api.lib'), 'delayimp.lib'],
    { cwd: compiled, env: vs.environment });
    const stage = join(work, 'package');
    mkdirSync(stage);
    for (const file of wrappers) copyFileSync(join(work, 'wrapper', file), join(stage, file));
    for (const file of binaries) copyFileSync(file.endsWith('.node') ? join(compiled, file)
      : join(work, 'libraries', 'lib', file), join(stage, file));
    for (const [source, dest] of [['source/LICENSE', 'LICENSE'], ['gyp/LICENSE', 'LICENSE-node-gyp'],
      ['api/LICENSE.md', 'LICENSE-node-addon-api'], ['licenseOnnx', 'LICENSE-onnxruntime'],
      ['licenseOnnxThirdParty', 'ThirdPartyNotices-onnxruntime.txt']]) copyFileSync(join(work, source), join(stage, dest));
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(packageManifest(), null, 2)}\n`);
    writeFileSync(join(stage, 'README.md'), `# ${name}\n\nWindows ARM64 build of the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Node API ${upstreamVersion}.\n\nThis independently published package includes the unchanged upstream JavaScript API, a Node-API v8 adapter with the Electron delay-load hook, and upstream CPU runtime DLLs. It requires Windows ARM64. The adapter and runtime DLLs statically link the MSVC runtime; no Visual C++ Redistributable is required. It has no installation scripts, downloads, credentials, models, or recordings.\n\nUse require('${name}') for the upstream API. The package is based on sherpa-onnx-node ${upstreamVersion}; the mt suffix identifies its static MSVC runtime build. Other architectures should use sherpa-onnx-node.\n\nBuild and release source: ${repository}\n\nUpstream licenses and ONNX Runtime third-party notices are included.\n`);
    if (readdirSync(stage).sort().join('\n') !== [...files].sort().join('\n')) throw new Error('Unexpected staging contents');
    for (const file of files) scanBytes(readFileSync(join(stage, file)), sensitive);
    smoke(stage);
    const result = JSON.parse(npm(['pack', stage, '--ignore-scripts', '--json', '--pack-destination', output, '--registry', registry], work));
    if (result.length !== 1 || result[0].filename !== relative(output, archive)) throw new Error('Unexpected npm pack output');
    await auditTarball(archive, sensitive);
    await check();
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
}

/** GitHub Actions publishes through npm trusted publishing; local publication requires the owner account. */
function publicationArguments() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    if (npm(['whoami', '--registry', registry]).trim() !== 'yudshj') throw new Error('Expected the yudshj npm account');
    return [];
  }
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Trusted publishing requires the id-token: write permission');
  const [major, minor, patch] = npm(['--version']).trim().split('.').map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) throw new Error('Trusted publishing requires npm 11.5.1 or later');
  return ['--provenance'];
}

async function publish() {
  const report = await check();
  const extra = publicationArguments();
  const status = await fetch(`${registry}${encodeURIComponent(name)}/${version}`);
  if (status.status !== 404) throw new Error(`Publication requires an unpublished version; registry returned ${status.status}`);
  if (createHash('sha512').update(readFileSync(archive)).digest('base64') !== report.sha512) throw new Error('Tarball changed after audit');
  const result = spawnSync(process.execPath, [npmCli, 'publish', archive, '--tag', 'latest', '--access', 'public', '--ignore-scripts', '--registry', registry, ...extra], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('npm publish did not confirm success; inspect the registry before retrying');
  console.log(`Published ${name}@${version}; audited sha512-${report.sha512}`);
}

const action = process.argv[2];
if (action === 'build') await build();
else if (action === 'check') await check();
else if (action === 'publish') await publish();
else throw new Error('Usage: node release.mjs build|check|publish');
