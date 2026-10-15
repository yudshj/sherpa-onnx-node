# sherpa-onnx-node

Build and release tools for [`@yudshj/sherpa-onnx-node`](https://www.npmjs.com/package/@yudshj/sherpa-onnx-node): the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 1.13.8 Node API with Microsoft's ONNX Runtime 1.28.2 on Windows x64, Windows ARM64 and macOS ARM64, and upstream's own binaries elsewhere.

Upstream `sherpa-onnx-node` builds against a personal ONNX Runtime rebuild (`csukuangfj/onnxruntime-libs`) on Windows and macOS and publishes no Windows ARM64 binding. These packages take every binary from the official sherpa-onnx and Microsoft GitHub releases instead, and compile only the missing Node binding.

## Packages

```sh
npm install @yudshj/sherpa-onnx-node
```

```js
const sherpa = require('@yudshj/sherpa-onnx-node');
```

| Package | Platform | Contents |
|---|---|---|
| `@yudshj/sherpa-onnx-node` | any | The 17 upstream JavaScript API files, unchanged; optional dependencies on the three platform packages and on the upstream passthroughs below |
| `@yudshj/sherpa-onnx-win-x64` | Windows 10/11 x64 | Binding, `sherpa-onnx-c-api.dll`, Microsoft ONNX Runtime, Visual C++ runtime |
| `@yudshj/sherpa-onnx-win-arm64` | Windows 10/11 ARM64 | Binding, `sherpa-onnx-c-api.dll`, Microsoft ONNX Runtime, Visual C++ runtime |
| `@yudshj/sherpa-onnx-darwin-arm64` | macOS 14 or later, Apple silicon | Binding, `libsherpa-onnx-c-api.dylib`, Microsoft ONNX Runtime |

npm installs only the platform package matching `os` and `cpu`. The upstream loader in the main package finds it at `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`, the same layout as upstream's `sherpa-onnx-<platform>-<arch>` packages, so the JavaScript is unchanged. All four packages share one version.

Upstream passthroughs: on macOS x64, Linux x64 and Linux ARM64 (glibc) the main package depends on upstream's own `sherpa-onnx-<platform>-<arch>@1.13.8` under the aliases `@yudshj/sherpa-onnx-darwin-x64`, `@yudshj/sherpa-onnx-linux-x64` and `@yudshj/sherpa-onnx-linux-arm64`, so one dependency covers every platform upstream `sherpa-onnx-node` covers plus Windows ARM64. These packages are upstream's unchanged builds, including their ONNX Runtime from `csukuangfj/onnxruntime-libs`; nothing here audits them. Microsoft stopped publishing macOS x86_64 ONNX Runtime binaries after 1.23, and sherpa-onnx 1.13.8 needs the ONNX Runtime 1.28 C API, so no trusted macOS x64 build exists. Windows x86 is not supported.

Microsoft's macOS ONNX Runtime 1.28.2 is built for macOS 14.0, so the macOS package cannot load on macOS 13 or earlier.

## Where every file comes from

| File | Source | Verification |
|---|---|---|
| JavaScript API, `LICENSE` | sherpa-onnx `v1.13.8` source tag | SHA-256 of the tag archive; the file set must equal the allowlist |
| `sherpa-onnx-c-api.dll` / `libsherpa-onnx-c-api.dylib` | sherpa-onnx `v1.13.8` GitHub release (`win-*-shared-MT-Release-lib`, `osx-arm64-shared-lib`) | SHA-256 of the release archive and of the shipped file |
| `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `libonnxruntime.dylib`, license and notices | Microsoft's ONNX Runtime `v1.28.2` GitHub release | SHA-256 of the release archive and of the shipped file; on Windows also a valid embedded Microsoft signature |
| `msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, and on x64 `vcruntime140_1.dll` (Windows) | Visual C++ redistributable of the build's Visual Studio installation | Valid embedded Microsoft signature; version at least the newest linker of any bundled binary |
| `sherpa-onnx.node` | Compiled here from the tag's addon sources, node-addon-api 8.3.0, Node 24.21.0 headers and, on Windows, `node.lib` and the node-gyp 12.4.0 delay-load hook | SHA-256 of every input |

Every pinned input and the SHA-256 of every shipped upstream binary are in [`lock.json`](lock.json).

Microsoft builds ONNX Runtime for Windows against the dynamic Visual C++ runtime. The Windows packages deploy Microsoft's signed runtime libraries beside it, so no Visual C++ Redistributable installation is required. Microsoft's macOS ONNX Runtime has only an ad-hoc signature, so its pinned SHA-256 is the verification. It ships as `libonnxruntime.dylib`, the name that sherpa-onnx's `@rpath/libonnxruntime.dylib` dependency loads.

## Build

Each platform package builds on its own native host:

| Target | Host | Toolchain |
|---|---|---|
| `main` | any | Node only |
| `win-x64` | Windows x64, native x64 Node | Visual Studio 2022 or 2026 with the x64 C++ tools and a Windows SDK |
| `win-arm64` | Windows 11 ARM64, native ARM64 Node | Visual Studio 2022 or 2026 with the ARM64 C++ tools and a Windows SDK |
| `darwin-arm64` | macOS on Apple silicon | Xcode command-line tools |

```sh
npm ci --ignore-scripts
npm test
node release.mjs build <main|win-x64|win-arm64|darwin-arm64>
node accept.mjs <win-x64|win-arm64|darwin-arm64>
```

`node release.mjs build <target>` writes the tarballs and audit reports to `dist/`. A platform build also builds the main package, because its smoke test loads the binding through the upstream loader:

1. Download every input in `lock.json` into `.cache`, verify its SHA-256, and extract only the listed members.
2. Compile the binding. On Windows this is one `cl` invocation in the `vcvarsall.bat` environment of the newest Visual Studio that configures the native toolchain, with `/MT`, `/EHsc` (node-addon-api C++ exceptions), `NAPI_VERSION=8` and the node-gyp delay-load hook with `/DELAYLOAD:node.exe`, so the same binding loads in Node and Electron. On macOS it is one `clang++` invocation with `-undefined dynamic_lookup`, `@loader_path` as the only run path and a macOS 14.0 deployment target. `VS_INSTALLATION` pins a Visual Studio installation. Source `#line` directives and explicit install names keep build paths out of the binary.
3. Stage exactly the allowlisted files and pack with `npm pack`.
4. Audit the packed tarball:
   - exact file set, no links or owner metadata, exact `package.json`;
   - every repackaged upstream binary matches its pinned SHA-256;
   - every other file except signed Windows runtime libraries is scanned for local user names, host names, home and user paths, configured secrets and known credential formats;
   - Windows: `dumpbin` reports the native machine type and imports limited to bundled files, the delay-loaded Node host and Windows components, and `signtool verify /pa` checks the embedded signatures of the Microsoft files, whose signer and issuing CA must both be `O=Microsoft Corporation`;
   - macOS: `lipo` reports only arm64, and `otool -l` shows dependencies limited to bundled files and system libraries, `@loader_path` as the only run path, and deployment targets no newer than macOS 14.0.
5. Install the main and platform tarballs into a fresh `node_modules` and run the smoke test: load the API through the upstream loader, run native resampling and Silero VAD inference through ONNX Runtime, and require every eagerly loaded bundled library to come from the platform package rather than from the system, even where Windows provides its own `onnxruntime.dll`.

`node accept.mjs <target>` transcribes `test_wavs/zh.wav` from the official SenseVoice INT8 model archive in sherpa-onnx's `asr-models` release, both whole and through Silero VAD, and requires `开饭时间早上9点至下午5点。`. Set `ELECTRON` to an Electron executable to repeat it in Electron's Node mode. These checks run on build machines that have Visual Studio or Xcode installed and do not replace validation on a clean machine.

`npm run negative-control` (Windows ARM64) downloads the two earlier `@yudshj/sherpa-onnx-win-arm64` releases and requires the binary audit to reject them: `1.13.8` imports an unbundled C++ runtime, and the ONNX Runtime in `1.13.8-mt.1` is not Microsoft-signed.

## Continuous integration

[`build.yml`](.github/workflows/build.yml) runs for every push and pull request on GitHub-hosted runners: `ubuntu-24.04` (main), `windows-2025` (win-x64), `windows-11-arm` (win-arm64) and `macos-15` (darwin-arm64). Each platform job tests the audit rules, builds, audits, smoke-tests and runs the acceptance transcription on its platform, then uploads the tarball and audit report. The main job additionally installs upstream's Linux x64 package through its alias and loads the binding with the upstream loader (`node passthrough-smoke.mjs`). Workflow actions are pinned to commit SHAs.

## Publish

[`publish.yml`](.github/workflows/publish.yml) runs `build.yml`, then publishes from the protected `npm` environment, which accepts only `main` and requires approval. It uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored, and adds provenance. `node release.mjs publish <directory>` checks that every tarball matches its audit report, that every binary package carries native inspection evidence, and that no version already exists, then publishes the three platform packages before the main package.

1. Bump the version: `npm version <upstream>-r.<n> --no-git-tag-version`, then commit to `main`.
2. Run **Publish** from the Actions tab on `main` and approve the `npm` environment.

Each of the four packages must trust `publish.yml` with the `npm` environment:

```sh
npm trust github <package> --file publish.yml --repository yudshj/sherpa-onnx-node --environment npm --allow-publish
```

npm accepts a trust relationship only for an existing package. Publish the first version of a new package from the audited CI artifacts with the owner account, `node release.mjs publish <directory>` locally, then configure trust. `--dry-run` performs every check and `npm publish --dry-run` without uploading or logging in. Registry checks use npm itself, so they follow npm's network configuration.

## Versions

| Version | Packages |
|---|---|
| `1.13.8-r.4` | Unpublished. The main package adds the upstream passthrough aliases for macOS x64 and Linux; platform packages are unchanged. |
| `1.13.8-r.3` | All four packages, published from GitHub Actions with provenance. Same contents as `1.13.8-r.2`. |
| `1.13.8-r.2` | All four packages, published from the owner account to create the new packages; no provenance. Microsoft ONNX Runtime on every platform. `@yudshj/sherpa-onnx-win-arm64` becomes a binary-only platform package; depend on `@yudshj/sherpa-onnx-node` instead. |
| `1.13.8-mt.1` | `@yudshj/sherpa-onnx-win-arm64` only, self-contained. Ships the ONNX Runtime rebuild from the sherpa-onnx release archive. |
| `1.13.8` | `@yudshj/sherpa-onnx-win-arm64` only, deprecated. Its binaries import `MSVCP140.dll` and `VCRUNTIME140.dll` without bundling them. |

## License

The tools are licensed under [Apache-2.0](LICENSE). The packages include the sherpa-onnx, node-addon-api, node-gyp (Windows) and ONNX Runtime licenses and notices. The Visual C++ runtime libraries are Microsoft redistributable code under the Visual Studio license terms.
