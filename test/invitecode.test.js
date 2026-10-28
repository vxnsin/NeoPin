import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normaliseCode } from "../src/invites.js";

// The sign-up page loads this file as a plain script, so it is run the same way here.
const file = new URL("../public/assets/scripts/invitecode.js", import.meta.url);
const { normaliseInviteCode, formatInviteCode, isCompleteInviteCode } = vm.runInNewContext(
  `${fs.readFileSync(file, "utf8")}\n({ normaliseInviteCode, formatInviteCode, isCompleteInviteCode });`
);

test("the page reads a code exactly like the server", () => {
  for (const input of ["7k3qm-x9tv2", " 7K3QM X9TV2 ", "7k3Qm x9tV2", "o1il-0-1-1u", "", "abc"]) {
    assert.equal(normaliseInviteCode(input), normaliseCode(input), input);
  }
});

test("typing is grouped as XXXXX-XXXXX and capped at ten characters", () => {
  assert.equal(formatInviteCode("7k3"), "7K3");
  assert.equal(formatInviteCode("7k3qm"), "7K3QM");
  assert.equal(formatInviteCode("7k3qmx"), "7K3QM-X");
  assert.equal(formatInviteCode(" 7k3qm x9tv2 and more"), "7K3QM-X9TV2");
  assert.equal(formatInviteCode("oil"), "011");
  assert.equal(formatInviteCode(null), "");
});

test("a code is complete at ten characters", () => {
  assert.equal(isCompleteInviteCode("7K3QM-X9TV2"), true);
  assert.equal(isCompleteInviteCode("7K3QM-X9TV"), false);
  assert.equal(isCompleteInviteCode("7k3qm x9tv2"), true);
});
