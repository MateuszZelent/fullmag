export interface Viewport3DWorkerPoolWorker {
  terminate: () => void;
}

export interface Viewport3DWorkerPoolOptions<
  TWorker extends Viewport3DWorkerPoolWorker,
> {
  readonly createWorker: () => TWorker;
  readonly maxWorkers: number;
}

export interface Viewport3DWorkerPoolSnapshot {
  readonly activeJobs: number;
  readonly maxWorkers: number;
  readonly workerCount: number;
}

export interface Viewport3DWorkerPoolLease<
  TWorker extends Viewport3DWorkerPoolWorker,
> {
  readonly worker: TWorker;
  readonly release: () => void;
}

export interface Viewport3DWorkerPool<
  TWorker extends Viewport3DWorkerPoolWorker,
> {
  readonly acquire: () => Viewport3DWorkerPoolLease<TWorker>;
  readonly dispose: () => void;
  readonly snapshot: () => Viewport3DWorkerPoolSnapshot;
}
