"use client";

import { useState } from "react";
import { X, Monitor, Cpu, Sliders, Keyboard, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { resolveApiBase } from "@/lib/apiBase";
import {
  getLivePollIntervalMs,
  LIVE_POLL_INTERVAL_MAX_MS,
  LIVE_POLL_INTERVAL_MIN_MS,
  setLivePollIntervalMs,
} from "@/lib/livePolling";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "next/navigation";

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[0.68rem] font-semibold tracking-widest uppercase text-muted-foreground border-b border-border/40 pb-1">
        {title}
      </h3>
      {children}
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function SettingsRow({ label, description, children }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="flex flex-col min-w-0">
        <span className="text-[0.8rem] font-medium text-foreground">{label}</span>
        {description && (
          <span className="text-[0.71rem] text-muted-foreground leading-snug mt-0.5">{description}</span>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

type SettingsTab = "appearance" | "runtime" | "controls" | "shortcuts" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Monitor size={14} /> },
  { id: "runtime", label: "Runtime", icon: <Cpu size={14} /> },
  { id: "controls", label: "Controls", icon: <Sliders size={14} /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={14} /> },
  { id: "about", label: "About", icon: <Info size={14} /> },
];

function AppearanceTab() {
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="Theme">
        <SettingsRow label="Color theme" description="Choose the workspace color scheme">
          <Select defaultValue="dark">
            <SelectTrigger className="w-[160px] h-8 bg-muted/40 border-border/60 text-[0.78rem]">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark (default)</SelectItem>
              <SelectItem value="darker">Darker</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Accent color" description="Primary action and highlight color">
          <Select defaultValue="blue">
            <SelectTrigger className="w-[160px] h-8 bg-muted/40 border-border/60 text-[0.78rem]">
              <SelectValue placeholder="Accent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="blue">Blue</SelectItem>
              <SelectItem value="violet">Violet</SelectItem>
              <SelectItem value="emerald">Emerald</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Layout">
        <SettingsRow label="UI density" description="Controls spacing and panel sizes">
          <Select defaultValue="default">
            <SelectTrigger className="w-[160px] h-8 bg-muted/40 border-border/60 text-[0.78rem]">
              <SelectValue placeholder="Density" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="default">Default</SelectItem>
              <SelectItem value="comfortable">Comfortable</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function RuntimeTab() {
  const [pollIntervalMs, setPollIntervalMsState] = useState<number>(() =>
    getLivePollIntervalMs(),
  );
  const backendUrl = resolveApiBase();

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="Backend connection">
        <SettingsRow label="API base URL" description="URL of the local Fullmag backend">
          <Input
            defaultValue={backendUrl}
            className="w-52 h-8 bg-muted/40 border-border/60 text-[0.78rem] font-mono"
          />
        </SettingsRow>
        <SettingsRow label="Polling interval (ms)" description="Live state refresh rate">
          <Input
            type="number"
            value={pollIntervalMs}
            min={LIVE_POLL_INTERVAL_MIN_MS}
            max={LIVE_POLL_INTERVAL_MAX_MS}
            step={50}
            className="w-24 h-8 bg-muted/40 border-border/60 text-[0.78rem]"
            onChange={(event) => {
              const normalized = setLivePollIntervalMs(Number(event.target.value));
              setPollIntervalMsState(normalized);
            }}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function ControlsTab() {
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="3D viewport">
        <SettingsRow label="Mouse sensitivity" description="Orbit / pan speed multiplier">
          <input type="range" min={0.1} max={3} step={0.1} defaultValue={1} className="w-28 accent-primary h-1 bg-muted/40 rounded-full appearance-none cursor-pointer" />
        </SettingsRow>
        <SettingsRow label="Invert Y axis" description="Flip vertical orbit direction">
          <Switch />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function ShortcutsTab() {
  const shortcuts = [
    { action: "Run simulation", keys: "F5" },
    { action: "Stop simulation", keys: "Shift+F5" },
    { action: "Toggle sidebar", keys: "Ctrl+B" },
    { action: "Switch to Build mode", keys: "Ctrl+1" },
    { action: "Switch to Study mode", keys: "Ctrl+2" },
    { action: "Switch to Analyze mode", keys: "Ctrl+3" },
    { action: "Switch to Runs mode", keys: "Ctrl+4" },
    { action: "3D view", keys: "1" },
    { action: "2D view", keys: "2" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.75rem] text-muted-foreground mb-2">Keyboard shortcuts are fixed in this version.</p>
      <div className="flex flex-col divide-y divide-border/30">
        {shortcuts.map((s) => (
          <div key={s.action} className="flex items-center justify-between py-1.5">
            <span className="text-[0.8rem] text-foreground/80">{s.action}</span>
            <kbd className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[0.68rem] font-mono text-muted-foreground">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="Fullmag">
        <div className="flex flex-col gap-1.5 text-[0.78rem] text-muted-foreground">
          <div className="flex justify-between"><span>Product</span><span className="text-foreground font-medium">Fullmag CAE</span></div>
          <div className="flex justify-between"><span>Frontend</span><span className="text-foreground font-medium">Next.js 15 / React 19</span></div>
          <div className="flex justify-between"><span>Runtime</span><span className="text-foreground font-medium">Rust + Python</span></div>
        </div>
      </SettingsSection>
      <SettingsSection title="License">
        <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
          Fullmag is proprietary software. All rights reserved.
        </p>
      </SettingsSection>
    </div>
  );
}

function SettingsDialogInner({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative flex h-[560px] w-[780px] max-w-[95vw] max-h-[90vh] rounded-xl border border-border/60 bg-background shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-44 shrink-0 flex-col border-r border-border/40 bg-card/40 p-2">
          <h2 className="px-2 py-2 text-[0.72rem] font-semibold tracking-widest uppercase text-muted-foreground">
            Preferences
          </h2>
          <nav className="flex flex-col gap-0.5 mt-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-[0.78rem] font-medium transition-colors text-left",
                  activeTab === t.id
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <span className="opacity-70">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex flex-1 flex-col min-w-0">
          <div className="flex items-center justify-between border-b border-border/40 px-5 py-3">
            <h3 className="text-[0.9rem] font-semibold">
              {TABS.find((t) => t.id === activeTab)?.label}
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  router.push("/settings");
                }}
                className="rounded-md border border-border/60 px-2 py-1 text-[0.72rem] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                Open Full Settings
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-5">
            {activeTab === "appearance" && <AppearanceTab />}
            {activeTab === "runtime" && <RuntimeTab />}
            {activeTab === "controls" && <ControlsTab />}
            {activeTab === "shortcuts" && <ShortcutsTab />}
            {activeTab === "about" && <AboutTab />}
          </div>
          <div className="flex items-center justify-end border-t border-border/40 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border/60 px-4 py-1.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SettingsDialog() {
  const open = useWorkspaceStore((s) => s.settingsOpen);
  const setOpen = useWorkspaceStore((s) => s.setSettingsOpen);
  if (!open) return null;
  return <SettingsDialogInner onClose={() => setOpen(false)} />;
}
