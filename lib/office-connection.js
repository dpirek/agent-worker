import WebSocket from "ws";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function websocketErrorDetail(event) {
  const error = event?.error || event;
  const messages = [];
  for (let current = error; current; current = current.cause) {
    const message = String(current.message || "").trim();
    if (message && !messages.includes(message)) messages.push(message);
  }
  const attributes = [];
  for (const key of ["code", "errno", "syscall", "hostname", "address", "port"]) {
    const value = error?.[key] ?? error?.cause?.[key];
    if (value !== undefined && value !== "") attributes.push(`${key}=${value}`);
  }
  return [messages.join(": ") || String(event?.message || "Unknown WebSocket error"), ...attributes].join("; ");
}

function officeWebSocketUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error("AI_HARNESS_OFFICE_URL must use ws:// or wss://.");
  }
  if (url.username || url.password) {
    throw new Error("AI_HARNESS_OFFICE_URL must not contain credentials.");
  }
  if (url.search) throw new Error("AI_HARNESS_OFFICE_URL must not contain query parameters.");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws/workers";
  url.hash = "";
  return url.href;
}

function sendJson(socket, payload) {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    throw new Error("Worker message exceeds the 2 MiB protocol limit.");
  }
  socket.send(text);
}

function createOfficeConnection({
  url,
  token,
  worker,
  onTask,
  onDirectMessage = () => {},
  onDisconnect = () => {},
  onStatus = () => {},
  onInfo = console.error,
  WebSocketImpl = WebSocket,
  tlsRejectUnauthorized = true,
  reconnectMinMs = DEFAULT_RECONNECT_MIN_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const endpoint = officeWebSocketUrl(url);
  const credential = String(token || "").trim();
  if (!credential) throw new Error("AI_HARNESS_WORKER_TOKEN is required to register with the office.");
  if (!worker || typeof worker !== "object") throw new Error("Worker registration details are required.");
  if (typeof onTask !== "function") throw new Error("An office task handler is required.");
  if (typeof WebSocketImpl !== "function") throw new Error("This Node.js runtime does not provide a WebSocket client.");
  const rejectUnauthorized = tlsRejectUnauthorized !== false;
  if (!rejectUnauthorized && new URL(endpoint).protocol === "wss:") {
    onInfo(`WARNING: TLS certificate verification is disabled for the Office WebSocket at ${endpoint}.`);
  }

  const minimumDelay = positiveInteger(reconnectMinMs, DEFAULT_RECONNECT_MIN_MS);
  const maximumDelay = Math.max(minimumDelay, positiveInteger(reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS));
  const heartbeatDelay = positiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS);
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  let attempts = 0;
  let activeConnectionId = null;
  let status = "disconnected";
  let lastSocketError = "";

  function setStatus(next, details = {}) {
    status = next;
    onStatus({ status, endpoint, connectionId: activeConnectionId, ...details });
  }

  function clearTimers() {
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  }

  function scheduleReconnect(closeCode, error = "") {
    if (stopped) return;
    if (closeCode === 4001) {
      setStatus("replaced");
      return;
    }
    const delay = Math.min(maximumDelay, minimumDelay * (2 ** Math.min(attempts, 10)));
    attempts += 1;
    setStatus("reconnecting", { retryInMs: delay, ...(error ? { error } : {}) });
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (stopped) return;
    clearTimers();
    setStatus("connecting");
    lastSocketError = "";
    let current;
    try {
      current = new WebSocketImpl(endpoint, [], { rejectUnauthorized });
    } catch (error) {
      lastSocketError = websocketErrorDetail(error);
      onInfo(`Office WebSocket connection failed at ${endpoint}: ${lastSocketError}`);
      setStatus("disconnected", { error: lastSocketError });
      scheduleReconnect(undefined, lastSocketError);
      return;
    }
    socket = current;

    current.addEventListener("open", () => {
      if (current !== socket || stopped) return;
      setStatus("registering");
      sendJson(current, { type: "register", credentials: { token: credential }, worker });
      heartbeatTimer = setInterval(() => {
        if (current === socket && current.readyState === WebSocketImpl.OPEN) {
          try { sendJson(current, { type: "ping" }); } catch (error) { onInfo(`Office heartbeat failed: ${error.message}`); }
        }
      }, heartbeatDelay);
      heartbeatTimer.unref?.();
    });

    current.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("The office sent a non-text WebSocket message.");
        if (Buffer.byteLength(event.data) > MAX_MESSAGE_BYTES) throw new Error("Office message exceeds the 2 MiB protocol limit.");
        const payload = JSON.parse(event.data);
        if (payload.type === "registered") {
          activeConnectionId = String(payload.connectionId || "");
          attempts = 0;
          setStatus("connected", { worker: payload.worker });
          return;
        }
        if (payload.type === "task") {
          if (!activeConnectionId) throw new Error("The office assigned a task before registration completed.");
          onTask(payload, {
            connectionId: activeConnectionId,
            send(update) {
              if (current !== socket || current.readyState !== WebSocketImpl.OPEN) {
                throw new Error("The office WebSocket is not connected.");
              }
              sendJson(current, update);
            },
          });
          return;
        }
        if (payload.type === "direct_message") {
          if (!activeConnectionId) throw new Error("The office sent a direct message before registration completed.");
          onDirectMessage(payload, {
            connectionId: activeConnectionId,
            send(response) {
              if (current !== socket || current.readyState !== WebSocketImpl.OPEN) {
                throw new Error("The office WebSocket is not connected.");
              }
              sendJson(current, response);
            },
          });
          return;
        }
        if (["task_update_ack", "direct_message_ack", "pong"].includes(payload.type)) return;
        if (payload.type === "error") {
          onInfo(`Office protocol error: ${payload.error || "Unknown error"}`);
          return;
        }
        throw new Error(`Unexpected office message type: ${payload.type || "(missing)"}`);
      } catch (error) {
        onInfo(`Invalid office message: ${error.message}`);
        current.close(4002, "Worker protocol error");
      }
    });

    current.addEventListener("error", (event) => {
      if (current !== socket) return;
      lastSocketError = websocketErrorDetail(event);
      onInfo(`Office WebSocket error at ${endpoint}: ${lastSocketError}`);
      setStatus("error", { error: lastSocketError });
    });

    current.addEventListener("close", (event) => {
      if (current !== socket) return;
      clearTimers();
      socket = null;
      const connectionId = activeConnectionId;
      activeConnectionId = null;
      setStatus("disconnected", {
        code: event.code,
        reason: event.reason,
        ...(lastSocketError ? { error: lastSocketError } : {}),
      });
      if (connectionId) onDisconnect(connectionId, event.reason || "Office connection closed.");
      scheduleReconnect(event.code, lastSocketError);
    });
  }

  return {
    start: connect,
    stop() {
      stopped = true;
      clearTimers();
      const current = socket;
      socket = null;
      activeConnectionId = null;
      if (current && current.readyState < WebSocketImpl.CLOSING) current.close(1000, "Worker shutting down");
      setStatus("stopped");
    },
    getStatus() { return { status, endpoint, connectionId: activeConnectionId }; },
  };
}

export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_RECONNECT_MIN_MS,
  MAX_MESSAGE_BYTES,
  createOfficeConnection,
  officeWebSocketUrl,
  websocketErrorDetail,
};
