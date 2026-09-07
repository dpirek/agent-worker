# Agent Worker

![Agent Worker Console](screenshots/console-redesign.png)

An asynchronous coding worker built on the agentic harness in `lib/`. It accepts a task over HTTP,
immediately acknowledges it, runs a fresh `CodingAgent`, and POSTs the final result back to the
caller's callback URL.

For an integration contract that can be handed directly to another agent or orchestrator, see
[`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md).

## Run

Node.js 22.5 or newer is required for the built-in SQLite task store.
Copy the example configuration, edit it for the selected provider, and start the worker:

```sh
cp .env.example .env
# Edit PROVIDER_NAME, PROVIDER_URL, PROVIDER_API_KEY, and PROVIDER_MODEL in .env.
npm start
```

The server listens on `0.0.0.0:3000` by default. Open `/` for a browser testing REPL and live agent
status. The agent card is available at `GET /.well-known/agent-card.json`; `GET /api/info` describes
the agent's capabilities and model; `GET /health` provides a minimal health check; and
`GET /api/status` reports redacted configuration, queue, and task state.
Recent task history is persisted to `db/tasks.sqlite` by default, so the latest 50 tasks remain
visible in the console after a restart. Override the location with `WORKER_TASK_DB`.

All runtime configuration, provider options, callback settings, and tool permissions are listed in
`.env.example`. It also includes editable copies of every default system prompt. Shell environment
variables take precedence over values loaded from `.env`.

The worker auto-approves only the tools named in `WORKER_TOOLS`, because no interactive user is
present to answer approval prompts. Set `WORKER_TOOLS` explicitly to reduce its capabilities.
Agent-created files and commands are isolated to a new `.workspace/{taskId}/` subfolder for every
task. On successful completion, the worker saves the agent's final Markdown response as
`.workspace/{taskId}/output.md`. It then packages the task folder as `.workspace/{taskId}.zip` and
includes the ZIP as a file artifact in the terminal result. The task files and archive are available
at `GET /workspace/{taskId}/{path}` and `GET /workspace/{taskId}.zip`, respectively.

## Send a task

```sh
curl http://localhost:3000/a2a \
  -H 'content-type: application/json' \
  -d '{
    "message": {
      "messageId": "msg-001",
      "role": "user",
      "parts": [{ "kind": "text", "text": "Inspect the project and fix the failing tests." }]
    },
    "callback": {
      "url": "https://orchestrator.example.com/a2a/callback",
      "token": "callback-secret-xyz"
    }
  }'
```

The worker responds with HTTP `202` and a generated `taskId`. Reusing a `messageId` is idempotent:
the existing task is returned and is not run again.

When the task finishes, the callback receives `Authorization: Bearer <token>` and:

```json
{
  "taskId": "generated-uuid",
  "inReplyTo": "msg-001",
  "status": { "state": "completed" },
  "message": {
    "messageId": "result-generated-uuid",
    "role": "agent",
    "parts": [{ "kind": "text", "mimeType": "text/markdown", "text": "The agent's final result." }]
  },
  "artifacts": [{
    "artifactId": "workspace-generated-uuid",
    "name": "generated-uuid.zip",
    "parts": [{
      "kind": "file",
      "file": {
        "name": "generated-uuid.zip",
        "mimeType": "application/zip",
        "uri": "https://worker.example.com/workspace/generated-uuid.zip"
      }
    }],
    "metadata": { "fileCount": 3, "size": 12480 }
  }]
}
```

The requester downloads the ZIP from `artifacts[0].parts[0].file.uri`. Failed tasks are also sent
to the callback with `status.state` set to `failed` and an `error` object; when packaging succeeds,
their partial workspace is handed off in the same artifact shape. Callback delivery is attempted
three times by default.
