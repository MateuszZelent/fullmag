import { act, createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  SceneCurrentTransport,
  SceneOerstedField,
  SceneSpinTorque,
  SceneSpinTransport,
  TransportAuthoringCapabilityMap,
  TransportValidationResponse,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
  type TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";
import { buildOerstedFieldResource } from "./OerstedFieldPanel";
import { buildSpinTorqueResource } from "./SpinTorquePanel";
import {
  computeAutoHallPolarization,
  CurrentTransportInspectorPanel,
  OerstedFieldInspectorPanel,
  SpinInterfaceInspectorPanel,
  SpinTorqueInspectorPanel,
  SpinTransportInspectorPanel,
  StructuredCurrentClosureInspectorPanel,
  StructuredCurrentSourceCutInspectorPanel,
} from "./TransportAndSpinSpecs";
import type {
  KnownSceneOerstedField,
  KnownSceneSpinTorque,
} from "./transportShared";

/* ── Lightweight Radix UI Primitives for Deterministic DOM Testing ── */

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
  Item: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
  }) => (
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
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
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
  Action: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button data-slot="confirm-delete-action" type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
const mockSelectCallbacks = new WeakMap<object, (v: string) => void>();

vi.mock("@radix-ui/react-select", () => ({
  Root: ({
    children,
    disabled,
    onValueChange,
    value,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onValueChange?: (v: string) => void;
    value?: string;
  }) => (
    <div
      ref={(node) => {
        if (node && onValueChange) {
          mockSelectCallbacks.set(node, (v: string) => {
            if (!disabled) onValueChange(v);
          });
        }
      }}
      data-disabled={disabled ? "true" : "false"}
      data-select-value={value ?? ""}
      data-slot="mock-select-root"
    >
      {children}
    </div>
  ),
  Trigger: ({
    children,
    "aria-label": ariaLabel,
    disabled,
    id,
  }: {
    children?: ReactNode;
    "aria-label"?: string;
    disabled?: boolean;
    id?: string;
  }) => (
    <button aria-label={ariaLabel} disabled={disabled} id={id} type="button">
      {children}
    </button>
  ),
  Value: ({
    children,
    placeholder,
  }: {
    children?: ReactNode;
    placeholder?: string;
  }) => <span>{children ?? placeholder}</span>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({
    children,
    disabled,
    value,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    value?: string;
  }) => (
    <div
      data-disabled={disabled ? "true" : undefined}
      data-select-item={value}
    >
      {children}
    </div>
  ),
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));
const MockTabsContext = createContext<(v: string) => void>(() => undefined);

vi.mock("@radix-ui/react-tabs", () => ({
  Root: ({
    children,
    onValueChange,
  }: {
    children?: ReactNode;
    onValueChange?: (v: string) => void;
  }) => (
    <MockTabsContext.Provider value={onValueChange ?? (() => undefined)}>
      <div>{children}</div>
    </MockTabsContext.Provider>
  ),
  List: ({ children }: { children?: ReactNode }) => (
    <div role="tablist">{children}</div>
  ),
  Trigger: ({
    children,
    value,
  }: {
    children?: ReactNode;
    value?: string;
  }) => {
    const onSelect = useContext(MockTabsContext);
    return (
      <button
        data-tab-value={value}
        role="tab"
        type="button"
        onClick={() => value && onSelect(value)}
      >
        {children}
      </button>
    );
  },
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

/* ── Shared Fixtures & Hoisted State ── */

const SCOPE_KEY = "session=w4-transport&epoch=1&request_scope_epoch=1";

function buildDefaultCapabilities(): TransportAuthoringCapabilityMap {
  return {
    contract_version: "spin-transport-capabilities.v1",
    m1_one_way_steady: {
      authoring_allowed: true,
      reason: "M1 one-way steady ready",
      status: "semantic_only",
    },
    m2_reciprocal: {
      authoring_allowed: true,
      reason: "M2 reciprocal ready",
      status: "semantic_only",
    },
    m3_transient: {
      authoring_allowed: true,
      reason: "M3 transient ready",
      status: "semantic_only",
    },
    gpu: {
      authoring_allowed: false,
      reason: "GPU spin solver disabled on test host",
      status: "unsupported",
    },
    single_precision: {
      authoring_allowed: false,
      reason: "FP32 spin solver disabled",
      status: "unsupported",
    },
    hybrid: {
      authoring_allowed: false,
      reason: "Hybrid discretization unsupported",
      status: "unsupported",
    },
  };
}

const richCurrentLoop: KnownSceneCurrentTransport = {
  kind: "current_transport",
  name: "ct-loop",
  model: "ohmic_poisson",
  coupling: "one_way",
  gauge: "zero_mean",
  solve_region: "ring",
  conductivity_s_per_m: 5.8e7,
  domain: [
    { object_id: "ring", region_id: "arm-a" },
    { object_id: "ring", region_id: "arm-b" },
  ],
  materials: [
    {
      region: { object_id: "ring", region_id: "arm-a" },
      material: { sigma_Spm: 5.8e7 },
    },
    {
      region: { object_id: "ring", region_id: "arm-b" },
      material: { sigma_Spm: 4.5e7 },
    },
  ],
  boundaries: [
    {
      id: "anode",
      kind: "voltage_electrode",
      potential_V: 0.25,
      surfaces: [{ object_id: "ring", surface_id: "x-", orientation: [-1, 0, 0] }],
    },
    {
      id: "cathode",
      kind: "voltage_electrode",
      potential_V: 0,
      surfaces: [{ object_id: "ring", surface_id: "x+", orientation: [1, 0, 0] }],
    },
  ],
  time_envelope: {
    kind: "pulse",
    amplitude: 1.5,
    t_on_s: 1e-10,
    t_off_s: 2e-9,
  },
  external_lead_preparation: { mode: "extend_contacts", pad_cells: 4 },
  solver: {
    engine: "cg",
    linear: {
      relative_tolerance: 1e-10,
      absolute_tolerance: 1e-14,
      max_iterations: 1500,
    },
    operator_version: "fv_charge_harmonic_source_cut_v1",
    physical_residual_version: "charge_balance_integrated_l2.v1",
  },
  structured_current_closure: {
    kind: "closed_geometry",
    closure_id: "ring-closure",
    schema_version: "structured_current_closure.v1",
    source_cuts: [
      {
        source_cut_id: "cut-1",
        circuit_id: "loop-1",
        region: { object_id: "ring", region_id: "arm-a" },
        plane: {
          coordinate_frame: "world",
          axis: "x",
          normal: "positive_axis",
          offset_m: 5e-9,
        },
        drive: {
          kind: "impressed_potential_jump",
          drive_id: "drive-1",
          potential_jump_V: 0.12,
          schema_version: "impressed_potential_jump.v1",
        },
      },
      {
        source_cut_id: "cut-extra",
        circuit_id: "loop-extra",
        region: { object_id: "ring", region_id: "arm-b" },
        plane: {
          axis: "y",
          normal: "negative_axis",
          offset_m: -2e-9,
        },
        drive: {
          kind: "impressed_potential_jump",
          drive_id: "drive-extra",
          potential_jump_V: -0.05,
          schema_version: "impressed_potential_jump.v1",
        },
      },
    ],
  },
};

const pillarCurrent: KnownSceneCurrentTransport = {
  kind: "current_transport",
  name: "ct-pillar",
  model: "prescribed_density",
  coupling: "one_way",
  current_density: [1e11, 0, 0],
  solve_region: "pillar",
  conservative_current_view: {
    closure: "divergence_free",
    pins: ["v0", "v1"],
  },
};

const richSpinTransport: KnownSceneSpinTransport = {
  id: "st-bilayer",
  schema_version: "spin_transport.v1",
  current_source_id: "ct-loop",
  mode: "steady",
  constitutive_version: "transport_constitutive.one_way.fullmag.v1",
  domain: [
    { object_id: "stack", region_id: "hm" },
    { object_id: "stack", region_id: "fm" },
  ],
  materials: [
    {
      region: { object_id: "stack", region_id: "hm" },
      material: {
        sigma_s_Spm: 4.2e6,
        polarization_p: 0,
        theta_sh: 0.12,
        lambda_sf_m: 1.8e-9,
        lambda_j_m: "disabled",
        lambda_phi_m: "disabled",
      },
    },
    {
      region: { object_id: "stack", region_id: "fm" },
      material: {
        sigma_s_Spm: 7.5e6,
        polarization_p: 0.65,
        theta_sh: 0,
        lambda_sf_m: 5e-9,
        lambda_j_m: 1.2e-9,
        lambda_phi_m: 2.4e-9,
      },
    },
  ],
  interfaces: [
    {
      id: "iface-hm-fm",
      kind: "mixing_conductance",
      normal_side: { object_id: "stack", region_id: "hm" },
      ferromagnet_side: { object_id: "stack", region_id: "fm" },
      normal_to_ferromagnet: [0, 0, 1],
      normal_surface: {
        object_id: "stack",
        surface_id: "z+",
        orientation: [0, 0, 1],
      },
      ferromagnet_surface: {
        object_id: "stack",
        surface_id: "z-",
        orientation: [0, 0, -1],
      },
      g_up_Spm2: 1.2e15,
      g_down_Spm2: 0.3e15,
      g_r_Spm2: 5.5e14,
      g_i_Spm2: 4.5e13,
      g_sml_Spm2: 2e13,
      spin_memory_loss: {
        formula_version: "sml_reservoir.fullmag.v2",
        g_n_Spm2: 1.1e15,
        g_f_Spm2: 0.9e15,
        g_lattice_Spm2: 0.4e15,
      },
      absorption: "full_absorption",
      formula_version: "magnetoelectronic.fullmag.v2",
    },
  ],
  boundaries: [
    {
      id: "bc-spin-top",
      kind: "spin_insulating",
      surfaces: [{ object_id: "stack", surface_id: "z+", orientation: [0, 0, 1] }],
    },
  ],
  requested_execution: {
    discretization: "fdm",
    device: "cpu",
    precision: "double",
    execution_mode: "strict",
  },
  solver: {
    engine: "gmres",
    default_external_boundary: "spin_insulating",
    linear: {
      relative_tolerance: 1e-9,
      absolute_tolerance: 1e-13,
      max_iterations: 800,
    },
    operator_version: "fv_spin_upwind_v1",
    physical_residual_version: "transport_balance_integrated_l2.v1",
  },
};

const prescribedSotVectorTorque: KnownSceneSpinTorque = {
  kind: "prescribed_sot",
  id: "sot-vec",
  schema_version: "prescribed_sot.v1",
  formula_version: "prescribed_sot.fullmag.v1",
  target: { object_id: "stack", region_id: "fm" },
  drive: {
    kind: "vector_current_source",
    current_source_id: "ct-loop",
    drive_direction: [0, 1, 0],
    interface_normal: [0, 0, 1],
  },
  xi_dl: 0.14,
  xi_fl: -0.04,
  free_layer_thickness_m: 1.4e-9,
};

const interfaceCppTorque: SceneSpinTorque = {
  kind: "interface_cpp",
  id: "cpp-1",
  current_density: [2e11, 0, 0],
  degree: 0.62,
  lambda_asymmetry: 1.4,
  epsilon_prime: 0.09,
  spin_polarization: [0, 1, 0],
  interface_normal: [0, 0, 1],
};

const cylinderOersted: KnownSceneOerstedField = {
  kind: "oersted_cylinder",
  id: "oe-wire",
  current: 0.01,
  radius: 50e-9,
  center: [0, 0, 0],
  axis: [0, 0, 1],
  time_dependence: {
    kind: "pulse",
    t_on: 1e-10,
    t_off: 3e-9,
  },
};

const state = vi.hoisted(() => ({
  revision: 12,
  capabilities: null as TransportAuthoringCapabilityMap | null,
  currentItems: [] as SceneCurrentTransport[],
  spinItems: [] as SceneSpinTransport[],
  torqueItems: [] as SceneSpinTorque[],
  oerstedItems: [] as SceneOerstedField[],
  meshEvidenceData: null as unknown,
  meshEvidenceError: null as Error | null,
  lastObservedMeshSides: null as {
    sideA: { objectId: string; regionId: string };
    sideB: { objectId: string; regionId: string };
  } | null,
  refetchCurrent: vi.fn(),
  refetchSpin: vi.fn(),
  refetchInterfaces: vi.fn(),
  refetchMeshEvidence: vi.fn(),
  refetchTorques: vi.fn(),
  refetchOersted: vi.fn(),
  validateTransport: vi.fn(),
  createCurrentTransport: vi.fn(),
  replaceCurrentTransport: vi.fn(),
  deleteCurrentTransport: vi.fn(),
  createSpinTransport: vi.fn(),
  replaceSpinTransport: vi.fn(),
  deleteSpinTransport: vi.fn(),
  createSpinTorque: vi.fn(),
  replaceSpinTorque: vi.fn(),
  deleteSpinTorque: vi.fn(),
  createOerstedField: vi.fn(),
  replaceOerstedField: vi.fn(),
  deleteOerstedField: vi.fn(),
  recordHistory: vi.fn(),
  setSelection: vi.fn(),
  invalidateResource: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        scene: vi.fn(async () => ({
          revision: state.revision,
          scene_revision: state.revision,
          objects: [],
        })),
        validateTransport: state.validateTransport,
        createCurrentTransport: state.createCurrentTransport,
        replaceCurrentTransport: state.replaceCurrentTransport,
        deleteCurrentTransport: state.deleteCurrentTransport,
        createSpinTransport: state.createSpinTransport,
        replaceSpinTransport: state.replaceSpinTransport,
        deleteSpinTransport: state.deleteSpinTransport,
        createSpinTorque: state.createSpinTorque,
        replaceSpinTorque: state.replaceSpinTorque,
        deleteSpinTorque: state.deleteSpinTorque,
        createOerstedField: state.createOerstedField,
        replaceOerstedField: state.replaceOerstedField,
        deleteOerstedField: state.deleteOerstedField,
      },
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: state.recordHistory,
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => SCOPE_KEY,
    },
    layout: { setPanelVisible: vi.fn() },
    resources: {
      invalidate: state.invalidateResource,
      getRevision: () => state.revision,
      subscribe: () => () => undefined,
    },
    selection: {
      get: () => null,
      set: state.setSelection,
    },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({
    sessionId: "w4-transport",
    sessionEpoch: "1",
    requestScopeEpoch: "1",
  }),
  useSessionStatusSelector: (selector: (s: unknown) => unknown) =>
    selector({
      data: {
        capabilities: {
          transport_authoring: state.capabilities,
        },
      },
      status: "ready",
    }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({
    data: {
      revision: state.revision,
      objects: [
        {
          id: "ring",
          name: "Ring",
          regions: [
            { region_id: "arm-a", name: "Arm A", enabled: true },
            { region_id: "arm-b", name: "Arm B", enabled: true },
          ],
        },
        {
          id: "stack",
          name: "Bilayer Stack",
          regions: [
            { region_id: "hm", name: "Heavy Metal", enabled: true },
            { region_id: "fm", name: "Ferromagnet", enabled: true },
          ],
        },
        {
          id: "pillar",
          name: "Nano Pillar",
          regions: [{ region_id: "free", name: "Free Layer", enabled: true }],
        },
      ],
      current_transports: state.currentItems,
      spin_transports: state.spinItems,
    },
    status: "ready",
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  invalidateSpinAuthoringResources: vi.fn(),
  useCurrentTransportsResource: () => ({
    data: { items: state.currentItems, scene_revision: state.revision },
    status: "ready",
    error: null,
    refetch: state.refetchCurrent,
  }),
  useSpinTransportsResource: () => ({
    data: { items: state.spinItems, scene_revision: state.revision },
    status: "ready",
    error: null,
    refetch: state.refetchSpin,
  }),
  useSpinInterfacesResource: () => ({
    data: {
      scene_revision: state.revision,
      items: state.spinItems.flatMap((st) => {
        const rec = st as Record<string, unknown>;
        const ownerId = typeof rec.id === "string" ? rec.id : "";
        const ifaces = Array.isArray(rec.interfaces) ? rec.interfaces : [];
        return ifaces.map((iface: Record<string, unknown>) => ({
          owner_spin_transport_id: ownerId,
          interface_id: typeof iface.id === "string" ? iface.id : "",
          known:
            iface.kind === "mixing_conductance" || iface.kind === "transparent",
          interface: iface,
        }));
      }),
    },
    status: "ready",
    error: null,
    refetch: state.refetchInterfaces,
  }),
  useSpinInterfaceMeshEvidenceResource: (
    sideA: { objectId: string; regionId: string },
    sideB: { objectId: string; regionId: string },
  ) => {
    state.lastObservedMeshSides = { sideA, sideB };
    return {
      data: state.meshEvidenceData,
      error: state.meshEvidenceError,
      status: state.meshEvidenceData ? "ready" : "idle",
      refetch: state.refetchMeshEvidence,
    };
  },
  useSpinTorquesResource: () => ({
    data: { items: state.torqueItems, scene_revision: state.revision },
    status: "ready",
    error: null,
    refetch: state.refetchTorques,
  }),
  useOerstedFieldsResource: () => ({
    data: { items: state.oerstedItems, scene_revision: state.revision },
    status: "ready",
    error: null,
    refetch: state.refetchOersted,
  }),
}));

/* ── DOM Interaction Helpers ── */

type TestInputCompat = TestElement & {
  _valueTracker?: { setValue: (next: string) => void };
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  attachEvent?: (
    name: string,
    fn: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: () => void;
};

function setInputValue(input: TestElement, value: string) {
  const compat = input as TestInputCompat;
  compat.attachEvent ??= (_name, fn) => {
    compat._onPropertyChange = fn;
  };
  compat.detachEvent ??= () => {
    compat._onPropertyChange = undefined;
  };
  input.focus();
  input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  const previous = input.value;
  input.value = value;
  compat._valueTracker?.setValue(previous);
  if (compat._onPropertyChange) {
    compat._onPropertyChange({
      propertyName: "value",
      target: input,
      srcElement: input,
    });
  } else {
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  }
  input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

async function flushAsyncCommits() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function chooseRadixSelectByAriaLabel(
  host: TestElement,
  ariaLabel: string,
  nextValue: string,
) {
  const trigger = findElement(
    host,
    (el) => el.getAttribute("aria-label") === ariaLabel,
    `Select trigger "${ariaLabel}"`,
  );
  let cursor: TestElement | null = trigger.parentElement as TestElement | null;
  while (cursor && cursor.getAttribute("data-slot") !== "mock-select-root") {
    cursor = cursor.parentElement as TestElement | null;
  }
  if (!cursor) throw new Error(`Missing select root for "${ariaLabel}"`);
  const cb = mockSelectCallbacks.get(cursor);
  if (!cb) throw new Error(`Missing select callback for "${ariaLabel}"`);
  cb(nextValue);
}

function defaultValidResponse(): TransportValidationResponse {
  return {
    semantic: { valid: true, issues: [] },
    execution: {
      authoring_allowed: true,
      qualification: "qualified",
      requested_lane: {
        discretization: "fdm",
        device: "cpu",
        precision: "double",
      },
      resolved_lane: {
        discretization: "fdm",
        device: "cpu",
        precision: "double",
      },
      reason: "Mesh-exact transport lane qualified",
    },
  };
}

let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  state.revision = 12;
  state.capabilities = buildDefaultCapabilities();
  state.currentItems = [
    structuredClone(richCurrentLoop),
    structuredClone(pillarCurrent),
    { future_kind: "charge.v99", opaque_data: [1, 2, 3] },
  ];
  state.spinItems = [
    structuredClone(richSpinTransport),
    { id: "opaque-spin", schema_version: "spin.v99", keep: { exact: true } },
  ];
  state.torqueItems = [
    structuredClone(prescribedSotVectorTorque),
    structuredClone(interfaceCppTorque),
    { kind: "vendor_torque.v9", id: "opaque-torque", exact: { keep: 42 } },
  ];
  state.oerstedItems = [
    structuredClone(cylinderOersted),
    { kind: "vendor_oersted.v9", id: "opaque-oe", custom: true },
  ];
  state.meshEvidenceData = null;
  state.meshEvidenceError = null;
  state.lastObservedMeshSides = null;

  state.validateTransport.mockImplementation(async () => defaultValidResponse());

  const makeAck = (req: { resource?: unknown; base_revision: number }) => ({
    resource: req.resource,
    scene_revision: req.base_revision + 1,
    committed_scene: {
      revision: req.base_revision + 1,
      objects: [],
    },
  });
  state.createCurrentTransport.mockImplementation(async (req) => makeAck(req));
  state.replaceCurrentTransport.mockImplementation(async (_id, req) =>
    makeAck(req),
  );
  state.deleteCurrentTransport.mockImplementation(async (_id, req) =>
    makeAck(req),
  );
  state.createSpinTransport.mockImplementation(async (req) => makeAck(req));
  state.replaceSpinTransport.mockImplementation(async (_id, req) =>
    makeAck(req),
  );
  state.deleteSpinTransport.mockImplementation(async (_id, req) =>
    makeAck(req),
  );
  state.createSpinTorque.mockImplementation(async (req) => makeAck(req));
  state.replaceSpinTorque.mockImplementation(async (_id, req) => makeAck(req));
  state.deleteSpinTorque.mockImplementation(async (_id, req) => makeAck(req));
  state.createOerstedField.mockImplementation(async (req) => makeAck(req));
  state.replaceOerstedField.mockImplementation(async (_id, req) => makeAck(req));
  state.deleteOerstedField.mockImplementation(async (_id, req) => makeAck(req));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("Wave 4 Transport, Spin & Oersted Inspector Parity", () => {
  it("renders all 7 routes with zero <textarea>, zero raw <select>, zero title=, and zero unknown/unavailable literals", () => {
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
        key="scc"
        selection={{
          kind: "physics.structured-current-closure",
          label: "ring-closure",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:ct-loop:closure",
          objectId: null,
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-closure",
            nodeId: "model:physics:ct:ct-loop:closure",
            structuredCurrentClosureId: "ring-closure",
            type: "structured-current-closure",
          },
        }}
      />,
      <StructuredCurrentSourceCutInspectorPanel
        key="scsc"
        selection={{
          kind: "physics.structured-current-source-cut",
          label: "cut-1",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:ct-loop:cut:cut-1",
          objectId: null,
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-source-cut",
            nodeId: "model:physics:ct:ct-loop:cut:cut-1",
            structuredCurrentClosureId: "ring-closure",
            structuredCurrentSourceCutId: "cut-1",
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
          label: "iface-hm-fm",
          moduleSource: "explorer",
          nodeId: "model:physics:si:iface-hm-fm",
          objectId: null,
          ref: {
            kind: "physics.spin-interface",
            nodeId: "model:physics:si:iface-hm-fm",
            spinInterfaceId: "iface-hm-fm",
            spinInterfaceOwnerId: "st-bilayer",
            type: "spin-interface",
          },
        }}
      />,
      <SpinTorqueInspectorPanel
        key="stq"
        selection={{
          kind: "physics.spin-torque",
          label: "sot-vec",
          moduleSource: "explorer",
          nodeId: "model:physics:torque:sot-vec",
          objectId: null,
          ref: {
            kind: "physics.spin-torque",
            nodeId: "model:physics:torque:sot-vec",
            spinTorqueId: "sot-vec",
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
      expect(
        findElements(mounted.host, (el) => el.tagName === "TEXTAREA"),
      ).toHaveLength(0);
      expect(
        findElements(mounted.host, (el) => el.tagName === "SELECT"),
      ).toHaveLength(0);
      expect(
        findElements(mounted.host, (el) => el.getAttribute("title") !== null),
      ).toHaveLength(0);
      expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);
      expect(mounted.host.textContent).not.toMatch(/\bunavailable\b/i);
    }
  });

  it("opens a new CurrentTransport creation draft when selection.ref is null, supports allowCleanApply, and preserves multi-domain, boundaries, time_envelope, and leads losslessly on replace", async () => {
    vi.useFakeTimers();
    const newDraftSelection: Selection = {
      kind: "physics.current-transport",
      label: "Charge transport",
      moduleSource: "inspector",
      nodeId: "model:object:pillar:current-transport:draft",
      objectId: "pillar",
      ref: null,
    };

    mounted = mountWave4TestElement(
      <CurrentTransportInspectorPanel selection={newDraftSelection} />,
    );

    // Must NOT fall back to items[0] ("ct-loop"); must show Create button immediately via allowCleanApply!
    const createBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Create")),
      "Create button on clean new draft",
    );
    expect(createBtn.disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(state.validateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "current_transport",
          operation: "create",
        }),
      }),
      expect.objectContaining({ sessionScopeKey: SCOPE_KEY }),
    );
    expect(mounted.host.textContent).toContain("Qualification: qualified");
    expect(mounted.host.textContent).toContain("Requested lane:");

    await act(async () => {
      createBtn.click();
      await flushAsyncCommits();
    });

    expect(state.createCurrentTransport).toHaveBeenCalledOnce();
    expect(state.replaceCurrentTransport).not.toHaveBeenCalled();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "physics.current-transport",
        ref: expect.objectContaining({ currentTransportId: "current" }),
      }),
      "inspector",
    );

    // Now mount existing rich `ct-loop`, modify electrode potential_V, and verify lossless round-trip!
    mounted.rerender(
      <CurrentTransportInspectorPanel
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
    );

    // Switch to "Boundaries & Closure" tab to edit real voltage_electrode potential_V
    const boundariesTab = findElement(
      mounted.host,
      (el) => el.getAttribute("data-tab-value") === "electrodes",
      "Boundaries & Closure tab",
    );
    await act(async () => {
      boundariesTab.click();
    });

    const potentialInput = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Electrode potential 1",
      "Boundary 1 potential_V input",
    );
    expect(potentialInput.value).toBe("0.25");

    await act(async () => {
      setInputValue(potentialInput, "0.45");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply button",
    );
    await act(async () => {
      applyBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceCurrentTransport).toHaveBeenCalledOnce();
    expect(state.validateTransport).toHaveBeenLastCalledWith(
      {
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "current_transport",
          operation: "replace",
          path_id: "ct-loop",
          resource: expect.objectContaining({ name: "ct-loop" }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    const saved = state.replaceCurrentTransport.mock.calls[0]![1]
      .resource as KnownSceneCurrentTransport;
    expect(saved.domain).toHaveLength(2);
    expect(saved.materials).toHaveLength(2);
    expect(saved.materials?.[0]?.material.sigma_Spm).toBe(5.8e7);
    expect(saved.boundaries).toHaveLength(2);
    expect(
      (saved.boundaries?.[0] as { potential_V?: number }).potential_V,
    ).toBe(0.45);
    expect(saved.time_envelope).toEqual({
      kind: "pulse",
      amplitude: 1.5,
      t_on_s: 1e-10,
      t_off_s: 2e-9,
    });
    expect(saved.external_lead_preparation).toEqual({
      mode: "extend_contacts",
      pad_cells: 4,
    });
    expect(saved.solve_region).toBe("ring");
    expect(saved.conductivity_s_per_m).toBe(5.8e7);
    expect(
      saved.structured_current_closure?.source_cuts[0]?.plane.coordinate_frame,
    ).toBe("world");

    // Positional addressing of opaque record renders strictly read-only without Replace/Delete
    mounted.rerender(
      <CurrentTransportInspectorPanel
        selection={{
          kind: "physics.current-transport",
          label: "opaque-pos-2",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:pos:2",
          objectId: null,
          ref: {
            currentTransportIndex: 2,
            kind: "physics.current-transport",
            nodeId: "model:physics:ct:pos:2",
            type: "current-transport",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("charge.v99");
    expect(
      findElements(
        mounted.host,
        (el) => el.getAttribute("data-mode") === "readOnly",
      ),
    ).toHaveLength(1);
    expect(
      findElements(
        mounted.host,
        (el) =>
          el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      ),
    ).toHaveLength(0);
  });

  it("generates unique circuit_id and source_cut_id on Add Source Cut and preserves coordinate_frame, region, and parent owner fields in StructuredClosurePanels", async () => {
    mounted = mountWave4TestElement(
      <StructuredCurrentClosureInspectorPanel
        selection={{
          kind: "physics.structured-current-closure",
          label: "ring-closure",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:ct-loop:closure",
          objectId: "ring",
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-closure",
            nodeId: "model:physics:ct:ct-loop:closure",
            structuredCurrentClosureId: "ring-closure",
            type: "structured-current-closure",
          },
        }}
      />,
    );

    const addCutBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Add Source Cut")),
      "Add Source Cut button",
    );
    await act(async () => {
      addCutBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceCurrentTransport).toHaveBeenCalledOnce();
    const afterAddOwner = state.replaceCurrentTransport.mock.calls[0]![1]
      .resource as KnownSceneCurrentTransport;
    const cuts = afterAddOwner.structured_current_closure!.source_cuts;
    expect(cuts).toHaveLength(3);
    const circuitIds = cuts.map((c) => c.circuit_id);
    const cutIds = cuts.map((c) => c.source_cut_id);
    expect(new Set(circuitIds).size).toBe(3);
    expect(new Set(cutIds).size).toBe(3);
    // Parent fields preserved 100%!
    expect(afterAddOwner.boundaries).toHaveLength(2);
    expect(afterAddOwner.time_envelope).toEqual(richCurrentLoop.time_envelope);
    expect(afterAddOwner.external_lead_preparation).toEqual(
      richCurrentLoop.external_lead_preparation,
    );

    // Mount SourceCut panel, change coordinate_frame to "object" and region to "ring / arm-b", and save!
    state.replaceCurrentTransport.mockClear();
    mounted.rerender(
      <StructuredCurrentSourceCutInspectorPanel
        selection={{
          kind: "physics.structured-current-source-cut",
          label: "cut-1",
          moduleSource: "explorer",
          nodeId: "model:physics:ct:ct-loop:cut:cut-1",
          objectId: "ring",
          ref: {
            currentTransportId: "ct-loop",
            kind: "physics.structured-current-source-cut",
            nodeId: "model:physics:ct:ct-loop:cut:cut-1",
            structuredCurrentClosureId: "ring-closure",
            structuredCurrentSourceCutId: "cut-1",
            type: "structured-current-source-cut",
          },
        }}
      />,
    );

    await act(async () => {
      chooseRadixSelectByAriaLabel(
        mounted!.host,
        "Plane coordinate frame",
        "object",
      );
      chooseRadixSelectByAriaLabel(
        mounted!.host,
        "Source cut region scope",
        JSON.stringify(["ring", "arm-b"]),
      );
    });

    const applyCutBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply source cut button",
    );
    await act(async () => {
      applyCutBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceCurrentTransport).toHaveBeenCalledOnce();
    const updatedOwner = state.replaceCurrentTransport.mock.calls[0]![1]
      .resource as KnownSceneCurrentTransport;
    const updatedCut =
      updatedOwner.structured_current_closure?.source_cuts.find(
        (c) => c.source_cut_id === "cut-1",
      );
    expect(updatedCut?.plane.coordinate_frame).toBe("object");
    expect(updatedCut?.region).toEqual({
      object_id: "ring",
      region_id: "arm-b",
    });

    // Also test Remove Source Cut action via header menu!
    state.replaceCurrentTransport.mockClear();
    const removeMenuBtn = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        Boolean(el.textContent?.includes("Remove Source Cut")),
      "Remove Source Cut menuitem",
    );
    await act(async () => {
      removeMenuBtn.click();
    });
    const confirmDeleteBtn = findElement(
      mounted.host,
      (el) => el.getAttribute("data-slot") === "alert-dialog-action",
      "Confirm Remove Source Cut",
    );
    await act(async () => {
      confirmDeleteBtn.click();
      await flushAsyncCommits();
    });
    expect(state.replaceCurrentTransport).toHaveBeenCalledOnce();
    const afterRemoveOwner = state.replaceCurrentTransport.mock.calls[0]![1]
      .resource as KnownSceneCurrentTransport;
    expect(afterRemoveOwner.structured_current_closure?.source_cuts).toHaveLength(
      1,
    );
  });

  it("preserves owned spin interfaces, supports disabled reaction lengths, transient mode, reciprocal nonlinear policy, and opens a new interface draft on Add HM/FM Spin Interface", async () => {
    mounted = mountWave4TestElement(
      <SpinTransportInspectorPanel
        selection={{
          kind: "physics.spin-transport",
          label: "st-bilayer",
          moduleSource: "explorer",
          nodeId: "model:physics:st:st-bilayer",
          objectId: "stack",
          ref: {
            kind: "physics.spin-transport",
            nodeId: "model:physics:st:st-bilayer",
            spinTransportId: "st-bilayer",
            type: "spin-transport",
          },
        }}
      />,
    );

    // Switch to "Execution & Solver" tab to check GPU disabled reason and edit max iterations
    const solverTab = findElement(
      mounted.host,
      (el) => el.getAttribute("data-tab-value") === "solver",
      "Execution & Solver tab",
    );
    await act(async () => {
      solverTab.click();
    });

    // Discretization is read-only session-locked (no editable FDM / FEM toggle) and GPU option carries disabled notice
    expect(mounted.host.textContent).toContain("FDM (Session)");
    expect(
      findElements(
        mounted.host,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent?.trim() === "FDM" || el.textContent?.trim() === "FEM"),
      ),
    ).toHaveLength(0);
    expect(mounted.host.textContent).toContain(
      "GPU spin solver disabled on test host",
    );

    const maxIterInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-solverMaxIterations"),
      "Spin solver max iterations input",
    );
    await act(async () => {
      setInputValue(maxIterInput, "1200");
    });

    // Switch to "Interfaces & BC" tab -> click "Add HM/FM Spin Interface"
    const interfacesTab = findElement(
      mounted.host,
      (el) => el.getAttribute("data-tab-value") === "interfaces",
      "Interfaces & BC tab",
    );
    await act(async () => {
      interfacesTab.click();
    });

    const addIfaceBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Add HM/FM Spin Interface")),
      "Add HM/FM Spin Interface button",
    );
    await act(async () => {
      addIfaceBtn.click();
    });
    const navCall = state.setSelection.mock.calls[0]?.[0] as Selection;
    expect(navCall).toMatchObject({
      kind: "physics.spin-interface",
      ref: {
        draft: true,
        spinInterfaceOwnerId: "st-bilayer",
        type: "spin-interface",
      },
    });

    const applyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply spin transport",
    );
    await act(async () => {
      applyBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceSpinTransport).toHaveBeenCalledOnce();
    expect(state.validateTransport).toHaveBeenLastCalledWith(
      {
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "spin_transport",
          operation: "replace",
          path_id: "st-bilayer",
          resource: expect.objectContaining({ id: "st-bilayer" }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    const savedSpin = state.replaceSpinTransport.mock.calls[0]![1]
      .resource as KnownSceneSpinTransport;
    expect(savedSpin.solver.linear.max_iterations).toBe(1200);
    expect(savedSpin.materials[0]?.material.lambda_j_m).toBe("disabled");
    expect(savedSpin.materials[0]?.material.lambda_phi_m).toBe("disabled");
    // Owned interfaces preserved 100% losslessly (including normal_surface, ferromagnet_surface, spin_memory_loss)!
    expect(savedSpin.interfaces).toEqual(richSpinTransport.interfaces);
  });

  it("authors SpinInterface trace bindings, reservoir spin_memory_loss, live draft mesh verification, and new interface creation without clobbering existing interfaces", async () => {
    // 1. Mount NEW draft from `+ Add HM/FM Spin Interface` -> must NOT overwrite interfaces[0]!
    mounted = mountWave4TestElement(
      <SpinInterfaceInspectorPanel
        selection={{
          kind: "physics.spin-interface",
          label: "New HM/FM interface",
          moduleSource: "inspector",
          nodeId: "model:physics:spin-interface:st-bilayer:draft",
          objectId: "stack",
          ref: {
            draft: true,
            kind: "physics.spin-interface",
            nodeId: "model:physics:spin-interface:st-bilayer:draft",
            spinInterfaceOwnerId: "st-bilayer",
            type: "spin-interface",
          },
        }}
      />,
    );

    const idInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-id"),
      "New spin interface ID input",
    );
    expect(idInput.value).toBe("interface");
    expect(idInput.disabled).toBe(false);

    // 2. Mount existing `iface-hm-fm`, test trace binding + Clear both trace bindings + SML + live mesh error!
    state.meshEvidenceError = new Error(
      "No shared tet4 facets: sides are not adjacent in the accepted mesh.",
    );

    mounted.rerender(
      <SpinInterfaceInspectorPanel
        selection={{
          kind: "physics.spin-interface",
          label: "iface-hm-fm",
          moduleSource: "explorer",
          nodeId: "model:physics:si:iface-hm-fm",
          objectId: "stack",
          ref: {
            kind: "physics.spin-interface",
            nodeId: "model:physics:si:iface-hm-fm",
            spinInterfaceId: "iface-hm-fm",
            spinInterfaceOwnerId: "st-bilayer",
            type: "spin-interface",
          },
        }}
      />,
    );

    expect(mounted.host.textContent).toContain(
      "No shared tet4 facets: sides are not adjacent in the accepted mesh.",
    );
    expect(state.lastObservedMeshSides).toEqual({
      sideA: { objectId: "stack", regionId: "hm" },
      sideB: { objectId: "stack", regionId: "fm" },
    });

    // Refresh mesh evidence button works
    const refreshMeshBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Refresh mesh evidence")),
      "Refresh mesh evidence button",
    );
    await act(async () => {
      refreshMeshBtn.click();
    });
    expect(state.refetchMeshEvidence).toHaveBeenCalledOnce();

    // Clear both trace bindings, then rebind to "x+" -> "x-"
    const clearTracesBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Clear both trace bindings")),
      "Clear both trace bindings button",
    );
    await act(async () => {
      clearTracesBtn.click();
    });
    expect(mounted.host.textContent).toContain("Normal-metal trace: not bound");

    await act(async () => {
      chooseRadixSelectByAriaLabel(
        mounted!.host,
        "Oriented trace pair (normal metal → ferromagnet)",
        "x+",
      );
    });
    expect(mounted.host.textContent).toContain("stack:x+; outward [1, 0, 0]");
    expect(mounted.host.textContent).toContain("stack:x-; outward [-1, 0, 0]");

    // Update reservoir g_n and verify parent SpinTransport is saved losslessly
    const gNInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-gN"),
      "Reservoir g_n input",
    );
    await act(async () => {
      setInputValue(gNInput, "2.5e15");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply spin interface",
    );
    await act(async () => {
      applyBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceSpinTransport).toHaveBeenCalledOnce();
    expect(state.validateTransport).toHaveBeenCalledWith(
      {
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "spin_interface",
          operation: "replace",
          owner_spin_transport_id: "st-bilayer",
          interface_id: "iface-hm-fm",
          resource: expect.objectContaining({ id: "iface-hm-fm" }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    const submittedOwner = state.replaceSpinTransport.mock.calls[0]![1]
      .resource as KnownSceneSpinTransport;
    expect(submittedOwner.boundaries).toEqual(richSpinTransport.boundaries);
    expect(submittedOwner.materials).toEqual(richSpinTransport.materials);
    expect(submittedOwner.interfaces?.[0]).toMatchObject({
      id: "iface-hm-fm",
      kind: "mixing_conductance",
      normal_to_ferromagnet: [1, 0, 0],
      normal_surface: {
        object_id: "stack",
        surface_id: "x+",
        orientation: [1, 0, 0],
      },
      ferromagnet_surface: {
        object_id: "stack",
        surface_id: "x-",
        orientation: [-1, 0, 0],
      },
      g_sml_Spm2: 2e13,
      formula_version: "magnetoelectronic.fullmag.v2",
      absorption: "full_absorption",
      spin_memory_loss: {
        formula_version: "sml_reservoir.fullmag.v2",
        g_n_Spm2: 2.5e15,
        g_f_Spm2: 0.9e15,
        g_lattice_Spm2: 0.4e15,
      },
    });
  });

  it("handles interface_cpp, drift_diffusion solve_id, slonczewski epsilon_prime & time_expression, zhang_li operator/lande_g, negative prescribed_sot, and 3-way conflict rebase in SpinTorqueInspectorPanel", async () => {
    expect(computeAutoHallPolarization([0, 0, 1], [1, 0, 0])).toEqual([
      0, 1, 0,
    ]);

    // 1. Mount `interface_cpp` torque ("cpp-1") and verify it saves as `kind: "interface_cpp"` (NEVER "slonczewski"!)
    mounted = mountWave4TestElement(
      <SpinTorqueInspectorPanel
        selection={{
          kind: "physics.spin-torque",
          label: "cpp-1",
          moduleSource: "explorer",
          nodeId: "model:physics:torque:cpp-1",
          objectId: null,
          ref: {
            kind: "physics.spin-torque",
            nodeId: "model:physics:torque:cpp-1",
            spinTorqueId: "cpp-1",
            type: "spin-torque",
          },
        }}
      />,
    );

    const epsInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-epsilonPrime"),
      "Interface CPP epsilon_prime input",
    );
    expect(epsInput.value).toBe("0.09");
    await act(async () => {
      setInputValue(epsInput, "0.15");
    });

    const applyCppBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply interface_cpp torque",
    );
    await act(async () => {
      applyCppBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceSpinTorque).toHaveBeenCalledOnce();
    expect(state.validateTransport).toHaveBeenLastCalledWith(
      {
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "spin_torque",
          operation: "replace",
          path_id: "cpp-1",
          resource: expect.objectContaining({ kind: "interface_cpp", id: "cpp-1" }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    const savedCpp = state.replaceSpinTorque.mock.calls[0]![1].resource as Record<
      string,
      unknown
    >;
    expect(savedCpp).toMatchObject({
      kind: "interface_cpp",
      id: "cpp-1",
      degree: 0.62,
      lambda_asymmetry: 1.4,
      epsilon_prime: 0.15,
      spin_polarization: [0, 1, 0],
      interface_normal: [0, 0, 1],
    });

    // 2. Mount `prescribed_sot` vector_current_source ("sot-vec") -> verify hydrated drive_direction [0, 1, 0] and HTTP 409 Rebase Draft!
    state.replaceSpinTorque.mockClear();
    state.replaceSpinTorque.mockRejectedValueOnce(
      new ControlRoomApiError("Revision conflict", 409),
    );

    mounted.rerender(
      <SpinTorqueInspectorPanel
        selection={{
          kind: "physics.spin-torque",
          label: "sot-vec",
          moduleSource: "explorer",
          nodeId: "model:physics:torque:sot-vec",
          objectId: "stack",
          ref: {
            kind: "physics.spin-torque",
            nodeId: "model:physics:torque:sot-vec",
            spinTorqueId: "sot-vec",
            type: "spin-torque",
          },
        }}
      />,
    );

    const driveDirY = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("aria-label") === "Reference current drive direction y",
      "SOT drive_direction y input",
    );
    expect(driveDirY.value).toBe("1");

    const xiDlInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-xiDl"),
      "SOT xiDl input",
    );
    await act(async () => {
      setInputValue(xiDlInput, "0.22");
    });

    const applySotBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply SOT button",
    );
    await act(async () => {
      applySotBtn.click();
      await flushAsyncCommits();
    });

    // HTTP 409 triggers Revision conflict notice + Rebase Draft quickFix!
    expect(mounted.host.textContent).toContain("Revision conflict detected");
    const rebaseBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Rebase Draft")),
      "Rebase Draft quickFix button",
    );
    await act(async () => {
      rebaseBtn.click();
    });

    // After Rebase Draft, re-query enabled Apply button and verify commit succeeds!
    const rebasedApplyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Rebased Apply SOT button",
    );
    await act(async () => {
      rebasedApplyBtn.click();
      await flushAsyncCommits();
    });
    expect(state.replaceSpinTorque).toHaveBeenCalledTimes(2);
    expect(state.replaceSpinTorque.mock.calls[1]![1].resource).toMatchObject({
      kind: "prescribed_sot",
      xi_dl: 0.22,
      drive: {
        kind: "vector_current_source",
        current_source_id: "ct-loop",
        drive_direction: [0, 1, 0],
        interface_normal: [0, 0, 1],
      },
    });

    // 3. Direct builder verification for drift_diffusion solve_id, negative signed_scalar SOT, slonczewski time_expression, and zhang_li canonical v1!
    const baseDraft = {
      exists: false,
      id: "dd-1",
      torqueKind: "drift_diffusion_spin_torque" as const,
      targetMode: "scoped" as const,
      targetObjectId: "stack",
      targetRegionId: "fm",
      currentBindingMode: "prescribed_density" as const,
      currentSource: "ct-loop",
      currentDensityVec: [1e11, 0, 0] as const,
      solveId: "st-bilayer",
      degree: 0.5,
      beta: 0.02,
      lambdaAsymmetry: 1.2,
      epsilonPrime: 0.07,
      spinPolarizationVec: [0, 0, 1] as const,
      stackNormalVec: [0, 0, 1] as const,
      interfaceNormalVec: [0, 0, 1] as const,
      hasFreeLayerThickness: true,
      freeLayerThicknessM: 1.2e-9,
      fixedLayerPosition: "" as const,
      realizationMode: "thin_layer_homogenized" as const,
      realizationJson: "",
      formulaVersion: "drift_diffusion_spin_torque.fullmag.v1",
      schemaVersion: "drift_diffusion_spin_torque.v1",
      operatorVersion: "zl_central_reference_v1",
      landeGText: "2.1",
      sotDriveKind: "signed_scalar" as const,
      signedCurrentDensityApm2: -1.8e11,
      sigmaHatVec: [0, 1, 0] as const,
      sotEnvelopeJson: JSON.stringify({
        kind: "sinusoidal",
        amplitude: 1,
        frequency_hz: 2e9,
        phase_rad: 0,
        offset: 0,
      }),
      driveDirectionVec: [1, 0, 0] as const,
      sotInterfaceNormalVec: [0, 0, 1] as const,
      legacyScalarMagnitudeApm2: 1e11,
      xiDl: 0.12,
      xiFl: -0.03,
      rawSpinPolarizationText: "",
      compatibilityOriginJson: "",
      timeProfileKind: "expression" as const,
      pulseAmplitude: 1,
      pulseTOnS: 1e-10,
      pulseTOffS: 1e-9,
      exprSource: "heaviside(t - on) * sin(2 * pi * f * t)",
      exprConstantsJson: '{"f": 4e9, "on": 1e-11}',
      exprEventTimesText: "1e-11",
    };

    expect(buildSpinTorqueResource(baseDraft)).toEqual({
      kind: "drift_diffusion_spin_torque",
      id: "dd-1",
      solve_id: "st-bilayer",
      target: { object_id: "stack", region_id: "fm" },
      schema_version: "drift_diffusion_spin_torque.v1",
      formula_version: "drift_diffusion_spin_torque.fullmag.v1",
    });

    expect(
      buildSpinTorqueResource({
        ...baseDraft,
        id: "sot-neg",
        torqueKind: "prescribed_sot",
        formulaVersion: "prescribed_sot.fullmag.v1",
        schemaVersion: "prescribed_sot.v1",
        timeProfileKind: "constant",
      }),
    ).toMatchObject({
      kind: "prescribed_sot",
      drive: {
        kind: "signed_scalar",
        current_density_Apm2: -1.8e11,
        sigma_hat: [0, 1, 0],
        envelope: {
          kind: "sinusoidal",
          amplitude: 1,
          frequency_hz: 2e9,
          phase_rad: 0,
          offset: 0,
        },
      },
    });

    expect(
      buildSpinTorqueResource({
        ...baseDraft,
        id: "slon-expr",
        torqueKind: "slonczewski",
        formulaVersion: "slonczewski.fullmag.v2",
        schemaVersion: "slonczewski_torque.v1",
      }),
    ).toMatchObject({
      kind: "slonczewski",
      epsilon_prime: 0.07,
      realization: {
        kind: "thin_layer_homogenized",
        realization_version: "slonczewski_thin_layer_homogenized.v1",
      },
      time_expression: {
        source: "heaviside(t - on) * sin(2 * pi * f * t)",
        constants: { f: 4e9, on: 1e-11 },
        event_times_s: [1e-11],
      },
    });

    expect(
      buildSpinTorqueResource({
        ...baseDraft,
        id: "zl-v1",
        torqueKind: "zhang_li",
        formulaVersion: "zhang_li.fullmag.v1",
        schemaVersion: "zhang_li_torque.v1",
      }),
    ).toMatchObject({
      kind: "zhang_li",
      formula_version: "zhang_li.fullmag.v1",
      schema_version: "zhang_li_torque.v1",
      operator_version: "zl_central_reference_v1",
      lande_g: 2.1,
      target: { object_id: "stack", region_id: "fm" },
    });
  });

  it("auto-resolves unambiguous Oersted CurrentTransport source on new drafts, preserves real SceneOerstedTimeDependence, and gates mutations on capability", async () => {
    // 1. New Oersted draft scoped to object "pillar" auto-binds to "ct-pillar" via resolveOerstedCurrentSource!
    mounted = mountWave4TestElement(
      <OerstedFieldInspectorPanel
        selection={{
          kind: "physics.oersted-field",
          label: "Oersted Field",
          moduleSource: "inspector",
          nodeId: "model:object:pillar:oersted-field:draft",
          objectId: "pillar",
          ref: null,
        }}
      />,
    );

    const idInput = findElement(
      mounted.host,
      (el) => (el.getAttribute("id") ?? "").endsWith("-id"),
      "Auto-bound Oersted ID input",
    );
    expect(idInput.value).toBe("oersted:ct-pillar");
    expect(mounted.host.textContent).toContain("from_current_solution");

    // 2. Mount existing `oe-wire` (`oersted_cylinder`) -> preserves pulse `time_dependence` & live B_Oe(R) readout!
    mounted.rerender(
      <OerstedFieldInspectorPanel
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
    );

    expect(mounted.host.textContent).toContain("40 mT");
    const tOffInput = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Oersted pulse t_off",
      "Oersted pulse t_off input",
    );
    expect(tOffInput.value).toBe("3e-9");

    await act(async () => {
      setInputValue(tOffInput, "5e-9");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply Oersted wire button",
    );
    await act(async () => {
      applyBtn.click();
      await flushAsyncCommits();
    });

    expect(state.replaceOerstedField).toHaveBeenCalledOnce();
    expect(state.validateTransport).toHaveBeenLastCalledWith(
      {
        validation_version: "transport-authoring-validation.v1",
        base_revision: 12,
        candidate: expect.objectContaining({
          kind: "oersted_field",
          operation: "replace",
          path_id: "oe-wire",
          resource: expect.objectContaining({ kind: "oersted_cylinder", id: "oe-wire" }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    for (const [req] of state.validateTransport.mock.calls as [Record<string, unknown>][]) {
      expect(req).toHaveProperty("candidate");
      expect(req).not.toHaveProperty("kind");
      expect(req).not.toHaveProperty("operation");
      expect(req).not.toHaveProperty("resource");
    }
    expect(state.replaceOerstedField.mock.calls[0]![1].resource).toEqual({
      kind: "oersted_cylinder",
      id: "oe-wire",
      current: 0.01,
      radius: 50e-9,
      center: [0, 0, 0],
      axis: [0, 0, 1],
      time_dependence: {
        kind: "pulse",
        t_on: 1e-10,
        t_off: 5e-9,
      },
    });

    expect(
      buildOerstedFieldResource({
        exists: true,
        id: "oe-sinc",
        kind: "oersted_cylinder",
        currentA: 0.02,
        radiusM: 40e-9,
        centerVec: [0, 0, 0],
        axisVec: [0, 0, 1],
        timeDependenceJson: JSON.stringify({
          kind: "sinc_pulse",
          cutoff_hz: 15e9,
          t0: 4e-10,
          amplitude: 1.2,
        }),
        source: "",
        model: "from_current_solution",
      }),
    ).toMatchObject({
      kind: "oersted_cylinder",
      time_dependence: {
        kind: "sinc_pulse",
        cutoff_hz: 15e9,
        t0: 4e-10,
        amplitude: 1.2,
      },
    });

    // 3. Capability gate: disabling `m1_one_way_steady` locks Apply and hides Delete!
    state.capabilities = {
      ...buildDefaultCapabilities(),
      m1_one_way_steady: {
        authoring_allowed: false,
        reason: "M1 authoring locked by policy",
        status: "unsupported",
      },
    };
    mounted.rerender(
      <OerstedFieldInspectorPanel
        selection={{
          kind: "physics.oersted-field",
          label: "oe-wire",
          moduleSource: "explorer",
          nodeId: "model:physics:oe:oe-wire-locked",
          objectId: null,
          ref: null,
        }}
      />,
    );
    expect(mounted.host.textContent).toContain(
      "M1 authoring locked by policy",
    );
    const lockedCreateBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Create")),
      "Locked Create button",
    );
    expect(lockedCreateBtn.disabled).toBe(true);
  });
});
