/** Inspect actual PE machine types and imports with Microsoft's dumpbin before a package can be released. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { toolchain } from './toolchain.mjs';

export function parseDependents(output) {
  if (!/File Type: DLL/i.test(output)) throw new Error('dumpbin did not identify a DLL');
  const imports = [...new Set(output.split(/\r?\n/u).map(line => line.trim())
    .filter(line => /^[a-z0-9_.-]+\.(?:dll|exe)$/iu.test(line)))].sort();
  if (imports.length === 0) throw new Error('dumpbin returned no imports');
  const forbidden = imports.filter(name => /^(msvcp|vcruntime|concrt|vccorlib)[0-9_]*\.dll$/iu.test(name));
  if (forbidden.length) throw new Error(`Dynamic MSVC runtime imports: ${forbidden.join(', ')}`);
  return imports;
}

export function parseMachine(output) {
  const match = output.match(/^\s*([0-9A-F]+) machine \(([^)]+)\)/imu);
  if (!match) throw new Error('dumpbin did not report a machine type');
  if (match[1].toUpperCase() !== 'AA64') throw new Error(`Expected an ARM64 binary; dumpbin reported ${match[1]} machine (${match[2]})`);
  return match[2];
}

let dumpbin;

export function inspectDependents(file) {
  dumpbin ??= process.env.DUMPBIN || join(toolchain().bin, 'dumpbin.exe');
  const options = { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const machine = parseMachine(execFileSync(dumpbin, ['/NOLOGO', '/HEADERS', file], options));
  const output = execFileSync(dumpbin, ['/NOLOGO', '/DEPENDENTS', file], options);
  return { machine, imports: parseDependents(output), dumpbin: output.replace(/^Dump of file.*$/mu, `Dump of file ${file.split(/[\\/]/u).at(-1)}`) };
}
