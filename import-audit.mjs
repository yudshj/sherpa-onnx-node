/** Inspect actual PE imports with Microsoft's tool before a package can be released. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function parseDependents(output) {
  if (!/File Type: DLL/i.test(output)) throw new Error('dumpbin did not identify a DLL');
  const imports = [...new Set(output.split(/\r?\n/u).map(line => line.trim())
    .filter(line => /^[a-z0-9_.-]+\.(?:dll|exe)$/iu.test(line)))].sort();
  if (imports.length === 0) throw new Error('dumpbin returned no imports');
  const forbidden = imports.filter(name => /^(msvcp|vcruntime|concrt|vccorlib)[0-9_]*\.dll$/iu.test(name));
  if (forbidden.length) throw new Error(`Dynamic MSVC runtime imports: ${forbidden.join(', ')}`);
  return imports;
}

function dumpbinPath() {
  if (process.env.DUMPBIN) return process.env.DUMPBIN;
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const roots = execFileSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' })
    .trim().split(/\r?\n/u).filter(Boolean);
  for (const root of roots) {
    const tools = join(root, 'VC', 'Tools', 'MSVC');
    if (!existsSync(tools)) continue;
    for (const version of readdirSync(tools).sort().reverse()) {
      const file = join(tools, version, 'bin', 'Hostarm64', 'arm64', 'dumpbin.exe');
      if (existsSync(file)) return file;
    }
  }
  throw new Error('ARM64 dumpbin unavailable; set DUMPBIN to its full path');
}

export function inspectDependents(file) {
  const output = execFileSync(dumpbinPath(), ['/NOLOGO', '/DEPENDENTS', file], { encoding: 'utf8', windowsHide: true });
  return { imports: parseDependents(output), dumpbin: output.replace(/^Dump of file.*$/mu, `Dump of file ${file.split(/[\\/]/u).at(-1)}`) };
}
