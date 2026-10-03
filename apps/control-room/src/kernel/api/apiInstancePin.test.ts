import { describe, expect, it } from "vitest";
import { resolveApiInstancePin } from "./apiInstancePin";

describe("API instance launch pin", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  it("accepts one canonical pin and leaves standalone URLs unpinned", () => {
    expect(resolveApiInstancePin("")).toBeNull();
    expect(resolveApiInstancePin(`?fullmag_api_instance=${id}`)).toBe(id);
  });
  it("rejects ambiguity and malformed pins instead of discarding them", () => {
    for (const value of ["", "invalid", id.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) {
      expect(() => resolveApiInstancePin(`?fullmag_api_instance=${value}`)).toThrow();
    }
    expect(() => resolveApiInstancePin(`?fullmag_api_instance=${id}&fullmag_api_instance=${id}`)).toThrow();
  });
});
