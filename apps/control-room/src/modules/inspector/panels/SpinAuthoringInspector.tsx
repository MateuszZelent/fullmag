"use client";

import { useMemo, useState } from "react";

import type {
  SceneCurrentTransport,
  SceneOerstedField,
  SceneSpinTorque,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  CURRENT_TRANSPORTS_RESOURCE_KEY,
  OERSTED_FIELDS_RESOURCE_KEY,
  SPIN_TORQUES_RESOURCE_KEY,
  useCurrentTransportsResource,
  useOerstedFieldsResource,
  useSpinTorquesResource,
} from "@/kernel/resources/spinAuthoringResources";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { InspectorSection } from "../primitives/InspectorSection";
import type { PhysicsInteractionId } from "./PhysicsInteractionPanelModel";

type SpinResource = SceneCurrentTransport | SceneSpinTorque | SceneOerstedField;
type Family = "current_transport" | "spin_torque" | "oersted_field";

const DEFAULTS: Record<Family, SpinResource> = {
  current_transport: {
    kind: "current_transport",
    model: "prescribed_density",
    name: "current",
    current_density: [0, 0, 0],
  },
  spin_torque: {
    kind: "zhang_li",
    id: "spin-torque",
    current_density: [0, 0, 0],
    degree: 0.4,
    beta: 0,
  },
  oersted_field: {
    kind: "oersted_cylinder",
    id: "oersted-field",
    center: [0, 0, 0],
    axis: [0, 0, 1],
    radius: 1e-9,
    current: 0,
  },
};

function identity(family: Family, value: SpinResource): string {
  return family === "current_transport"
    ? (value as SceneCurrentTransport).name
    : (value as SceneSpinTorque | SceneOerstedField).id ?? "";
}

export function SpinAuthoringInspector({ family }: { family: Extract<PhysicsInteractionId, Family> }) {
  const { api, resources } = useKernel();
  const current = useCurrentTransportsResource({ enabled: family === "current_transport" });
  const torques = useSpinTorquesResource({ enabled: family === "spin_torque" });
  const oersted = useOerstedFieldsResource({ enabled: family === "oersted_field" });
  const active = family === "current_transport" ? current : family === "spin_torque" ? torques : oersted;
  const items = useMemo(() => (active.data?.items ?? []) as SpinResource[], [active.data]);
  const [selectedId, setSelectedId] = useState("");
  const selected = items.find((item) => identity(family, item) === selectedId) ?? null;
  const [draft, setDraft] = useState(JSON.stringify(DEFAULTS[family], null, 2));
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function save(): Promise<void> {
    setPending(true);
    setFeedback(null);
    try {
      const resource = JSON.parse(draft) as SpinResource;
      const base_revision = active.data?.scene_revision;
      if (base_revision === undefined) throw new Error("Scene revision is unavailable.");
      if (family === "current_transport") {
        const request = { base_revision, resource: resource as SceneCurrentTransport };
        if (selectedId) await api.model.replaceCurrentTransport(selectedId, request);
        else await api.model.createCurrentTransport(request);
      } else if (family === "spin_torque") {
        const request = { base_revision, resource: resource as SceneSpinTorque };
        if (selectedId) await api.model.replaceSpinTorque(selectedId, request);
        else await api.model.createSpinTorque(request);
      } else {
        const request = { base_revision, resource: resource as SceneOerstedField };
        if (selectedId) await api.model.replaceOerstedField(selectedId, request);
        else await api.model.createOerstedField(request);
      }
      resources.invalidate(family === "current_transport" ? CURRENT_TRANSPORTS_RESOURCE_KEY : family === "spin_torque" ? SPIN_TORQUES_RESOURCE_KEY : OERSTED_FIELDS_RESOURCE_KEY, Date.now());
      setFeedback({ kind: "success", message: "Authoring resource committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Authoring resources">
        <label className="fm-form-field">
          <span className="fm-form-field__label">Resource</span>
          <select className="fm-select" value={selectedId} onChange={(event) => {
            const id = event.target.value;
            setSelectedId(id);
            const item = items.find((candidate) => identity(family, candidate) === id);
            setDraft(JSON.stringify(item ?? DEFAULTS[family], null, 2));
          }}>
            <option value="">New resource</option>
            {items.map((item) => {
              const id = identity(family, item);
              return <option key={id} value={id}>{id}</option>;
            })}
          </select>
        </label>
        <label className="fm-form-field">
          <span className="fm-form-field__label">Canonical typed payload</span>
          <textarea
            className="fm-input fm-spin-authoring-json"
            aria-label="Canonical typed payload"
            rows={18}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p className="fm-help-text">All values use the canonical OpenAPI schema and SI units. Unsupported variants remain visible but cannot be committed.</p>
        {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
        <Button disabled={pending || active.status !== "ready"} onClick={() => void save()}>
          {pending ? "Committing…" : selected ? "Replace" : "Create"}
        </Button>
      </InspectorSection>
    </div>
  );
}
