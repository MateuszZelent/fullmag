"use client";

import { useState, useSyncExternalStore } from "react";
import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { Button } from "@/shared/ui/Button";

const cameraActions = [
  ["viewport-3d.fit", "Fit scene"],
  ["viewport-3d.reset-camera", "Reset camera"],
  ["viewport-3d.open-camera-dialog", "Camera parameters"],
] as const;

/** Camera ownership stays with the shared viewport command registry. */
export function AntennaCameraControls() {
  const kernel = useKernel();
  const version = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => -1,
  );
  const [error, setError] = useState<string | null>(null);
  const context = createCommandContext("inspector", kernel, { sourceDetail: "antenna-camera" });
  return <div className="fm-antenna-camera">
    <p className="fm-inspector-field__hint">Shared workspace camera. Rotate the view to inspect vectors pointing towards or away from you.</p>
    <div className="fm-antenna-camera__actions flex flex-wrap gap-2">
      {cameraActions.map(([id, label]) => <Button key={id} size="sm" type="button"
        disabled={version < 0 || !kernel.commands.isEnabled(id, context)}
        onClick={async () => {
          const result = await kernel.commands.execute(id, createCommandContext("inspector", kernel, { sourceDetail: "antenna-camera" }));
          setError(result.status === "failed" ? result.message ?? "Camera command failed." : null);
        }}>{label}</Button>)}
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
