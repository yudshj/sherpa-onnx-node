/** Locate one Visual Studio ARM64 toolchain that every build and audit step shares. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const arm64Tools = 'Microsoft.VisualStudio.Component.VC.Tools.ARM64';

/**
 * Parse the output of cmd's `set` into an environment object.
 * @param {string} output Lines of NAME=value.
 * @returns {Record<string, string>} Environment variables.
 */
export function parseEnvironment(output) {
  const environment = {};
  for (const line of output.split(/\r?\n/u)) {
    // Drive-current-directory entries such as =C:=C:\work are not inheritable variables.
    const separator = line.startsWith('=') ? -1 : line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function developerEnvironment(installation) {
  const vcvarsall = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  if (!existsSync(vcvarsall)) return undefined;
  // vcvarsall's exit status is unreliable; the resulting variables decide whether it configured ARM64.
  const output = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${vcvarsall}" arm64 >nul 2>&1 & set"`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const environment = parseEnvironment(output);
  if (!environment.VCToolsInstallDir || !environment.VCToolsRedistDir || !environment.WindowsSdkDir) return undefined;
  const bin = join(environment.VCToolsInstallDir, 'bin', 'Hostarm64', 'arm64');
  const signtool = join(environment.WindowsSdkVerBinPath ?? '', 'arm64', 'signtool.exe');
  if (!['cl.exe', 'link.exe', 'dumpbin.exe'].every(tool => existsSync(join(bin, tool))) || !existsSync(signtool)) return undefined;
  return { environment, bin, signtool };
}

let selected;

/**
 * Select the newest Visual Studio installation whose `vcvarsall.bat arm64` configures native ARM64 MSVC, its C++
 * runtime redistributable and a Windows SDK. VS_INSTALLATION pins one installation path.
 * @returns {{ path: string, version: string, environment: Record<string, string>, bin: string, signtool: string }} Selected toolchain.
 */
export function toolchain() {
  if (selected) return selected;
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const pinned = process.env.VS_INSTALLATION?.toLowerCase();
  const candidates = JSON.parse(execFileSync(vswhere, ['-products', '*', '-requires', arm64Tools, '-format', 'json'],
    { encoding: 'utf8', windowsHide: true }))
    .filter(entry => !pinned || entry.installationPath.toLowerCase() === pinned)
    .sort((a, b) => b.installationVersion.localeCompare(a.installationVersion, 'en', { numeric: true }));
  for (const candidate of candidates) {
    const developer = developerEnvironment(candidate.installationPath);
    if (developer) return selected = { path: candidate.installationPath, version: candidate.installationVersion, ...developer };
  }
  throw new Error(`No Visual Studio installation${pinned ? ` at ${process.env.VS_INSTALLATION}` : ''} configures native ARM64 MSVC and a Windows SDK`);
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
