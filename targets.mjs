/** Names, file lists and manifests of the main JavaScript package and each platform binary package. */
import { readFileSync } from 'node:fs';

export const lock = JSON.parse(readFileSync(new URL('./lock.json', import.meta.url), 'utf8'));
/** One version for every package; bump it with `npm version` before each publication. */
export const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
export const sherpaVersion = lock.sherpaVersion;
export const onnxruntimeVersion = lock.onnxruntimeVersion;
export const repository = 'https://github.com/yudshj/sherpa-onnx-node';
if (!version.startsWith(`${sherpaVersion}-`)) throw new Error(`Version ${version} must be a prerelease of sherpa-onnx ${sherpaVersion}`);

/** Platform package directories follow upstream sherpa-onnx-node, whose loader looks for ../sherpa-onnx-<platform>-<arch>. */
export const platforms = {
  'win-x64': { os: 'win32', cpu: 'x64', label: 'Windows x64' },
  'win-arm64': { os: 'win32', cpu: 'arm64', label: 'Windows ARM64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', label: 'macOS ARM64 (macOS 14 or later)' },
};
export const targets = ['main', ...Object.keys(platforms)];

/** Upstream JavaScript API from scripts/node-addon-api/lib of the source tag, shipped unchanged. */
export const javascript = ['addon-static-import.js', 'addon.js', 'audio-tagg.js', 'keyword-spotter.js',
  'non-streaming-asr.js', 'non-streaming-speaker-diarization.js', 'non-streaming-speech-denoiser.js',
  'non-streaming-tts.js', 'online-speech-denoiser.js', 'punctuation.js', 'resampler.js', 'sherpa-onnx.js',
  'speaker-identification.js', 'spoken-language-identification.js', 'streaming-asr.js', 'types.js', 'vad.js'];

/** Microsoft Visual C++ runtime libraries that Microsoft's Windows ONNX Runtime imports, deployed beside it. */
export const windowsRuntime = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll'];
/** Microsoft's macOS ONNX Runtime 1.28.2 is built for macOS 14.0. */
export const minimumMacOS = '14.0';

export function assertTarget(target) {
  if (!targets.includes(target)) throw new Error(`Unknown target ${target}; expected ${targets.join(', ')}`);
}

export const isWindows = target => platforms[target]?.os === 'win32';

export function packageName(target) {
  assertTarget(target);
  return target === 'main' ? '@yudshj/sherpa-onnx-node' : `@yudshj/sherpa-onnx-${target}`;
}

/** File name produced by `npm pack` for a scoped package. */
export const tarballName = target => `${packageName(target).slice(1).replace('/', '-')}-${version}.tgz`;

/** Upstream binaries shipped byte-for-byte, keyed by package file, with the pinned SHA-256 of each. */
export function pinnedFiles(target) {
  if (target === 'main') return {};
  return Object.fromEntries(Object.values(lock.targets[target].assets)
    .flatMap(asset => Object.entries(asset.ship ?? {}).map(([file, entry]) => [file, entry.sha256])));
}

export function packageFiles(target) {
  assertTarget(target);
  if (target === 'main') return [...javascript, 'LICENSE', 'README.md', 'package.json'];
  const windows = isWindows(target);
  return ['sherpa-onnx.node', ...Object.keys(pinnedFiles(target)), ...(windows ? windowsRuntime : []),
    'LICENSE', 'LICENSE-node-addon-api', ...(windows ? ['LICENSE-node-gyp'] : []), 'LICENSE-onnxruntime',
    'ThirdPartyNotices-onnxruntime.txt', 'README.md', 'package.json'];
}

export const binaries = target => packageFiles(target).filter(file => /\.(?:node|dll|dylib)$/u.test(file));

export function manifest(target) {
  const common = { license: 'Apache-2.0', repository: { type: 'git', url: `git+${repository}.git` } };
  const files = packageFiles(target).filter(file => file !== 'package.json');
  const publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  if (target === 'main') {
    return { name: packageName(target), version,
      description: `sherpa-onnx ${sherpaVersion} Node API for Windows x64, Windows ARM64 and macOS ARM64 with Microsoft ONNX Runtime ${onnxruntimeVersion}.`,
      main: 'sherpa-onnx.js', engines: { node: '>=18' }, ...common,
      optionalDependencies: Object.fromEntries(Object.keys(platforms).map(platform => [packageName(platform), version])),
      files, publishConfig };
  }
  const { os, cpu, label } = platforms[target];
  return { name: packageName(target), version,
    description: `${label} binaries for @yudshj/sherpa-onnx-node: sherpa-onnx ${sherpaVersion} and Microsoft ONNX Runtime ${onnxruntimeVersion}.`,
    os: [os], cpu: [cpu], ...common, files, publishConfig };
}

export function readme(target) {
  const source = `Build and release source, with the origin and checksum of every file: ${repository}`;
  if (target === 'main') {
    return `# ${packageName(target)}\n\nThe [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) ${sherpaVersion} Node API, unchanged from the upstream \`v${sherpaVersion}\` source tag, `
      + `with native binaries for ${Object.values(platforms).map(platform => platform.label).join(', ')}.\n\n`
      + `npm installs the matching \`@yudshj/sherpa-onnx-<platform>\` package. Each one contains the upstream \`sherpa-onnx-c-api\` library from the sherpa-onnx GitHub release, `
      + `Microsoft's ONNX Runtime ${onnxruntimeVersion} release, and a Node-API binding compiled from the upstream sources. Other platforms are not supported.\n\n`
      + `\`\`\`js\nconst sherpa = require('${packageName(target)}');\n\`\`\`\n\n${source}\n`;
  }
  const windows = isWindows(target);
  return `# ${packageName(target)}\n\n${platforms[target].label} binaries for [@yudshj/sherpa-onnx-node](https://www.npmjs.com/package/@yudshj/sherpa-onnx-node); install that package instead.\n\n`
    + `- \`sherpa-onnx-c-api\`: unchanged from the sherpa-onnx v${sherpaVersion} GitHub release.\n`
    + `- ONNX Runtime: unchanged from Microsoft's ONNX Runtime ${onnxruntimeVersion} GitHub release${windows ? ', Microsoft-signed' : ''}.\n`
    + (windows ? `- \`${windowsRuntime.join('`, `')}\`: Microsoft-signed Visual C++ runtime libraries, so no Visual C++ Redistributable installation is required.\n` : '')
    + `- \`sherpa-onnx.node\`: Node-API v8 binding compiled from the upstream sources${windows ? ' with the Electron delay-load hook' : ''}.\n\n`
    + `It has no installation scripts, downloads, credentials, models, or recordings.\n\n${source}\n`;
}
