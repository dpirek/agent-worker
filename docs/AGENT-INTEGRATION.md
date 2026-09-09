# AI Agent Office worker integration

This worker implements the AI Agent Office WebSocket worker contract. The worker initiates and owns
one persistent connection to `ws://OFFICE_HOST:OFFICE_PORT/ws/workers` and uses `wss://` across
untrusted networks. HTTP task submission and completion callbacks are not supported.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AI_HARNESS_OFFICE_URL` | Office `ws://` or `wss://` URL. A bare origin gets `/ws/workers`. |
| `AI_HARNESS_WORKER_TOKEN` | Shared office registration credential. Required when an office URL is configured. |
| `WORKER_NAME` | Stable registry identity matching `^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$`. |
| `WORKER_DESCRIPTION` | Optional discovery description. |
| `WORKER_PUBLIC_URL` | Credential-free public HTTP(S) base used for artifact URLs and converted to the registered WS(S) identity. |
| `WORKER_RECONNECT_MIN_MS` | Initial reconnect delay; default `1000`. |
| `WORKER_RECONNECT_MAX_MS` | Maximum reconnect delay; default `30000`. |
| `WORKER_HEARTBEAT_MS` | Application heartbeat interval; default `30000`. |

These values can be loaded directly from `.env` with `npm start`, or composed through
`agent-worker.yaml` and launched with `npx agent-worker --config agent-worker.yaml`. YAML services
support Docker-style `env_file`, `environment`, variable interpolation, and `--service` selection
for manifests containing multiple worker instances.

## Lifecycle

Immediately after the socket opens, the worker sends a `register` envelope containing the shared
credential and worker identity, capabilities, and model metadata. The registered URL is the
credential-free WS(S) form of `WORKER_PUBLIC_URL` with `/agent` appended.

The worker becomes assignable after receiving `registered`. It accepts `task` messages only after
that point. Each assignment's `taskId` is used as the execution identity and its
`message.messageId` is copied to every update's `inReplyTo`.

The worker sends a `working` update as execution starts. Successful execution then ends with exactly
one `completed` update. Its `artifacts` array contains the published workspace ZIP with an
`application/zip` MIME type, byte size, and file count. The URI is published before the update
is sent and remains served by the worker HTTP process.

Failed execution ends with exactly one `failed` update containing `error.message` and explanatory
Markdown. Failed updates never include artifacts.

## Connection behavior

- JSON text messages are limited to 2 MiB; binary application messages are rejected.
- `{ "type": "ping" }` heartbeats are sent while connected; office `pong` replies are accepted.
- `task_update_ack` confirms office acceptance but does not stop worker execution.
- Task execution is placed on the worker queue outside the socket message callback.
- Closing a connection marks every unfinished task assigned to that connection failed locally.
- Reconnection uses exponential backoff and creates a fresh registration. Old tasks are never resumed.
- Close code `4001` means a newer socket replaced this worker, so the replaced client does not fight
  the new connection by reconnecting.
- Close codes `4000` and `4002` are logged and retried after backoff so corrected office state can be
  picked up without restarting the worker.

The office token is never emitted by `/api/status`; only the connection endpoint and state appear
there.
