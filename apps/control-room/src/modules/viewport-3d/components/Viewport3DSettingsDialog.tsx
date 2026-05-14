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
import { VIEWPORT_3D_VISUAL_PROFILES, type Viewport3DVisualProfileId } from "../viewport3dVisualProfile";

export function Viewport3DSettingsDialog() {
  const state = useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    () => viewport3dStore.getSnapshot(),
    () => viewport3dStore.getSnapshot(),
  );

  const isOpen = state.widgets.settingsDialogOpen;
  const currentProfileId = state.visualProfileId;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => viewport3dStore.setSettingsDialogOpen(open)}>
      <DialogContent aria-describedby="fm-viewport-settings-dialog-description">
        <DialogHeader>
          <DialogTitle>Visualization Settings</DialogTitle>
          <DialogDescription id="fm-viewport-settings-dialog-description">
            Adjust 3D graphics quality and performance profiles. Higher quality modes provide better aesthetics but may require more GPU resources.
          </DialogDescription>
        </DialogHeader>

        <div className="fm-dialog__body" style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
          {Object.values(VIEWPORT_3D_VISUAL_PROFILES).map((profile) => (
            <div 
              key={profile.id} 
              style={{
                display: "flex", 
                justifyContent: "space-between", 
                alignItems: "center",
                padding: "0.5rem",
                border: currentProfileId === profile.id ? "1px solid var(--fm-color-primary)" : "1px solid var(--fm-color-border)",
                borderRadius: "var(--fm-radius-md)",
                backgroundColor: currentProfileId === profile.id ? "var(--fm-color-primary-dim)" : "transparent"
              }}
            >
              <div>
                <strong style={{ display: "block" }}>{profile.label}</strong>
                <span style={{ fontSize: "12px", color: "var(--fm-color-muted)" }}>
                  {profile.antialias ? "Anti-aliasing" : "No AA"} • DPR: {profile.dprCap}x • Tone Mapping: {profile.toneMapping}
                </span>
              </div>
              <Button 
                variant={currentProfileId === profile.id ? "primary" : "secondary"}
                onClick={() => {
                  viewport3dStore.setVisualProfile(profile.id as Viewport3DVisualProfileId);
                }}
              >
                {currentProfileId === profile.id ? "Active" : "Apply"}
              </Button>
            </div>
          ))}
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
