interface ChartFrameSchedulerOptions {
  cancelFrame?: (handle: number) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
}

export interface ChartFrameScheduler {
  cancel: () => void;
  schedule: (task: () => void) => void;
}

export function createChartFrameScheduler({
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  requestFrame = (callback) => requestAnimationFrame(callback),
}: ChartFrameSchedulerOptions = {}): ChartFrameScheduler {
  let frameHandle: number | null = null;
  let pendingTask: (() => void) | null = null;

  return {
    cancel: () => {
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
      }
      frameHandle = null;
      pendingTask = null;
    },
    schedule: (task) => {
      pendingTask = task;
      if (frameHandle !== null) return;
      frameHandle = requestFrame(() => {
        const taskToRun = pendingTask;
        pendingTask = null;
        frameHandle = null;
        taskToRun?.();
      });
    },
  };
}
