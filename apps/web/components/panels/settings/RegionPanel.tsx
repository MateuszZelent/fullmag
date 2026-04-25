"use client";

import { useMemo } from "react";

import { useModel } from "../../runs/control-room/ControlRoomContext";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import { TextField } from "../../ui/TextField";
import { findSceneObjectByNodeId } from "./objectSelection";
import { SidebarSection } from "./primitives";

export default function RegionPanel({ nodeId }: { nodeId?: string }) {
  const model = useModel();
  const sceneAuthoring = useSceneAuthoringActions();

  const { object: sceneObject } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.sceneDocument),
    [model.sceneDocument, nodeId],
  );

  const updateObject = (updater: (regionName: string | null) => string | null) => {
    if (!sceneObject || !model.sceneDocument) return;
    const nextObjects = model.sceneDocument.objects.map((object) =>
      object.id === sceneObject.id
        ? {
            ...object,
            region_name: updater(object.region_name ?? null),
          }
        : object,
    );
    model.setSceneDocument({
      ...model.sceneDocument,
      objects: nextObjects,
    });
    void sceneAuthoring
      .updateSceneMergePatch({ objects: nextObjects })
      .catch((error) => {
        console.error("failed to patch authoring region object", error);
      });
  };

  if (!sceneObject) {
    return (
      <div className="flex flex-col gap-0 border-t border-border/20">
        <SidebarSection title="Regions" defaultOpen={true}>
          <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground">
            Select a region node to inspect its identity and current implementation status.
          </div>
        </SidebarSection>
      </div>
    );
  }

  const regionName = sceneObject.region_name?.trim() || sceneObject.name;

  return (
    <div className="flex flex-col px-2 pt-4">
      <SidebarSection title="Region Identity" defaultOpen={true}>
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2.5">
            <div className="text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground">
              Active Region
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-foreground">{regionName}</span>
              <span className="rounded-md border border-border/40 bg-background/40 px-2 py-0.5 text-[0.65rem] font-mono text-muted-foreground">
                object: {sceneObject.name}
              </span>
            </div>
          </div>

          <TextField
            key={`${sceneObject.name}-region-name-${sceneObject.region_name ?? ""}`}
            label="Region Name"
            defaultValue={sceneObject.region_name ?? ""}
            placeholder={sceneObject.name}
            onBlur={(event) => {
              const nextName = event.target.value.trim();
              updateObject(() => (nextName.length > 0 ? nextName : null));
            }}
            mono
            tooltip="Leave empty to keep the default region name equal to the object name."
          />
        </div>
      </SidebarSection>

      <SidebarSection title="Region Authoring Status" defaultOpen={true}>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100/90">
            Regions are not yet first-class magnetic submodules. Today, one object still maps to one
            editable magnetic setup.
          </div>
          <div className="rounded-lg border border-border/30 bg-card/20 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
            Planned next layer: each region will get its own `Magnetic Parameters` and `Magnetic Texture`
            instead of inheriting the parent object setup.
          </div>
        </div>
      </SidebarSection>
    </div>
  );
}
