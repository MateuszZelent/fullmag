type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeTabRouteAddress(listener: Listener): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function notifyTabRouteAddressChanged(): void {
  for (const listener of listeners) listener();
}
