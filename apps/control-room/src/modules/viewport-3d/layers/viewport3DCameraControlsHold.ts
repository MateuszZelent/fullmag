type CameraControls = { enabled?: boolean };
const holds = new WeakMap<CameraControls, { count: number; wasEnabled: boolean }>();

/** Native HUD capture and R3F ring handlers can suspend the same controls. */
export function holdViewport3DCameraControls(controls: CameraControls | undefined): () => void {
  if (!controls || typeof controls.enabled !== "boolean") return () => undefined;
  const hold = holds.get(controls) ?? { count: 0, wasEnabled: controls.enabled };
  hold.count += 1;
  holds.set(controls, hold);
  controls.enabled = false;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold.count -= 1;
    if (hold.count !== 0) return;
    holds.delete(controls);
    controls.enabled = hold.wasEnabled;
  };
}
