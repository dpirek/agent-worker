import assert from "node:assert/strict";
import test from "node:test";

import { officeHeaderStatus } from "../public/lib/render.mjs";

test("shows the office connection in the header", () => {
  assert.deepEqual(officeHeaderStatus({ status: "connected" }), {
    className: "dot ok",
    text: "Agent connected to office",
  });
  assert.equal(officeHeaderStatus({ status: "reconnecting" }).text, "Agent reconnecting to office");
  assert.equal(officeHeaderStatus({ status: "disabled" }).text, "Office not configured");
});
