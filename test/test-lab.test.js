import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createWorkerServer } from '../lib/worker.js';
import { testEnvironment } from '../lib/lab-config.js';

test('test env settings isolate runner configuration and preserve server storage', () => {
  const base={WORKER_WORKSPACE:'/worker',PORT:'3000',PROVIDER_NAME:'openai',PROVIDER_API_KEY:'base-key'};
  const selected=testEnvironment('PROVIDER_MODEL=test-model\nPROVIDER_API_KEY=run-secret\nWORKER_WORKSPACE=/tmp/other\nPORT=9999',base);
  assert.equal(selected.WORKER_WORKSPACE,'/worker');
  assert.equal(selected.PORT,'3000');
  assert.equal(selected.PROVIDER_API_KEY,'run-secret');
  assert.equal(base.PROVIDER_API_KEY,'base-key');
  assert.throws(()=>testEnvironment('WORKER_MAX_TURNS=0',base),/between 1 and 200/);
  assert.throws(()=>testEnvironment('x'.repeat(70_000),base),/64 KiB/);
});

test('test lab runs isolated configurations, returns files and activity, and supports cancellation', async t => {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'test-lab-'));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const seen=[];
  const server=createWorkerServer({env:{WORKER_WORKSPACE:workspace,WORKER_TASK_DB:':memory:',PROVIDER_NAME:'openai',PROVIDER_API_KEY:'base-key'},
    testRunnerFactory:async({env,onInfo})=>async(prompt,context)=>{
      seen.push(env.PROVIDER_MODEL);
      onInfo(`Using ${env.PROVIDER_API_KEY}`);
      context.onActivity({category:'tool',message:`Read ${env.PROVIDER_API_KEY}`});
      if(prompt==='stop') await new Promise((resolve,reject)=>{
        if(context.signal.aborted) reject(new Error('Stopped'));
        else context.signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true});
      });
      if(prompt==='fail') throw new Error(`Provider rejected ${env.PROVIDER_API_KEY}`);
      await fs.writeFile(path.join(context.workspace,'result.txt'),`Model ${env.PROVIDER_MODEL}`);
      return `Delivered by ${env.PROVIDER_MODEL}; ${env.PROVIDER_API_KEY}`;
    },onInfo:()=>{},
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=async url=>(await (await fetch(base+url)).json());
  const post=(body,route='/api/test',origin=base)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
  const wait=async(id,terminal=true)=>{
    for(let i=0;i<100;i++) {
      const {task}=await get('/api/tasks/'+id);
      if(terminal ? !['working','submitted'].includes(task.state) : task.activity.length>0)return task;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('Run did not reach expected state');
  };
  assert.equal((await fetch(base+'/test')).status,200);
  const defaults=await get('/api/test/config');
  assert.equal(defaults.apiKeyConfigured,true);
  assert.ok(!JSON.stringify(defaults).includes('base-key'));
  assert.equal((await post({prompt:'hello',envConfig:''},'/api/test','https://elsewhere.example')).status,403);
  for(const model of ['test-one','test-two']) {
    const response=await post({prompt:'run',envConfig:`PROVIDER_MODEL=${model}\nPROVIDER_API_KEY=run-secret`});
    assert.equal(response.status,202);
    const {taskId}=await response.json();
    const task=await wait(taskId);
    assert.equal(task.state,'completed');
    assert.match(task.result.message.parts[0].text,new RegExp(model));
    assert.ok(!JSON.stringify(task).includes('run-secret'));
    assert.equal(task.activity.length,2);
    assert.equal((await fetch(base+'/workspace/'+taskId+'/result.txt')).status,200);
    assert.equal((await fetch(base+'/workspace/'+taskId+'.zip')).status,200);
  }
  assert.deepEqual(seen,['test-one','test-two']);
  assert.ok(!JSON.stringify(await get('/api/status')).includes('run-secret'));
  assert.ok(!JSON.stringify(await get('/api/messages')).includes('run-secret'));
  const failed=await (await post({prompt:'fail',envConfig:'PROVIDER_API_KEY=run-secret'})).json();
  assert.match((await wait(failed.taskId)).error,/\[redacted\]/);
  const stopped=await (await post({prompt:'stop',envConfig:''})).json();
  await wait(stopped.taskId,false);
  assert.equal((await post({taskId:stopped.taskId},'/api/test/cancel')).status,200);
  assert.equal((await wait(stopped.taskId)).state,'failed');
});
