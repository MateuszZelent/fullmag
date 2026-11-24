/**
 * Local-only viewport wireframe ghost visibility for composite CSG geometry operands.
 *
 * Toggling an operand's ghost visibility never mutates SceneDocument or increments
 * scene_revision; it is strictly a UI/viewport inspection preference keyed by
 * `${objectId}:${operandId}`.
 */

type GhostVisibilityListener = () => void;

export function geometryOperandGhostKey(objectId: string, operandId: string): string {
  return `${objectId}:${operandId}`;
}

class GeometryGhostVisibilityStore {
  private readonly listeners = new Set<GhostVisibilityListener>();
  private keys = new Set<string>();
  private snapshot: ReadonlySet<string> = this.keys;

  readonly subscribe = (listener: GhostVisibilityListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReadonlySet<string> => this.snapshot;
  readonly getServerSnapshot = (): ReadonlySet<string> => EMPTY_GHOST_SET;

  isGhostVisible(objectId: string, operandId: string): boolean {
    return this.keys.has(geometryOperandGhostKey(objectId, operandId));
  }

  setGhostVisible(objectId: string, operandId: string, visible: boolean): void {
    const key = geometryOperandGhostKey(objectId, operandId);
    const has = this.keys.has(key);
    if (has === visible) return;
    const next = new Set(this.keys);
    if (visible) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.keys = next;
    this.snapshot = next;
    this.emit();
  }

  toggle(objectId: string, operandId: string): boolean {
    const nextVisible = !this.isGhostVisible(objectId, operandId);
    this.setGhostVisible(objectId, operandId, nextVisible);
    return nextVisible;
  }

  clearObject(objectId: string): void {
    const prefix = `${objectId}:`;
    let changed = false;
    const next = new Set<string>();
    for (const key of this.keys) {
      if (key.startsWith(prefix)) {
        changed = true;
      } else {
        next.add(key);
      }
    }
    if (!changed) return;
    this.keys = next;
    this.snapshot = next;
    this.emit();
  }

  clear(): void {
    if (this.keys.size === 0) return;
    this.keys = new Set<string>();
    this.snapshot = this.keys;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const EMPTY_GHOST_SET: ReadonlySet<string> = new Set<string>();

export const geometryGhostVisibilityStore = new GeometryGhostVisibilityStore();
