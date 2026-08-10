type Listener<TPayload> = (payload: TPayload) => void;

export class EventBus<TEventMap extends object> {
  private readonly listeners = new Map<keyof TEventMap, Set<Listener<TEventMap[keyof TEventMap]>>>();

  on<K extends keyof TEventMap>(
    event: K,
    listener: Listener<TEventMap[K]>,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<Listener<TEventMap[keyof TEventMap]>>();
    listeners.add(listener as Listener<TEventMap[keyof TEventMap]>);
    this.listeners.set(event, listeners);

    return () => {
      listeners.delete(listener as Listener<TEventMap[keyof TEventMap]>);
      if (listeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  subscribe<K extends keyof TEventMap>(
    event: K,
    listener: Listener<TEventMap[K]>,
  ): () => void {
    return this.on(event, listener);
  }

  emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) {
      (listener as Listener<TEventMap[K]>)(payload);
    }
  }
}
