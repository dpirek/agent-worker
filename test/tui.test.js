import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTerminalMonitor, renderDashboard, tuiRequested } from '../lib/tui.js';

const status = {
  agent: {name:'Test Worker'}, provider:{model:'test-model',name:'test'},
  orchestration:{status:'connected'}, execution:{officeMcp:{status:'verified',connectivity:{toolCount:5}}},
  queue:{active:1,queued:2,directMessages:{active:1,queued:0}},
  tasks:[{taskId:'old-task',state:'completed'}, {taskId:'live-task',state:'working',startedAt:'2026-01-01T00:00:00Z'}],
};

test('dashboard shows worker connectivity, queues, tasks, and bounded activity', () => {
  const view=renderDashboard(status,{rows:24,columns:90,logs:['model / started','tool / read_file'],now:Date.parse('2026-01-01T00:01:00Z')});
  assert.match(view,/Office: connected.*MCP: verified/);
  assert.match(view,/1 running \/ 2 queued/);
  assert.match(view,/MCP tools: 5/);
  assert.ok(view.indexOf('live-task')<view.indexOf('old-task'));
  assert.match(view,/tool \/ read_file/);
  assert.equal(view.split('\r\n').length,24);
  for(const rows of [1,6,16,24]) {
    const compact=renderDashboard(status,{rows,columns:20});
    assert.equal(compact.split('\r\n').length,rows);
    assert.ok(compact.split('\r\n').every(line=>line.length<=19));
  }
});

test('dashboard treats terminal escapes and credentials as untrusted text', () => {
  const view=renderDashboard({...status,agent:{name:'\x1b[2Jbad\x1b]0;title\x07'},orchestration:{status:'error',error:'Bearer private-token'}},
    {logs:['\x1b[31mtool\x1b[0m\nspoofed line'],columns:100});
  assert.doesNotMatch(view,/\x1b|\x07|private-token/);
  assert.match(view,/Bearer \[redacted\]/);
});

test('monitor restores terminal state, supports pause/history, and stops once', () => {
  const input=new EventEmitter(),output=new EventEmitter();
  input.isTTY=output.isTTY=true;
  input.isRaw=false;
  input.isPaused=()=>true;
  input.setRawMode=value=>{input.isRaw=value;};
  input.resume=()=>{};
  let inputPaused=false;
  input.pause=()=>{inputPaused=true;};
  output.columns=80;output.rows=24;
  let written='',reads=0,quits=0;
  output.write=text=>{written+=text;};
  const monitor=createTerminalMonitor({input,output,getStatus:()=>{reads++;return status;},onQuit:()=>quits++});
  monitor.start();
  assert.equal(input.isRaw,true);
  assert.match(written,/\x1b\[\?1049h/);
  monitor.log('activity');
  input.emit('data',Buffer.from(' '));
  const pausedReads=reads;
  output.emit('resize');
  assert.equal(reads,pausedReads);
  assert.match(written,/PAUSED/);
  input.emit('data',Buffer.from('r'));
  assert.ok(reads>pausedReads);
  input.emit('data',Buffer.from('q'));
  monitor.stop();
  assert.equal(quits,1);
  assert.equal(input.isRaw,false);
  assert.equal(inputPaused,true);
  assert.equal(input.listenerCount('data'),0);
  assert.equal(output.listenerCount('resize'),0);
  assert.ok(written.endsWith('\x1b[?25h\x1b[?1049l'));
});

test('non-terminal output uses plain logs and npm flags enable the monitor', () => {
  let written='';
  const monitor=createTerminalMonitor({input:{},output:{write:text=>{written+=text;}}});
  monitor.start();monitor.log('hello');monitor.stop();
  assert.match(written,/hello/);
  assert.doesNotMatch(written,/\x1b/);
  assert.equal(tuiRequested(['--tui'],{}),true);
  assert.equal(tuiRequested([],{npm_config_tui:'true'}),true);
  assert.equal(tuiRequested([],{}),false);
});
