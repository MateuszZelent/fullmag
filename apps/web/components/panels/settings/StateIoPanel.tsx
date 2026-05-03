"use client";

import { useState } from "react";
import { useCommand } from "../../runs/control-room/context-hooks";
import { Button } from "../../ui/button";
import { SidebarSection } from "./primitives";
import SelectField from "../../ui/SelectField";

export default function StateIoPanel() {
  const ctx = useCommand();
  const [profile, setProfile] = useState<"compact" | "resume" | "solved" | "archive">("compact");
  const [restoreMode, setRestoreMode] = useState<"resume" | "initial_condition" | "config_only">("resume");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleImport = () => {
    if (!selectedFile) return;
    void ctx.handleStateImport(selectedFile, {
      restoreMode,
    });
  };

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Save Session" defaultOpen={true}>
        <div className="grid gap-2">
          <SelectField
            label="Save Profile"
            value={profile}
            onchange={(val) => setProfile(val as "compact" | "resume" | "solved" | "archive")}
            disabled={ctx.stateIoBusy}
            options={[
              { value: "compact", label: "Compact (.fms)" },
              { value: "resume", label: "Resume-ready (.fms)" },
              { value: "solved", label: "Solved archive (.fms)" },
              { value: "archive", label: "Full archive (.fms)" },
            ]}
            tooltip="Save the canonical Fullmag session package. Compact is the lightest export, while archive keeps the broadest reproducibility payload."
          />
        </div>

        <div className="flex gap-2 mt-3">
          <Button
            size="sm"
            variant="outline"
            type="button"
            className="w-full"
            disabled={ctx.stateIoBusy || !ctx.session}
            onClick={() => { void ctx.handleStateExport(profile); }}
          >
            {ctx.stateIoBusy ? "Working…" : "Save Session"}
          </Button>
        </div>
      </SidebarSection>

      <SidebarSection title="Open Session" defaultOpen={true}>
        <div className="grid gap-2">
          <input
            type="file"
            accept=".fms"
            disabled={ctx.stateIoBusy}
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            className="text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-primary"
          />
          <SelectField
            label="Restore Mode"
            value={restoreMode}
            onchange={(val) => setRestoreMode(val as "resume" | "initial_condition" | "config_only")}
            disabled={ctx.stateIoBusy}
            options={[
              { value: "resume", label: "Resume Workspace" },
              { value: "initial_condition", label: "Initial Condition Only" },
              { value: "config_only", label: "Configuration Only" },
            ]}
            tooltip="Choose how the imported session should be restored into the control room."
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            className="mt-1 w-full"
            disabled={ctx.stateIoBusy || !selectedFile}
            onClick={handleImport}
          >
            {ctx.stateIoBusy ? "Working…" : "Open Session"}
          </Button>
          <div className="text-[0.68rem] leading-relaxed text-muted-foreground/80 border border-border/10 bg-card/40 p-2.5 rounded-lg mt-1">
            Fullmag imports canonical `.fms` bundles. The control room now inspects the package first and then restores the selected session mode.
          </div>
        </div>
      </SidebarSection>

      {ctx.scriptInitialState && (
        <SidebarSection title="Script Initial State" defaultOpen={false}>
          <div className="grid gap-1 rounded-md border border-border/10 bg-card/40 p-3">
            <span className="font-mono text-xs text-foreground break-all">
              {ctx.scriptInitialState.source_path}
            </span>
            <span className="text-[0.68rem] text-muted-foreground">
              Format: {ctx.scriptInitialState.format}
              {ctx.scriptInitialState.dataset ? ` · Dataset: ${ctx.scriptInitialState.dataset}` : ""}
            </span>
          </div>
        </SidebarSection>
      )}

      {ctx.stateIoMessage && (
        <div className="p-3">
          <div className="text-[0.68rem] leading-relaxed text-muted-foreground p-3 rounded-md bg-card/40 border border-border/10">
            {ctx.stateIoMessage}
          </div>
        </div>
      )}
    </div>
  );
}
