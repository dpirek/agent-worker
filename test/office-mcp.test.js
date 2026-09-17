import assert from 'node:assert/strict';
import test from 'node:test';
import {connectOfficeMcp,normalizeOfficeMcpServers,testOfficeMcpConnectivity} from '../lib/office-mcp.js';

test('registration probe authenticates, reads project context, and releases its session', async () => {
 const requests=[];
 const env={AI_HARNESS_OFFICE_URL:'wss://office.example/ws/workers',AI_HARNESS_WORKER_TOKEN:'worker-secret'};
 let toolError=false;
 const fetchImpl=async(url,options)=>{
  assert.equal(url,'https://office.example/mcp/projects/central-office/tasks/worker-connectivity');
  assert.equal(options.headers.Authorization,'Bearer worker-secret');
  assert.equal(options.redirect,'error');
  const body=options.body?JSON.parse(options.body):{};
  requests.push(options.method==='DELETE'?'DELETE':body.method);
  if(options.method==='DELETE'||body.method==='notifications/initialized')return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-11-25'}
   :body.method==='tools/list'?{tools:[{name:'project_get_context'}]}
   :{content:[{type:'text',text:'private project content'}],isError:toolError};
  if(body.method==='tools/call')assert.deepEqual(body.params,{name:'project_get_context',arguments:{projectId:'central-office'}});
  return Response.json({jsonrpc:'2.0',id:body.id,result},{headers:{'mcp-session-id':'probe-session'}});
 };
 const result=await testOfficeMcpConnectivity({env,fetchImpl});
 assert.equal(result.status,'verified');
 assert.equal(result.toolCount,1);
 assert.ok(result.verifiedAt);
 assert.doesNotMatch(JSON.stringify(result),/worker-secret|private project content/);
 assert.deepEqual(requests,['initialize','notifications/initialized','tools/list','tools/call','DELETE']);
 toolError=true;
 await assert.rejects(testOfficeMcpConnectivity({env,fetchImpl}),/project-context connectivity test failed/);
 assert.equal(requests.at(-1),'DELETE');
 await assert.rejects(testOfficeMcpConnectivity({env,fetchImpl:async()=>new Response('worker-secret',{status:401})}),/HTTP 401/);
});
const config=(id='task-a',token='secret-a')=>({office_project:{type:'http',url:`/mcp/projects/project-a/tasks/${id}`,headers:{Authorization:`Bearer ${token}`}}});
const servers=(id='task-a',token='secret-a')=>normalizeOfficeMcpServers(config(id,token),'wss://office.example/ws/workers',id);
function mockOffice({failCall=false}={}) {
 const requests=[];
 const fetchImpl=async(url,options)=>{
  const body=options.body?JSON.parse(options.body):{};
  requests.push({url,headers:options.headers,body,method:options.method,redirect:options.redirect});
  if(options.method==='DELETE'||body.method==='notifications/initialized')return new Response(null,{status:202});
  if(failCall&&body.method==='tools/call')return new Response('secret-a',{status:401});
  const result=body.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Office',version:'1'}}
   :body.method==='tools/list'?{tools:[{name:'project_read_file',inputSchema:{type:'object',properties:{path:{type:'string'},offset:{type:'integer'}}}}]}
   :{content:[{type:'text',text:`File contents from ${url}; secret-a`}],isError:false};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json',...(body.method==='initialize'?{'mcp-session-id':'session-'+new URL(url).pathname.split('/').at(-1)}:{})}});
 };
 return {fetchImpl,requests};
}

