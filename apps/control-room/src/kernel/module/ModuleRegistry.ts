import type { ModuleId, ModuleManifest, SlotId } from "../types";

export class ModuleRegistry {
  private readonly modules = new Map<ModuleId, ModuleManifest>();

  register(manifest: ModuleManifest): void {
    if (this.modules.has(manifest.id)) {
      throw new Error(`Module "${manifest.id}" is already registered.`);
    }
    this.modules.set(manifest.id, manifest);
  }

  get(id: ModuleId): ModuleManifest | undefined {
    return this.modules.get(id);
  }

  all(): ModuleManifest[] {
    return Array.from(this.modules.values());
  }

  forSlot(slotId: SlotId): ModuleManifest[] {
    return this.all().filter((manifest) => manifest.slots.includes(slotId));
  }
}
