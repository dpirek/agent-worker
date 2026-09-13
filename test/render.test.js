import assert from "node:assert/strict";
import test from "node:test";

import { officeHeaderStatus } from "../public/lib/render.mjs";

test("shows the office connection in the header", () => {
  assert.deepEqual(officeHeaderStatus({ status: "connected" }), {
    className: "dot ok",
    text: "Connected to office",
  });
  assert.equal(officeHeaderStatus({ status: "reconnecting" }).text, "Agent reconnecting to office");
  assert.equal(officeHeaderStatus({ status: "disabled" }).text, "Office not configured");
});

test("reports Office MCP verification separately from the Office socket", async () => {
  const {officeMcpHeaderStatus}=await import('../public/lib/render.mjs');
  assert.equal(officeMcpHeaderStatus({status:'waiting'}).text,'MCP waiting');
  assert.match(officeMcpHeaderStatus({status:'waiting'}).detail,/no active MCP connection/);
  assert.equal(officeMcpHeaderStatus({status:'connected',connectedTasks:2,toolCount:10}).className,'dot ok');
  assert.match(officeMcpHeaderStatus({status:'connected',connectedTasks:2,toolCount:10}).detail,/10 tools/);
  assert.equal(officeMcpHeaderStatus({status:'error',error:'HTTP 401'}).className,'dot bad');
  assert.match(officeMcpHeaderStatus({status:'error',error:'HTTP 401'}).detail,/401/);
  assert.equal(officeMcpHeaderStatus({status:'not_provided'}).text,'MCP not supplied');
});
