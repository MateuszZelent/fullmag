import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { MODEL_PHYSICS_ROUTES } from "../../routes/modelPhysicsRoutes";
import {
  findElement,
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";
import {
  computeAutoHallPolarization,
  SpinTorqueInspectorPanel,
} from "../../inspectors/objects/transport";
import { CurrentTransportInspectorPanel } from "../transport/CurrentTransportPanel";
import { OerstedFieldInspectorPanel } from "../transport/OerstedFieldPanel";
import { SpinInterfaceInspectorPanel } from "../transport/SpinInterfacePanel";
import { SpinTransportInspectorPanel } from "../transport/SpinTransportPanel";
import {
  StructuredCurrentClosureInspectorPanel,
  StructuredCurrentSourceCutInspectorPanel,
} from "../transport/StructuredClosurePanels";
import {
  evaluateFieldDriveEnvelopeAtTime,
  FieldDriveInspectorPanel,
} from "../../inspectors/objects/field-drives";
import {
  CouplingInspectorPanel,
  ObjectPhysicsInspectorPanel,
  PhysicsModuleInspectorPanel,
  resolveCanonicalPhysicsModuleKind,
} from "../../inspectors/objects/physics";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
    <button role="menuitem" type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-context-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-alert-dialog">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => (
    <div role="alertdialog">{children}</div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button data-slot="confirm-delete-action" type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@radix-ui/react-select", () => ({
  Root: ({ children, onValueChange, value }: { children?: ReactNode; onValueChange?: (v: string) => void; value?: string }) => (
    <div data-select-value={value ?? ""} data-slot="mock-select-root" onClick={() => undefined}>
      {children}
      {onValueChange ? (
        <input
          data-slot="mock-select-trigger-input"
          type="hidden"
          value={value ?? ""}
          onChange={(e) => onValueChange(e.target.value)}
        />
      ) : null}
    </div>
  ),
  Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Value: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder}</span>
  ),
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div data-select-item={value}>{children}</div>
  ),
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-tabs", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => (
    <button role="tab" type="button">
      {children}
    </button>
  ),
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div aria-label={ariaLabel} data-slot="mock-scientific-echart" />
  ),
}));

const SUPPORTED_OP = {
  state: "supported" as const,
  reason_code: "ok",
  reason: "Supported",
  requires: [] as string[],
};

