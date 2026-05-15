"use client";

import { useSyncExternalStore } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";

import { viewport3dStore } from "../viewport3dStore";

function EffectToggle({
  label,
  description,
  enabled,
  onToggle,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0.75rem",
        border: enabled ? "1px solid var(--fm-color-primary)" : "1px solid var(--fm-color-border)",
        borderRadius: "var(--fm-radius-md)",
        backgroundColor: enabled ? "var(--fm-color-primary-dim)" : "transparent"
      }}
    >
      <div>
        <strong style={{ display: "block", color: enabled ? "var(--fm-color-foreground)" : "var(--fm-color-muted)" }}>{label}</strong>
        <span style={{ fontSize: "12px", color: "var(--fm-color-muted)" }}>
          {description}
        </span>
      </div>
      <Button
        variant={enabled ? "primary" : "secondary"}
        onClick={() => onToggle(!enabled)}
        style={{ minWidth: "80px" }}
      >
        {enabled ? "ON" : "OFF"}
      </Button>
    </div>
  );
}

export function Viewport3DSettingsDialog() {
  const state = useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    () => viewport3dStore.getSnapshot(),
    () => viewport3dStore.getSnapshot(),
  );

  const isOpen = state.widgets.settingsDialogOpen;
  const { effectAmbientOcclusion, effectAntialias, effectBloom } = state.widgets;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => viewport3dStore.setSettingsDialogOpen(open)}>
      <DialogContent aria-describedby="fm-viewport-settings-dialog-description">
        <DialogHeader>
          <DialogTitle>3D Render Effects</DialogTitle>
          <DialogDescription id="fm-viewport-settings-dialog-description">
            Adjust visual post-processing effects to make objects look more realistic (&quot;Full 3D&quot;). Note that these effects consume more GPU power.
          </DialogDescription>
        </DialogHeader>

        <div className="fm-dialog__body" style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>

          <EffectToggle
            label="Ambient Occlusion (Shadows)"
            description="Adds depth by shading crevices and corners. Heavily improves realism."
            enabled={effectAmbientOcclusion}
            onToggle={(v) => viewport3dStore.setEffectAmbientOcclusion(v)}
          />

          <EffectToggle
            label="Bloom (Glow)"
            description="Adds a light aura around highly saturated or bright magnetic fields."
            enabled={effectBloom}
            onToggle={(v) => viewport3dStore.setEffectBloom(v)}
          />

          <EffectToggle
            label="Anti-Aliasing"
            description="Smooths out jagged edges on polygon boundaries."
            enabled={effectAntialias}
            onToggle={(v) => viewport3dStore.setEffectAntialias(v)}
          />

        </div>

        <DialogFooter style={{ marginTop: "1rem" }}>
          <DialogClose asChild>
            <Button variant="secondary" onClick={() => viewport3dStore.setSettingsDialogOpen(false)}>
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
