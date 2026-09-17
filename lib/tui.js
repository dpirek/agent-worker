import { stripVTControlCharacters } from 'node:util';
import { sanitizeActivity } from './activity.js';
import { renderOfficeWorker } from './tui-office-art.js';

const clean = value => stripVTControlCharacters(String(sanitizeActivity(String(value ?? ''))))
  .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');

// Count full-width characters conservatively so terminal wrapping cannot scroll
// the dashboard. Combining marks do not occupy a terminal column.
function clip(value, width) {
  let result = '', used = 0;
  for (const char of clean(value)) {
    const code = char.codePointAt(0);
    const size = /\p{Mark}/u.test(char) ? 0 : code >= 0x1100 &&
      (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7af ||
       code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
       code >= 0xff01 && code <= 0xff60 || code >= 0x1f000) ? 2 : 1;
    if (used + size > width) break;
    result += char;
    used += size;
  }
  return result;
}

const duration = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
};

export function tuiRequested(argv = process.argv.slice(2), env = process.env) {
  return argv.includes('--tui') || ['true', '1'].includes(String(env.npm_config_tui).toLowerCase());
}

export function renderDashboard(status, { columns = 80, rows = 24, logs = [], offset = 0,
  paused = false, now = Date.now(), startedAt = now, address = '', color = false } = {}) {
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows);
  const showArt = width >= 79 && height >= 20;
  const office = status.orchestration || {};
  const mcp = status.execution?.officeMcp || {};
  const queue = status.queue || {};
  const tasks = [...(status.tasks || [])].sort((a, b) =>
    Number(['working', 'submitted'].includes(b.state)) - Number(['working', 'submitted'].includes(a.state)));
  const lines = [
    `AGENT WORKER / ${status.agent?.name || 'Starting'}${paused ? ' / PAUSED' : ''}`,
    `${address}  |  uptime ${duration(now - startedAt)}`,
    '-'.repeat(width),
    `Office: ${office.status || 'starting'}  |  MCP: ${mcp.status || 'waiting'}`,
    `Model: ${status.provider?.model || 'not configured'} (${status.provider?.name || 'default'})`,
    showArt && width < 110
      ? `Tasks: ${queue.active || 0} running / ${queue.queued || 0} queued | Chat: ${queue.directMessages?.active || 0} run / ${queue.directMessages?.queued || 0} wait`
      : `Tasks: ${queue.active || 0} running / ${queue.queued || 0} queued  |  Messages: ${queue.directMessages?.active || 0} running / ${queue.directMessages?.queued || 0} queued`,
    `MCP tools: ${mcp.toolCount || mcp.connectivity?.toolCount || 0}  |  ${mcp.error || office.error || 'No connection errors'}`,
    '', 'TASKS / active first',
  ];
  const taskLimit = Math.max(1, Math.min(6, Math.floor((height - 13) / 2)));
  for (const task of tasks.slice(0, taskLimit)) {
    const start = Date.parse(task.startedAt || task.createdAt);
    const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
    lines.push(`${String(task.state).padEnd(10)} ${Number.isFinite(start) ? duration(end - start) : '-'}  ${task.taskId}${task.error ? ` / ${task.error}` : ''}`);
  }
  if (!tasks.length) lines.push('No tasks yet. Waiting for Office assignments.');
  lines.push('', `ACTIVITY${offset ? ' / history' : ' / live'}`);
  const available = Math.max(0, height - lines.length - 1);
  const end = Math.max(0, logs.length - offset);
  lines.push(...logs.slice(Math.max(0, end - available), end));
  if (!logs.length && available) lines.push('Waiting for activity...');
  const body = lines.slice(0, height - 1);
  while (body.length < height - 1) body.push('');
  body.push('q / Ctrl+C quit   space pause   up/down history   r resume');
  const art = showArt ? renderOfficeWorker(color) : [];
  return body.map((line, index) => {
    if (index >= art.length) return clip(line, width);
    const textWidth = width - 26;
    // Pad by terminal columns, including wide characters, before appending our
    // own ANSI art. Untrusted status/log text still goes through clip/clean.
    const text = clip(line, textWidth);
    const padding = clip(text + ' '.repeat(textWidth), textWidth).slice(text.length);
    return text + padding + '  ' + art[index];
  }).join('\r\n');
}

export function createTerminalMonitor({ getStatus, onQuit, input = process.stdin,
  output = process.stdout, address = '', intervalMs = 500,
  color = !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb' } = {}) {
  const enabled = Boolean(input.isTTY && output.isTTY && input.setRawMode);
  const logs = [];
  const startedAt = Date.now();
  let active = false, paused = false, offset = 0, timer, snapshot = {};
  let wasRaw, wasPaused;
  const draw = () => {
    if (!active) return;
    try {
      if (!paused) snapshot = getStatus();
      output.write('\x1b[H' + renderDashboard(snapshot, {
        columns: output.columns, rows: output.rows, logs, offset, paused, startedAt, address, color,
      }).split('\r\n').map(line => line + '\x1b[K').join('\r\n'));
    } catch (error) { log(`Monitor error: ${error.message}`); }
  };
  function log(message) {
    const line = `${new Date().toLocaleTimeString('en-GB')}  ${clean(message)}`;
    logs.push(line);
    if (logs.length > 200) logs.shift();
    if (offset || paused) offset = Math.min(logs.length - 1, offset + 1);
    if (!enabled) output.write(line + '\n');
  }
  const key = data => {
    const value = data.toString();
    if (value === 'q' || value === '\x03') { stop(); onQuit?.(); }
    else if (value === ' ') { paused = !paused; draw(); }
    else if (value === '\x1b[A') { offset = Math.min(Math.max(0, logs.length - 1), offset + 1); draw(); }
    else if (value === '\x1b[B') { offset = Math.max(0, offset - 1); draw(); }
    else if (value === 'r') { offset = 0; paused = false; draw(); }
  };
  function stop() {
    if (!active) return;
    active = false;
    clearInterval(timer);
    input.off('data', key);
    output.off('resize', draw);
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
    output.write('\x1b[?25h\x1b[?1049l');
  }
  return {
    log, stop,
    start() {
      if (active || !enabled) return;
      active = true;
      wasRaw = Boolean(input.isRaw);
      wasPaused = input.isPaused();
      input.setRawMode(true);
      input.resume();
      input.on('data', key);
      output.on('resize', draw);
      output.write('\x1b[?1049h\x1b[?25l\x1b[2J');
      draw();
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
    },
  };
}
