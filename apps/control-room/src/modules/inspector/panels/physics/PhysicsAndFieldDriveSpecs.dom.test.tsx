import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  CurrentTransportInspectorPanel,
  OerstedFieldInspectorPanel,
  SpinInterfaceInspectorPanel,
  SpinTorqueInspectorPanel,
  SpinTransportInspectorPanel,
  StructuredCurrentClosureInspectorPanel,
  StructuredCurrentSourceCutInspectorPanel,
} from "../transport/TransportAndSpinSpecs";
import {
  evaluateFieldDriveEnvelopeAtTime,
  FieldDriveInspectorPanel,
} from "./FieldDriveSpec";
import {
  CouplingInspectorPanel,
  ObjectPhysicsInspectorPanel,
  PhysicsModuleInspectorPanel,
} from "./PhysicsModuleSpecs";

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
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button data-slot="confirm-delete-action" type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@radix-ui/react-select", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 44,
    study: { output_dt_s: 20e-12 },
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12, Dind: 1.5e-3 } }],
    couplings: [
      {
        id: "cpl-1",
        name: "SAF Bilayer RKKY",
        kind: "rkky",
        enabled: true,
        endpoint_a: { kind: "object", object_id: "layer-top" },
        endpoint_b: { kind: "object", object_id: "layer-bot" },
        j_rkky: -1.5e-3,
      },
    ],
    objects: [
      { id: "layer-top", name: "Top FM", role: "magnet", material_ref: "py" },
      { id: "layer-bot", name: "Bottom FM", role: "magnet", material_ref: "py" },
      { id: "hm-pt", name: "Pt Underlayer", role: "conductor" },
    ],
  },
  deleteFieldDrive: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
  patchObjectInteraction: vi.fn().mockResolvedValue({ scene_revision: 45 }),
  replaceSpinTransport: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObjectInteraction: mocks.patchObjectInteraction,
        patchStudy: vi.fn().mockResolvedValue({}),
        commitTransaction: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createCoupling: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        patchCoupling: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteCoupling: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteCurrentTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createSpinTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceSpinTransport: mocks.replaceSpinTransport,
        deleteSpinTransport: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteSpinTorque: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteOerstedField: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        createFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteFieldDrive: mocks.deleteFieldDrive,
        createMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        replaceMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
        deleteMaskFieldDrive: vi
          .fn()
          .mockResolvedValue({ committed_scene: { revision: 45 }, scene_revision: 45 }),
      },
    },
    commands: { execute: vi.fn(), getSessionScopeKey: () => "s1" },
    layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }), setPanelVisible: vi.fn() },
    resources: { invalidate: vi.fn() },
    selection: { set: mocks.setSelection },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
  useModelCouplingsResource: () => ({ data: { items: mocks.sceneData.couplings }, status: "ready" }),
}));

