export interface RetainedPlanarFrame<TModel> {
  readonly identityKey: string;
  readonly sourceDefinitionKey: string | null;
  readonly model: TModel;
}

/** One derived renderer frame per mounted owner; never copies resource buffers. */
export function createPlanarFrameRetention<TModel>() {
  let frame: RetainedPlanarFrame<TModel> | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => frame,
    getServerSnapshot: () => null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    retain: (identityKey: string | null, model: TModel | null, sourceDefinitionKey: string | null = null) => {
      const next = identityKey === null
        ? null
        : model !== null
          ? frame?.identityKey === identityKey && frame.model === model && frame.sourceDefinitionKey === sourceDefinitionKey
            ? frame
            : { identityKey, sourceDefinitionKey, model }
          : frame?.identityKey === identityKey &&
            (sourceDefinitionKey === null || frame.sourceDefinitionKey === sourceDefinitionKey) ? frame : null;
      if (next === frame) return;
      frame = next;
      for (const listener of listeners) listener();
    },
  };
}
