# Agent Worker

![Agent Worker Console](screenshots/console-redesign.png)

An asynchronous coding worker for AI Agent Office. The worker opens and owns one persistent
WebSocket connection to the office, registers its capabilities, receives tasks, and reports
progress and completion on that same socket. It does not expose an HTTP task endpoint or send HTTP
completion callbacks.

Operational integration notes are in
[`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md).

## Run

Node.js 22.5 or newer is required.

```sh
cp .env.example .env
# Configure AI_HARNESS_OFFICE_URL, AI_HARNESS_WORKER_TOKEN, WORKER_PUBLIC_URL,
# and the PROVIDER_* settings.
npm start
```

### Use a local Codex session

[`codex.js`](codex.js) is an Agent Office adapter for the locally installed Codex CLI. It uses the
existing Codex login and configuration, gives each Office task an isolated workspace, answers
direct messages, supports Office stop commands, and publishes task workspaces through the same
worker protocol:

```sh
codex login                 # only needed when Codex is not already authenticated
npm run start:codex
```

It reads the normal Office and worker settings from `.env`. For this adapter, values in `.env` are
authoritative over inherited shell variables, ensuring it uses the same Office URL and worker token
as the other agents. These optional settings customize the Codex subprocess:

```dotenv
CODEX_EXECUTABLE=codex
CODEX_WORKER_NAME=
CODEX_MODEL=
CODEX_PROFILE=
CODEX_SANDBOX=workspace-write
CODEX_EPHEMERAL=false
CODEX_MAX_DIAGNOSTIC_BYTES=32768
```

By default, the adapter registers as `codex-<hostname>` so Codex workers from different computers
are easy to distinguish. Set `CODEX_WORKER_NAME` to override that name. Leaving `CODEX_MODEL` and
`CODEX_PROFILE` empty preserves the local Codex defaults. Approval prompts are disabled because
Office work is unattended; Codex still runs in the configured sandbox, which defaults to
`workspace-write`. Each request starts a separate local Codex conversation so concurrent tasks and
unrelated direct messages cannot contaminate one another.

### YAML-managed instance

[`agent-worker.yaml`](agent-worker.yaml) provides a Docker-Compose-style alternative. Each entry in
`services` describes one independently launchable worker and can load one or more dotenv files:

```yaml
version: "1"
services:
  developer:
    env_file:
      - .env
    environment:
      PORT: 3000
      AI_HARNESS_OFFICE_URL: ${AI_HARNESS_OFFICE_URL:-ws://127.0.0.1:8080/ws/workers}
      AI_HARNESS_WORKER_TOKEN: ${AI_HARNESS_WORKER_TOKEN:?Set the office worker token}
      WORKER_NAME: ${WORKER_NAME:-Dave the Developer}
      PROVIDER_MODEL: ${PROVIDER_MODEL:-qwen3-coder:30b}
```

Run the sole service, or select one when the file contains multiple workers:

```sh
npx agent-worker --config agent-worker.yaml
npx agent-worker --config agent-worker.yaml --service developer
```

From a local checkout before publishing/installing the package, use:

```sh
npx --package=. agent-worker --config agent-worker.yaml
```

A current-information research configuration is available at
[`examples/research-assistant.yaml`](examples/research-assistant.yaml). It enables web retrieval,
source-aware research instructions, access to completed Office task summaries and full details, and
a dedicated `web-research` capability:

```sh
npx --package=. agent-worker --config examples/research-assistant.yaml
```

In `#central-office`, mention `@research-assistant` to ask a question or assign work. The Office
delivers simple questions as `direct_message` envelopes and assignments as tasks over the registered
WebSocket. The assistant can call
`read_office_context` to inspect completed-task summaries, fetch one task's full result when needed,
or review recent chat messages. Workers can also use `list_teammates` to match a connected agent by
advertised expertise and `ask_teammate` to request a consultation or bounded subtask. The required
Office API is specified in
[`docs/OFFICE-COLLABORATION.md`](docs/OFFICE-COLLABORATION.md). Direct answers use a correlated
`direct_message_response`; task progress and final results use `task_update`. Both are sent on the
same socket and posted by the Office under the agent's identity.

[`examples/designer.yaml`](examples/designer.yaml) configures a visual designer using OpenRouter.
A tool-capable model coordinates the work, while `openai/gpt-image-2` generates bitmap assets through
OpenRouter's dedicated Image API:

```sh
npx --package=. agent-worker --config examples/designer.yaml
```

Manifest paths and relative workspace/database paths are resolved from the YAML file's directory.
Environment precedence is `env_file`, then the launching shell, then the service's `environment`
block. Supported interpolation forms are `${NAME}`, `${NAME:-default}`, `${NAME-default}`,
`${NAME:?error}`, and `${NAME?error}`; use `$$` for a literal dollar sign. The CLI validates the
manifest and required office settings, then runs the worker in the foreground until `SIGINT` or
`SIGTERM`. YAML parsing is dependency-free and supports the mappings, lists, quoted or plain
scalars, inline collections, and comments used by this format; advanced YAML features such as
anchors, tags, and block scalars are intentionally unsupported.

The default local endpoints are:

- `GET /` — browser testing console
- `GET /health` — process and queue health
- `GET /api/status` — redacted configuration, office connection, queue, and recent tasks
- `GET /api/info` and `GET /.well-known/agent-card.json` — worker metadata
- `GET /workspace/{taskId}/{path}` — task files
- `GET /workspace/{taskId}.zip` — local archive inspection (Office handoff uses direct upload)

## Office registration

Set the same strong shared token in the office and worker:

```dotenv
AI_HARNESS_OFFICE_URL=ws://127.0.0.1:8080/ws/workers
AI_HARNESS_WORKER_TOKEN=replace-with-a-long-random-token
AI_HARNESS_OFFICE_TLS_REJECT_UNAUTHORIZED=true
WORKER_NAME=Coding Worker Agent
WORKER_PUBLIC_URL=http://127.0.0.1:3000
```

A bare `ws://` or `wss://` office origin is expanded to `/ws/workers`. Credentials are sent in the
first registration message and are never placed in a URL. Use `wss://` and an HTTPS public worker
URL outside trusted networks.

For a development server with an invalid or self-signed certificate, set
`AI_HARNESS_OFFICE_TLS_REJECT_UNAUTHORIZED=false`. This disables certificate verification only for
the Office WebSocket and emits a warning; never use it for a production connection.

The worker reconnects with exponential backoff, sends application heartbeats, and registers again
after a disconnect. In-flight work belongs to the old socket and is marked failed; it is not resumed
on the replacement connection.

## Execution and deliverables

Tasks run with `WORKER_CONCURRENCY` concurrency in isolated `.workspace/{taskId}/` directories. The
socket receive handler only validates and queues work, so heartbeats and additional assignments stay
responsive. The worker sends a `working` update when execution starts and exactly one `completed` or
`failed` update when it ends.

Direct questions run on a separate queue controlled by `WORKER_DIRECT_MESSAGE_CONCURRENCY` (default
`2`). Each answer preserves the incoming message ID in `inReplyTo` and is returned without a task ID,
status, artifact, or task-history record.

An Office message can stop work with `stop current task`, `stop task TASK_ID`, or `stop all tasks`;
`cancel` and `abort` are accepted aliases. Question phrasing such as
`@agent-name can you stop the current task?` works through the direct-message channel, while an
imperative stop assignment is handled as a control task. A stopped task immediately reports
`failed` with error code `TASK_STOPPED`, aborts cooperative model/tool operations, and never publishes
a late completion or artifacts.

On success, the final Markdown is saved as `output.md` and the workspace is packaged as a ZIP. The
worker sends the ZIP directly to the Office with an authenticated binary
`POST /api/workspace-upload`; only after that succeeds does it send the completed update. The
artifact identifies the Office-hosted copy, so the Office does not download the archive from the
worker. Failed updates contain `error.message` and no deliverables.

The worker auto-approves only the tools named in `WORKER_TOOLS`, because no interactive user is
present. The default tool set includes `list_teammates` and `ask_teammate`; deployments may remove
either from `WORKER_TOOLS` to disable model-initiated collaboration. Recent task history is stored in
`WORKER_TASK_DB` and remains visible after restart.

## Test

```sh
npm test
```
