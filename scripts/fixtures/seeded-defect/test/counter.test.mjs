import { test } from "node:test";
import assert from "node:assert/strict";
import { initialCount, bump } from "../counter.mjs";

test("bump increments by one by default", () => {
  assert.equal(bump(3), 4);
});

test("the initial count matches what the CLI prints", () => {
  assert.equal(initialCount(), 0);
});
