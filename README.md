# sherpa-onnx-node

Build and release tools for [`@yudshj/sherpa-onnx-win-arm64`](https://www.npmjs.com/package/@yudshj/sherpa-onnx-win-arm64), a Windows ARM64 package of the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Node API.

Upstream `sherpa-onnx-node` publishes no Windows ARM64 binding. This repository repackages official upstream artifacts and compiles only the missing Node binding.

## Where every file comes from

| Package file | Source | Verification |
|---|---|---|
| JavaScript API (17 files), `LICENSE` | sherpa-onnx `v1.13.8` source tag | SHA-256 of the tag archive; file set must equal the allowlist |
| `sherpa-onnx-c-api.dll` | sherpa-onnx `v1.13.8` GitHub release, `win-arm64-shared-MT-Release-lib` | SHA-256 of the release archive |
| `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, ONNX Runtime license and notices | Microsoft's ONNX Runtime `v1.28.2` GitHub release, `onnxruntime-win-arm64-1.28.2.zip` | SHA-256 of the release archive and a valid embedded Microsoft Corporation signature |
| `msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll` | Visual C++ ARM64 redistributable of the build's Visual Studio installation | Valid embedded Microsoft Corporation signature; version at least the newest linker of any bundled binary |
| `sherpa-onnx.node` | Compiled here from the tag's addon sources, node-addon-api 8.3.0, Node 24.21.0 headers and the node-gyp 12.4.0 delay-load hook | SHA-256 of every input |

The ONNX Runtime inside sherpa-onnx's own Windows release archives is a rebuild published outside Microsoft (`csukuangfj/onnxruntime-libs`), so it is not shipped. sherpa-onnx 1.13.8 targets ONNX Runtime 1.28.2 through its C API, and Microsoft's 1.28.2 release provides that API. Microsoft builds ONNX Runtime against the dynamic Visual C++ runtime; the runtime libraries are deployed beside it, so no Visual C++ Redistributable installation is required. Windows loads them from the package directory: the smoke test requires every eagerly loaded DLL, including `onnxruntime.dll`, to come from the package even when Windows provides its own `onnxruntime.dll` or a newer runtime in `System32`.

## Versions

| Version | Status |
|---|---|
| `1.13.8-r.2` | Unpublished. Microsoft ONNX Runtime and C++ runtime, as described above. |
| `1.13.8-mt.1` | Current on npm. Ships the static-runtime ONNX Runtime rebuild from the sherpa-onnx release archive. |
| `1.13.8` | Deprecated. Its DLLs and binding import `MSVCP140.dll` and `VCRUNTIME140.dll` without bundling them. |

## Build locally

Requirements:

- Windows 11 ARM64 and native ARM64 Node.js 22 or later.
- Visual Studio 2022 or 2026 (Build Tools suffice) with the MSVC ARM64 build tools (`Microsoft.VisualStudio.Component.VC.Tools.ARM64`) and a Windows SDK. CMake is not required.

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run negative-control
```

The build selects the newest Visual Studio installation whose `vcvarsall.bat arm64` configures native ARM64 MSVC, its C++ runtime redistributable and a Windows SDK, and uses that installation's compiler, linker, `dumpbin` and `signtool`; set `VS_INSTALLATION` to pin one installation path. Archives are extracted with Windows' built-in `tar.exe`, because GNU tar from Git or MSYS treats drive-letter colons as remote hosts.

`npm run build`:

1. Downloads the inputs pinned in [`lock.json`](lock.json), verifies their SHA-256, and extracts only the listed members.
2. Compiles the Node binding with one `cl` invocation: `/MT`, `/EHsc` (node-addon-api C++ exceptions), `NAPI_VERSION=8`, the node-gyp delay-load hook with `/DELAYLOAD:node.exe` so the same binding loads in Node and Electron, no debug information and no absolute PDB path. Source `#line` directives keep build paths out of diagnostics.
3. Stages exactly the 31 allowlisted files, runs the smoke test and packs the tarball into `dist/`.
4. Audits the packed tarball: allowlist, no links or owner metadata, exact `package.json`, and a scan for local user names, host names, paths, configured secrets and known credential formats. From the extracted tarball it then checks every binary with `dumpbin`: ARM64 machine type, and imports limited to bundled files, the delay-loaded Node host and Windows components. `signtool verify /pa` checks the embedded signatures of the Microsoft files. The smoke test runs again on the extracted package.

`npm run negative-control` downloads both earlier releases, verifies their registry integrity, and requires the binary audit to reject them: `1.13.8` imports an unbundled C++ runtime, and the ONNX Runtime in `1.13.8-mt.1` is not Microsoft-signed.

## Publish

Publication runs from the [Publish workflow](.github/workflows/publish.yml) on GitHub's `windows-11-arm` runner through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers); no npm token is stored in the repository. Workflow actions are pinned to commit SHAs. The workflow builds and audits on the runner, publishes that exact tarball with provenance, and refuses a version that already exists on the registry.

1. Bump the version: `npm version <upstream>-r.<n> --no-git-tag-version`, then commit to `main`.
2. Run **Publish** from the Actions tab on `main` and approve the `npm` environment.

The npm package must trust this repository's `publish.yml` workflow with the `npm` environment:

```sh
npm trust github @yudshj/sherpa-onnx-win-arm64 --file publish.yml --repository yudshj/sherpa-onnx-node --environment npm --allow-publish
```

`node release.mjs publish` also works locally for the `yudshj` npm account.

## Qualification with DeepSeek Harness

`node qualify.mjs <deepseek-harness-checkout> <model-assets>` loads the audited tarball in native Node 22 and 24 and in Electron 44.7.0 (Node mode and main process), then transcribes a pinned sample with the harness SenseVoice worker. It requires a prepared Windows ARM64 Desktop build in the checkout and the locked model files; `ELECTRON` overrides the checkout's Electron 44.7.0 executable. These checks do not replace validation on a clean machine without Visual Studio.

## License

The tools are licensed under [Apache-2.0](LICENSE). The package includes the sherpa-onnx, node-addon-api, node-gyp and ONNX Runtime licenses and notices. The Visual C++ runtime libraries are Microsoft redistributable code under the Visual Studio license terms.
