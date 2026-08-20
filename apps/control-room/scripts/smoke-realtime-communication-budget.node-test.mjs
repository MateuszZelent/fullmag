import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildQuantitySwitchAckProof,
  writeQuantitySwitchAckProofArtifact,
} from "./smoke-realtime-communication-budget.mjs";

const expectation = {
  resourceKey: "/v2/sessions/current/data/fields/H_demag/samples/vector?scope=full",
  revision: 7,
  viewportId: "main",
};

function validProof() {
  return buildQuantitySwitchAckProof({
    acknowledgements: [{ revision: 7, status: "rendered", viewportId: "main" }],
    expectations: [expectation],
    requests: [{ direction: "tx", method: "GET", path: expectation.resourceKey }],
  });
}

test("writes and reads an atomic valid quantity ACK proof artifact", () => {
  const directory = mkdtempSync("/tmp/fullmag-quantity-proof-");
  const artifact = join(directory, "proof.json");
  try {
    const proof = validProof();
    assert.equal(proof.result, "pass");
    writeQuantitySwitchAckProofArtifact(proof, artifact);
    assert.equal(existsSync(artifact), true);
    assert.equal(JSON.parse(readFileSync(artifact, "utf8")).schemaVersion, 1);
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test("fails closed for missing, duplicate, unexpected and style-only GET/ACK evidence", () => {
  const invalid = buildQuantitySwitchAckProof({
    acknowledgements: [
      { revision: 7, status: "rendered", viewportId: "main" },
      { revision: 99, status: "rendered", viewportId: "extra" },
    ],
    expectations: [expectation, { ...expectation, resourceKey: "style", revision: 8, styleOnly: true }],
    requests: [
      { direction: "tx", method: "GET", path: expectation.resourceKey },
      { direction: "tx", method: "GET", path: expectation.resourceKey },
      { direction: "tx", method: "GET", path: "style" },
      { direction: "tx", method: "GET", path: "/v2/sessions/current/data/fields/m/samples/vector?scope=full" },
    ],
  });
  assert.equal(invalid.result, "fail");
  assert.equal(invalid.failures.length >= 4, true);
});

test("fails closed for empty expectations, zero events, invalid expectations and malformed ACK POST", () => {
  for (const expectations of [[], [{ resourceKey: "x" }]]) {
    const proof = buildQuantitySwitchAckProof({ acknowledgements: [], expectations, requests: [] });
    assert.equal(proof.result, "fail");
  }
  const malformed = buildQuantitySwitchAckProof({
    acknowledgements: [{ raw: "not-json" }],
    expectations: [expectation],
    requests: [{ direction: "tx", method: "GET", path: expectation.resourceKey }],
  });
  assert.equal(malformed.result, "fail");
  assert.equal(malformed.failures.includes("malformed visualization ACK POST"), true);
});
