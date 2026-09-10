import assert from "node:assert/strict";
import test from "node:test";

import { CodingAgent } from "../lib/agent.js";
import { createAskTeammateTool, createListTeammatesTool } from "../lib/tools/team-collaboration.js";
import { createTools } from "../lib/tools/index.js";

const env = {
  AI_HARNESS_OFFICE_URL: "ws://office.example:8080/ws/workers",
  AI_HARNESS_WORKER_TOKEN: "secret",
  WORKER_NAME: "Developer",
};

test("lists other connected teammates and filters by advertised expertise", async () => {
  const requests = [];
  const tool = createListTeammatesTool({
    env,
    async fetchImpl(url, options) {
      requests.push({ url: url.href, options });
      return new Response(JSON.stringify({
        ok: true,
        workers: [
          { name: "Developer", status: "connected", capabilities: { skills: [], tools: [] } },
          {
            name: "Researcher", description: "Finds current facts.", url: "ws://private.example/agent", status: "busy",
            capabilities: {
              skills: [{ id: "web-research", name: "Research", description: "Cited web research." }],
              tools: ["curl"], mcp: true,
            },
          },
          { name: "Designer", status: "connected", capabilities: { skills: [], tools: ["generate_image"] } },
        ],
      }));
    },
  });

  const result = await tool.execute({ query: "cited web", available_only: false });
  assert.equal(result.count, 1);
  assert.equal(result.teammates[0].name, "Researcher");
  assert.equal(result.teammates[0].url, undefined);
  assert.equal(requests[0].url, "http://office.example:8080/api/sub-agents");
  assert.equal(requests[0].options.headers.authorization, "Bearer secret");
  assert.equal(requests[0].options.headers["x-agent-name"], "Developer");
});

test("can restrict teammate discovery to available workers", async () => {
  const tool = createListTeammatesTool({ env, async fetchImpl() {
    return new Response(JSON.stringify({ ok: true, workers: [
      { name: "Researcher", status: "busy" },
      { name: "Designer", status: "connected" },
    ] }));
  } });

  const result = await tool.execute({ query: null, available_only: true });
  assert.deepEqual(result.teammates.map((worker) => worker.name), ["Designer"]);
});

test("asks a teammate and polls the correlated delegation to completion", async () => {
  const requests = [];
  const tool = createAskTeammateTool({
    env, pollIntervalMs: 1,
    async fetchImpl(url, options = {}) {
      requests.push({ url: url.href, options });
      if (options.method === "POST") {
        return new Response(JSON.stringify({ ok: true, delegation: { id: "help-1", state: "queued" } }), { status: 202 });
      }
      return new Response(JSON.stringify({ ok: true, delegation: {
        id: "help-1", requester: "Developer", teammate: "Researcher", state: "completed",
        response: { text: "The supported answer." },
      } }));
    },
  });

  const result = await tool.execute({
    teammate: "Researcher",
    request: "Verify the API behavior and cite the source.",
    reason: "The teammate advertises web research.",
    mode: "consult",
    timeout_seconds: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.delegation.response.text, "The supported answer.");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://office.example:8080/api/delegations?id=help-1");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    teammate: "Researcher",
    request: "Verify the API behavior and cite the source.",
    reason: "The teammate advertises web research.",
    mode: "consult",
    timeoutSeconds: 5,
  });
});

test("returns a failed teammate result without losing its details", async () => {
  const tool = createAskTeammateTool({ env, async fetchImpl() {
    return new Response(JSON.stringify({ ok: true, delegation: {
      id: "help-2", state: "failed", error: "Researcher disconnected.",
    } }));
  } });

  const result = await tool.execute({
    teammate: "Researcher", request: "Check this.", reason: null,
    mode: "consult", timeout_seconds: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Researcher disconnected.");
});

test("registers teammate collaboration as built-in tools", () => {
  const names = createTools({ root: process.cwd(), env }).map((tool) => tool.name);
  assert.ok(names.includes("list_teammates"));
  assert.ok(names.includes("ask_teammate"));
});

test("instructs the model to select teammates by advertised expertise", async () => {
  let request;
  const collaborationTools = ["list_teammates", "ask_teammate"].map((name) => ({
    name, description: `${name} description`, parameters: { type: "object", properties: {} },
    async execute() { return { ok: true }; },
  }));
  const agent = new CodingAgent({
    client: { async createResponse(body) {
      request = body;
      return { id: "response-1", output_text: "Done.", output: [] };
    } },
    tools: collaborationTools,
    model: "test-model",
    root: process.cwd(),
  });

  await agent.run("Handle the task.");
  assert.match(request.instructions, /list_teammates to compare capabilities/);
  assert.match(request.instructions, /avoid duplicate or\s+circular requests/);
});
