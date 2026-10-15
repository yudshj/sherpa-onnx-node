/** Inspect Mach-O architectures, load commands and deployment targets of macOS binaries before release. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { macToolchain } from './toolchain.mjs';

/**
 * Read the install name, dependent libraries, run paths and deployment target from `otool -l` output.
 * @param {string} output Load commands of one single-architecture image.
 * @returns {{ id?: string, dependencies: string[], rpaths: string[], minos?: string }} Parsed load commands.
 */
export function parseLoadCommands(output) {
  const result = { dependencies: [], rpaths: [] };
  let command;
  for (const line of output.split(/\r?\n/u)) {
    const field = line.trim().match(/^(\S+) (.+?)(?: \(offset \d+\))?$/u);
    if (!field) continue;
    const [, key, value] = field;
    if (key === 'cmd') command = value;
    else if (key === 'name' && command === 'LC_ID_DYLIB') result.id = value;
    else if (key === 'name' && /^LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD)_DYLIB$/u.test(command)) result.dependencies.push(value);
    else if (key === 'path' && command === 'LC_RPATH') result.rpaths.push(value);
    else if (key === 'minos' && command === 'LC_BUILD_VERSION') result.minos = value;
  }
  return result;
}

const versionNumber = value => value.split('.').map(Number).reduce((sum, part, index) => sum + part * 1000 ** (2 - index), 0);

/**
 * Require system libraries or bundled files only, `@loader_path` as the only run path, and a deployment target no newer
 * than the package's minimum macOS.
 * @param {string} file Binary name.
 * @param {{ dependencies: string[], rpaths: string[], minos?: string }} commands Parsed load commands.
 * @param {string[]} bundled Binaries shipped beside each other.
 * @param {string} minimum Minimum macOS version the package declares.
 */
export function checkMachO(file, commands, bundled, minimum) {
  const present = new Set(bundled);
  const foreign = commands.dependencies.filter(name => !/^\/(?:usr\/lib|System\/Library)\//u.test(name)
    && !(name.startsWith('@rpath/') && present.has(name.slice('@rpath/'.length))));
  if (foreign.length) throw new Error(`${file} loads libraries that are neither bundled nor part of macOS: ${foreign.join(', ')}`);
  const rpaths = commands.rpaths.filter(path => path !== '@loader_path');
  if (rpaths.length) throw new Error(`${file} has run paths outside the package: ${rpaths.join(', ')}`);
  if (!commands.minos || versionNumber(commands.minos) > versionNumber(minimum)) {
    throw new Error(`${file} requires macOS ${commands.minos ?? 'unknown'}, newer than ${minimum}`);
  }
}

/**
 * Inspect bundled binaries in one directory.
 * @param {string} directory Directory containing the binaries.
 * @param {{ binaries: string[], minimum: string }} policy Bundled binaries and the minimum macOS version.
 * @returns {{ dependencies: Record<string, object> }} Evidence for the audit report.
 */
export function inspectMacBinaries(directory, policy) {
  const tools = macToolchain();
  const dependencies = {};
  for (const file of policy.binaries) {
    const path = join(directory, file);
    const archs = execFileSync(tools.lipo, ['-archs', path], { encoding: 'utf8' }).trim();
    if (archs !== 'arm64') throw new Error(`${file} must contain only arm64; lipo reported ${archs}`);
    const commands = parseLoadCommands(execFileSync(tools.otool, ['-l', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    checkMachO(file, commands, policy.binaries, policy.minimum);
    dependencies[file] = { arch: archs, ...commands };
  }
  return { dependencies };
}
