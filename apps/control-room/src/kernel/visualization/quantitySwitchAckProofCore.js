export function createQuantitySwitchAckProofRecorder() {
  const acknowledgements = [];
  const requests = [];
  return {
    acknowledgements,
    requests,
    recordAcknowledgement: (event) => acknowledgements.push(event),
    recordRequest: (event) => requests.push(event),
    validate: (expectations) => validateQuantitySwitchAckProof({ acknowledgements, expectations, requests }),
  };
}

export function validateQuantitySwitchAckProof({ acknowledgements, expectations, requests }) {
  const failures = [];
  if (!Array.isArray(expectations) || expectations.length === 0) failures.push("quantity proof expectations are required");
  const expected = new Set();
  for (const expectation of expectations ?? []) {
    if (!expectation?.carrierKey || !Number.isInteger(expectation.revision)) {
      failures.push("invalid quantity proof expectation");
      continue;
    }
    const key = `${expectation.carrierKey}\u0000${expectation.revision}`;
    expected.add(key);
    const gets = requests.filter((request) => request.carrierKey === expectation.carrierKey && request.method === "GET" && request.resourceKey === expectation.carrierKey);
    const acks = acknowledgements.filter((ack) => ack.carrierKey === expectation.carrierKey && ack.revision === expectation.revision);
    if (expectation.styleOnly ? gets.length !== 0 : gets.length !== 1) failures.push(`canonical GET count invalid for ${expectation.carrierKey}`);
    if (acks.length !== 1 || acks[0]?.status !== "rendered") failures.push(`terminal ACK invalid for ${expectation.carrierKey}@${expectation.revision}`);
  }
  for (const request of requests) if (!expected.has(`${request.carrierKey}\u0000${request.revision ?? ""}`) && request.unexpected) failures.push(`unexpected event ${request.carrierKey}`);
  for (const acknowledgement of acknowledgements) {
    if (acknowledgement.malformed) failures.push("malformed visualization ACK POST");
    else if (!expected.has(`${acknowledgement.carrierKey}\u0000${acknowledgement.revision}`)) failures.push(`unexpected terminal ACK for ${acknowledgement.carrierKey}@${acknowledgement.revision}`);
  }
  return failures;
}
