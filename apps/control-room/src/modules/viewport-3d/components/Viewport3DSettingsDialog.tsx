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
  id,
  label,
  description,
  enabled,
  onToggle,
}: {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      className="fm-viewport-3d__settings-toggle"
      data-enabled={String(enabled)}
    >
      <div className="fm-viewport-3d__settings-toggle-info">
        <span className="fm-viewport-3d__settings-toggle-label">{label}</span>
        <span className="fm-viewport-3d__settings-toggle-desc">
          {description}
        </span>
      </div>
      <label className="fm-viewport-3d__settings-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-checked={enabled}
          checked={enabled}
          onChange={() => onToggle(!enabled)}
        />
        <span className="fm-viewport-3d__settings-switch-track" />
      </label>
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
    <Dialog
      open={isOpen}
      onOpenChange={(open) => viewport3dStore.setSettingsDialogOpen(open)}
    >
      <DialogContent aria-describedby="fm-viewport-settings-dialog-description">
        <DialogHeader>
          <DialogTitle>3D Render Effects</DialogTitle>
          <DialogDescription id="fm-viewport-settings-dialog-description">
            Adjust visual post-processing effects to make objects look more realistic
            (&quot;Full 3D&quot;). Note that these effects consume more GPU power.
          </DialogDescription>
        </DialogHeader>

        <div className="fm-viewport-3d__settings-body">
          <EffectToggle
            id="fm-viewport-3d-effect-ambient-occlusion"
            label="Ambient Occlusion (Shadows)"
            description="Adds depth by shading crevices and corners. Heavily improves realism."
            enabled={effectAmbientOcclusion}
            onToggle={(v) => viewport3dStore.setEffectAmbientOcclusion(v)}
          />

          <EffectToggle
            id="fm-viewport-3d-effect-bloom"
            label="Bloom (Glow)"
            description="Adds a light aura around highly saturated or bright magnetic fields."
            enabled={effectBloom}
            onToggle={(v) => viewport3dStore.setEffectBloom(v)}
          />

          <EffectToggle
            id="fm-viewport-3d-effect-antialias"
            label="Anti-Aliasing"
            description="Smooths out jagged edges on polygon boundaries."
            enabled={effectAntialias}
            onToggle={(v) => viewport3dStore.setEffectAntialias(v)}
          />

        </div>

        <DialogFooter className="fm-viewport-3d__settings-footer">
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
