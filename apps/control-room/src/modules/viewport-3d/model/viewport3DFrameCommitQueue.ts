export interface Viewport3DFrameCommit<TFrameState> {
  frameState: TFrameState;
  revision: number;
}

export interface Viewport3DFrameCommitQueue<TFrameState> {
  drain(): Viewport3DFrameCommit<TFrameState>[];
  enqueue(commit: Viewport3DFrameCommit<TFrameState>): void;
  subscribe(listener: () => void): () => void;
}

export function createViewport3DFrameCommitQueue<TFrameState>(): Viewport3DFrameCommitQueue<TFrameState> {
  const commits: Viewport3DFrameCommit<TFrameState>[] = [];
  const listeners = new Set<() => void>();

  return {
    drain() {
      return commits.splice(0);
    },
    enqueue(commit) {
      commits.push(commit);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
