/** Build, audit and publish the main JavaScript package and the platform binary packages. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { auditTarball, privateValues, scanBytes } from './audit.mjs';
import { binaries, isWindows, javascript, lock, manifest, minimumMacOS, packageFiles, packageName, platforms, readme, tarballName, targets, version, windowsRuntime } from './targets.mjs';
import { macToolchain, systemTar, windowsToolchain } from './toolchain.mjs';

const root = import.meta.dirname;
const output = join(root, 'dist');
const registry = 'https://registry.npmjs.org/';
// npm sits beside node.exe on Windows and under lib/ of the installation prefix elsewhere.
const npmCli = process.env.npm_execpath ?? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run(command, args, options = {}) {
  const { env: base = process.env, ...rest } = options;
  const env = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/(?:token|secret|password|passwd|api.?key|private.?key|credential)/i.test(key)
    && !/^(?:CL|_CL_|LINK|_LINK_|CFLAGS|CXXFLAGS|LDFLAGS|CPPFLAGS)$/i.test(key)));
  execFileSync(command, args, { stdio: 'inherit', ...rest, env });
}

/** Download one pinned input into .cache, or reuse a cached copy whose SHA-256 still matches. */
export async function assetFile(key, asset) {
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${asset.sha256}-${key}`);
  if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === asset.sha256) return file;
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`${key}: checksum mismatch`);
  writeFileSync(file, bytes);
  return file;
}

/** Extract only the listed members of a pinned archive into a directory, or copy a pinned single file into it under its file name. */
export async function prepareAsset(key, asset, destination) {
  const file = await assetFile(key, asset);
  mkdirSync(destination, { recursive: true });
  if (!asset.root) { copyFileSync(file, join(destination, asset.file)); return; }
  run(systemTar(), ['-xf', file, '-C', destination, '--strip-components', '1', ...asset.members.map(member => `${asset.root}/${member}`)]);
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

async function pack(stage, target, sensitive) {
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest(target), null, 2)}\n`);
  writeFileSync(join(stage, 'README.md'), readme(target));
  if (readdirSync(stage).sort().join('\n') !== [...packageFiles(target)].sort().join('\n')) throw new Error(`Unexpected ${target} staging contents`);
  const result = JSON.parse(npm(['pack', stage, '--ignore-scripts', '--json', '--pack-destination', output, '--registry', registry]));
  if (result.length !== 1 || result[0].filename !== tarballName(target)) throw new Error('Unexpected npm pack output');
  const report = await auditTarball(join(output, tarballName(target)), target, sensitive);
  writeFileSync(join(output, `audit-${target}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${packageName(target)}@${version}: audited ${report.files.length} allowlisted files`);
  return report;
}

async function buildMain(work, sensitive) {
  const source = join(work, 'main-source');
  await prepareAsset('source', lock.common.source, source);
  const library = join(source, 'scripts', 'node-addon-api', 'lib');
  if (readdirSync(library).sort().join('\n') !== [...javascript].sort().join('\n')) throw new Error('Upstream JavaScript API files differ from the allowlist');
  const stage = join(work, 'main');
  mkdirSync(stage);
  for (const file of javascript) copyFileSync(join(library, file), join(stage, file));
  copyFileSync(join(source, 'LICENSE'), join(stage, 'LICENSE'));
  return pack(stage, 'main', sensitive);
}

function compileWindows(work, compiled, sources) {
  const vs = windowsToolchain();
  console.log(`Visual Studio ${vs.version} at ${vs.path}; MSVC ${vs.environment.VCToolsVersion} ${vs.arch}; Windows SDK ${vs.environment.WindowsSDKVersion.replace(/\\$/u, '')}`);
  // /EHsc enables node-addon-api C++ exceptions; the delay-loaded host lets Electron's executable provide Node-API.
  run(join(vs.bin, 'cl.exe'), ['/nologo', '/MP', '/O2', '/EHsc', '/MT', '/std:c++17', '/utf-8', '/DNDEBUG', '/DNAPI_VERSION=8',
    '/DHOST_BINARY="node.exe"', `/I${join(work, 'source')}`, `/I${join(work, 'api')}`, `/I${join(work, 'headers', 'include', 'node')}`,
    ...sources, join(work, 'gyp', 'src', 'win_delay_load_hook.cc'), '/LD', '/Fesherpa-onnx.node',
    '/link', '/DEBUG:NONE', '/PDBALTPATH:sherpa-onnx.pdb', '/INCREMENTAL:NO', '/DELAYLOAD:node.exe',
    join(work, 'nodeLib', 'node.lib'), join(work, 'sherpa', 'lib', 'sherpa-onnx-c-api.lib'), 'delayimp.lib'], { cwd: compiled, env: vs.environment });
  const runtimeRoot = join(vs.environment.VCToolsRedistDir, vs.arch);
  const runtimeDirectory = readdirSync(runtimeRoot).find(entry => /^Microsoft\.VC\d+\.CRT$/u.test(entry));
  if (!runtimeDirectory) throw new Error(`No ${vs.arch} C++ runtime redistributable under ${runtimeRoot}`);
  return Object.fromEntries(windowsRuntime.map(file => [file, join(runtimeRoot, runtimeDirectory, file)]));
}

