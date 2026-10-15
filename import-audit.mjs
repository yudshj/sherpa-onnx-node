/** Inspect actual PE imports with Microsoft's tool before a package can be released. */
import { execFileSync } from 'node:child_process';
import { dumpbinPath } from './toolchain.mjs';

export function parseDependents(output) {
  if (!/File Type: DLL/i.test(output)) throw new Error('dumpbin did not identify a DLL');
  const imports = [...new Set(output.split(/\r?\n/u).map(line => line.trim())
    .filter(line => /^[a-z0-9_.-]+\.(?:dll|exe)$/iu.test(line)))].sort();
  if (imports.length === 0) throw new Error('dumpbin returned no imports');
  const forbidden = imports.filter(name => /^(msvcp|vcruntime|concrt|vccorlib)[0-9_]*\.dll$/iu.test(name));
  if (forbidden.length) throw new Error(`Dynamic MSVC runtime imports: ${forbidden.join(', ')}`);
  return imports;
}

let dumpbin;

export function inspectDependents(file) {
  dumpbin ??= process.env.DUMPBIN || dumpbinPath();
  const output = execFileSync(dumpbin, ['/NOLOGO', '/DEPENDENTS', file], { encoding: 'utf8', windowsHide: true });
  return { imports: parseDependents(output), dumpbin: output.replace(/^Dump of file.*$/mu, `Dump of file ${file.split(/[\\/]/u).at(-1)}`) };
}
