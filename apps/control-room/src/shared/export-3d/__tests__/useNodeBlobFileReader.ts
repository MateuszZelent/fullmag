import { afterAll, beforeAll, vi } from "vitest";

class NodeBlobFileReader {
  result: ArrayBuffer | string | null = null;
  error: Error | null = null;
  onload: ((event: unknown) => void) | null = null;
  onloadend: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.emit("load");
        this.emit("loadend");
      },
      (err: unknown) => {
        this.error = err instanceof Error ? err : new Error(String(err));
        this.emit("error");
        this.emit("loadend");
      },
    );
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buffer) => {
        const mime = blob.type || "application/octet-stream";
        const base64 = Buffer.from(buffer).toString("base64");
        this.result = `data:${mime};base64,${base64}`;
        this.emit("load");
        this.emit("loadend");
      },
      (err: unknown) => {
        this.error = err instanceof Error ? err : new Error(String(err));
        this.emit("error");
        this.emit("loadend");
      },
    );
  }

  private emit(type: string): void {
    const event = { target: this };
    if (type === "load") this.onload?.(event);
    if (type === "loadend") this.onloadend?.(event);
    if (type === "error") this.onerror?.(event);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function useNodeBlobFileReader(): void {
  beforeAll(() => {
    vi.stubGlobal("FileReader", NodeBlobFileReader);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
}