test('normalizes Office MCP URLs and rejects cross-origin or cross-task credentials',()=>{
 assert.equal(servers()[0].url,'https://office.example/mcp/projects/project-a/tasks/task-a');
 assert.equal(normalizeOfficeMcpServers(config(),'ws://office.example:8005/ws/workers','task-a')[0].url,'http://office.example:8005/mcp/projects/project-a/tasks/task-a');
 for(const url of ['https://evil.example/mcp/projects/project-a/tasks/task-a','//evil.example/mcp/projects/project-a/tasks/task-a','/mcp/projects/project-a/tasks/task-b','/mcp/projects/project-a/tasks/task-a?token=secret','https://user:pass@office.example/mcp/projects/project-a/tasks/task-a']) {
  const value=config();value.office_project.url=url;
  assert.throws(()=>normalizeOfficeMcpServers(value,'wss://office.example/ws/workers','task-a'),/must belong/);
 }
 const missing=config();delete missing.office_project.headers;
 assert.throws(()=>normalizeOfficeMcpServers(missing,'wss://office.example','task-a'),/credential is missing/);
});

test('initializes, discovers tools, uses task authentication and negotiated protocol, then releases the session',async()=>{
 const mock=mockOffice(),states=[];
 const session=await connectOfficeMcp({servers:servers(),fetchImpl:mock.fetchImpl,onStatus:s=>states.push(s)});
 assert.deepEqual(mock.requests.map(r=>r.body.method),['initialize','notifications/initialized','tools/list']);
 assert.equal(states.at(-1).status,'connected');
 assert.equal(states.at(-1).toolCount,1);
 const result=await session.tools[0].execute({path:'notes.md',offset:64000});
 assert.match(result.content[0].text,/\[redacted\]/);
 assert.ok(!JSON.stringify(session.tools).includes('secret-a'));
 for(const r of mock.requests){assert.equal(r.headers.Authorization,'Bearer secret-a');assert.equal(r.redirect,'error');}
 assert.equal(mock.requests[1].headers['MCP-Protocol-Version'],'2025-06-18');
 assert.equal(mock.requests[1].headers['MCP-Session-Id'],'session-task-a');
 assert.deepEqual(mock.requests[3].body.params,{name:'project_read_file',arguments:{path:'notes.md',offset:64000,projectId:'project-a'}});
 await session.close();
 assert.equal(mock.requests.at(-1).method,'DELETE');
 const count=mock.requests.length;
 await assert.rejects(session.tools[0].execute({path:'notes.md'}),/cancelled/);
 assert.equal(mock.requests.length,count);
});

test('keeps concurrent task sessions and credentials separate',async()=>{
 const mock=mockOffice();
 const [a,b]=await Promise.all(['a','b'].map(id=>connectOfficeMcp({servers:servers(`task-${id}`,`secret-${id}`),fetchImpl:mock.fetchImpl})));
 await Promise.all([a.tools[0].execute({path:'a.md'}),b.tools[0].execute({path:'b.md'})]);
 for(const r of mock.requests){const id=r.url.endsWith('task-a')?'a':'b';assert.equal(r.headers.Authorization,`Bearer secret-${id}`);if(r.body.method!=='initialize')assert.equal(r.headers['MCP-Session-Id'],`session-task-${id}`);}
 await a.close();await b.tools[0].execute({path:'still-accessible.md'});await b.close();
});

test('rejects expired credentials without exposing server error bodies',async()=>{
 const mock=mockOffice({failCall:true}),states=[];
 const session=await connectOfficeMcp({servers:servers(),fetchImpl:mock.fetchImpl,onStatus:s=>states.push(s)});
 await assert.rejects(session.tools[0].execute({path:'a.md'}),/HTTP 401/);
 assert.equal(states.at(-1).status,'error');
 assert.ok(!JSON.stringify(states).includes('secret-a'));
 await session.close();
});

test('aborts in-flight MCP calls when the task is cancelled',async()=>{
 const mock=mockOffice(),controller=new AbortController();let started;
 const waiting=new Promise(resolve=>started=resolve);
 const session=await connectOfficeMcp({servers:servers(),signal:controller.signal,fetchImpl:async(url,options)=>{
  if(options.body&&JSON.parse(options.body).method==='tools/call')return new Promise((resolve,reject)=>{started();options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  return mock.fetchImpl(url,options);
 }});
 const request=session.tools[0].execute({path:'a.md'});
 const rejected=assert.rejects(request,/cancelled/);
 await waiting;controller.abort();await rejected;await session.close();
});