const mocks = vi.hoisted(() => ({
  discretization: "fem" as "fem" | "fdm" | null,
  openDocs: vi.fn(),
  sceneData: {
    revision: 44,
    scene_revision: 44,
    study: {
      output_dt_s: 20e-12,
      exchange_enabled: true,
      demag_enabled: true,
      demag_realization: "fredkin_koehler",
      rotated_interfacial_dmi: null as number | null,
      thermal_noise: { temperature: 300, seed: "42" } as { temperature: number; seed?: string | null } | null,
      pbc: {
        axes: ["periodic", "open", "open"],
        demag: "truncated_images",
        image_counts: [12, 0, 0],
      } as Record<string, unknown> | null,
      stages: [{ id: "run-1", kind: "run", output_every_seconds: 20e-12 }],
    },
    outputs: {
      table_autosave: { every_seconds: 20e-12 },
    },
    materials: [
      { id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12, Dind: 1.5e-3 } },
    ],
    couplings: [
      {
        coupling_id: "cpl-1",
        kind: "rkky",
        enabled: true,
        source: { kind: "object", object: "layer-top" },
        target: { kind: "object", object: "layer-bot" },
        parameters: { kind: "rkky", j1: -1.5e-3 },
      },
      {
        coupling_id: "cpl-ex",
        kind: "exchange",
        capability_policy: "require_runtime",
        enabled: true,
        source: { kind: "surface", object: "layer-top", selector: "+z" },
        target: { kind: "surface", object: "layer-bot", selector: "-z" },
        parameters: { kind: "exchange", mode: "explicit", inter_exchange: 8e-12, scale: 0.75 },
      },
    ],
    objects: [
      {
        id: "layer-top",
        name: "Top FM",
        role: "magnet",
        material_ref: "py",
        physics_stack: [
          {
            kind: "uniaxial_anisotropy",
            enabled: true,
            params: { ku1: 4.5e5, ku2: 1.0e4, axis: [0, 0, 1] },
          },
        ],
      },
      { id: "layer-bot", name: "Bottom FM", role: "magnet", material_ref: "py" },
      { id: "hm-pt", name: "Pt Underlayer", role: "conductor" },
    ],
  },
  couplingsData: {
    scene_revision: 44,
    couplings: [
      {
        coupling_id: "cpl-1",
        coupling_kind: "rkky",
        enabled: true,
        realization_status: "ready",
        blocker_reason: null as string | null,
        source: { kind: "object", object: "layer-top" },
        target: { kind: "object", object: "layer-bot" },
        params: { kind: "rkky", j1: -1.5e-3 },
        source_resolution: { status: "resolved", resolved_face_count: 64, area: 1e-14, tolerance: 1e-12 },
        target_resolution: { status: "resolved", resolved_face_count: 64, area: 1e-14, tolerance: 1e-12 },
      },
      {
        coupling_id: "cpl-ex",
        coupling_kind: "exchange",
        enabled: true,
        realization_status: "requires_runtime_capability",
        blocker_reason: "Non-conformal interface mesh gap exceeds tolerance" as string | null,
        source: { kind: "surface", object: "layer-top", selector: "+z" },
        target: { kind: "surface", object: "layer-bot", selector: "-z" },
        params: { kind: "exchange", mode: "explicit", inter_exchange: 8e-12, scale: 0.75 },
        source_resolution: {
          status: "resolved",
          resolved_face_count: 32,
          area: 2.5e-14,
          reason: "Matched top cap",
          tolerance: 1e-11,
        },
        target_resolution: {
          status: "unresolved",
          resolved_face_count: 0,
          area: null,
          reason: "Gap > 10 pm",
          tolerance: 1e-11,
        },
      },
    ],
  },
  objectInteractionData: {
    enabled: true,
    interaction_kind: "uniaxial_anisotropy",
    object_id: "layer-top",
    params: { ku1: 4.5e5, ku2: 1.0e4, axis: [0, 0, 1] },
    present: true,
    scene_revision: 44,
  },
  physicsGraphModules: [] as Record<string, unknown>[],
  commitTransaction: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
  patchCoupling: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
  patchMaterialAsset: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
  deleteFieldDrive: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
  patchObjectInteraction: vi.fn().mockResolvedValue({ scene_revision: 45 }),
  replaceSpinTransport: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
  validateTransport: vi.fn().mockResolvedValue({
    schema_version: "transport-authoring-validation.v1",
    valid: true,
    qualification: "production_qualified",
    execution: { requested_lane: "auto", resolved_lane: "fem_cpu", reason: null },
    semantic: { valid: true, issues: [] },
  }),
  invalidate: vi.fn(),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/layout/homeView", () => ({
  homeView: {
    openDocs: mocks.openDocs,
  },
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionResourceIdentity: () => ({
    sessionId: "sess-1",
    sessionEpoch: "1",
    requestScopeEpoch: "1",
  }),
  useSessionStatusSelector: (
    selector: (arg: { data: Record<string, unknown> | null; status: string }) => unknown,
  ) =>
    selector({
      status: "ready",
      data: {
        session: { session_id: "sess-1" },
        capabilities: {
          active_lane: {
            source: { kind: "planner" },
            resolved: mocks.discretization ? { discretization: mocks.discretization } : null,
            operations: {},
          },
        },
      },
    }),
}));

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  useActiveLaneCapabilities: () => ({
    source: { kind: "planner" },
    resolved: mocks.discretization ? { discretization: mocks.discretization } : null,
    operations: {
      "interaction.exchange": SUPPORTED_OP,
      "interaction.demag": SUPPORTED_OP,
      "interaction.zeeman": SUPPORTED_OP,
      "interaction.uniaxial_anisotropy": SUPPORTED_OP,
      "interaction.cubic_anisotropy": SUPPORTED_OP,
      "interaction.interfacial_dmi": SUPPORTED_OP,
      "interaction.bulk_dmi": SUPPORTED_OP,
      "interaction.rotated_interfacial_dmi": SUPPORTED_OP,
      "interaction.thermal": SUPPORTED_OP,
      "interaction.current_transport": SUPPORTED_OP,
      "interaction.spin_torque": SUPPORTED_OP,
      "interaction.oersted_field": SUPPORTED_OP,
      "interaction.magnetoelastic": {
        state: "deferred",
        reason_code: "deferred",
        reason: "Magnetoelastic strain authoring is deferred.",
        requires: [],
      },
    },
  }),
  resolveActiveLaneOperation: (
    snapshot: { operations?: Record<string, { state: string; reason: string; reason_code: string; requires: string[] }> } | null,
    opId: string,
  ) => {
    const op = snapshot?.operations?.[opId] ?? SUPPORTED_OP;
    return { ...op, enabled: op.state === "supported" };
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      resourceCacheScope: "test-scope",
      sessions: {
        current: {
          capabilities: vi.fn().mockResolvedValue({
            capabilities: {
              transport_authoring: {
                current_transport: { authoring_allowed: true },
                spin_transport: { authoring_allowed: true },
                spin_interface: { authoring_allowed: true },
                spin_torque: { authoring_allowed: true },
                oersted_field: { authoring_allowed: true },
              },
            },
          }),
        },
      },
      model: {
        scene: vi.fn().mockResolvedValue(mocks.sceneData),
        patchObjectInteraction: mocks.patchObjectInteraction,
        patchMaterialAsset: mocks.patchMaterialAsset,
        patchStudy: vi.fn().mockResolvedValue({}),
        commitTransaction: mocks.commitTransaction,
        createCoupling: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        patchCoupling: mocks.patchCoupling,
        deleteCoupling: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        validateTransport: mocks.validateTransport,
        readyAntennaTerms: vi.fn().mockResolvedValue({ terms: [] }),
        createCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        deleteCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        createSpinTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceSpinTransport: mocks.replaceSpinTransport,
        deleteSpinTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        createSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        deleteSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        createOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        deleteOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        createFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        deleteFieldDrive: mocks.deleteFieldDrive,
        createMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        replaceMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
        deleteMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45, scene_revision: 45 }, scene_revision: 45 }),
      },
    },
    commands: { execute: vi.fn(), getSessionScopeKey: () => "s1" },
    layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }), setPanelVisible: vi.fn() },
    resources: { invalidate: mocks.invalidate, getSnapshot: () => null },
    selection: { set: mocks.setSelection, get: () => null },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  MODEL_COUPLINGS_RESOURCE_KEY: "/api/v2/sessions/current/model/couplings",
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY: "/api/v2/sessions/current/model/regions/diagnostics",
  publishCommittedSceneResource: vi.fn(),
  resolveMaterialResourceKey: (id: string) =>
    `/api/v2/sessions/current/model/materials/${encodeURIComponent(id)}`,
  resolveObjectInteractionResourceKey: (objId: string, kind: string) =>
    `/api/v2/sessions/current/model/objects/${encodeURIComponent(objId)}/interactions/${kind}`,
  resolveSceneResourceRevision: (scene: { scene_revision?: number; revision?: number } | null) =>
    scene?.scene_revision ?? scene?.revision ?? null,
  useSceneResource: () => ({
    data: mocks.sceneData,
    status: "ready",
    error: null,
    refetch: vi.fn(),
  }),
  useModelCouplingsResource: () => ({
    data: mocks.couplingsData,
    status: "ready",
    refetch: vi.fn(),
  }),
  useObjectInteractionResource: () => ({
    data: mocks.objectInteractionData,
    status: "ready",
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/physicsGraphResources", () => ({
  usePhysicsGraphResource: () => ({
    data: {
      schema_version: "physics_graph.v1",
      scene_revision: 44,
      modules: mocks.physicsGraphModules,
      edges: [],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  invalidateSpinAuthoringResources: vi.fn(),
  useSpinAuthoringGeometryResource: () => ({ data: mocks.sceneData, status: "ready", refetch: vi.fn() }),
  useCurrentTransportsResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          name: "ct-loop",
          model: "ohmic_poisson",
          domain: [{ object_id: "hm-pt" }],
          materials: [{ region: { object_id: "hm-pt" }, material: { sigma_Spm: 6.25e6 } }],
          boundaries: [],
          structured_current_closure: {
            closure_id: "ring-closure",
            source_cuts: [
              {
                source_cut_id: "cut-x0",
                circuit_id: "loop-1",
                drive_id: "drv-1",
                region: { object_id: "hm-pt" },
                plane: { axis: "x", offset_m: 0, normal: "+x" },
                potential_jump_V: 0.025,
              },
            ],
          },
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
  useSpinTransportsResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          id: "st-bilayer",
          mode: "steady",
          domain: [{ object_id: "hm-pt" }, { object_id: "layer-bot" }],
          materials: [
            {
              region: { object_id: "hm-pt" },
              material: {
                sigma_s_Spm: 2.5e5,
                lambda_sf_m: 3e-9,
                lambda_j_m: "disabled",
                lambda_phi_m: "disabled",
                polarization_p: 0,
                theta_sh: 0.08,
              },
            },
          ],
          boundaries: [],
          interfaces: [
            {
              interface_id: "iface-pt-py",
              kind: "mixing_conductance",
              normal_side: { object_id: "hm-pt" },
              ferromagnet_side: { object_id: "layer-bot" },
              normal_to_ferromagnet: [0, 0, 1],
              g_up_Spm2: 1e15,
              g_down_Spm2: 0.2e15,
              re_g_mix_Spm2: 0.55e15,
              im_g_mix_Spm2: 0.04e15,
            },
          ],
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
  useSpinInterfacesResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          owner_spin_transport_id: "st-bilayer",
          interface_id: "iface-pt-py",
          known: true,
          interface: {
            interface_id: "iface-pt-py",
            kind: "mixing_conductance",
            normal_side: { object_id: "hm-pt" },
            ferromagnet_side: { object_id: "layer-bot" },
            normal_to_ferromagnet: [0, 0, 1],
            g_up_Spm2: 1e15,
            g_down_Spm2: 0.2e15,
            re_g_mix_Spm2: 0.55e15,
            im_g_mix_Spm2: 0.04e15,
          },
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
  useSpinInterfaceMeshEvidenceResource: () => ({ data: null, status: "idle", error: null, refetch: vi.fn() }),
  useSpinTorquesResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          id: "sot-1",
          model: "prescribed_sot",
          target: { object_id: "layer-top" },
          damping_like_efficiency: 0.08,
          field_like_efficiency: 0.02,
          spin_polarization: [0, -1, 0],
          thickness_m: 1e-9,
          drive: { kind: "signed_scalar", current_density_Apm2: 1e11 },
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
  useOerstedFieldsResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          id: "oe-wire",
          model: "oersted_cylinder",
          current_A: 0.01,
          radius_m: 50e-9,
          axis_point_m: [0, 0, 0],
          axis_direction: [0, 0, 1],
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/fieldDriveResources", () => ({
  useFieldDrivesResource: () => ({
    data: {
      scene_revision: 44,
      items: [
        {
          id: "sinc-pulse-1",
          name: "Broadband Sinc Drive",
          enabled: true,
          amplitude: [0.005, 0, 0],
          amplitude_t: [0.005, 0, 0],
          target: { kind: "global" },
          spatial_profile: { kind: "uniform" },
          waveform: { kind: "sinc_pulse", cutoff_hz: 30e9, t0: 0.5e-9 },
        },
      ],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/maskAntennaResources", () => ({
  useMaskFieldDrivesResource: () => ({ data: { scene_revision: 44, items: [] }, status: "ready", refetch: vi.fn() }),
  useReadyAntennasResource: () => ({ data: { items: [] }, status: "ready", refetch: vi.fn() }),
}));

describe("Physics, Transport, Spin & FieldDrive Specs (Wave 4 Parity)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.discretization = "fem";
    mocks.physicsGraphModules = [];
    mocks.sceneData.study.rotated_interfacial_dmi = null;
    mocks.sceneData.study.exchange_enabled = true;
    mocks.deleteFieldDrive.mockClear();
    mocks.patchObjectInteraction.mockClear();
    mocks.patchMaterialAsset.mockClear();
    mocks.patchCoupling.mockClear();
    mocks.commitTransaction.mockClear();
    mocks.invalidate.mockClear();
    mocks.setSelection.mockClear();
    mocks.openDocs.mockClear();
  });

  it("wires exactly 31 distinct components and disjoint selectionKinds in MODEL_PHYSICS_ROUTES", () => {
    expect(MODEL_PHYSICS_ROUTES).toHaveLength(31);
    const ids = new Set(MODEL_PHYSICS_ROUTES.map((r) => r.id));
    const components = new Set(MODEL_PHYSICS_ROUTES.map((r) => r.component));
    expect(ids.size).toBe(31);
    expect(components.size).toBe(31);
  });

  it("preserves authored params on ObjectPhysics toggle, supports Present removal, blocks Magnetoelastic HTTP 400, and passes typed creation refs", async () => {
    const objPhysSel: Selection = {
      kind: "object.physics",
      label: "Physics",
      moduleSource: "explorer",
      nodeId: "model:object:layer-top:physics",
      objectId: "layer-top",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectPhysicsInspectorPanel selection={objPhysSel} />);
    expect(mounted.host.textContent).toContain("Cubic anisotropy");
    expect(mounted.host.textContent).toContain("Interfacial DMI");
    expect(mounted.host.textContent).toContain("Bulk DMI");
    // Magnetoelastic must be badged Deferred without an active Switch that triggers HTTP 400
    expect(
      findElements(
        mounted.host,
        (el) => el.getAttribute("aria-label") === "Toggle Magnetoelastic coupling",
      ),
    ).toHaveLength(0);

    // Toggling Uniaxial anisotropy switch MUST NOT pass `params: {}` (which wipes ku1/ku2/axis)
    const uniaxialSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Toggle Uniaxial anisotropy",
    );
    expect(uniaxialSwitch).not.toBeNull();
    await act(async () => {
      uniaxialSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.patchObjectInteraction).toHaveBeenCalledTimes(1);
    const [patchedObjId, patchedKind, patchBody] = mocks.patchObjectInteraction.mock.calls[0]!;
    expect(patchedObjId).toBe("layer-top");
    expect(patchedKind).toBe("uniaxial_anisotropy");
    expect(patchBody).not.toHaveProperty("params");
    expect(patchBody).toMatchObject({
      base_revision: 44,
      enabled: false,
      present: true,
    });
    // Must invalidate expanded object interaction resource key, NEVER literal template path
    expect(mocks.invalidate).toHaveBeenCalledWith(
      "/api/v2/sessions/current/model/objects/layer-top/interactions/uniaxial_anisotropy",
      45,
    );
    expect(mocks.invalidate).not.toHaveBeenCalledWith(MODEL_OBJECT_INTERACTION_PATH, 45);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_SCENE_PATH, 45);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_READINESS_PATH, 45);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_STUDY_PATH, 45);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_PHYSICS_GRAPH_PATH, 45);

    // Unchecking Present checkbox removes optional interaction (`present: false`)
    mocks.patchObjectInteraction.mockClear();
    const presentCheckbox = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Present Uniaxial anisotropy",
    );
    expect(presentCheckbox).not.toBeNull();
    await act(async () => {
      (presentCheckbox as unknown as { checked: boolean }).checked = false;
      presentCheckbox?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "layer-top",
      "uniaxial_anisotropy",
      expect.objectContaining({ present: false }),
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );

    // Clicking `+ Spin Transport` passes typed creation ref (`draft: true`), never `ref: null`
    const spinTransportCreateBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Spin Transport")),
    );
    expect(spinTransportCreateBtn).not.toBeNull();
    act(() => {
      spinTransportCreateBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "physics.spin-transport",
        objectId: "layer-top",
        ref: expect.objectContaining({
          draft: true,
          type: "spin-transport",
        }),
      }),
      "inspector",
    );
  });

  it("renders PhysicsModule Bk = 2*Ku1/Ms, 6 Voigt strains, Graph provenance, Help dialog, and blocks unknown module coercion", () => {
    expect(resolveCanonicalPhysicsModuleKind("custom_nonlocal_operator")).toBeNull();

    mocks.physicsGraphModules = [
      {
        id: "mod-uni-top",
        kind: "uniaxial_anisotropy",
        source_path: "objects[0].physics_stack[0]",
        activation: "active",
        capability: { status: "supported", lane: "fem" },
        depends_on: ["material:py"],
        applies_to: [{ kind: "object", object_id: "layer-top" }],
        presentation: { family: "anisotropy", title: "Uniaxial Anisotropy" },
      },
    ];

    mounted = mountWave4TestElement(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Uniaxial Anisotropy",
          moduleSource: "explorer",
          nodeId: "model:object:layer-top:physics:module:uniaxial_anisotropy",
          objectId: "layer-top",
          ref: {
            kind: "physics.module",
            nodeId: "model:object:layer-top:physics:module:uniaxial_anisotropy",
            physicsActivation: "active",
            physicsModuleId: "mod-uni-top",
            physicsModuleKind: "uniaxial_anisotropy",
            physicsScopeKind: "object",
            type: "physics-module",
          },
        }}
      />,
    );
    // Bk = 2 * 4.5e5 / 8e5 = 1.125 T
    expect(mounted.host.textContent).toContain("1.125 T");
    expect(mounted.host.textContent).toContain("objects[0].physics_stack[0]");
    expect(mounted.host.textContent).toContain("material:py");

    // Open Interaction help dialog -> Open in documentation
    const helpBtn = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        Boolean(el.textContent?.includes("Interaction help")),
    );
    expect(helpBtn).not.toBeNull();
    act(() => {
      helpBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const docsBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Open in documentation")),
    );
    expect(docsBtn).not.toBeNull();
    act(() => {
      docsBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.openDocs).toHaveBeenCalledWith(
      "physics/interactions/anisotropy/uniaxial.html",
    );

    // Magnetoelastic shows all 6 Voigt strains (including shear eyz, exz, exy)
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Magnetoelastic",
          moduleSource: "explorer",
          nodeId: "model:object:layer-top:physics:module:magnetoelastic",
          objectId: "layer-top",
          ref: {
            kind: "physics.module",
            nodeId: "model:object:layer-top:physics:module:magnetoelastic",
            physicsActivation: "inactive",
            physicsModuleId: "magnetoelastic",
            physicsModuleKind: "magnetoelastic",
            physicsScopeKind: "object",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("Prescribed shear strain ε_yz");
    expect(mounted.host.textContent).toContain("Prescribed shear strain ε_xz");
    expect(mounted.host.textContent).toContain("Prescribed shear strain ε_xy");

    // Unknown graph module kind renders read-only without coercing to Symmetric Exchange
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Custom Chiral",
          moduleSource: "explorer",
          nodeId: "model:physics:module:custom_chiral",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:module:custom_chiral",
            physicsActivation: "active",
            physicsModuleId: "mod-custom",
            physicsModuleKind: "custom_chiral",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("Physics Module (custom_chiral)");
    expect(mounted.host.textContent).not.toContain("Symmetric Exchange");
  });

  it("commits canonical study schema keys for Demag, Rotated Interfacial DMI, Thermal Noise, Periodic BC, and Global Exchange", async () => {
    mounted = mountWave4TestElement(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Demagnetization",
          moduleSource: "explorer",
          nodeId: "model:physics:demag",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:demag",
            physicsActivation: "active",
            physicsModuleId: "demag",
            physicsModuleKind: "demag",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("FEM/BEM Fredkin-Koehler (no airbox)");

    // Toggle global Demag switch -> Apply writes `demag_enabled` AND `demag_realization`
    const enableSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      enableSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 44,
        merge_patch: {
          study: {
            demag_enabled: false,
            demag_realization: "fredkin_koehler",
          },
        },
      },
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );

    // Rotated Interfacial DMI writes `study.rotated_interfacial_dmi: number`
    mocks.commitTransaction.mockClear();
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Rotated Interfacial DMI",
          moduleSource: "explorer",
          nodeId: "model:physics:rotated_interfacial_dmi",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:rotated_interfacial_dmi",
            physicsActivation: "inactive",
            physicsModuleId: "rotated_interfacial_dmi",
            physicsModuleKind: "rotated_interfacial_dmi",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    const rotSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      rotSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const rotApply = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      rotApply?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 44,
        merge_patch: {
          study: {
            rotated_interfacial_dmi: 0.003,
          },
        },
      },
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );

    // Thermal noise writes `study.thermal_noise: null` on disable (never temperature_k / thermal_seed)
    mocks.commitTransaction.mockClear();
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Thermal Noise",
          moduleSource: "explorer",
          nodeId: "model:physics:thermal_noise",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:thermal_noise",
            physicsActivation: "active",
            physicsModuleId: "thermal_noise",
            physicsModuleKind: "thermal_noise",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    const thermSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      thermSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const thermApply = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      thermApply?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 44,
        merge_patch: {
          study: {
            thermal_noise: null,
          },
        },
      },
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );

    // Periodic BC writes `study.pbc: null` on disable (never periodic_boundary_conditions)
    mocks.commitTransaction.mockClear();
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Periodic BC",
          moduleSource: "explorer",
          nodeId: "model:physics:periodic_bc",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:periodic_bc",
            physicsActivation: "active",
            physicsModuleId: "periodic_bc",
            physicsModuleKind: "periodic_bc",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    const pbcSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      pbcSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const pbcApply = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      pbcApply?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 44,
        merge_patch: {
          study: {
            pbc: null,
          },
        },
      },
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );

    // Global Exchange writes `study.exchange_enabled` (never empty `{}`)
    mocks.commitTransaction.mockClear();
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Exchange",
          moduleSource: "explorer",
          nodeId: "model:physics:exchange",
          objectId: null,
          ref: {
            kind: "physics.module",
            nodeId: "model:physics:exchange",
            physicsActivation: "active",
            physicsModuleId: "exchange",
            physicsModuleKind: "exchange",
            physicsScopeKind: "global",
            type: "physics-module",
          },
        }}
      />,
    );
    const exSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      exSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const exApply = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      exApply?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 44,
        merge_patch: {
          study: {
            exchange_enabled: false,
          },
        },
      },
      expect.objectContaining({ sessionScopeKey: expect.any(String) }),
    );
  });

  it("preserves coupling_kind='exchange', surface endpoints, parameters.scale, capability_policy, and mesh diagnostics", async () => {
    mounted = mountWave4TestElement(
      <CouplingInspectorPanel
        selection={{
          kind: "physics.coupling",
          label: "cpl-ex",
          moduleSource: "explorer",
          nodeId: "model:physics:couplings:cpl-ex",
          objectId: null,
          ref: {
            couplingId: "cpl-ex",
            kind: "physics.coupling",
            nodeId: "model:physics:couplings:cpl-ex",
            type: "physics-coupling",
          },
        }}
      />,
    );

    // Reads `coupling_kind: "exchange"` without resetting to RKKY, and shows diagnostics + blocker
    expect(mounted.host.textContent).toContain("Direct exchange");
    expect(mounted.host.textContent).toContain("Non-conformal interface mesh gap exceeds tolerance");
    expect(mounted.host.textContent).toContain("32 faces");
    expect(mounted.host.textContent).toContain("Matched top cap");

    // Toggle coupling enabled -> Apply preserves surface endpoints, scale=0.75, capability_policy='require_runtime'
    const activeSwitch = findElement(mounted.host, (el) => el.getAttribute("role") === "switch");
    act(() => {
      activeSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchCoupling).toHaveBeenCalledWith(
      "cpl-ex",
      {
        enabled: false,
        kind: "exchange",
        capability_policy: "require_runtime",
        source: { kind: "surface", object: "layer-top", selector: "+z" },
        target: { kind: "surface", object: "layer-bot", selector: "-z" },
        parameters: {
          kind: "exchange",
          mode: "explicit",
          inter_exchange: 8e-12,
          scale: 0.75,
        },
      },
      expect.objectContaining({ baseRevision: 44, sessionScopeKey: expect.any(String) }),
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      "/api/v2/sessions/current/model/couplings",
      45,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      "/api/v2/sessions/current/model/regions/diagnostics",
      45,
    );
  });

  it("renders split ChargeTransport/Closure/SourceCut and Spin/Oersted inspectors with ZERO raw <select> elements", () => {
    // Auto Hall polarization: n = +z, J = +x => n x J = +y
    expect(computeAutoHallPolarization([0, 0, 1], [1e11, 0, 0])).toEqual([0, 1, 0]);

    const views = [
      <CurrentTransportInspectorPanel
        key="ct"
        selection={{
          kind: "physics.current-transport",
          label: "ct-loop",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:ct-loop",
          objectId: null,
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.current-transport",
            nodeId: "model:physics:ct:ct-loop",
            type: "current-transport",
          },
        }}
      />,
      <StructuredCurrentClosureInspectorPanel
        key="closure"
        selection={{
          kind: "physics.structured-current-closure",
          label: "ring-closure",
          moduleSource: "explorer",
          nodeId: "model:physics:closure",
          objectId: null,
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-closure",
            nodeId: "model:physics:closure",
            structuredCurrentClosureId: "ring-closure",
            type: "structured-current-closure",
          },
        }}
      />,
      <StructuredCurrentSourceCutInspectorPanel
        key="cut"
        selection={{
          kind: "physics.structured-current-source-cut",
          label: "cut-x0",
          moduleSource: "explorer",
          nodeId: "model:physics:cut",
          objectId: null,
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-source-cut",
            nodeId: "model:physics:cut",
            structuredCurrentClosureId: "ring-closure",
            structuredCurrentSourceCutId: "cut-x0",
            type: "structured-current-source-cut",
          },
        }}
      />,
      <SpinTransportInspectorPanel
        key="st"
        selection={{
          kind: "physics.spin-transport",
          label: "st-bilayer",
          moduleSource: "explorer",
          nodeId: "model:physics:st:st-bilayer",
          objectId: null,
          ref: {
            kind: "physics.spin-transport",
            nodeId: "model:physics:st:st-bilayer",
            spinTransportId: "st-bilayer",
            type: "spin-transport",
          },
        }}
      />,
      <SpinInterfaceInspectorPanel
        key="si"
        selection={{
          kind: "physics.spin-interface",
          label: "iface-pt-py",
          moduleSource: "explorer",
          nodeId: "model:physics:si:iface-pt-py",
          objectId: null,
          ref: {
            kind: "physics.spin-interface",
            nodeId: "model:physics:si:iface-pt-py",
            spinInterfaceId: "iface-pt-py",
            spinInterfaceOwnerId: "st-bilayer",
            type: "spin-interface",
          },
        }}
      />,
      <SpinTorqueInspectorPanel
        key="torque"
        selection={{
          kind: "physics.spin-torque",
          label: "sot-1",
          moduleSource: "explorer",
          nodeId: "model:physics:torque:sot-1",
          objectId: null,
          ref: {
            kind: "physics.spin-torque",
            nodeId: "model:physics:torque:sot-1",
            spinTorqueId: "sot-1",
            type: "spin-torque",
          },
        }}
      />,
      <OerstedFieldInspectorPanel
        key="oe"
        selection={{
          kind: "physics.oersted-field",
          label: "oe-wire",
          moduleSource: "explorer",
          nodeId: "model:physics:oe:oe-wire",
          objectId: null,
          ref: {
            kind: "physics.oersted-field",
            nodeId: "model:physics:oe:oe-wire",
            oerstedFieldId: "oe-wire",
            type: "oersted-field",
          },
        }}
      />,
    ];

    mounted = mountWave4TestElement(views[0]!);
    for (const view of views) {
      mounted.rerender(view);
      expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
      expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);
    }
  });

  it("renders FieldDriveInspectorPanel with ScientificEChart B(t) preview, Nyquist notice, and Delete Field Drive AlertDialog", async () => {
    expect(
      evaluateFieldDriveEnvelopeAtTime(
        {
          waveformKind: "sinc_pulse",
          cutoffFreqHz: 20e9,
          carrierFreqHz: 10e9,
          chirpStopFreqHz: 25e9,
          timeCenterS: 0.5e-9,
          pulseSigmaS: 0.1e-9,
          phaseRad: 0,
          piecewisePoints: [],
        },
        0.5e-9,
      ),
    ).toBeCloseTo(1, 9);

    mounted = mountWave4TestElement(
      <FieldDriveInspectorPanel
        selection={{
          kind: "physics.field-drive",
          label: "Broadband Sinc Drive",
          moduleSource: "explorer",
          nodeId: "model:physics:field-drives:sinc-pulse-1",
          objectId: null,
          ref: {
            fieldDriveId: "sinc-pulse-1",
            kind: "physics.field-drive",
            nodeId: "model:physics:field-drives:sinc-pulse-1",
            type: "physics-field-drive",
          },
        }}
      />,
    );

    expect(
      findElement(mounted.host, (el) => el.getAttribute("data-slot") === "mock-scientific-echart"),
    ).not.toBeNull();
    // 30 GHz > 25 GHz Nyquist warning
    expect(mounted.host.textContent).toContain("Nyquist");

    // Click Delete Field Drive menu item -> opens AlertDialog -> Confirm deletes & navigates to physics.field-drives
    const deleteMenuBtn = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        Boolean(el.textContent?.includes("Delete")),
    );
    expect(deleteMenuBtn).not.toBeNull();
    act(() => {
      deleteMenuBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const dialogRoot = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("data-slot") === "mock-dialog-root" ||
        el.getAttribute("data-slot") === "mock-alert-dialog",
    );
    const confirmBtn = findElement(
      dialogRoot,
      (el) =>
        el.getAttribute("data-slot") === "confirm-delete-action" ||
        (el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Delete"))),
    );
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.deleteFieldDrive).toHaveBeenCalled();
    expect(mocks.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "physics.field-drives" }),
      "inspector",
    );
  });
});
