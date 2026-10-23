"use client";

import { useState } from "react";
import { parseQuantityInput } from "@/kernel/authoring/object-edit/quantityInput";

import { GeometryValidationSummary } from "@/modules/inspector/primitives/GeometryValidationSummary";
import { ColorField } from "@/modules/inspector/primitives/ColorField";
import { FormField } from "@/modules/inspector/primitives/FormField";
import { InspectorGroup } from "@/modules/inspector/primitives/InspectorGroup";
import { InspectorPropertyRow } from "@/modules/inspector/primitives/InspectorPropertyRow";
import { QuantityUnitSelect } from "@/modules/inspector/primitives/QuantityUnitSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Vector3Field } from "@/modules/inspector/primitives/Vector3Field";
import { InspectorEditSessionProvider, useInspectorEditSession } from "@/modules/inspector/InspectorEditSession";
import { PlanarNumberField } from "@/modules/inspector/visualization/PlanarNumberField";
import { PlanarManualRangeFields } from "@/modules/inspector/visualization/PlanarManualRangeFields";
import { PlanarPresentationDraftOwner, PlanarPresentationFieldContext } from "@/modules/inspector/visualization/PlanarPresentationDraftOwner";
import { RibbonMenuRenderer } from "@/modules/ribbon/RibbonMenuRenderer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/ui/DropdownMenu";

type ValidationState = "ready-empty" | "loading" | "error" | "stale";

function InspectorThemeFixture() {
  const [name, setName] = useState("Permalloy sample");
  const [color, setColor] = useState("#89b4fa");
  const [colorChanges, setColorChanges] = useState(0);
  return (
    <section
      aria-label="Inspector theme fixture"
      className="fm-inspector-panel rounded-fm-surface border border-fm-subtle bg-fm-panel p-fm-3"
      data-testid="inspector-theme-fixture"
      style={{ containerType: "inline-size", width: "100%", maxWidth: 480 }}
    >
      <InspectorGroup title="Properties" description="Shared Visualize-style Inspector controls">
        <FormField label="Sample name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <FormField label="Execution profile" type="select" defaultValue="long">
          <option value="long">Automatic — use the configured compute environment</option>
          <option value="manual">Manual</option>
        </FormField>
        <FormField label="Field amplitude" value="1e-" unit="A/m" error="Complete the exponent before applying." onChange={() => {}} />
        <FormField label="Unavailable value" value="Resource unavailable" disabled />
        <InspectorPropertyRow label="Display mode">
          <Select defaultValue="solid">
            <SelectTrigger aria-label="Display mode"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="solid">Solid</SelectItem><SelectItem value="wireframe">Wireframe</SelectItem></SelectContent>
          </Select>
        </InspectorPropertyRow>
        <Vector3Field label="Origin" values={["1", "2", "3"]} onChange={() => {}} unitControls={[
          <QuantityUnitSelect key="x" label="Origin X" input={parseQuantityInput("1", "length", "nm")} onChange={() => {}} />,
          <QuantityUnitSelect key="y" label="Origin Y" input={parseQuantityInput("2", "length", "nm")} onChange={() => {}} />,
          <QuantityUnitSelect key="z" label="Origin Z" input={parseQuantityInput("3", "length", "nm")} onChange={() => {}} />,
        ]} />
        <FormField label="Notes" type="textarea" defaultValue="Retain local authoring values while resources refresh." />
      </InspectorGroup>
      <InspectorGroup title="Appearance">
        <ColorField label="Sample color" hint="Viewport-local preference." value={color} onChange={(value) => { setColor(value); setColorChanges((count) => count + 1); }} />
        <ColorField label="Theme color" value="var(--fm-accent)" onChange={() => {}} />
        <ColorField label="Automatic color" value="" onChange={() => {}} />
        <ColorField label="Disabled color" value="#a6e3a1" disabled onChange={() => {}} />
      </InspectorGroup>
      <output data-testid="inspector-theme-color-changes">{colorChanges}</output>
    </section>
  );
}

function PlanarGuardSnapshot() {
  const session = useInspectorEditSession();
  return <output data-testid="planar-guard">{JSON.stringify({ dirty: session?.dirty ?? false, valid: session?.valid ?? true })}</output>;
}

