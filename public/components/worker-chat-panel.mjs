import { defineComponent } from "./define-component.mjs";

defineComponent("worker-chat-panel", {
  classes: ["panel", "chat-panel"],
  attributes: { role: "region", "aria-labelledby": "worker-chat-title" },
  template: `
    <div class="panel-head">
      <div class="panel-title"><h2 id="worker-chat-title">Chat</h2></div>
      <div class="panel-tools"><span id="chat-state" role="status">Office + REPL</span>
        <button class="panel-minimize-button" type="button" data-panel-toggle data-panel-name="Chat" aria-expanded="true" aria-label="Minimize Chat"><span class="panel-toggle-symbol" aria-hidden="true">−</span></button>
      </div>
    </div>
    <div class="chat-feed" id="chat-feed" role="log" aria-label="Incoming and outgoing messages" aria-live="polite">
      <button class="file-action" id="chat-older" type="button" hidden>Load earlier messages</button>
      <p class="preview-empty" id="chat-empty">Incoming and outgoing messages will appear here.</p>
      <div id="chat-messages"></div>
    </div>
  `,
});
