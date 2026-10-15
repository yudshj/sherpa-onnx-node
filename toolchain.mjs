/** Locate the native toolchain that every build and audit step on one host shares. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const msvcComponents = { x64: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', arm64: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' };

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

function developerEnvironment(installation, arch) {
  const vcvarsall = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  if (!existsSync(vcvarsall)) return undefined;
  // vcvarsall's exit status is unreliable; the resulting variables decide whether it configured the native toolchain.
  const output = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${vcvarsall}" ${arch} >nul 2>&1 & set"`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const environment = parseEnvironment(output);
  if (!environment.VCToolsInstallDir || !environment.VCToolsRedistDir || !environment.WindowsSdkDir
    || environment.VSCMD_ARG_HOST_ARCH !== arch || environment.VSCMD_ARG_TGT_ARCH !== arch) return undefined;
  const bin = join(environment.VCToolsInstallDir, 'bin', `Host${arch}`, arch);
  const signtool = join(environment.WindowsSdkVerBinPath ?? '', arch, 'signtool.exe');
  if (!['cl.exe', 'link.exe', 'dumpbin.exe'].every(tool => existsSync(join(bin, tool))) || !existsSync(signtool)) return undefined;
  return { environment, bin, signtool };
}

let selected;

/**
 * Select the newest Visual Studio installation whose `vcvarsall.bat` configures the native MSVC toolchain for this
 * host, its C++ runtime redistributable and a Windows SDK. VS_INSTALLATION pins one installation path.
 * @returns {{ arch: string, path: string, version: string, environment: Record<string, string>, bin: string, signtool: string }} Selected toolchain.
 */
export function windowsToolchain() {
  if (selected) return selected;
  const arch = process.arch;
  if (process.platform !== 'win32' || !msvcComponents[arch]) throw new Error('Windows builds require native Windows x64 or ARM64 Node');
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const pinned = process.env.VS_INSTALLATION?.toLowerCase();
  const candidates = JSON.parse(execFileSync(vswhere, ['-products', '*', '-requires', msvcComponents[arch], '-format', 'json'],
    { encoding: 'utf8', windowsHide: true }))
    .filter(entry => !pinned || entry.installationPath.toLowerCase() === pinned)
    .sort((a, b) => b.installationVersion.localeCompare(a.installationVersion, 'en', { numeric: true }));
  for (const candidate of candidates) {
    const developer = developerEnvironment(candidate.installationPath, arch);
    if (developer) return selected = { arch, path: candidate.installationPath, version: candidate.installationVersion, ...developer };
  }
  throw new Error(`No Visual Studio installation${pinned ? ` at ${process.env.VS_INSTALLATION}` : ''} configures native ${arch} MSVC and a Windows SDK`);
}

/**
 * Locate Xcode's command-line tools.
 * @returns {{ clang: string, otool: string, lipo: string, sdk: string }} Tool paths and the macOS SDK.
 */
export function macToolchain() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('macOS builds require native macOS ARM64 Node');
  const find = tool => execFileSync('xcrun', ['--find', tool], { encoding: 'utf8' }).trim();
  return { clang: find('clang++'), otool: find('otool'), lipo: find('lipo'),
    sdk: execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim() };
}

/**
 * Return the host's bsdtar or tar. On Windows only the built-in tar.exe is used, because GNU tar from Git or MSYS
 * treats drive-letter colons as remote hosts.
 * @returns {string} tar executable.
 */
export function systemTar() {
  if (process.platform !== 'win32') return process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
  const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(file)) throw new Error('Windows tar.exe is unavailable; use Windows 10 1803 or later');
  return file;
}
