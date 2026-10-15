/** Locate one Visual Studio installation and the Windows tools every build step must share. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const requiredComponents = ['Microsoft.VisualStudio.Component.VC.Tools.ARM64', 'Microsoft.VisualStudio.Component.VC.CMake.Project'];
const generators = { 17: 'Visual Studio 17 2022', 18: 'Visual Studio 18 2026' };

/**
 * Map a Visual Studio installation version to its CMake generator.
 * @param {string} installationVersion vswhere installationVersion, such as 17.14.37710.0.
 * @returns {string} Visual Studio generator name.
 */
export function generatorFor(installationVersion) {
  const generator = generators[Number.parseInt(installationVersion, 10)];
  if (!generator) throw new Error(`Unsupported Visual Studio version ${installationVersion}; use Visual Studio 2022 or 2026`);
  return generator;
}

/**
 * Select the newest Visual Studio with ARM64 C++ tools and its bundled CMake.
 * VS_INSTALLATION pins a specific installation; it must still contain both components.
 * @returns {{ path: string, version: string, generator: string, cmake: string }} Selected installation.
 */
export function visualStudio() {
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installations = JSON.parse(execFileSync(vswhere, ['-products', '*', '-requires', ...requiredComponents, '-format', 'json'],
    { encoding: 'utf8', windowsHide: true }));
  const pinned = process.env.VS_INSTALLATION;
  const selected = pinned
    ? installations.find(entry => entry.installationPath.toLowerCase() === pinned.toLowerCase())
    : installations.sort((a, b) => b.installationVersion.localeCompare(a.installationVersion, 'en', { numeric: true }))[0];
  if (!selected) {
    throw new Error(`No Visual Studio installation${pinned ? ` at ${pinned}` : ''} provides ${requiredComponents.join(' and ')}`);
  }
  const cmake = join(selected.installationPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
  if (!existsSync(cmake)) throw new Error(`Bundled CMake is missing from ${selected.installationPath}`);
  return { path: selected.installationPath, version: selected.installationVersion, generator: generatorFor(selected.installationVersion), cmake };
}

/**
 * Locate the native ARM64 dumpbin of the selected installation.
 * @param {string} installation Visual Studio installation path.
 * @returns {string} dumpbin.exe path.
 */
export function dumpbinPath(installation = visualStudio().path) {
  const tools = join(installation, 'VC', 'Tools', 'MSVC');
  for (const version of readdirSync(tools).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    const file = join(tools, version, 'bin', 'Hostarm64', 'arm64', 'dumpbin.exe');
    if (existsSync(file)) return file;
  }
  throw new Error(`ARM64 dumpbin is missing from ${installation}`);
}

/**
 * Return Windows' built-in bsdtar. GNU tar from Git or MSYS treats drive-letter colons as remote hosts.
 * @returns {string} tar.exe path.
 */
export function systemTar() {
  const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(file)) throw new Error('Windows tar.exe is unavailable; use Windows 10 1803 or later');
  return file;
}
