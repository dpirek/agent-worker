import assert from "node:assert/strict";
import test from "node:test";

import { createReadOfficeContextTool, officeHttpUrl } from "../lib/tools/read-office-context.js";

test("derives the Office HTTP origin from its worker WebSocket URL", () => {
  assert.equal(officeHttpUrl({ AI_HARNESS_OFFICE_URL: "ws://office.example:8080/ws/workers" }).href, "http://office.example:8080/");
  assert.equal(officeHttpUrl({ AI_HARNESS_OFFICE_URL: "wss://office.example/ws/workers" }).href, "https://office.example/");
});

test("reads completed summaries, full task details, and Office messages", async () => {
  const requests = [];
  const tool = createReadOfficeContextTool({
    env: {
      AI_HARNESS_OFFICE_URL: "ws://office.example:8080/ws/workers",
      AI_HARNESS_WORKER_TOKEN: "secret",
    },
    async fetchImpl(url, options) {
      requests.push({ url: url.href, options });
      if (url.pathname === "/api/memory") return new Response(JSON.stringify({
        ok: true,
        records: [{
          id: "memory-1", title: "Rate report", summary: "The report is ready.", status: "completed",
          agent: "Research Assistant", sourceId: "task-1", occurredAt: 123,
          details: { taskId: "task-1", priority: "high" }, artifacts: [{ name: "report.md" }],
        }],
      }));
      if (url.pathname === "/api/tasks") return new Response(JSON.stringify({
        ok: true,
        tasks: [{ id: "office-1", messageId: "message-1", workerTaskId: "task-1", result: "Full report contents" }],
      }));
      return new Response(JSON.stringify({
        ok: true, messages: [{ id: "chat-1", text: "What changed?" }], members: [{ name: "Office Manager" }],
      }));
    },
  });

  const summaries = await tool.execute({ view: "completed_tasks", query: "rates", full_details: false, limit: 10 });
  assert.equal(summaries.records[0].summary, "The report is ready.");
  assert.equal(summaries.records[0].artifactCount, 1);
  assert.equal(summaries.records[0].details, undefined);
  assert.match(requests[0].url, /kind=task/);
  assert.match(requests[0].url, /status=completed/);
  assert.match(requests[0].url, /query=rates/);
  assert.equal(requests[0].options.headers.authorization, "Bearer secret");

  const details = await tool.execute({ view: "task_details", query: "task-1", full_details: null, limit: null });
  assert.equal(details.task.result, "Full report contents");
  const messages = await tool.execute({ view: "messages", query: null, full_details: null, limit: 5 });
  assert.equal(messages.messages[0].text, "What changed?");
});
