/** Inspect PE machine types, import closure and publisher signatures with Microsoft's tools before release. */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { toolchain } from './toolchain.mjs';

/** Windows components present on every supported Windows 10/11 ARM64 installation. */
const systemLibraries = new Set(['kernel32.dll', 'advapi32.dll', 'setupapi.dll', 'dbghelp.dll', 'dxgi.dll']);

export function isSystemLibrary(name) {
  return systemLibraries.has(name.toLowerCase()) || /^api-ms-win-[a-z0-9-]+\.dll$/iu.test(name);
}

export function parseDependents(output) {
  if (!/File Type: DLL/i.test(output)) throw new Error('dumpbin did not identify a DLL');
  const imports = [...new Set(output.split(/\r?\n/u).map(line => line.trim())
    .filter(line => /^[a-z0-9_.-]+\.(?:dll|exe)$/iu.test(line)))].sort();
  if (imports.length === 0) throw new Error('dumpbin returned no imports');
  return imports;
}

export function parseHeaders(output) {
  const machine = output.match(/^\s*([0-9A-F]+) machine \(([^)]+)\)/imu);
  if (!machine) throw new Error('dumpbin did not report a machine type');
  if (machine[1].toUpperCase() !== 'AA64') throw new Error(`Expected an ARM64 binary; dumpbin reported ${machine[1]} machine (${machine[2]})`);
  const linker = output.match(/^\s*([0-9]+\.[0-9]+) linker version/imu);
  if (!linker) throw new Error('dumpbin did not report a linker version');
  return { machine: machine[2], linker: linker[1] };
}

/**
 * Require every import to be a bundled file, the delay-loaded Node host, or a Windows component.
 * @param {Record<string, { imports: string[] }>} dependencies Imports per bundled binary.
 * @param {string[]} bundled Binaries shipped beside each other.
 */
export function checkClosure(dependencies, bundled) {
  const present = new Set(bundled.map(name => name.toLowerCase()));
  for (const [file, { imports }] of Object.entries(dependencies)) {
    const missing = imports.filter(name => !present.has(name.toLowerCase()) && name.toLowerCase() !== 'node.exe' && !isSystemLibrary(name));
    if (missing.length) throw new Error(`${file} imports libraries that are neither bundled nor part of Windows: ${missing.join(', ')}`);
  }
}

/**
 * Require valid embedded Microsoft Corporation Authenticode signatures on files that must come from Microsoft.
 * @param {Record<string, { status: string, subject: string }>} signatures Signature per file.
 * @param {string[]} files Files that must be Microsoft-signed.
 */
export function checkMicrosoftSignatures(signatures, files) {
  for (const file of files) {
    const signature = signatures[file];
    if (signature?.status !== 'Valid' || !/^CN=Microsoft Corporation,/u.test(signature.subject)) {
      throw new Error(`${file} must carry a valid Microsoft Corporation Authenticode signature`);
    }
  }
}

const versionNumber = value => {
  const [major, minor] = value.split('.').map(Number);
  return major * 1000 + minor;
};

/**
 * Require each bundled C++ runtime library to be at least as new as every linker that produced a bundled binary.
 * @param {Record<string, { linker: string }>} dependencies Linker version per binary.
 * @param {Record<string, string | undefined>} runtimeVersions File version per runtime library.
 */
export function checkRuntimeVersions(dependencies, runtimeVersions) {
  const required = Math.max(...Object.values(dependencies).map(entry => versionNumber(entry.linker)));
  for (const [file, version] of Object.entries(runtimeVersions)) {
    if (!version || versionNumber(version) < required) throw new Error(`${file} ${version} is older than the newest bundled linker`);
  }
}

/**
 * Verify each file's embedded Authenticode signature with signtool and read its signer and file version.
 * Get-AuthenticodeSignature reports a matching system catalog instead when one exists, which depends on the machine.
 */
function embeddedSignatures(paths) {
  const script = "$ErrorActionPreference='Stop'; $result=[ordered]@{}; foreach ($path in ($env:AUDIT_FILES | ConvertFrom-Json)) {"
    + ' try { $subject=([Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($path)).Subject } catch { $subject="" };'
    + ' $result[[IO.Path]::GetFileName($path)]=[ordered]@{subject=$subject;version=(Get-Item -LiteralPath $path).VersionInfo.FileVersion} };'
    + ' $result | ConvertTo-Json -Compress';
  const details = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, AUDIT_FILES: JSON.stringify(paths) } }));
  for (const path of paths) {
    const file = path.split(/[\\/]/u).at(-1);
    const verified = spawnSync(toolchain().signtool, ['verify', '/pa', '/q', path], { windowsHide: true });
    details[file] = { status: verified.status === 0 ? 'Valid' : details[file].subject ? 'Invalid' : 'NotSigned', ...details[file] };
  }
  return details;
}

let dumpbin;

/**
 * Inspect bundled binaries in one directory.
 * @param {string} directory Directory containing the binaries.
 * @param {{ binaries: string[], microsoft: string[], runtime: string[] }} policy Bundled binaries, files that must be
 *   Microsoft-signed, and C++ runtime libraries whose version must cover every linker.
 * @returns {{ dependencies: Record<string, object>, signatures: Record<string, object> }} Evidence for the audit report.
 */
export function inspectBinaries(directory, policy) {
  dumpbin ??= process.env.DUMPBIN || join(toolchain().bin, 'dumpbin.exe');
  const options = { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const dependencies = {};
  for (const file of policy.binaries) {
    const path = join(directory, file);
    const headers = parseHeaders(execFileSync(dumpbin, ['/NOLOGO', '/HEADERS', path], options));
    const output = execFileSync(dumpbin, ['/NOLOGO', '/DEPENDENTS', path], options);
    dependencies[file] = { ...headers, imports: parseDependents(output), dumpbin: output.replace(/^Dump of file.*$/mu, `Dump of file ${file}`) };
  }
  checkClosure(dependencies, policy.binaries);
  const signatures = embeddedSignatures(policy.binaries.map(file => join(directory, file)));
  checkMicrosoftSignatures(signatures, policy.microsoft);
  checkRuntimeVersions(dependencies, Object.fromEntries(policy.runtime.map(file => [file, signatures[file]?.version])));
  return { dependencies, signatures };
}
