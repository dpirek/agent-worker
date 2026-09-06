# Agent-to-Agent Integration Guide

This document is the protocol contract for any agent or orchestrator that delegates work to the
Agent Worker. The worker accepts a task asynchronously and sends the result to a caller-controlled
HTTP callback.

## Information the calling agent needs

Before sending work, obtain:

- `WORKER_BASE_URL`: the reachable origin of this worker, such as `https://worker.example.com`.
- `CALLBACK_URL`: an HTTP(S) endpoint controlled by the calling agent and reachable by the worker.
- `CALLBACK_TOKEN`: an optional shared secret the calling agent will verify on callbacks.

The worker's configured workspace and enabled tools determine what it can do. By default, all agent
file operations and commands are isolated to the worker's `.workspace/` directory, which is created
when the server starts. Inspect `GET /api/status` before delegating if the task depends on a
particular model or tool.

## Recommended interaction

1. Start the callback receiver before submitting a task.
2. Optionally verify readiness with `GET /health`.
3. Discover the agent at `GET /.well-known/agent-card.json`.
4. Create a unique, stable `messageId` for the task.
5. Send the task to the card's `url`, normally `POST /a2a`.
6. Treat HTTP `202` as acceptance only, not completion.
7. Wait for a callback whose `inReplyTo` matches the submitted `messageId`.
8. Handle both `completed` and `failed` terminal states.
9. Deduplicate callback retries by `taskId` or the result `message.messageId`.

## Discovery

### `GET /.well-known/agent-card.json`

Example response:

```json
{
  "name": "Coding Worker Agent",
  "description": "Completes coding tasks in its configured workspace.",
  "url": "https://worker.example.com/a2a",
  "skills": [
    {
      "id": "coding-task",
      "name": "Coding Task",
      "description": "Inspect, modify, and validate a software workspace."
    }
  ]
}
```

Use the returned `url` for task submission rather than constructing it when possible.

## Submit a task

### `POST /a2a`

Request headers:

```http
Content-Type: application/json
```

Request body:

```json
{
  "message": {
    "messageId": "deploy-api-fix-20260906-001",
    "role": "user",
    "parts": [
      {
        "kind": "text",
        "text": "Inspect the API tests, fix the failing request validation, and run the relevant tests."
      }
    ]
  },
  "callback": {
    "url": "https://orchestrator.example.com/agent-callback",
    "token": "a-caller-generated-secret"
  }
}
```

Contract details:

- `message.messageId` is required, must be non-empty, and must not exceed 200 characters.
- `message.parts` must contain at least one non-empty `{ "kind": "text" }` part.
- Multiple text parts are joined with a blank line, in order.
- `callback.url` is required and must be HTTP or HTTPS without embedded URL credentials.
- `callback.token` is optional. If present, it is returned as a Bearer token.
- The maximum request size is controlled by `WORKER_MAX_MESSAGE_BYTES`.
- Agent reply text is Markdown. Text parts declare `"mimeType": "text/markdown"`.
- Created files are linked through `/workspace/{workspace-relative-path}` using percent-encoded paths.

Successful acceptance returns HTTP `202`:

```json
{
  "accepted": true,
  "taskId": "2a16f377-e557-42c6-a842-d339ed077234",
  "messageId": "deploy-api-fix-20260906-001",
  "status": "working"
}
```

The initial `status` can be `submitted` or `working`, depending on how quickly a queue slot becomes
available.

### Idempotency

`messageId` is the idempotency key. Repeating a message ID does not execute the task again. The
worker returns HTTP `202` with the original `taskId` and adds `"duplicate": true`.

Idempotency and task history are currently in memory. They reset when the worker process restarts.

## Receive the result

The worker performs an HTTP `POST` to `callback.url` with JSON content. If a callback token was
provided, the request includes:

```http
Authorization: Bearer a-caller-generated-secret
Content-Type: application/json
```

Verify the token using a timing-safe comparison before accepting the result.

### Completed callback

```json
{
  "taskId": "2a16f377-e557-42c6-a842-d339ed077234",
  "inReplyTo": "deploy-api-fix-20260906-001",
  "status": { "state": "completed" },
  "message": {
    "messageId": "result-2a16f377-e557-42c6-a842-d339ed077234",
    "role": "agent",
    "parts": [
      {
        "kind": "text",
        "mimeType": "text/markdown",
        "text": "Implemented the validation fix.\n\n### Created files\n\n- [report.md](https://worker.example.com/workspace/report.md)"
      }
    ]
  }
}
```

### Failed callback

```json
{
  "taskId": "2a16f377-e557-42c6-a842-d339ed077234",
  "inReplyTo": "deploy-api-fix-20260906-001",
  "status": { "state": "failed" },
  "message": {
    "messageId": "result-2a16f377-e557-42c6-a842-d339ed077234",
    "role": "agent",
    "parts": [{ "kind": "text", "text": "Task failed: model unavailable" }]
  },
  "error": {
    "code": "TASK_FAILED",
    "message": "model unavailable"
  }
}
```

