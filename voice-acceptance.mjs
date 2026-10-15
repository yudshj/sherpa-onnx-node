/** Exercise the real provider worker over its private loopback API; no external model API is used. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const root=import.meta.dirname, token=randomBytes(32).toString('hex');
const child=spawn(process.execPath,[join(root,'worker.mjs'),await readFile(join(root,'voice-config.json'),'utf8')],{
  env:{...process.env,DSH_SPEECH_TOKEN:token,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','inherit'],windowsHide:true});
const exited=once(child,'exit'), lines=createInterface({input:child.stdout});
const timeout=setTimeout(()=>child.kill(),120000);
try {
  const [line]=await Promise.race([once(lines,'line'),exited.then(([code])=>{throw Error(`Worker exited ${code}`)})]);
  const {port}=JSON.parse(line), audio=await readFile(join(root,'zh.wav'));
  const request=async language=>{
    const r=await fetch(`http://127.0.0.1:${port}/transcribe?language=${language}`,{method:'POST',
      headers:{authorization:`Bearer ${token}`},body:audio,signal:AbortSignal.timeout(60000)});
    return {status:r.status,body:await r.json()};
  };
  const cold=await request('zh'),warm=await request('zh'),bad=await request('fr'),after=await request('zh');
  assert.equal(cold.status,200);assert.ok(cold.body.text.length>0);assert.equal(warm.body.text,cold.body.text);
  assert.equal(bad.status,400);assert.equal(after.status,200);assert.equal(after.body.text,cold.body.text);
  console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null,arch:process.arch,
    cold,warm,invalidLanguageStatus:bad.status,afterInvalidStatus:after.status}));
} finally {clearTimeout(timeout);lines.close();child.kill();await exited;}