function PlanarDraftFixture() {
  const [visible, setVisible] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [range, setRange] = useState({ min: -1, max: 1 });
  const [commitCount, setCommitCount] = useState(0);
  return (
    <section aria-label="Planar raw input fixture" data-testid="planar-draft-fixture">
      <h2>Planar input drafts</h2>
      <InspectorEditSessionProvider>
        <button type="button" onClick={() => setVisible(false)}>Show fixture 3D</button>
        <button type="button" onClick={() => setVisible(true)}>Show fixture 2D</button>
        <PlanarPresentationDraftOwner identityKey="audit-session:planar-target">
          <PlanarPresentationFieldContext contextKey="audit-source">
            {visible ? (
              <>
                <PlanarNumberField label="Audit planar opacity" minimum={0} maximum={1} path="opacity" value={opacity} onCommit={(value) => {
                  setOpacity(value);
                  setCommitCount((count) => count + 1);
                }} />
                <PlanarManualRangeFields minimum={range.min} maximum={range.max} onCommit={(value) => {
                  setRange(value);
                  setCommitCount((count) => count + 1);
                }} />
              </>
            ) : <p>Input fields are unmounted in the fixture 3D view.</p>}
          </PlanarPresentationFieldContext>
        </PlanarPresentationDraftOwner>
        <PlanarGuardSnapshot />
      </InspectorEditSessionProvider>
      <output data-testid="planar-commit-count">{commitCount}</output>
      <output data-testid="planar-opacity">{opacity}</output>
      <output data-testid="planar-range">{JSON.stringify(range)}</output>
    </section>
  );
}

export default function FrontendControlsFixturePage() {
  const [vectorValues, setVectorValues] = useState<[string, string, string]>([
    "0",
    "0",
    "0",
  ]);
  const [vectorCallbackCount, setVectorCallbackCount] = useState(0);
  const [color, setColor] = useState("#123456");
  const [colorCommandCount, setColorCommandCount] = useState(0);
  const [lastColorCommand, setLastColorCommand] = useState("");
  const [validationState, setValidationState] =
    useState<ValidationState>("ready-empty");

  const validationProps = {
    error:
      validationState === "error"
        ? new Error("Fixture geometry validation request failed.")
        : null,
    hasData: validationState === "ready-empty" || validationState === "stale",
    messages: [],
    refreshError: null,
    status:
      validationState === "ready-empty"
        ? ("ready" as const)
        : validationState === "error"
          ? ("error" as const)
          : validationState === "stale"
            ? ("stale" as const)
            : ("loading" as const),
  };

  function handleVectorChange(index: 0 | 1 | 2, value: string): void {
    setVectorCallbackCount((count) => count + 1);
    setVectorValues((current) => {
      const next: [string, string, string] = [...current];
      next[index] = value;
      return next;
    });
  }

  return (
    <main
      data-testid="frontend-controls-fixture"
      style={{ display: "grid", gap: 16, margin: "0 auto", maxWidth: 920, padding: 24 }}
    >
      <h1>Frontend controls browser fixture</h1>

      <InspectorThemeFixture />

      <PlanarDraftFixture />

      <section aria-labelledby="vector-audit-heading">
        <h2 id="vector-audit-heading">Vector field callback</h2>
        <Vector3Field
          errors={["Fixture vector validation error.", undefined, undefined]}
          label="Audit vector"
          values={vectorValues}
          onChange={handleVectorChange}
        />
        <output aria-label="Vector callback count" data-testid="vector-callback-count">
          {vectorCallbackCount}
        </output>
        <button
          type="button"
          onClick={() => setVectorCallbackCount(0)}
        >
          Reset vector callback count
        </button>
      </section>

      <section aria-labelledby="validation-audit-heading" data-testid="validation-summary-fixture">
        <h2 id="validation-audit-heading">Geometry validation summary</h2>
        <div aria-label="Validation fixture states" role="group">
          <button type="button" onClick={() => setValidationState("ready-empty")}>
            Ready empty
          </button>
          <button type="button" onClick={() => setValidationState("loading")}>
            Loading
          </button>
          <button type="button" onClick={() => setValidationState("error")}>
            Error
          </button>
          <button type="button" onClick={() => setValidationState("stale")}>
            Stale previous result
          </button>
        </div>
        <output aria-label="Validation fixture state" data-testid="validation-state">
          {validationState}
        </output>
        <GeometryValidationSummary {...validationProps} />
      </section>

      <section aria-labelledby="color-audit-heading" data-testid="color-picker-fixture">
        <h2 id="color-audit-heading">Ribbon color control</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button">Open audit color menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Before color controls</DropdownMenuItem>
            <RibbonMenuRenderer
              nodes={[
                { type: "color", id: "audit-color", label: "Audit color", value: color, commandId: "audit.set-color" },
                { type: "color", id: "disabled-color", label: "Disabled color", value: "#abcdef", disabled: true },
              ]}
              onCommand={(commandId, input) => {
                setColorCommandCount((count) => count + 1);
                setLastColorCommand(JSON.stringify({ commandId, input }));
                if (typeof input === "string") setColor(input);
              }}
            />
            <DropdownMenuItem>After color controls</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <output data-testid="color-command-count">{colorCommandCount}</output>
        <output data-testid="last-color-command">{lastColorCommand}</output>
      </section>
    </main>
  );
}