function compileMac(work, compiled, sources) {
  const tools = macToolchain();
  console.log(`clang ${execFileSync(tools.clang, ['--version'], { encoding: 'utf8' }).split('\n')[0]}; SDK ${tools.sdk}`);
  // Node and Electron executables provide Node-API symbols at load time.
  run(tools.clang, ['-std=c++17', '-O2', '-fPIC', '-fexceptions', '-DNDEBUG', '-DNAPI_VERSION=8', '-arch', 'arm64',
    `-mmacosx-version-min=${minimumMacOS}`, '-isysroot', tools.sdk, `-ffile-prefix-map=${work}=.`,
    `-I${join(work, 'source')}`, `-I${join(work, 'api')}`, `-I${join(work, 'headers', 'include', 'node')}`, ...sources,
    // Without an explicit install name the linker records the absolute output path.
    '-shared', '-undefined', 'dynamic_lookup', '-Wl,-install_name,@rpath/sherpa-onnx.node', '-Wl,-rpath,@loader_path', `-L${join(work, 'sherpa', 'lib')}`, '-lsherpa-onnx-c-api',
    '-o', join(compiled, 'sherpa-onnx.node')], { cwd: compiled });
  return {};
}

async function buildPlatform(target, work, sensitive) {
  const { os, cpu } = platforms[target];
  if (process.platform !== os || process.arch !== cpu) throw new Error(`${target} builds on native ${os} ${cpu} Node only`);
  const assets = { ...lock.common, ...lock.targets[target].assets };
  for (const [key, asset] of Object.entries(assets)) await prepareAsset(key, asset, join(work, key));
  for (const key of ['source', 'api', 'headers', 'gyp']) if (assets[key]) mapSourceNames(join(work, key), key);
  // Upstream releases ship sherpa-onnx-c-api but no Node binding for these platforms; compile only the binding.
  const compiled = join(work, 'compiled');
  mkdirSync(compiled);
  const bindingRoot = join(work, 'source', 'harmony-os', 'SherpaOnnxHar', 'sherpa_onnx', 'src', 'main', 'cpp');
  const sources = readdirSync(bindingRoot).filter(file => file.endsWith('.cc') && file !== 'utils.cc').sort().map(file => join(bindingRoot, file));
  const runtime = isWindows(target) ? compileWindows(work, compiled, sources) : compileMac(work, compiled, sources);
  const stage = join(work, target);
  mkdirSync(stage);
  copyFileSync(join(compiled, 'sherpa-onnx.node'), join(stage, 'sherpa-onnx.node'));
  for (const [key, asset] of Object.entries(assets)) {
    for (const [file, entry] of Object.entries(asset.ship ?? {})) copyFileSync(join(work, key, entry.path), join(stage, file));
  }
  for (const [file, path] of Object.entries(runtime)) copyFileSync(path, join(stage, file));
  for (const [source, dest] of [['source/LICENSE', 'LICENSE'], ['api/LICENSE.md', 'LICENSE-node-addon-api'],
    ...(isWindows(target) ? [['gyp/LICENSE', 'LICENSE-node-gyp']] : []), ['onnxruntime/LICENSE', 'LICENSE-onnxruntime'],
    ['onnxruntime/ThirdPartyNotices.txt', 'ThirdPartyNotices-onnxruntime.txt']]) copyFileSync(join(work, source), join(stage, dest));
  scanBytes(readFileSync(join(stage, 'sherpa-onnx.node')), sensitive);
  return pack(stage, target, sensitive);
}

/**
 * Install the main and platform tarballs into a fresh node_modules, then load the package through the upstream loader,
 * run native resampling and Silero VAD inference through ONNX Runtime, and require every eagerly loaded bundled
 * library to come from the platform package directory.
 */
