import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uploadWorkspaceZip } from '../lib/office-upload.js';

test('uploads raw archive bytes with assignment credentials and returns only the artifact ID', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-upload-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const archivePath = path.join(directory,'archive.zip');
  const bytes = Buffer.from([0x50,0x4b,3,4,0,255]);
  await fs.writeFile(archivePath,bytes);
  const env = {AI_HARNESS_OFFICE_URL:'wss://office.example/ws/workers',AI_HARNESS_WORKER_TOKEN:'shared-secret'};
  const artifactUpload = {url:'/api/worker-artifacts?taskId=task-1&name=<filename>',token:'task-secret',method:'POST',contentType:'application/octet-stream'};
  const options = {archivePath,taskId:'task-1',artifactUpload,env};
  const uploaded = await uploadWorkspaceZip({...options,fetchImpl:async(url,request)=>{
    assert.equal(String(url),'https://office.example/api/worker-artifacts?taskId=task-1&name=task-1.zip');
    assert.equal(request.headers.authorization,'Bearer task-secret');
    assert.equal(request.headers['content-type'],'application/octet-stream');
    assert.equal(request.method,'POST');
    assert.equal(request.redirect,'error');
    assert.deepEqual(request.body,bytes);
    return Response.json({ok:true,artifactId:'artifact-123',token:'task-secret',uri:'https://wrong.example'});
  }});
  assert.deepEqual(uploaded,{name:'task-1.zip',size:bytes.length,artifactId:'artifact-123'});
  for (const url of ['https://evil.example/api/worker-artifacts?taskId=task-1', '/api/worker-artifacts?taskId=other', '/api/workspace-upload?taskId=task-1', '/api/worker-artifacts?taskId=task-1&taskId=other']) {
    await assert.rejects(uploadWorkspaceZip({...options,artifactUpload:{...artifactUpload,url},fetchImpl:()=>assert.fail('must not fetch')}),/must belong/);
  }
  for (const config of [null, {...artifactUpload,token:''}, {...artifactUpload,method:'GET'}]) {
    await assert.rejects(uploadWorkspaceZip({...options,artifactUpload:config,fetchImpl:()=>assert.fail('must not fetch')}));
  }
  for (const response of [new Response('task-secret',{status:401}),Response.json({ok:true}),new Response('task-secret'),Response.json({ok:false,error:'task-secret'})]) {
    await assert.rejects(uploadWorkspaceZip({...options,fetchImpl:async()=>response}),error=>!error.message.includes('task-secret'));
  }
  await assert.rejects(uploadWorkspaceZip({...options,fetchImpl:async()=>new Response('x'.repeat(1_000_001))}),/within limits/);
  await assert.rejects(uploadWorkspaceZip({...options,signal:AbortSignal.abort(),fetchImpl:()=>assert.fail('must not fetch')}),/abort/i);
});