The callback receiver should return any HTTP `2xx` status. Non-2xx responses and network failures
are retried according to `WORKER_CALLBACK_RETRIES` and `WORKER_CALLBACK_TIMEOUT_MS`. Because a
callback may be delivered more than once, processing must be idempotent.

## Observe status or poll a task

Callbacks are the primary completion mechanism. Polling is available for recovery and diagnostics.

### `GET /health`

```json
{ "ok": true, "active": 1, "queued": 2 }
```

### `GET /api/tasks/{taskId}`

While running:

```json
{
  "ok": true,
  "task": {
    "taskId": "2a16f377-e557-42c6-a842-d339ed077234",
    "messageId": "deploy-api-fix-20260906-001",
    "state": "working",
    "source": "a2a",
    "callbackDelivered": false,
    "createdAt": "2026-09-06T12:00:00.000Z",
    "startedAt": "2026-09-06T12:00:00.010Z",
    "finishedAt": null,
    "error": null,
    "callbackError": null
  }
}
```

For a terminal task, `state` is `completed` or `failed` and `result` contains the same payload sent
to the callback. `callbackDelivered` indicates whether a callback endpoint returned a 2xx response;
`callbackError` explains exhausted delivery attempts.

### `GET /api/status`

Returns redacted agent identity, provider/model, workspace, enabled tools, system prompt overrides,
MCP status, callback policy, queue counts, and the 50 most recent tasks. It never returns the
provider API key, only `apiKeyConfigured: true|false`.

### `GET /workspace/{path}`

Serves a file from the agent's workspace with its detected content type. Paths in Markdown replies
use this endpoint. For example, `https://worker.example.com/workspace/reports/result%20one.md`
serves `.workspace/reports/result one.md`. Paths cannot escape the configured workspace.

## HTTP errors

Errors returned before task acceptance have this shape:

```json
{ "ok": false, "error": "Human-readable explanation." }
```

Expected status codes:

- `400`: malformed JSON, message, prompt, or callback.
- `404`: unknown endpoint or task ID.
- `413`: request exceeds `WORKER_MAX_MESSAGE_BYTES`.

Do not wait for a callback if task submission did not return HTTP `202` with `accepted: true`.

## Minimal Node.js caller

This example assumes the callback server is reachable by the worker at the supplied callback URL.

```js
import crypto from "node:crypto";
import http from "node:http";

const workerBaseUrl = process.env.WORKER_BASE_URL;
const callbackPublicUrl = process.env.CALLBACK_PUBLIC_URL;
const callbackToken = process.env.CALLBACK_TOKEN;

const pending = new Map();
const callbackServer = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/agent-callback") {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${callbackToken}`) {
    res.writeHead(401).end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const resolve = pending.get(result.inReplyTo);
  if (resolve) {
    pending.delete(result.inReplyTo);
    resolve(result);
  }
  res.writeHead(204).end();
});

callbackServer.listen(8080);

async function delegate(text) {
  const messageId = crypto.randomUUID();
  const resultPromise = new Promise((resolve) => pending.set(messageId, resolve));
  const response = await fetch(`${workerBaseUrl}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        messageId,
        role: "user",
        parts: [{ kind: "text", text }],
      },
      callback: {
        url: `${callbackPublicUrl}/agent-callback`,
        token: callbackToken,
      },
    }),
  });
  const accepted = await response.json();
  if (response.status !== 202 || !accepted.accepted) {
    pending.delete(messageId);
    throw new Error(accepted.error || `Worker returned HTTP ${response.status}`);
  }
  return resultPromise;
}

const result = await delegate("Inspect the project and report the current test failures.");
console.log(result);
callbackServer.close();
```

## Copyable instructions for another agent

Provide the following text together with the concrete worker and callback URLs:

> Delegate coding tasks to the Agent Worker. First fetch
> `WORKER_BASE_URL/.well-known/agent-card.json`. Send each task as a unique text message to the
> returned URL using `POST /a2a`, including a reachable callback URL and shared callback token.
> Treat HTTP 202 as acceptance only. Wait for a callback with a matching `inReplyTo`; verify its
> Bearer token, deduplicate it by `taskId`, and handle both `completed` and `failed` states. Use
> `GET /api/tasks/{taskId}` only as a polling fallback. Never reuse a `messageId` for different work.

## Security notes

- The worker currently has no built-in authentication on task submission or status endpoints. Put it
  behind an authenticated reverse proxy or keep it on a trusted network.
- Give the worker a dedicated callback token and rotate it if exposed.
- Do not place secrets in task text; task content can be processed by the configured model provider.
- Review `WORKER_WORKSPACE` and `WORKER_TOOLS` before delegation. Enabled tools are auto-approved.
