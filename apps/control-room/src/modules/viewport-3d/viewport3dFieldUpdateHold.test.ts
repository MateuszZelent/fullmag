import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import {
  sharedResourceRuntimeStore,
} from "@/kernel/resources/ResourceRuntimeStore";

import {
  beginViewport3DFieldUpdateHold,
  endViewport3DFieldUpdateHold,
  resetViewport3DFieldUpdateHoldForTest,
} from "./viewport3dFieldUpdateHold";

describe("viewport3dFieldUpdateHold", () => {
  it("pauses active viewport field-vector loads as soon as a camera hold starts", () => {
    const magnetizationVectorPath = DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    );
    const effectiveFieldVectorPath = DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "H_eff",
    );
    const pauseMatching = vi
      .spyOn(sharedResourceRuntimeStore, "pauseMatching")
      .mockImplementation(() => undefined);
    try {
      resetViewport3DFieldUpdateHoldForTest();

      beginViewport3DFieldUpdateHold();

      expect(pauseMatching).toHaveBeenCalledTimes(1);
      const predicate = pauseMatching.mock.calls[0][0];
      expect(
        predicate(`${magnetizationVectorPath}?component=full`),
      ).toBe(true);
      expect(
        predicate(`${effectiveFieldVectorPath}?scope_kind=airbox`),
      ).toBe(true);
      expect(predicate(VISUALIZATION_STATE_PATH)).toBe(false);
      expect(predicate(DATA_FIELDS_PATH)).toBe(false);
    } finally {
      endViewport3DFieldUpdateHold();
      pauseMatching.mockRestore();
      resetViewport3DFieldUpdateHoldForTest();
    }
  });
});
