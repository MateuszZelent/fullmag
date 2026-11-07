// @vitest-environment jsdom
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SliderProps = {
  value: number[];
  onValueChange: (value: number[]) => void;
  onValueCommit: (value: number[]) => void;
};
const slider = vi.hoisted(() => ({ current: null as SliderProps | null }));
vi.mock("@/shared/ui/Slider", () => ({
  Slider: (props: SliderProps) => {
    slider.current = props;
    return <div data-testid="slider-value">{props.value[0]}</div>;
  },
}));

import { NumberField } from "./ObjectVisualizationTargetSection";

let root: Root;
let container: HTMLDivElement;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  slider.current = null;
  vi.unstubAllGlobals();
});

function LayoutProbe({ children, onLayout }: { children: ReactNode; onLayout?: () => void }) {
  useLayoutEffect(() => onLayout?.(), [onLayout]);
  return children;
}

async function renderField(
  value: number,
  onChange: (value: number) => void,
  range: { min?: number; max?: number; step?: number } = {},
  onLayout?: () => void,
) {
  await act(async () => root.render(
    <LayoutProbe onLayout={onLayout}>
      <section>
        <input aria-label="Unrelated field" defaultValue="unchanged" />
        <NumberField label="Arrow budget" value={value} min={0} max={40} {...range} onChange={onChange} />
      </section>
    </LayoutProbe>,
  ));
}
async function drag(value: number) {
  await act(async () => slider.current!.onValueChange([value]));
}
async function commit(value: number) {
  await act(async () => slider.current!.onValueCommit([value]));
}
function runFrameCallbacks() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
async function flushFrames() {
  await act(async () => runFrameCallbacks());
}
function displayedValue() {
  return Number(container.querySelector("output")!.textContent);
}

describe("visualization NumberField draft ownership", () => {
  it.each([
    { value: 12, range: {} },
    { value: 10, range: { max: 20 } },
  ])("cancels a queued old commit before paint for $value/$range", async ({ value, range }) => {
    const onChange = vi.fn();
    await renderField(10, onChange);
    await commit(3);
    await renderField(value, onChange, range, runFrameCallbacks);
    expect(displayedValue()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the latest callback when a frame fires before passive effects", async () => {
    const oldOnChange = vi.fn();
    const latestOnChange = vi.fn();
    await renderField(10, oldOnChange);
    await commit(4);
    await renderField(10, latestOnChange, {}, runFrameCallbacks);
    expect(oldOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("accepts the acknowledged value and later scope/reset changes without remounting", async () => {
    const onChange = vi.fn();
    await renderField(10, onChange);
    const input = container.querySelector("input")!;
    input.focus();
    container.scrollTop = 37;
    await drag(3);
    await commit(3);
    await flushFrames();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(3);
    await renderField(3, onChange);
    await renderField(12, onChange);
    expect(displayedValue()).toBe(12);
    expect(slider.current!.value).toEqual([12]);
    await renderField(10, onChange);
    expect(displayedValue()).toBe(10);
    expect(container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("unchanged");
    expect(container.scrollTop).toBe(37);
  });

  it("keeps an active draft through unrelated renders and commits once per frame", async () => {
    const oldOnChange = vi.fn();
    const latestOnChange = vi.fn();
    await renderField(10, oldOnChange);
    await drag(3);
    await commit(3);
    await commit(4);
    await renderField(10, latestOnChange);
    expect(displayedValue()).toBe(4);
    expect(frames.size).toBe(1);
    expect(latestOnChange).not.toHaveBeenCalled();
    await flushFrames();
    expect(oldOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("discards a draft when the upstream range changes", async () => {
    const onChange = vi.fn();
    await renderField(10, onChange);
    await drag(3);
    await renderField(10, onChange, { max: 20 });
    expect(displayedValue()).toBe(10);
    await renderField(10, onChange);
    expect(displayedValue()).toBe(10);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancels a queued old commit when the canonical value changes", async () => {
    const onChange = vi.fn();
    await renderField(10, onChange);
    await commit(3);
    await renderField(12, onChange);
    await flushFrames();
    expect(displayedValue()).toBe(12);
    expect(onChange).not.toHaveBeenCalled();
  });
});
