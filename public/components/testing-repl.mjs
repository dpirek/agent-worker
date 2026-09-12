import { defineComponent } from "./define-component.mjs";

defineComponent("testing-repl", {
  classes: ["panel", "repl-panel"],
  attributes: { role: "region", "aria-labelledby": "repl-title" },
  template: `
    <div class="panel-head">
      <div class="panel-title">
        <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m8 5 7 7-7 7"/></svg>
        <span class="head-rule"></span><h2 id="repl-title">Testing REPL</h2>
      </div>
      <div class="panel-tools">
        <span class="badge" id="run-state">idle</span>
        <button class="panel-minimize-button" type="button" data-panel-toggle data-panel-name="Testing REPL" aria-expanded="true" aria-label="Minimize Testing REPL" title="Minimize Testing REPL"><span class="panel-toggle-symbol" aria-hidden="true">−</span></button>
      </div>
    </div>
    <div class="console" id="console"><div class="empty"><div class="empty-target">Send a task to exercise the configured agent.<br>Enter sends · Shift+Enter adds a new line.</div></div></div>
    <form id="repl-form">
      <textarea id="prompt" rows="1" aria-label="Task prompt" placeholder="Ask the worker to inspect, change, or explain something in its workspace…" required></textarea>
    </form>
  `,
});
