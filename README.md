# sherpa-onnx-win-arm64

Build and release tools for [`@yudshj/sherpa-onnx-win-arm64`](https://www.npmjs.com/package/@yudshj/sherpa-onnx-win-arm64), a Windows ARM64 build of the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Node API.

Upstream `sherpa-onnx-node` publishes no Windows ARM64 binary. This package ships the unchanged upstream JavaScript API, a Node-API v8 adapter compiled for ARM64, and the upstream ARM64 runtime DLLs. Every binary statically links the MSVC runtime, so no Visual C++ Redistributable is required. The same adapter loads in native Node and in Electron through the node-gyp delay-load hook.

## Versions

| Version | Status |
|---|---|
| `1.13.8-mt.1` | Current. Built from upstream 1.13.8 `win-arm64-shared-MT-Release-lib` and an `/MT` adapter. |
| `1.13.8` | Deprecated. Its DLLs and adapter import `MSVCP140.dll` and `VCRUNTIME140.dll`, which a clean Windows ARM64 installation lacks. |

`1.13.8-mt.1` was built and published from a Windows ARM64 workstation with the tools in this repository's first commit, using Visual Studio 2022 Build Tools 17.14 (MSVC 19.44.35229) and Windows SDK 10.0.26100.0. Later versions publish from GitHub Actions.

## Build locally

Requirements:

- Windows 11 ARM64 and native ARM64 Node.js 22 or later.
- Visual Studio 2022 or 2026 (Build Tools suffice) with the MSVC ARM64 build tools (`Microsoft.VisualStudio.Component.VC.Tools.ARM64`) and C++ CMake tools (`Microsoft.VisualStudio.Component.VC.CMake.Project`).

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run negative-control
```

The build selects the newest Visual Studio installation that has both components and uses its bundled CMake, compiler and `dumpbin`; set `VS_INSTALLATION` to pin one installation path. Archives are extracted with Windows' built-in `tar.exe`, because GNU tar from Git or MSYS treats drive-letter colons as remote hosts.

`npm run build`:

1. Downloads the inputs pinned in [`lock.json`](lock.json) and verifies their SHA-256: the upstream source tag, the upstream static-runtime ARM64 libraries, node-addon-api, Node headers and `node.lib`, the node-gyp delay-load hook, the upstream `sherpa-onnx-node` JavaScript wrapper and the ONNX Runtime notices.
2. Compiles the Node-API adapter from the upstream addon sources with [`CMakeLists.txt`](CMakeLists.txt): `/MT`, `NAPI_VERSION=8`, `/DELAYLOAD:node.exe`, no debug information and no absolute PDB path. Source `#line` directives keep build paths out of diagnostics.
3. Stages exactly the 28 allowlisted files, runs a native resampling smoke test and packs the tarball into `dist/`.
4. Audits the packed tarball: allowlist, no links or owner metadata, exact `package.json`, the ARM64 machine type from `dumpbin /HEADERS`, `dumpbin /DEPENDENTS` without dynamic MSVC runtime imports, and a scan for local user names, host names, paths, configured secrets and known credential formats. It then extracts the tarball and runs the smoke test again.

`npm run negative-control` downloads the deprecated `1.13.8` tarball, verifies its registry integrity, and requires the import audit to reject all four of its binaries.

## Publish

Publication runs from the [Publish workflow](.github/workflows/publish.yml) on `windows-11-arm` through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers); no npm token is stored in the repository. The workflow builds and audits on the runner, publishes that exact tarball with provenance, and refuses a version that already exists on the registry.

1. Bump the version: `npm version <upstream>-mt.<n> --no-git-tag-version`, then commit to `main`.
2. Run **Publish** from the Actions tab on `main` and approve the `npm` environment.

The npm package must trust this repository's `publish.yml` workflow with the `npm` environment:

```sh
npm trust github @yudshj/sherpa-onnx-win-arm64 --file publish.yml --repository yudshj/sherpa-onnx-win-arm64 --environment npm
```

`node release.mjs publish` also works locally for the `yudshj` npm account.

## Qualification with DeepSeek Harness

`node qualify.mjs <deepseek-harness-checkout> <model-assets>` loads the audited tarball in native Node 22 and 24 and in Electron 44.7.0 (Node mode and main process), then transcribes a pinned sample with the harness SenseVoice worker. It requires a prepared Windows ARM64 Desktop build in the checkout and the locked model files. These checks do not replace validation on a clean machine without Visual Studio.

## License

The tools are licensed under [Apache-2.0](LICENSE). The package includes the upstream sherpa-onnx, node-addon-api, node-gyp and ONNX Runtime licenses and notices.
