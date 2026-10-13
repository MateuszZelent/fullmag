import assert from "node:assert/strict";

import {
  preparationMinimumRevision,
  preparationPublicationState,
  preparationRetryKey,
} from "../src/kernel/resources/simulationPreparationPublication.ts";
import { sessionScopedResourceKey } from "../src/kernel/resources/sessionResourceIdentity.ts";

let cases = 0;
for (const published of [undefined, null, 0, 7, 8]) {
  for (const required of [null, 0, 7, 9]) {
    const expected = published === undefined ? "unknown"
      : (published ?? 0) > 0 || (required ?? 0) > 0 ? "published" : "absent";
    assert.equal(preparationPublicationState(published, required), expected);
    assert.equal(preparationMinimumRevision(published, required),
      expected === "published" ? Math.max(published ?? 0, required ?? 0) : null);
    cases += 1;
  }
}
for (const invalid of [-1, NaN, Infinity]) {
  assert.equal(preparationPublicationState(invalid, null), "unknown");
  assert.equal(preparationMinimumRevision(invalid, 7), null);
  cases += 1;
}
const identity = { sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:1" };
const key = (scope, revision) => preparationRetryKey(sessionScopedResourceKey(scope, "preparation"), revision);
const first = key(identity, 7);
assert.notEqual(first, key({ ...identity, sessionId: "B" }, 7));
assert.notEqual(first, key({ ...identity, sessionEpoch: "A@2" }, 7));
assert.notEqual(first, key({ ...identity, requestScopeEpoch: "api:2" }, 7));
assert.notEqual(first, key(identity, 8));
assert.equal(key(identity, null), null);
console.log(`PASS: ${cases} publication/minimum cases and full-identity retry keys. React, timers, GET counts and browser NOT VERIFIED.`);
