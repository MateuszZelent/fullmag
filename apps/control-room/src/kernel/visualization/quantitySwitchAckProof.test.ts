import { describe, expect, it } from "vitest";

import {
  createQuantitySwitchAckProofRecorder,
  validateQuantitySwitchAckProof,
} from "./quantitySwitchAckProof";

describe("quantity-switch request/ACK proof", () => {
  it("accepts one canonical GET and one rendered ACK per data carrier", () => {
    expect(validateQuantitySwitchAckProof({
      acknowledgements: [{ carrierKey: "s1\\0H_demag", revision: 9, status: "rendered" }],
      expectations: [{ carrierKey: "s1\\0H_demag", revision: 9 }],
      requests: [{ carrierKey: "s1\\0H_demag", method: "GET", resourceKey: "s1\\0H_demag" }],
    })).toEqual([]);
  });

  it("records request and ACK evidence before validating it", () => {
    const recorder = createQuantitySwitchAckProofRecorder();
    recorder.recordRequest({ carrierKey: "s1\\0m", method: "GET", resourceKey: "s1\\0m" });
    recorder.recordAcknowledgement({ carrierKey: "s1\\0m", revision: 3, status: "rendered" });
    expect(recorder.validate([{ carrierKey: "s1\\0m", revision: 3 }])).toEqual([]);
  });

  it("fails closed for duplicate or missing data GETs, missing ACKs, and style ACK loss", () => {
    const failures = validateQuantitySwitchAckProof({
      acknowledgements: [
        { carrierKey: "s1\\0H_demag", revision: 9, status: "rendered" },
        { carrierKey: "s1\\0H_demag", revision: 9, status: "rendered" },
      ],
      expectations: [
        { carrierKey: "s1\\0H_demag", revision: 9 },
        { carrierKey: "s1\\0style", revision: 10, styleOnly: true },
      ],
      requests: [
        { carrierKey: "s1\\0H_demag", method: "GET", resourceKey: "s1\\0H_demag" },
        { carrierKey: "s1\\0H_demag", method: "GET", resourceKey: "s1\\0H_demag" },
      ],
    });
    expect(failures).toEqual(expect.arrayContaining([
      "canonical GET count invalid for s1\\0H_demag",
      "terminal ACK invalid for s1\\0H_demag@9",
      "terminal ACK invalid for s1\\0style@10",
    ]));
  });
});