export async function install(target, directory) {
  for (const name of ['main', target]) {
    const destination = join(directory, 'node_modules', ...packageName(name).split('/'));
    mkdirSync(destination, { recursive: true });
    await tar.x({ file: join(output, tarballName(name)), cwd: destination, strip: 1, strict: true });
  }
  return join(directory, 'node_modules', ...packageName('main').split('/'));
}

async function smoke(target) {
  const work = mkdtempSync(join(output, 'smoke-'));
  try {
    const main = await install(target, work);
    const platform = join(work, 'node_modules', ...packageName(target).split('/'));
    const vad = await assetFile('sileroVad', lock.testAssets.sileroVad);
    // ONNX Runtime loads onnxruntime_providers_shared.dll only for shared execution providers.
    const expected = binaries(target).filter(file => file !== 'onnxruntime_providers_shared.dll').map(file => join(platform, file).toLowerCase());
    const script = `const assert=require('node:assert/strict'); const path=require('node:path'); const s=require(${JSON.stringify(main)});
      assert.equal(typeof s.OfflineRecognizer,'function'); assert.equal(typeof s.Vad,'function');
      assert.equal(new s.LinearResampler(16000,8000).flush(new Float32Array(1600)).length,800);
      const v=new s.Vad({sileroVad:{model:${JSON.stringify(vad)},threshold:0.5,minSpeechDuration:0.25,minSilenceDuration:0.5,windowSize:512},
        sampleRate:16000,debug:0,numThreads:1},10);
      const tone=new Float32Array(16000).map((_,i)=>0.1*Math.sin(2*Math.PI*440*i/16000));
      for (let i=0;i+512<=tone.length;i+=512) v.acceptWaveform(tone.subarray(i,i+512));
      v.flush();
      const loaded=process.report.getReport().sharedObjects.map(p=>p.toLowerCase());
      for (const file of ${JSON.stringify(expected)}) {
        const hit=loaded.find(p=>path.basename(p)===path.basename(file));
        assert.ok(hit && hit.endsWith(file), path.basename(file)+' loaded from '+hit);
      }
      console.log('Smoke passed: '+process.platform+'-'+process.arch+'; resampling and Silero VAD inference; bundled libraries loaded from the package');`;
    run(process.execPath, ['-e', script]);
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10 }); }
}

async function build(target) {
  if (!targets.includes(target)) throw new Error(`Usage: node release.mjs build <${targets.join('|')}>`);
  mkdirSync(output, { recursive: true });
  const work = mkdtempSync(join(output, 'build-'));
  const sensitive = privateValues([work, root]);
  try {
    await buildMain(work, sensitive);
    if (target !== 'main') {
      await buildPlatform(target, work, sensitive);
      await smoke(target);
    }
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

/**
 * Publish audited tarballs from one directory: every platform package first, then the main package that depends on
 * them. Every tarball must match its audit report, and no version may already exist on the registry.
 */
async function publish(directory) {
  if (!directory) throw new Error('Usage: node release.mjs publish <directory with tarballs and audit reports>');
  const order = [...Object.keys(platforms), 'main'];
  const reports = Object.fromEntries(order.map(target => [target, JSON.parse(readFileSync(join(directory, `audit-${target}.json`), 'utf8'))]));
  for (const target of order) {
    const bytes = readFileSync(join(directory, tarballName(target)));
    const report = reports[target];
    if (report.name !== packageName(target) || report.version !== version) throw new Error(`${target} report is for ${report.name}@${report.version}`);
    if (createHash('sha512').update(bytes).digest('base64') !== report.sha512) throw new Error(`${target} tarball differs from its audit report`);
    if (target !== 'main' && !report.dependencies) throw new Error(`${target} report lacks native binary inspection`);
    const status = await fetch(`${registry}${encodeURIComponent(packageName(target))}/${version}`);
    if (status.status !== 404) throw new Error(`${packageName(target)}@${version} already exists or the registry returned ${status.status}`);
  }
  const extra = publicationArguments();
  for (const target of order) {
    const result = spawnSync(process.execPath, [npmCli, 'publish', join(directory, tarballName(target)), '--tag', 'latest', '--access', 'public',
      '--ignore-scripts', '--registry', registry, ...extra], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm publish ${packageName(target)} did not confirm success; inspect the registry before retrying`);
    console.log(`Published ${packageName(target)}@${version}; audited sha512-${reports[target].sha512}`);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [action, argument] = process.argv.slice(2);
  if (action === 'build') await build(argument);
  else if (action === 'publish') await publish(argument);
  else throw new Error('Usage: node release.mjs build <target> | publish <directory>');
}
