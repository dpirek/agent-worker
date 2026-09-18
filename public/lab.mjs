import { renderMarkdown } from './lib/markdown.mjs';

const $ = id => document.getElementById(id);
const prompt = $('task-prompt'), config = $('env-config');
let taskId, timer, startedAt, polling = false;
async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const post = (url, body) => request(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
const fileUrl = path => '/workspace/' + path.split('/').map(encodeURIComponent).join('/');

$('env-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 64 * 1024) throw new Error('Choose an .env file smaller than 64 KiB.');
    config.value = await file.text();
    $('test-error').textContent = '';
  } catch (error) { $('test-error').textContent = error.message; }
  event.target.value = '';
});

async function deliveredFiles(id) {
  const container = $('test-files');
  container.replaceChildren();
  let count = 0;
  async function visit(folder, depth = 0) {
    if (depth > 8 || count >= 100) return;
    const data = await request('/api/workspace?path=' + encodeURIComponent(folder));
    for (const entry of data.entries) {
      if (count >= 100) break;
      if (entry.type === 'directory') { await visit(entry.path, depth + 1); continue; }
      count++;
      const card = document.createElement('div'); card.className = 'file-result';
      const link = document.createElement('a'); link.href = fileUrl(entry.path); link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${entry.path.slice(id.length + 1)} · ${(entry.size / 1024).toFixed(1)} KB ↗`;
      card.append(link);
      if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) {
        const image = document.createElement('img'); image.src = link.href; image.alt = entry.name; image.loading = 'lazy'; card.append(image);
      } else if (/\.(md|txt|json|csv|log)$/i.test(entry.name)) {
        const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Preview'; details.append(summary);
        details.addEventListener('toggle', async () => {
          if (!details.open || details.dataset.loaded) return;
          details.dataset.loaded = 'true';
          const pre = document.createElement('pre'); pre.textContent = 'Loading…'; details.append(pre);
          try { const data = await request('/api/workspace/file?path=' + encodeURIComponent(entry.path)); pre.textContent = data.content + (data.truncated ? '\n[Preview truncated]' : ''); }
          catch(error) { pre.textContent = error.message; }
        }); card.append(details);
      }
      container.append(card);
    }
  }
  await visit(id);
  if (!count) container.textContent = 'No files were created.';
  if (count >= 100) container.append('Showing the first 100 files. Download the ZIP for all output.');
}

async function poll() {
  if (polling || !taskId) return;
  polling = true;
  try {
    const {task} = await request('/api/tasks/' + encodeURIComponent(taskId));
    $('run-status').textContent = task.state;
    $('elapsed').textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    $('test-activity').textContent = task.activity?.map(event => `${event.at.slice(11,19)}  ${event.message}`).join('\n') || 'Waiting for agent activity…';
    if (!['submitted','working'].includes(task.state)) {
      clearTimeout(timer);
      const text = task.result?.message?.parts?.map(part => part.text || '').join('\n') || task.error || 'No text output.';
      $('test-output').classList.remove('empty-result');
      $('test-output').replaceChildren(renderMarkdown(text));
      if (task.error) $('test-error').textContent = task.error;
      $('run-test').disabled = false; $('stop-test').disabled = true;
      if (task.archive) { $('download-zip').href = fileUrl(taskId + '.zip'); $('download-zip').download = taskId + '.zip'; $('download-zip').hidden = false; }
      try { if (task.workspace) await deliveredFiles(taskId); }
      catch (error) { $('test-files').textContent = `Could not load files: ${error.message}`; }
      taskId = null;
    }
  } catch (error) { $('test-error').textContent = `Status check failed: ${error.message}. Retrying…`; }
  finally { polling = false; if (taskId) timer = setTimeout(poll, 1000); }
}
$('test-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (taskId) return;
  $('run-test').disabled = true; $('test-error').textContent = ''; $('run-status').textContent = 'Submitting…';
  $('test-output').textContent = 'The agent is working. Delivered output will appear when it finishes.';
  $('test-files').textContent = 'Waiting for files…'; $('download-zip').hidden = true;
  $('test-activity').textContent = 'Starting…';
  try {
    const result = await post('/api/test', {prompt:prompt.value, envConfig:config.value});
    taskId = result.taskId; startedAt = Date.now(); $('stop-test').disabled = false;
    await poll();
  } catch (error) { $('test-error').textContent = error.message; $('run-status').textContent = 'Not started'; $('run-test').disabled = false; }
});
$('stop-test').addEventListener('click', async () => {
  if (!taskId) return;
  $('stop-test').disabled = true;
  try { await post('/api/test/cancel', {taskId}); }
  catch(error) { $('test-error').textContent = error.message; $('stop-test').disabled = false; }
});
try {
  const settings = await request('/api/test/config');
  config.value = settings.envConfig;
  $('key-status').textContent = settings.apiKeyConfigured ? 'A provider key is configured on the worker. Omit PROVIDER_API_KEY to use it.' : 'No provider key configured. Add PROVIDER_API_KEY if your provider requires one.';
  $('run-test').disabled = false;
} catch(error) { $('test-error').textContent = `Could not load defaults: ${error.message}`; $('run-test').disabled = false; }
