import { describe, expect, it, vi } from "vitest";

describe("composeRefs", () => {
  it("uses React 19 cleanup callbacks without clearing plain callback refs", async () => {
    const { composeRefs } = await import("../react-compose-refs-shim");
    const node = { tagName: "BUTTON" };
    const objectRef = { current: null as typeof node | null };
    const cleanup = vi.fn();
    const cleanupRef = vi.fn(() => cleanup);
    const plainCallbackRef = vi.fn();

    const detach = composeRefs(objectRef, cleanupRef, plainCallbackRef)(node);

    expect(objectRef.current).toBe(node);
    expect(cleanupRef).toHaveBeenCalledWith(node);
    expect(plainCallbackRef).toHaveBeenCalledWith(node);

    expect(typeof detach).toBe("function");
    detach?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(objectRef.current).toBeNull();
    expect(plainCallbackRef).not.toHaveBeenCalledWith(null);
  });

  it("clears object refs but skips callback refs on explicit null detach", async () => {
    const { composeRefs } = await import("../react-compose-refs-shim");
    const objectRef = { current: { tagName: "BUTTON" } as { tagName: string } | null };
    const stateSettingRef = vi.fn();

    composeRefs(objectRef, stateSettingRef)(null);

    expect(objectRef.current).toBeNull();
    expect(stateSettingRef).not.toHaveBeenCalled();
  });

  it("deduplicates repeated callback refs for the same node", async () => {
    const { composeRefs } = await import("../react-compose-refs-shim");
    const node = { tagName: "BUTTON" };
    const cleanup = vi.fn();
    const stateSettingRef = vi.fn(() => cleanup);
    const composedRef = composeRefs(stateSettingRef);

    const firstDetach = composedRef(node);
    const secondDetach = composedRef(node);

    expect(typeof firstDetach).toBe("function");
    expect(typeof secondDetach).toBe("function");
    expect(stateSettingRef).toHaveBeenCalledTimes(1);

    firstDetach?.();
    composedRef(node);

    expect(stateSettingRef).toHaveBeenCalledTimes(2);
  });
});

describe("useComposedRefs", () => {
  it("keeps a stable callback across unstable state-setting refs", async () => {
    vi.resetModules();

    type RefObject<T> = { current: T };
    const hookSlots: RefObject<unknown>[] = [];
    let hookIndex = 0;

    vi.doMock("react", () => ({
      useCallback<T extends (...args: unknown[]) => unknown>(
        callback: T,
        _deps: unknown[],
      ): T {
        const slot = hookSlots[hookIndex] ?? { current: callback };
        hookSlots[hookIndex] = slot;
        hookIndex += 1;
        return slot.current as T;
      },
      useRef<T>(initialValue: T): RefObject<T> {
        const slot = hookSlots[hookIndex] ?? { current: initialValue };
        hookSlots[hookIndex] = slot;
        hookIndex += 1;
        return slot as RefObject<T>;
      },
    }));

    const { useComposedRefs } = await import("../react-compose-refs-shim");
    const nodeA = { tagName: "BUTTON", render: 1 };
    const nodeB = { tagName: "BUTTON", render: 2 };
    const firstStateSettingRef = vi.fn();
    const secondStateSettingRef = vi.fn();

    hookIndex = 0;
    const firstComposed = useComposedRefs(firstStateSettingRef);
    firstComposed(nodeA);

    hookIndex = 0;
    const secondComposed = useComposedRefs(secondStateSettingRef);
    secondComposed(nodeB);

    expect(secondComposed).toBe(firstComposed);
    expect(firstStateSettingRef).toHaveBeenCalledTimes(1);
    expect(firstStateSettingRef).toHaveBeenCalledWith(nodeA);
    expect(secondStateSettingRef).toHaveBeenCalledTimes(1);
    expect(secondStateSettingRef).toHaveBeenCalledWith(nodeB);

    vi.doUnmock("react");
  });
});
