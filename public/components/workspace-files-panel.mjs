import { defineComponent } from "./define-component.mjs";

defineComponent("workspace-files-panel", {
  classes: ["panel", "workspace-panel"],
  attributes: { role: "region", "aria-labelledby": "workspace-files-title" },
  template: `
    <div class="panel-head">
      <div class="panel-title"><h2 id="workspace-files-title">Workspace files</h2></div>
      <div class="panel-tools">
        <button type="button" class="file-action" id="workspace-refresh">Refresh</button>
        <button type="button" class="file-action" id="workspace-expand" aria-expanded="false">Expand</button>
        <button class="panel-minimize-button" type="button" data-panel-toggle data-panel-name="Workspace files" aria-expanded="true" aria-label="Minimize Workspace files"><span class="panel-toggle-symbol" aria-hidden="true">−</span></button>
      </div>
    </div>
    <div class="workspace-toolbar">
      <button type="button" class="file-action" id="workspace-up" disabled>↑ Up</button>
      <button type="button" class="file-action" id="workspace-root">Root</button>
      <span id="workspace-path" title="Workspace root">/</span>
    </div>
    <div class="workspace-body">
      <div class="workspace-list" id="workspace-list" aria-label="Workspace entries"></div>
      <div class="workspace-preview">
        <div class="preview-toolbar"><span id="preview-name">Preview</span><button type="button" class="file-action" id="preview-mode" hidden>Source</button><a id="preview-download" class="file-action" hidden download>Download</a></div>
        <p id="workspace-feedback" role="status">Loading files…</p>
        <div id="preview-content"><p class="preview-empty">Select a file to preview.</p></div>
      </div>
    </div>
  `,
});
