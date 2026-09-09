import assert from "node:assert/strict";
import test from "node:test";

import { createOfficeConnection, officeWebSocketUrl } from "../lib/office-connection.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(text) { this.sent.push(JSON.parse(text)); }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

test("normalizes a bare office origin and rejects credentials in its URL", () => {
  assert.equal(officeWebSocketUrl("ws://office.example:8080"), "ws://office.example:8080/ws/workers");
  assert.equal(officeWebSocketUrl("wss://office.example/custom"), "wss://office.example/custom");
  assert.throws(() => officeWebSocketUrl("https://office.example"), /ws:\/\/ or wss:\/\//);
  assert.throws(() => officeWebSocketUrl("ws://secret@office.example"), /must not contain credentials/);
  assert.throws(() => officeWebSocketUrl("ws://office.example?token=secret"), /query parameters/);
});

test("registers first and handles tasks and direct messages on the same socket", () => {
  FakeWebSocket.instances.length = 0;
  const tasks = [];
  const directMessages = [];
  const statuses = [];
  const connection = createOfficeConnection({
    url: "ws://office.example",
    token: "shared-secret",
    worker: { name: "Worker 1", url: "ws://worker.example/agent", capabilities: {} },
    WebSocketImpl: FakeWebSocket,
    heartbeatMs: 60_000,
    onStatus(status) { statuses.push(status); },
    onTask(task, transport) { tasks.push({ task, transport }); },
    onDirectMessage(message, transport) { directMessages.push({ message, transport }); },
  });

  connection.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent[0], {
    type: "register",
    credentials: { token: "shared-secret" },
    worker: { name: "Worker 1", url: "ws://worker.example/agent", capabilities: {} },
  });
  socket.emit("message", { data: JSON.stringify({ type: "registered", connectionId: "connection-1", worker: { name: "Worker 1" } }) });
  socket.emit("message", { data: JSON.stringify({
    type: "task", taskId: "task-1",
    message: { messageId: "message-1", parts: [{ kind: "text", text: "Run" }] },
  }) });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].transport.connectionId, "connection-1");
  tasks[0].transport.send({ type: "task_update", taskId: "task-1", status: { state: "working" } });
  assert.equal(socket.sent[1].type, "task_update");
  socket.emit("message", { data: JSON.stringify({ type: "task_update_ack", taskId: "task-1", state: "working" }) });

  socket.emit("message", { data: JSON.stringify({
    type: "direct_message",
    message: { messageId: "direct-1", parts: [{ kind: "text", text: "Which version?" }] },
  }) });
  assert.equal(directMessages.length, 1);
  assert.equal(directMessages[0].transport.connectionId, "connection-1");
  directMessages[0].transport.send({
    type: "direct_message_response",
    inReplyTo: "direct-1",
    message: { messageId: "reply-1", role: "agent", parts: [{ kind: "text", mimeType: "text/plain", text: "1.2.3" }] },
  });
  assert.equal(socket.sent[2].type, "direct_message_response");
  socket.emit("message", { data: JSON.stringify({ type: "direct_message_ack", messageId: "direct-1", state: "completed" }) });
  assert.equal(socket.readyState, FakeWebSocket.OPEN);
  assert.equal(statuses.at(-1).status, "connected");
  connection.stop();
});

test("does not fight a newer socket after close code 4001", () => {
  FakeWebSocket.instances.length = 0;
  const statuses = [];
  const connection = createOfficeConnection({
    url: "ws://office.example",
    token: "shared-secret",
    worker: { name: "Worker 1", url: "ws://worker.example/agent", capabilities: {} },
    WebSocketImpl: FakeWebSocket,
    onTask() {},
    onStatus(status) { statuses.push(status.status); },
  });
  connection.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.emit("message", { data: JSON.stringify({ type: "registered", connectionId: "old-connection" }) });
  socket.close(4001, "Worker reconnected");
  assert.equal(statuses.at(-1), "replaced");
  assert.equal(FakeWebSocket.instances.length, 1);
  connection.stop();
});

test("requires the shared worker token", () => {
  assert.throws(() => createOfficeConnection({
    url: "ws://office.example",
    token: "",
    worker: {},
    onTask() {},
    WebSocketImpl: FakeWebSocket,
  }), /AI_HARNESS_WORKER_TOKEN is required/);
});
