import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiUsage } from "../extensions/usage.ts";

test("normalizes the current OpenCode Go usage response", () => {
  const data = normalizeApiUsage({
    usage: {
      rolling: { percent: 12, resetsAt: "2099-01-01T00:00:00.000Z" },
      weekly: { percent: 34, resetsAt: "2099-01-02T00:00:00.000Z" },
      monthly: { percent: 56, resetsAt: "2099-02-01T00:00:00.000Z" },
    },
  });

  assert.equal(data.rolling?.usagePercent, 12);
  assert.equal(data.weekly?.usagePercent, 34);
  assert.equal(data.monthly?.usagePercent, 56);
  assert.ok((data.rolling?.resetInSec ?? 0) > 0);
});