vi.mock("@/kernel/resources/physicsGraphResources", () => ({
  usePhysicsGraphResource: () => ({
    data: { schema_version: "physics_graph.v1", modules: [], edges: [] },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  invalidateSpinAuthoringResources: vi.fn(),
  useCurrentTransportsResource: () => ({
    data: {
      items: [
        {
          name: "ct-loop",
          model: "ohmic_steady_state",
          sigma_Spm: 6.25e6,
          external_lead_preparation: "extend_contacts",
          structured_current_closure: {
            closure_id: "ring-closure",
            source_cuts: [
              {
                source_cut_id: "cut-x0",
                circuit_id: "loop-1",
                drive_id: "drv-1",
                plane: { axis: "x", offset_m: 0, orientation: 1 },
                drive: { potential_jump_V: 0.025 },
              },
            ],
          },
        },
      ],
    },
    status: "ready",
  }),
  useSpinTransportsResource: () => ({
    data: {
      items: [
        {
          id: "st-bilayer",
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
  }),
  useSpinInterfacesResource: () => ({
    data: {
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
            re_g_mix_Spm2: 0.55e15,
          },
        },
      ],
    },
    status: "ready",
  }),
  useSpinInterfaceMeshEvidenceResource: () => ({ data: null, status: "idle", error: null }),
  useSpinTorquesResource: () => ({
    data: {
      items: [
        {
          id: "sot-1",
          kind: "spin_orbit_torque",
          xi_dl: 0.08,
          xi_fl: 0.02,
          spin_polarization: [0, -1, 0],
        },
      ],
    },
    status: "ready",
  }),
  useOerstedFieldsResource: () => ({
    data: {
      items: [
        {
          id: "oe-wire",
          kind: "oersted_cylinder",
          current_A: 0.01,
          radius_m: 50e-9,
          center_m: [0, 0, 0],
          axis: [0, 0, 1],
        },
      ],
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/fieldDriveResources", () => ({
  useFieldDrivesResource: () => ({
    data: {
      items: [
        {
          id: "sinc-pulse-1",
          name: "Broadband Sinc Drive",
          enabled: true,
          amplitude_t: [0.005, 0, 0],
          target: { kind: "global" },
          spatial_profile: { kind: "uniform" },
          waveform: { kind: "sinc_pulse", cutoff_hz: 30e9, t0: 0.5e-9 },
        },
      ],
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/maskAntennaResources", () => ({
  useMaskFieldDrivesResource: () => ({ data: { items: [] }, status: "ready" }),
}));

describe("Physics, Transport, Spin & FieldDrive Specs (Task 17)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.deleteFieldDrive.mockClear();
    mocks.setSelection.mockClear();
  });

  it("wires exactly 31 distinct components and disjoint selectionKinds in MODEL_PHYSICS_ROUTES", () => {
    expect(MODEL_PHYSICS_ROUTES).toHaveLength(31);
    const ids = new Set(MODEL_PHYSICS_ROUTES.map((r) => r.id));
    const components = new Set(MODEL_PHYSICS_ROUTES.map((r) => r.component));
    expect(ids.size).toBe(31);
    expect(components.size).toBe(31);
  });

  it("renders ObjectPhysics switch matrix, CubicAnisotropy, InterfacialDmi.interface_normal, Bulk DMI, and RKKY Coupling", () => {
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

    // CubicAnisotropy module leaf
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Cubic Anisotropy",
          moduleSource: "explorer",
          nodeId: "model:object:layer-top:physics:module:cubic_anisotropy",
          objectId: "layer-top",
          ref: {
            kind: "physics.module",
            nodeId: "model:object:layer-top:physics:module:cubic_anisotropy",
            physicsActivation: "active",
            physicsModuleId: "cubic_anisotropy",
            physicsModuleKind: "cubic_anisotropy",
            physicsScopeKind: "object",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("First-order cubic constant");
    expect(mounted.host.textContent).toContain("Orthogonalize c₂");

    // Interfacial DMI with interface_normal
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Interfacial DMI",
          moduleSource: "explorer",
          nodeId: "model:object:layer-top:physics:module:interfacial_dmi",
          objectId: "layer-top",
          ref: {
            kind: "physics.module",
            nodeId: "model:object:layer-top:physics:module:interfacial_dmi",
            physicsActivation: "active",
            physicsModuleId: "interfacial_dmi",
            physicsModuleKind: "interfacial_dmi",
            physicsScopeKind: "object",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("Symmetry-breaking interface normal");

    // Bulk DMI writable quantity
    mounted.rerender(
      <PhysicsModuleInspectorPanel
        selection={{
          kind: "physics.module",
          label: "Bulk DMI",
          moduleSource: "explorer",
          nodeId: "model:object:layer-top:physics:module:bulk_dmi",
          objectId: "layer-top",
          ref: {
            kind: "physics.module",
            nodeId: "model:object:layer-top:physics:module:bulk_dmi",
            physicsActivation: "active",
            physicsModuleId: "bulk_dmi",
            physicsModuleKind: "bulk_dmi",
            physicsScopeKind: "object",
            type: "physics-module",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("Bulk DMI constant");

    // RKKY Coupling
    mounted.rerender(
      <CouplingInspectorPanel
        selection={{
          kind: "physics.coupling",
          label: "SAF Bilayer RKKY",
          moduleSource: "explorer",
          nodeId: "model:physics:couplings:cpl-1",
          objectId: null,
          ref: {
            couplingId: "cpl-1",
            kind: "physics.coupling",
            nodeId: "model:physics:couplings:cpl-1",
            type: "physics-coupling",
          },
        }}
      />,
    );
    expect(mounted.host.textContent).toContain("Antiferromagnetic (AF)");
  });

  it("renders split ChargeTransport/Closure/SourceCut and Spin/Oersted inspectors with ZERO <textarea> JSON inputs", () => {
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
          ref: null,
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
          ref: null,
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
          ref: null,
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
          ref: null,
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
          ref: null,
        }}
      />,
    ];

    mounted = mountWave4TestElement(views[0]!);
    for (const view of views) {
      mounted.rerender(view);
      // Zero JSON <textarea> elements and zero raw <select> elements!
      expect(findElements(mounted.host, (el) => el.tagName === "TEXTAREA")).toHaveLength(0);
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
            fieldDriveKind: "regional",
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
    expect(mounted.host.textContent).toContain("Excitation exceeds output Nyquist frequency");

    // Click Delete Field Drive menu item -> opens AlertDialog -> Confirm deletes & navigates to physics.field-drives
    const deleteMenuBtn = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        Boolean(el.textContent?.includes("Delete Field Drive")),
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
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Delete Field Drive")),
    );
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.deleteFieldDrive).toHaveBeenCalledWith("sinc-pulse-1", {
      base_revision: 44,
    });
    expect(mocks.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "physics.field-drives" }),
      "inspector",
    );
  });
});
