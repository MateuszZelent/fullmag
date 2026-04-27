"use client";

import { useEffect, useMemo, useState } from "react";

import { useModel } from "../../runs/control-room/ControlRoomContext";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import type { RegionListResource } from "@/src/api/types";
import { TextField } from "../../ui/TextField";
import { findSceneObjectByNodeId } from "./objectSelection";
import { SidebarSection } from "./primitives";

export default function RegionPanel({ nodeId }: { nodeId?: string }) {
  const model = useModel();
  const sceneAuthoring = useSceneAuthoringActions();
  const [regions, setRegions] = useState<RegionListResource | null>(null);

  const { object: sceneObject } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.sceneDocument),
    [model.sceneDocument, nodeId],
  );

  useEffect(() => {
    let cancelled = false;
    if (!model.sceneDocument) {
      setRegions(null);
      return;
    }
    void sceneAuthoring
      .getRegions()
      .then((nextRegions) => {
        if (!cancelled) {
          setRegions(nextRegions);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("failed to load authoring regions", error);
          setRegions(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [model.sceneDocument?.revision, sceneAuthoring]);

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
  const regionResource = regions?.regions.find((region) =>
    region.source_object_ids.includes(sceneObject.id),
  );
  const updateObject = (updater: (regionName: string | null) => string | null) => {
    const currentScene = model.sceneDocument;
    if (!currentScene) return;
    const nextObjects = currentScene.objects.map((object) =>
      object.id === sceneObject.id
        ? {
            ...object,
            region_name: updater(object.region_name ?? null),
            tags: Array.from(new Set([...(object.tags ?? []), "mesh:dirty"])),
          }
        : object,
    );
    model.setSceneDocument({
      ...currentScene,
      revision: currentScene.revision + 1,
      objects: nextObjects,
    });
    void sceneAuthoring
      .patchRegion(regionResource?.region_id ?? `region:${sceneObject.id}`, {
        name: nextObjects.find((object) => object.id === sceneObject.id)?.region_name ?? "",
      })
      .then((committedScene) => {
        model.setSceneDocument(committedScene);
      })
      .catch((error) => {
        console.error("failed to patch authoring region object", error);
        model.setSceneDocument(currentScene);
      });
  };

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
          <div className="rounded-lg border border-border/30 bg-card/20 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <span>Source</span>
              <span className="font-mono text-foreground">{regionResource?.source ?? "object"}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>Material</span>
              <span className="font-mono text-foreground">
                {regionResource?.material_ref ?? sceneObject.material_ref}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>Mesh parts</span>
              <span className="font-mono text-foreground">
                {regionResource?.mesh_part_ids.length ?? 0}
              </span>
            </div>
          </div>
        </div>
      </SidebarSection>
    </div>
  );
}
