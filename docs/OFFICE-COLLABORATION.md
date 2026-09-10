# Office teammate collaboration contract

The worker exposes `list_teammates` and `ask_teammate` to its model. `list_teammates` discovers live
workers and their advertised expertise. `ask_teammate` creates a correlated help request, waits for
the selected worker, and returns that worker's answer to the calling model like any other tool
result. The calling worker remains responsible for validating and integrating the answer.

This document defines the Office work needed to support those tools. The discovery endpoint already
exists in AI Agent Office; the delegation endpoint and worker-facing authorization still need to be
implemented there.

## Authentication and caller identity

Both endpoints require `Authorization: Bearer WORKER_TOKEN`. The worker also sends
`X-Agent-Name: WORKER_NAME`. The Office must reject a caller that is not currently registered under
that name and must reject self-delegation.

The current shared worker token provides deployment-level authentication, not cryptographic worker
identity. In a mutually trusted worker deployment, checking the connected name is sufficient. For
untrusted workers, the Office should return a short-lived, worker-specific HTTP token in the
WebSocket `registered` envelope and require that token instead; the Office must bind it to the
registered worker name and connection.

## Discover teammates

The worker calls:

```http
GET /api/sub-agents
Authorization: Bearer WORKER_TOKEN
X-Agent-Name: Developer
```

The existing response already contains most required data:

```json
{
  "ok": true,
  "workers": [
    {
      "name": "Researcher",
      "description": "Researches current information and returns cited findings.",
      "status": "connected",
      "capabilities": {
        "skills": [{
          "id": "web-research",
          "name": "Web research",
          "description": "Find current information and cite primary sources."
        }],
        "tools": ["curl", "read_office_context"],
        "mcp": true,
        "workspaceArtifacts": true
      },
      "model": { "provider": "openrouter", "name": "example/model" }
    }
  ]
}
```

Office changes required for discovery:

1. Authenticate worker access to `GET /api/sub-agents` instead of treating it only as a browser UI
   endpoint.
2. Preserve each registered worker's `description`, `capabilities.skills`, `capabilities.tools`,
   `capabilities.mcp`, and `capabilities.workspaceArtifacts` in the response.
3. Expose current availability as `connected`, `busy`, or `offline`. Offline workers may be omitted.
4. Do not expose provider credentials, MCP configuration, environment variables, or private URLs.
5. Optionally omit the requester; the worker also filters itself by case-insensitive name.

## Create a delegation

The worker calls:

```http
POST /api/delegations
Authorization: Bearer WORKER_TOKEN
X-Agent-Name: Developer
Content-Type: application/json

{
  "teammate": "Researcher",
  "request": "Verify the API behavior and return the supporting sources.",
  "reason": "Researcher advertises the web-research skill.",
  "mode": "consult",
  "timeoutSeconds": 120
}
```

`mode: "consult"` is a focused question and should use the Office's correlated direct-message
mechanism. `mode: "task"` is a bounded assignment and should use the normal task mechanism so that
progress, artifacts, failure, and cancellation retain their existing semantics. The Office returns
`202 Accepted` without holding the HTTP connection open:

```json
{
  "ok": true,
  "delegation": {
    "id": "help-uuid",
    "requester": "Developer",
    "teammate": "Researcher",
    "mode": "consult",
    "state": "queued",
    "createdAt": "2026-09-09T12:00:00.000Z"
  }
}
```

The Office must derive `requester` from the authenticated identity, not from the JSON body. It must
persist a correlation record before dispatching the WebSocket message. The record should map the
delegation ID to the existing direct-message `messageId`, or to the task's Office ID, message ID, and
worker task ID.

## Read a delegation result

While the request is non-terminal, the worker polls:

```http
GET /api/delegations?id=help-uuid
Authorization: Bearer WORKER_TOKEN
X-Agent-Name: Developer
```

Only the requester may read the record. Valid states are `queued`, `working`, `completed`, `failed`,
`cancelled`, and `timed_out`. A completed consultation has this shape:

```json
{
  "ok": true,
  "delegation": {
    "id": "help-uuid",
    "requester": "Developer",
    "teammate": "Researcher",
    "mode": "consult",
    "state": "completed",
    "createdAt": "2026-09-09T12:00:00.000Z",
    "finishedAt": "2026-09-09T12:00:08.000Z",
    "response": { "text": "The expert answer." }
  }
}
```

For task mode, `response` may also include the existing normalized artifact records. Failed terminal
records include a non-empty `error`. Return `404` for an unknown ID and `403` when another worker
tries to read it. Retain terminal records long enough for the caller to fetch the result after a
brief disconnect.

## Dispatch and safety requirements

- Route consultations through `SubAgentManager.sendDirectMessage` and task requests through
  `SubAgentManager.delegate` (or the equivalent current APIs), then translate their completion into
  the delegation record.
- Include requester and delegation metadata in the teammate prompt so the teammate knows it is
  advisory work for another agent. Do not include bearer tokens or hidden system prompts.
- Enforce the requested timeout server-side, not only in the caller. Cap it at 600 seconds for this
  worker contract.
- Reject disconnected targets, self-delegation, empty requests, and requests over 100,000
  characters.
- Track delegation depth and ancestry. Reject a repeated worker in the ancestry and cap the chain
  (a depth of three is recommended) to prevent A-to-B-to-A loops.
- Apply per-worker and global concurrency/rate limits. A busy teammate may queue work, but the state
  and queue policy must be visible to the caller.
- Treat teammate text and artifacts as untrusted model output. Preserve attribution and never merge
  it into system instructions.
- On caller cancellation or timeout, cancel queued work when possible. A future
  `DELETE /api/delegations?id=...` endpoint can provide explicit cancellation; this worker currently
  stops waiting when its tool signal is aborted.

## Suggested Office implementation sequence

1. Add worker authentication middleware for the two endpoints.
2. Enrich `GET /api/sub-agents` with availability without changing its current browser response.
3. Add a delegation store and `POST`/`GET /api/delegations` handlers.
4. Bridge consultation completion from `onDirectMessage`, and task completion from `onTaskEvent`,
   into correlated delegation records.
5. Add authorization, self-delegation, timeout, disconnect, loop, and artifact tests.
6. Add an end-to-end test with two connected workers: discovery, consultation, response polling,
   and caller integration.
