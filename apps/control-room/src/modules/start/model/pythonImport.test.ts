import { describe, expect, it, vi } from "vitest";
import { SCRIPT_PROJECT_MAX_BYTES } from "./scriptProject";
import { readPythonImport } from "./pythonImport";

const sourceFile = (bytes: Uint8Array, name = "antenna.py") => ({
  name, size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer as ArrayBuffer),
});

describe("Python source import", () => {
  it("preserves UTF-8, BOM, line endings and provenance without executing source", async () => {
    const text = "\uFEFF# pole \u03bc\r\nraise RuntimeError('not executed')\r\n";
    const file = sourceFile(new TextEncoder().encode(text));
    expect(await readPythonImport(file)).toEqual({ fileName: "antenna.py", text, origin: "python:antenna.py", projectName: "antenna" });
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized files before reading any bytes", async () => {
    const file = { name: "large.py", size: SCRIPT_PROJECT_MAX_BYTES + 1, arrayBuffer: vi.fn() };
    await expect(readPythonImport(file)).rejects.toThrow("1 MiB");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });
  it("accepts the byte limit exactly and refuses a returned oversized buffer", async () => {
    expect((await readPythonImport(sourceFile(new Uint8Array(SCRIPT_PROJECT_MAX_BYTES).fill(32)))).text.length).toBe(SCRIPT_PROJECT_MAX_BYTES);
    const file = sourceFile(new Uint8Array(SCRIPT_PROJECT_MAX_BYTES + 1));
    file.size = 0;
    await expect(readPythonImport(file)).rejects.toThrow("1 MiB");
  });
  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    await expect(readPythonImport(sourceFile(new Uint8Array([0xc3, 0x28])))).rejects.toThrow("valid UTF-8");
  });
});
