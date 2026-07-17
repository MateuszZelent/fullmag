import { useCallback, useState } from "react";
import { Calculator } from "lucide-react";

import { useObjectTopologicalChargeResource } from "@/kernel/resources/studyRuntimeResources";
import { FeedbackBanner } from "@/modules/inspector/primitives/FeedbackBanner";
import { FieldRow } from "@/modules/inspector/primitives/FieldRow";
import { InspectorGroup } from "@/modules/inspector/primitives/InspectorGroup";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  resolveTopologicalChargePanelModel,
  type TopologicalChargeMethodInfo,
} from "./topologicalChargeModel";

const CONTINUUM_MATHML = `<math display="block" aria-label="Q Sigma equals one over four pi times the integral over Sigma of m hat dot partial u m hat cross partial v m hat">
  <mrow>
    <msub><mi>Q</mi><mi>&Sigma;</mi></msub><mo>=</mo>
    <mfrac><mn>1</mn><mrow><mn>4</mn><mi>&pi;</mi></mrow></mfrac>
    <msub><mo>&Integral;</mo><mi>&Sigma;</mi></msub>
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

const DISCRETE_MATHML = `<math display="block" aria-label="Q h of s i equals one over four pi times sum of oriented triangle solid angles">
  <mrow>
    <msub><mi>Q</mi><mi>h</mi></msub>
    <mo>(</mo><msub><mi>s</mi><mi>i</mi></msub><mo>)</mo><mo>=</mo>
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
type TopologicalChargePlane = "auto" | "xy" | "xz" | "yz";
type TopologicalChargeSupport = "midplane" | "layer_profile";
type TopologicalChargeProfileSamples = "auto" | 17 | 33 | 65;

export function TopologicalChargeExtensionPanel({ selection }: InspectorPanelProps) {
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const [calculationMode, setCalculationMode] =
    useState<TopologicalChargeCalculationMode>("on_demand");
  const [plane, setPlane] = useState<TopologicalChargePlane>("auto");
  const [support, setSupport] = useState<TopologicalChargeSupport>("midplane");
  const [profileSamples, setProfileSamples] =
    useState<TopologicalChargeProfileSamples>("auto");
  const resource = useObjectTopologicalChargeResource(objectId, {
    pauseLoad: calculationMode === "on_demand",
    query: {
      plane,
      support,
      profile_samples: support === "layer_profile" ? profileSamples : undefined,
    },
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
      <InspectorGroup title="Topological Charge">
        <TopologicalChargeMethodSummary method={model.method} />
        <TopologicalChargeControls
          busy={busy}
          mode={calculationMode}
          plane={plane}
          support={support}
          profileSamples={profileSamples}
          onCompute={handleCompute}
          onModeChange={handleModeChange}
          onPlaneChange={(value) => setPlane(value as TopologicalChargePlane)}
          onSupportChange={(value) => setSupport(value as TopologicalChargeSupport)}
          onProfileSamplesChange={(value) =>
            setProfileSamples(value === "auto" ? "auto" : Number(value) as 17 | 33 | 65)
          }
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
        <TopologicalChargeProfileTable profile={resource.data?.profile ?? []} />
      </InspectorGroup>
    </div>
  );
}

function TopologicalChargeProfileTable({
  profile,
}: {
  profile: NonNullable<ReturnType<typeof useObjectTopologicalChargeResource>["data"]>["profile"];
}) {
  if (!profile || profile.length === 0) return null;

  return (
    <div className="fm-topological-charge-profile" aria-label="Topological charge profile">
      <h4>Support profile</h4>
      <table>
        <thead>
          <tr>
            <th scope="col">i</th>
            <th scope="col">s (m)</th>
            <th scope="col">weight (m)</th>
            <th scope="col">Q(s)</th>
            <th scope="col">status</th>
            <th scope="col">trust</th>
          </tr>
        </thead>
        <tbody>
          {profile.map((sample) => (
            <tr key={sample.index}>
              <td>{sample.index}</td>
              <td>{sample.coordinate_m.toExponential(3)}</td>
              <td>{sample.integration_weight_m.toExponential(3)}</td>
              <td>{typeof sample.charge === "number" ? sample.charge.toFixed(6) : "unavailable"}</td>
              <td>{sample.status}</td>
              <td>{sample.trust}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopologicalChargeControls({
  busy,
  mode,
  plane,
  support,
  profileSamples,
  onCompute,
  onModeChange,
  onPlaneChange,
  onSupportChange,
  onProfileSamplesChange,
}: {
  busy: boolean;
  mode: TopologicalChargeCalculationMode;
  plane: TopologicalChargePlane;
  support: TopologicalChargeSupport;
  profileSamples: TopologicalChargeProfileSamples;
  onCompute: () => void;
  onModeChange: (mode: string) => void;
  onPlaneChange: (plane: string) => void;
  onSupportChange: (support: string) => void;
  onProfileSamplesChange: (samples: string) => void;
}) {
  return (
    <div className="fm-topological-charge-controls">
      <Tabs value={mode} onValueChange={onModeChange}>
        <TabsList aria-label="Topological charge calculation mode">
          <TabsTrigger value="on_demand">On demand</TabsTrigger>
          <TabsTrigger value="continuous">Continuous</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tabs value={plane} onValueChange={onPlaneChange}>
        <TabsList aria-label="Topological charge support plane">
          <TabsTrigger value="auto">Auto</TabsTrigger>
          <TabsTrigger value="xy">XY</TabsTrigger>
          <TabsTrigger value="xz">XZ</TabsTrigger>
          <TabsTrigger value="yz">YZ</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tabs value={support} onValueChange={onSupportChange}>
        <TabsList aria-label="Topological charge support mode">
          <TabsTrigger value="midplane">Midplane</TabsTrigger>
          <TabsTrigger value="layer_profile">Profile</TabsTrigger>
        </TabsList>
      </Tabs>
      {support === "layer_profile" ? (
        <Tabs value={String(profileSamples)} onValueChange={onProfileSamplesChange}>
          <TabsList aria-label="Topological charge profile sample count">
            <TabsTrigger value="auto">Auto</TabsTrigger>
            <TabsTrigger value="17">17</TabsTrigger>
            <TabsTrigger value="33">33</TabsTrigger>
            <TabsTrigger value="65">65</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
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
