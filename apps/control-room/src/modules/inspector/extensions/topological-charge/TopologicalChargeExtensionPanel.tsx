import { useCallback, useState } from "react";
import { Calculator } from "lucide-react";

import { useObjectTopologicalChargeResource } from "@/kernel/resources/studyRuntimeResources";
import { FeedbackBanner } from "@/modules/inspector/primitives/FeedbackBanner";
import { FieldRow } from "@/modules/inspector/primitives/FieldRow";
import { InspectorSection } from "@/modules/inspector/primitives/InspectorSection";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  resolveTopologicalChargePanelModel,
  type TopologicalChargeMethodInfo,
} from "./topologicalChargeModel";

const CONTINUUM_MATHML = `<math display="block" aria-label="Q equals one over four pi times the integral of m hat dot partial u m hat cross partial v m hat">
  <mrow>
    <mi>Q</mi><mo>=</mo>
    <mfrac><mn>1</mn><mrow><mn>4</mn><mi>&pi;</mi></mrow></mfrac>
    <msub><mo>&Integral;</mo><mi>&Omega;</mi></msub>
    <mover accent="true"><mi>m</mi><mo>^</mo></mover>
    <mo>&middot;</mo>
    <mrow>
      <mo>(</mo>
      <msub><mo>&part;</mo><mi>u</mi></msub>
      <mover accent="true"><mi>m</mi><mo>^</mo></mover>
      <mo>&times;</mo>
      <msub><mo>&part;</mo><mi>v</mi></msub>
      <mover accent="true"><mi>m</mi><mo>^</mo></mover>
      <mo>)</mo>
    </mrow>
    <mspace width="0.2em"></mspace><mi>d</mi><mi>u</mi>
    <mspace width="0.1em"></mspace><mi>d</mi><mi>v</mi>
  </mrow>
</math>`;

const DISCRETE_MATHML = `<math display="block" aria-label="Q h equals one over four pi times sum of triangle solid angles">
  <mrow>
    <msub><mi>Q</mi><mi>h</mi></msub><mo>=</mo>
    <mfrac><mn>1</mn><mrow><mn>4</mn><mi>&pi;</mi></mrow></mfrac>
    <munder><mo>&sum;</mo><mi>&triangle;</mi></munder>
    <mn>2</mn><mi>atan2</mi><mo>(</mo>
    <mrow>
      <mi>a</mi><mo>&middot;</mo><mo>(</mo><mi>b</mi><mo>&times;</mo><mi>c</mi><mo>)</mo>
    </mrow>
    <mo>,</mo>
    <mrow>
      <mn>1</mn><mo>+</mo><mi>a</mi><mo>&middot;</mo><mi>b</mi>
      <mo>+</mo><mi>b</mi><mo>&middot;</mo><mi>c</mi>
      <mo>+</mo><mi>c</mi><mo>&middot;</mo><mi>a</mi>
    </mrow>
    <mo>)</mo>
  </mrow>
</math>`;

type TopologicalChargeCalculationMode = "on_demand" | "continuous";

export function TopologicalChargeExtensionPanel({ selection }: InspectorPanelProps) {
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const [calculationMode, setCalculationMode] =
    useState<TopologicalChargeCalculationMode>("on_demand");
  const resource = useObjectTopologicalChargeResource(objectId, {
    pauseLoad: calculationMode === "on_demand",
  });
  const model = resolveTopologicalChargePanelModel(resource.status, resource.data);
  const busy = resource.status === "loading";

  const handleModeChange = useCallback((nextMode: string) => {
    setCalculationMode(nextMode as TopologicalChargeCalculationMode);
  }, []);

  const handleCompute = useCallback(() => {
    resource.refetch();
  }, [resource]);

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Topological Charge">
        <TopologicalChargeMethodSummary method={model.method} />
        <TopologicalChargeControls
          busy={busy}
          mode={calculationMode}
          onCompute={handleCompute}
          onModeChange={handleModeChange}
        />
        {model.banner ? (
          <FeedbackBanner kind={model.banner.kind} message={model.banner.message} />
        ) : null}
        <FieldRow
          label="Calculation"
          value={calculationMode === "continuous" ? "continuous" : "on demand"}
        />
        {model.rows.map((row) => (
          <FieldRow key={row.label} label={row.label} value={row.value} />
        ))}
      </InspectorSection>
    </div>
  );
}

function TopologicalChargeControls({
  busy,
  mode,
  onCompute,
  onModeChange,
}: {
  busy: boolean;
  mode: TopologicalChargeCalculationMode;
  onCompute: () => void;
  onModeChange: (mode: string) => void;
}) {
  return (
    <div className="fm-topological-charge-controls">
      <Tabs value={mode} onValueChange={onModeChange}>
        <TabsList aria-label="Topological charge calculation mode">
          <TabsTrigger value="on_demand">On demand</TabsTrigger>
          <TabsTrigger value="continuous">Continuous</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button
        size="sm"
        type="button"
        variant={mode === "continuous" ? "secondary" : "primary"}
        disabled={busy}
        onClick={onCompute}
        title="Compute topological charge now"
      >
        <Calculator size={13} aria-hidden="true" />
        {busy ? "Computing" : "Compute"}
      </Button>
    </div>
  );
}

function TopologicalChargeMethodSummary({
  method,
}: {
  method: TopologicalChargeMethodInfo;
}) {
  return (
    <div className="fm-topological-charge-method">
      <div className="fm-topological-charge-method__header">
        <div>
          <h4>{method.title}</h4>
          <p>{method.description}</p>
        </div>
        <span>{method.sampleQuality}</span>
      </div>
      <div
        className="fm-topological-charge-method__equations"
        aria-label="Topological charge equations"
      >
        <div className="fm-topological-charge-method__equation">
          <span>Continuum</span>
          <RenderedMath mathml={CONTINUUM_MATHML} />
        </div>
        <div className="fm-topological-charge-method__equation">
          <span>Discrete triangles</span>
          <RenderedMath mathml={DISCRETE_MATHML} />
        </div>
      </div>
      <dl className="fm-topological-charge-method__terms">
        {method.terms.map((term) => (
          <div key={term.symbol}>
            <dt>{term.symbol}</dt>
            <dd>{term.meaning}</dd>
          </div>
        ))}
      </dl>
      <ul className="fm-topological-charge-method__notes">
        {method.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

function RenderedMath({ mathml }: { mathml: string }) {
  return (
    <div
      className="fm-topological-charge-method__math"
      dangerouslySetInnerHTML={{ __html: mathml }}
    />
  );
}
