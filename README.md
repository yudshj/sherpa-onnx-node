# Windows ARM64 sherpa release tools

Build and publish `@yudshj/sherpa-onnx-win-arm64@1.13.8-mt.1`. The package exposes the upstream `sherpa-onnx-node` JavaScript API and ships Windows ARM64 native binaries. The package is based on upstream 1.13.8 and statically links the MSVC runtime.

Use native Windows ARM64 Node, CMake, Visual Studio 2022 ARM64 C++ build tools. Log in with the `yudshj` npm account separately; no credentials belong in this directory.

```powershell
npm install --ignore-scripts
npm test
npm run build
npm run check
npm run publish:package
```

`build` verifies pinned SHA-256 downloads, compiles the Node-API v8 adapter with the Electron delay-load hook, and stages only the exact allowlisted runtime files. Source `#line` directives give compiled diagnostics public relative filenames; release linking excludes debug information and absolute PDB paths. Build work directories are private to each invocation and removed on completion or failure. `dist` contains the final tarball and a public-data-only audit report.

`check` inspects the actual compressed tarball, rejects extra files, links, duplicate entries, missing files, unexpected manifest fields, non-ARM64 binaries and personal tar owner metadata. Every DLL and Node addon is checked with dumpbin /DEPENDENTS; dynamic MSVC runtime imports fail the audit. It scans UTF-8/ASCII and UTF-16 data for local usernames, hostnames, paths, configured sensitive environment values, npm credentials, and known secret formats. Values are read into memory and never included in diagnostics. It then extracts the audited archive into a fresh directory, loads the API and executes native resampling.

`publish:package` audits again and publishes that exact tarball, with lifecycle scripts disabled, only through the public npm registry and the expected account. An existing version is rejected. A failed publish requires checking registry state before retrying; npm may require an interactive authentication step. npm publicly identifies the publisher account; this is registry metadata, not a bundled secret.

The scanner is defense in depth, not a claim that arbitrary data can be proven secret-free. The primary protection is constructing the package exclusively from checksum-pinned public upstream inputs and newly compiled runtime binaries. Review `dist/audit.json` and the allowlist before publication. Never add user configuration, logs, recordings, models, compiler outputs other than the `.node`, or build scripts to the allowlist.
`node qualify.mjs <harness-worktree> <model-assets>` verifies the exact archive with native Node 22/24, Electron 44.7.0 in Node and main-process modes, and locked SenseVoice INT8/Silero models. Reports are saved in `dist/evidence`. `node negative-control.mjs` rejects the preserved old registry binaries. Clean-machine validation is separate from these local checks.
