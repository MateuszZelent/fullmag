import type { ModuleManifest, SlotId } from "../types";

interface SlotHostProps {
  slotId: SlotId;
  moduleManifest: ModuleManifest | null;
}

export function SlotHost({ slotId, moduleManifest }: SlotHostProps) {
  return (
    <section className="fm-slot" data-slot-id={slotId}>
      {moduleManifest ? (
        <div className="fm-slot__module">{moduleManifest.title}</div>
      ) : (
        <div className="fm-slot__empty">No module mounted</div>
      )}
    </section>
  );
}
