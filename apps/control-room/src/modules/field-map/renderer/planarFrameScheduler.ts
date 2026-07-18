export interface FrameHost {
  cancelAnimationFrame(id: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export function createPlanarFrameScheduler(
  host: FrameHost,
  render: () => void,
) {
  let frame: number | null = null;
  return {
    dispose() {
      if (frame !== null) host.cancelAnimationFrame(frame);
      frame = null;
    },
    invalidate() {
      if (frame !== null) return;
      frame = host.requestAnimationFrame(() => {
        frame = null;
        render();
      });
    },
  };
}
