import { createHash } from "node:crypto";
import {
  binaryRangeFulfillOptions,
  buildFemAirboxTopology,
  computeLegendFingerprint,
  encodeFmcsV2,
  encodeFmcsV4,
  encodeFmrmV2,
  encodeFmvpV2,
  encodeFmvpV3,
  encodeFmtbV1,
} from "./binaryEncoders.mjs";

const CONTRACT_VERSION = "1.0.0";
const REQUEST_BASE_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers":
    "x-api-contract-version,etag,x-request-id,x-fullmag-domain-generation-id,content-range,accept-ranges",
  "x-api-contract-version": CONTRACT_VERSION,
};

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Generates realistic micromagnetic 3D skyrmion + stripe domain vector/scalar buffers.
 */
function generateFdmGridPayloads(nx = 48, ny = 48, nz = 1, dx = 4e-9, dy = 4e-9, dz = 2e-9, pattern = "skyrmion") {
  const count = nx * ny * nz;
  const mVec = new Float64Array(count * 3);
  const mz = new Float64Array(count);
  const mx = new Float64Array(count);
  const my = new Float64Array(count);
  const hDemag = new Float64Array(count * 3);
  const topoCharge = new Float64Array(count);
  const regionIds = new Uint32Array(count);

  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const skyrmionRadius = nx * 0.22;

  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const idx = (iz * ny + iy) * nx + ix;
        const rx = ix - cx;
        const ry = iy - cy;
        const r = Math.hypot(rx, ry);
        const phi = Math.atan2(ry, rx);

        let nxm;
        let nym;
        let nzm;
        if (pattern === "eigenmode") {
          const sx = Math.sin((Math.PI * 3 * (ix + 0.5)) / nx);
          const sy = Math.sin((Math.PI * 2 * (iy + 0.5)) / ny);
          const amp = sx * sy;
          const phase = (Math.PI * 2 * (ix + 0.5)) / nx;
          const vx = amp * Math.cos(phase);
          const vy = amp * Math.sin(phase);
          const vz = Math.cos(amp * Math.PI * 0.85);
          const norm = Math.hypot(vx, vy, vz) || 1;
          nxm = vx / norm;
          nym = vy / norm;
          nzm = vz / norm;
        } else {
          // Two satellite fractional vortices + main central skyrmion for vivid multi-domain visualization
          const coreTheta = Math.PI * Math.exp(-(r * r) / (skyrmionRadius * skyrmionRadius));
          const ripple = 0.28 * Math.sin(ix * 0.34) * Math.cos(iy * 0.28);
          const theta = Math.max(0.05, Math.min(Math.PI - 0.05, coreTheta + Math.abs(ripple) * 0.9));
          // Mixed Néel-Bloch helicity angle
          const azimuth = phi + Math.PI * 0.28 + 0.18 * Math.sin(rx * 0.22);

          const vx = Math.sin(theta) * Math.cos(azimuth);
          const vy = Math.sin(theta) * Math.sin(azimuth);
          const vz = -Math.cos(theta);
          const norm = Math.hypot(vx, vy, vz) || 1;

          nxm = vx / norm;
          nym = vy / norm;
          nzm = vz / norm;
        }

        mVec[idx * 3] = nxm;
        mVec[idx * 3 + 1] = nym;
        mVec[idx * 3 + 2] = nzm;
        mx[idx] = nxm;
        my[idx] = nym;
        mz[idx] = nzm;

        hDemag[idx * 3] = -0.35 * nxm * 8e5;
        hDemag[idx * 3 + 1] = -0.35 * nym * 8e5;
        hDemag[idx * 3 + 2] = -0.92 * nzm * 8e5;

        topoCharge[idx] = (1 - Math.abs(nzm)) * Math.exp(-(r * r) / (skyrmionRadius * skyrmionRadius));

        // Region layout: 1 = inner nanodisk/core, 2 = pinning ring, 3 = cladding waveguide
        if (r <= nx * 0.26) regionIds[idx] = 1;
        else if (r <= nx * 0.42) regionIds[idx] = 2;
        else regionIds[idx] = 3;
      }
    }
  }

  return {
    grid: [nx, ny, nz],
    cellSize: [dx, dy, dz],
    bounds: {
      min: [-(nx * dx) / 2, -(ny * dy) / 2, -(nz * dz) / 2],
      max: [(nx * dx) / 2, (ny * dy) / 2, (nz * dz) / 2],
    },
    mFmvp: encodeFmvpV2({ quantityId: "m", grid: [nx, ny, nz], nComp: 3, data: mVec }),
    mzFmvp: encodeFmvpV2({ quantityId: "m_z", grid: [nx, ny, nz], nComp: 1, data: mz }),
    hDemagFmvp: encodeFmvpV2({ quantityId: "H_demag", grid: [nx, ny, nz], nComp: 3, data: hDemag }),
    topoFmvp: encodeFmvpV2({ quantityId: "topological_charge", grid: [nx, ny, nz], nComp: 1, data: topoCharge }),
    regionIds,
    mx,
    my,
    mz,
    mVec,
  };
}

/**
 * Generates high-contrast 2D planar field slice data + FMCS v4 exact mesh overlay.
 */
function generatePlanarSliceData(nu = 96, nv = 96, plane = "xy", q = 0.5, mode = "fdm", quantity = "M") {
  const count = nu * nv;
  const scalar = new Float64Array(count);
  const vectors = new Float64Array(count * 3);
  const emptyMask = new Uint8Array(count);

  const cx = (nu - 1) / 2;
  const cy = (nv - 1) / 2;
  const diskRadius = nu * 0.46;

  for (let iv = 0; iv < nv; iv += 1) {
    for (let iu = 0; iu < nu; iu += 1) {
      const idx = iv * nu + iu;
      const du = iu - cx;
      const dv = iv - cy;
      const r = Math.hypot(du, dv);
      const phi = Math.atan2(dv, du);

      const inside = mode === "fem" ? r <= diskRadius || (Math.abs(du) < nu * 0.42 && Math.abs(dv) < nv * 0.22) : true;
      // PLANAR_OCCUPANCY: 0 = occupied, 1 = empty
      emptyMask[idx] = inside ? 0 : 1;

      const phaseShift = (q - 0.5) * 2.2;
      const wave = Math.sin(iu * 0.16 + phaseShift) * Math.cos(iv * 0.14);
      const sk = Math.PI * Math.exp(-(r * r) / Math.pow(nu * 0.19, 2));
      const vz = inside ? -Math.cos(sk) + 0.24 * wave : 0;
      const vx = inside ? Math.sin(sk) * Math.cos(phi + 0.7) + 0.18 * Math.cos(iv * 0.1) : 0;
      const vy = inside ? Math.sin(sk) * Math.sin(phi + 0.7) + 0.18 * Math.sin(iu * 0.1) : 0;
      const norm = Math.hypot(vx, vy, vz) || 1;

      vectors[idx * 3] = inside ? vx / norm : 0;
      vectors[idx * 3 + 1] = inside ? vy / norm : 0;
      vectors[idx * 3 + 2] = inside ? vz / norm : 0;
      scalar[idx] = quantity === "H_ant"
        ? (inside ? 1.2e4 * Math.sin(iu * 0.22) * Math.exp(-(dv * dv) / (nv * nv * 0.08)) : 0)
        : vectors[idx * 3 + 2];
    }
  }

  const uMin = -96e-9;
  const uMax = 96e-9;
  const vMin = plane === "xy" ? -96e-9 : -12e-9;
  const vMax = plane === "xy" ? 96e-9 : 12e-9;

  // Build clean 4x4 grid of triangular cells for FMCS v4 mesh overlay
  const nxSeg = 5;
  const nySeg = 5;
  const verts = [];
  for (let j = 0; j <= nySeg; j += 1) {
    const v = vMin + ((vMax - vMin) * j) / nySeg;
    for (let i = 0; i <= nxSeg; i += 1) {
      const u = uMin + ((uMax - uMin) * i) / nxSeg;
      verts.push(u, v);
    }
  }
  const polyOffsets = [0];
  const parentIds = [];
  const segCoords = [];
  const segKinds = [];
  let vCursor = 0;
  for (let j = 0; j < nySeg; j += 1) {
    for (let i = 0; i < nxSeg; i += 1) {
      const n00 = j * (nxSeg + 1) + i;
      const n01 = n00 + (nxSeg + 1);
      const n11 = n01 + 1;
      const u0 = verts[n00 * 2];
      const v0 = verts[n00 * 2 + 1];
      const u1 = verts[n11 * 2];
      const v1 = verts[n11 * 2 + 1];

      // Cell edge segments
      segCoords.push(u0, v0, u1, v0);
      segKinds.push(j === 0 ? 0 : j === 2 ? 1 : 2);
      segCoords.push(u1, v0, u1, v1);
      segKinds.push(i === nxSeg - 1 ? 0 : 2);
      segCoords.push(u0, v0, u1, v1);
      segKinds.push(2);

      parentIds.push(j * nxSeg + i + 1);
      vCursor += 3;
      polyOffsets.push(vCursor);
    }
  }

  // Remap compact vertices for polygons (simple fan vertices per triangle for validation)
  const polyVerts = [];
  const rebuiltOffsets = [0];
  for (let j = 0; j < nySeg; j += 1) {
    for (let i = 0; i < nxSeg; i += 1) {
      const n00 = j * (nxSeg + 1) + i;
      const n10 = n00 + 1;
      const n11 = n00 + (nxSeg + 1) + 1;
      polyVerts.push(verts[n00 * 2], verts[n00 * 2 + 1]);
      polyVerts.push(verts[n10 * 2], verts[n10 * 2 + 1]);
      polyVerts.push(verts[n11 * 2], verts[n11 * 2 + 1]);
      rebuiltOffsets.push(polyVerts.length / 2);
    }
  }

  const fmcsBuffer = encodeFmcsV4({
    bounds: { uMin, uMax, vMin, vMax },
    vertices: new Float32Array(polyVerts),
    polygonOffsets: new Uint32Array(rebuiltOffsets),
    parentElementIds: new Uint32Array(parentIds),
    segments: new Float32Array(segCoords),
    segmentKinds: new Uint8Array(segKinds),
  });

  return {
    nu,
    nv,
    bounds: { uMin, uMax, vMin, vMax },
    scalarBuffer: encodeFmvpV2({ quantityId: quantity, grid: [nu, nv, 1], nComp: 1, data: scalar }),
    vectorsBuffer: encodeFmvpV2({ quantityId: "M", grid: [nu, nv, 1], nComp: 3, data: vectors }),
    emptyMaskBuffer: Buffer.from(emptyMask),
    meshOverlayBuffer: fmcsBuffer,
  };
}

/**
 * Creates a complete stateful mock API fixture environment for a Playwright BrowserContext.
 */
export function createDocsFixtureContext({
  scenario = "fdm-skyrmion",
  theme = "dark",
  instanceTabs = null,
  extraRoutes = null,
} = {}) {
  const isFem = scenario === "fem-airbox" || scenario === "study-antenna-fem";
  const isHysteresis = scenario === "study-hysteresis";
  const isEigen = scenario === "results-eigen-dispersion";
  const isSaved = scenario === "results-saved-project";
  const isStart = scenario === "start-screen-hub" || scenario === "start-screen-live";

  const domainGenId = `domgen-${scenario}-rev12`;
  const gridFingerprint = sha256Hex(`grid-${scenario}`);
  const sessionId = isFem ? "sess-fem-yig-waveguide" : "sess-fdm-skyrmion-hub";
  const runId = isSaved ? "run_sweep_042_fem" : isEigen ? "run_eigen_fmr_018" : "run_llg_live_007";
  const stageId = isHysteresis ? "stage_hysteresis_01" : isEigen ? "stage_eigen_01" : "stage_relax_01";

  const fdmData = generateFdmGridPayloads(48, 48, 1, 4e-9, 4e-9, 2e-9, isEigen ? "eigenmode" : "skyrmion");
  const femTopology = buildFemAirboxTopology({
    coreBounds: { min: [-80e-9, -32e-9, -10e-9], max: [80e-9, 32e-9, 10e-9] },
    airboxBounds: { min: [-140e-9, -76e-9, -44e-9], max: [140e-9, 76e-9, 44e-9] },
  });

  const regionLegend = [
    { numeric_id: 1, object_id: "obj_yig_film", region_id: "reg_skyrmion_core", priority: 10, name: "Core Region" },
    { numeric_id: 2, object_id: "obj_yig_film", region_id: "reg_pinning_ring", priority: 20, name: "Pinning Ring" },
    { numeric_id: 3, object_id: "obj_cpw_track", region_id: "reg_cladding", priority: 30, name: "Waveguide Track" },
  ];
  const legendFingerprint = computeLegendFingerprint(regionLegend);
  const fmrmBuffer = encodeFmrmV2({
    counts: fdmData.grid,
    legendCount: regionLegend.length,
    gridFingerprintHex: gridFingerprint,
    regionIds: fdmData.regionIds,
  });

  // FEM node magnetization vector field aligned to 16 nodes in femTopology
  const femNodeCount = femTopology.nodeCount;
  const femMData = new Float64Array(femNodeCount * 3);
  const femHantData = new Float64Array(femNodeCount);
  for (let i = 0; i < femNodeCount; i += 1) {
    const angle = (i / Math.max(1, femNodeCount)) * Math.PI * 2;
    femMData[i * 3] = Math.cos(angle) * 0.7;
    femMData[i * 3 + 1] = Math.sin(angle) * 0.7;
    femMData[i * 3 + 2] = i < 8 ? 0.5 : -0.4;
    femHantData[i] = 9500 * Math.cos(angle);
  }
  const femMFmvp = encodeFmvpV2({ quantityId: "m", grid: [femNodeCount, 1, 1], nComp: 3, data: femMData });
  const femHantFmvp = encodeFmvpV2({ quantityId: "H_ant", grid: [femNodeCount, 1, 1], nComp: 1, data: femHantData });

  // Live time-series FMTB table (120 rows x 7 columns: step, t, mx, my, mz, E_total, E_exch)
  const tableRowCount = 120;
  const tableColCount = 7;
  const tableValues = new Float64Array(tableRowCount * tableColCount);
  for (let r = 0; r < tableRowCount; r += 1) {
    const tNs = r * 0.015;
    const t = tNs * 1e-9;
    const env = Math.exp(-tNs * 0.9);
    const omega = 2 * Math.PI * 6.5;
    const base = r * tableColCount;
    tableValues[base + 0] = r;
    tableValues[base + 1] = t;
    tableValues[base + 2] = env * Math.cos(omega * tNs) * 0.72;
    tableValues[base + 3] = env * Math.sin(omega * tNs) * 0.72;
    tableValues[base + 4] = 0.64 + 0.34 * (1 - env);
    tableValues[base + 5] = -4.2e-18 * (1 + 0.35 * (1 - env));
    tableValues[base + 6] = 1.8e-18 * (0.4 + 0.6 * env);
  }

  // Mutable session visualization state conforming to OpenAPI VisualizationStateResource (schema_version: 5)
  let vizRevision = 5;
  let vizState = {
    schema_version: 5,
    revision: vizRevision,
    domain_generation_id: domainGenId,
    active_quantity_id: "M",
    auto_contrast: true,
    colormap: "rdbu_r",
    contrast_max: 1,
    contrast_min: -1,
    field_component: "z",
    max_points: 16384,
    slice_layer: 0,
    slice_mode: "single",
    vector_density: 50,
    vector_glyphs: true,
    view_mode: "3d",
    x_chosen_size: 48,
    y_chosen_size: 48,
    camera: {
      fov_degrees: 45,
      orthographic_scale: null,
      position: [2e-6, 1.4e-6, 2e-6],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 1, 0],
    },
    clip: {
      enabled: false,
      axis: "x",
      flipped: false,
      position_percent: 50,
    },
    diagnostics: {
      degraded_reasons: [],
      warnings: [],
    },
    domains: {
      active_scope: {
        object_id: null,
        part_id: null,
        scope: "full",
      },
      topology_mode: "auto",
      volume_edges_budget: 100000,
    },
    fdm: {
      x_chosen_size: 48,
      y_chosen_size: 48,
    },
    fem: {},
    layers: {
      airbox: {
        render_mode: "wireframe",
        show_airbox: isFem,
        show_airbox_vectors: false,
      },
      bounds: { visible: true },
      points: { visible: false },
      primitives: { visible: true },
      quantity: { visible: true },
      surface: { opacity: 1, visible: true },
      vectors: { density: 28, domain: "auto", visible: true },
      wireframe: { visible: isFem },
    },
    overrides: [],
    quantity: {
      active_quantity_id: "M",
      auto_contrast: true,
      colormap: "rdbu_r",
      component: "z",
      contrast_max: 1,
      contrast_min: -1,
      field_component: "z",
    },
    sampling: {
      max_bytes: null,
      max_glyphs: 16384,
      max_points: 16384,
      profile: "balanced",
      progressive: true,
    },
    slice: {
      axis: "z",
      auto_contrast: true,
      colormap: "rdbu_r",
      component: "z",
      layer_index: 0,
      mode: "single",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean_occupied",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "M",
      render_mode: "heatmap",
      show_airbox: isFem,
      show_magnetic_texture: true,
      show_mesh: isFem,
      show_primitives: true,
      show_quantity: true,
      show_vectors: true,
      thickness_percent: null,
    },
    targets: {
      airbox: {
        label: "Airbox Envelope",
        scope: "airbox",
        scope_id: "airbox",
        settings: {
          active_quantity_id: "H_ant",
          bounds_visible: false,
          geometry_scope: "full",
          opacity: 0.28,
          points_visible: false,
          render_mode: "wireframe",
          surface_color_source: "solid",
          surface_visible: false,
          vector_alpha: 1,
          vector_color_mode: "orientation",
          vector_mono_color: "#00c2ff",
          vector_thickness: 1,
          vectors_visible: false,
          visible: isFem,
          wireframe_color: "#94a3b8",
          wireframe_opacity: 1,
          wireframe_visible: true,
        },
        source: "airbox",
      },
      objects: [
        {
          label: "YIG Film Core",
          scope: "object",
          scope_id: "obj_yig_film",
          settings: {
            active_quantity_id: "m",
            bounds_opacity: 0.45,
            bounds_visible: true,
            geometry_scope: "full",
            opacity: 1,
            point_color: "#cdd6f4",
            point_opacity: 1,
            points_visible: false,
            render_mode: "surface",
            scalar_color_palette: "rdbu_r",
            surface_color_source: "orientation",
            surface_mono_color: "#cdd6f4",
            surface_opacity: 1,
            surface_projection_mode: "raw_nodal",
            surface_visible: true,
            vector_alpha: 1,
            vector_budget: 2048,
            vector_color_mode: "orientation",
            vector_length_scale: 1.15,
            vector_mono_color: "#cdd6f4",
            vector_thickness: 1,
            vectors_visible: true,
            viewport_colorbar_visible: false,
            visible: true,
            wireframe_color: "#64748b",
            wireframe_opacity: 0.5,
            wireframe_visible: false,
          },
          source: "scene",
        },
      ],
      parts: [],
    },
    trim: {
      x: { enabled: false, max_percent: 100, min_percent: 0 },
      y: { enabled: false, max_percent: 100, min_percent: 0 },
      z: { enabled: false, max_percent: 100, min_percent: 0 },
    },
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "hide",
      length_scale: 1,
      mono_color: "#00c2ff",
      thickness: 1,
    },
    planar: {
      colormap: "rdbu_r",
      component: "z",
      crop: null,
      default_slice: {
        operator: { kind: "plane_sample" },
        plane: "xy",
        position_fraction: 0.5,
      },
      display_unit: null,
      field_overlays: [],
      interaction: {
        pan_u_m: 0,
        pan_v_m: 0,
        zoom: 1,
      },
      layer_model: "legacy",
      layers: {
        boundaries: isFem,
        bounds: true,
        contours: false,
        mesh: isFem,
        points: false,
        probes: true,
        raster: true,
        streamlines: false,
        vectors: true,
      },
      multislice: {
        enabled: false,
        position_fractions: [0.25, 0.5, 0.75],
      },
      point_style: {
        color: "#f5e0dc",
        opacity: 1,
        size: 5,
      },
      quality: "interactive",
      quantity_id: "m",
      range: {
        mode: "auto",
        min: null,
        max: null,
      },
      raster_opacity: 1,
      resolution: {
        height: 96,
        vector_budget: 512,
        width: 96,
      },
      source: {
        kind: "default",
      },
      target_overrides: [],
      vector_style: {
        color_mode: "orientation",
        length_mode: "uniform",
        monochrome_color: "#cdd6f4",
        opacity: 1,
        scale: 1,
        thickness: 1,
      },
      view_scope: {
        kind: "monitor_target",
      },
      viewport_colorbar_visible: true,
      visible: true,
      wireframe_style: {
        color: "#94a3b8",
        opacity: 0.7,
      },
    },
  };

  function mergeVizState(current, patch, nextRevision) {
    const patchPlanar = patch?.planar ?? null;
    const patchLayers = patch?.layers ?? null;
    const patchTargets = patch?.targets ?? null;
    return {
      ...current,
      ...patch,
      revision: nextRevision,
      camera: patch?.camera ? { ...current.camera, ...patch.camera } : current.camera,
      clip: patch?.clip ? { ...current.clip, ...patch.clip } : current.clip,
      diagnostics: patch?.diagnostics ? { ...current.diagnostics, ...patch.diagnostics } : current.diagnostics,
      domains: patch?.domains
        ? {
            ...current.domains,
            ...patch.domains,
            active_scope: patch.domains.active_scope
              ? { ...current.domains.active_scope, ...patch.domains.active_scope }
              : current.domains.active_scope,
          }
        : current.domains,
      fdm: patch?.fdm ? { ...current.fdm, ...patch.fdm } : current.fdm,
      fem: patch?.fem ? { ...current.fem, ...patch.fem } : current.fem,
      layers: patchLayers
        ? {
            ...current.layers,
            ...patchLayers,
            airbox: patchLayers.airbox ? { ...current.layers.airbox, ...patchLayers.airbox } : current.layers.airbox,
            bounds: patchLayers.bounds ? { ...current.layers.bounds, ...patchLayers.bounds } : current.layers.bounds,
            points: patchLayers.points ? { ...current.layers.points, ...patchLayers.points } : current.layers.points,
            primitives: patchLayers.primitives
              ? { ...current.layers.primitives, ...patchLayers.primitives }
              : current.layers.primitives,
            quantity: patchLayers.quantity
              ? { ...current.layers.quantity, ...patchLayers.quantity }
              : current.layers.quantity,
            surface: patchLayers.surface ? { ...current.layers.surface, ...patchLayers.surface } : current.layers.surface,
            vectors: patchLayers.vectors ? { ...current.layers.vectors, ...patchLayers.vectors } : current.layers.vectors,
            wireframe: patchLayers.wireframe
              ? { ...current.layers.wireframe, ...patchLayers.wireframe }
              : current.layers.wireframe,
          }
        : current.layers,
      quantity: patch?.quantity ? { ...current.quantity, ...patch.quantity } : current.quantity,
      sampling: patch?.sampling ? { ...current.sampling, ...patch.sampling } : current.sampling,
      slice: patch?.slice ? { ...current.slice, ...patch.slice } : current.slice,
      targets: patchTargets
        ? {
            ...current.targets,
            ...patchTargets,
            airbox: patchTargets.airbox ?? current.targets.airbox,
            objects: Array.isArray(patchTargets.objects) ? patchTargets.objects : current.targets.objects,
            parts: Array.isArray(patchTargets.parts) ? patchTargets.parts : current.targets.parts,
          }
        : current.targets,
      trim: patch?.trim
        ? {
            x: patch.trim.x ? { ...current.trim.x, ...patch.trim.x } : current.trim.x,
            y: patch.trim.y ? { ...current.trim.y, ...patch.trim.y } : current.trim.y,
            z: patch.trim.z ? { ...current.trim.z, ...patch.trim.z } : current.trim.z,
          }
        : current.trim,
      vector_style: patch?.vector_style ? { ...current.vector_style, ...patch.vector_style } : current.vector_style,
      planar: patchPlanar
        ? {
            ...current.planar,
            ...patchPlanar,
            default_slice: patchPlanar.default_slice
              ? { ...current.planar.default_slice, ...patchPlanar.default_slice }
              : current.planar.default_slice,
            interaction: patchPlanar.interaction
              ? { ...current.planar.interaction, ...patchPlanar.interaction }
              : current.planar.interaction,
            layers: patchPlanar.layers ? { ...current.planar.layers, ...patchPlanar.layers } : current.planar.layers,
            multislice: patchPlanar.multislice
              ? { ...current.planar.multislice, ...patchPlanar.multislice }
              : current.planar.multislice,
            range: patchPlanar.range ? { ...current.planar.range, ...patchPlanar.range } : current.planar.range,
            resolution: patchPlanar.resolution
              ? { ...current.planar.resolution, ...patchPlanar.resolution }
              : current.planar.resolution,
            vector_style: patchPlanar.vector_style
              ? { ...current.planar.vector_style, ...patchPlanar.vector_style }
              : current.planar.vector_style,
          }
        : current.planar,
    };
  }

  let activeWorkspaceRevision = 1;
  let workspaceSnapshot = {
    schema_version: "workspace.v1",
    revision: activeWorkspaceRevision,
    active_session_id: sessionId,
    script: {
      source: [
        'import fullmag as fm',
        '',
        'session = fm.connect(port=3274)',
        'film = fm.Cuboid(size=(192e-9, 192e-9, 4e-9), name="YIG Waveguide")',
        'film.material = fm.Material.yig(Ms=1.4e5, Aex=3.7e-12, alpha=2e-4)',
        'film.magnetization = fm.Skyrmion(radius=36e-9, core_polarity=-1)',
        'study = fm.Study([fm.Relax(), fm.Eigenmode(num_modes=8)])',
        'result = session.run(study)',
      ].join("\n"),
      canonical_status: "synced",
      fidelity: "exact",
      diagnostics: [],
    },
  };

  const unmockedRequests = [];

  const sceneResource = {
    version: "2.0.0",
    schema_version: "model_scene.v2",
    revision: 12,
    scene_revision: 12,
    domain_generation_id: domainGenId,
    discretization: isFem ? "fem" : "fdm",
    name: isFem ? "YIG CPW Waveguide (FEM + Airbox)" : "CoFeB/Pt Skyrmion Track (FDM)",
    scene: {
      id: "scene_yig_waveguide",
      name: isFem ? "YIG CPW Waveguide (FEM + Airbox)" : "CoFeB/Pt Skyrmion Track (FDM)",
      authoring_schema: "scene.v2",
    },
    bounds: isFem
      ? { min: [-140e-9, -76e-9, -44e-9], max: [140e-9, 76e-9, 44e-9] }
      : { min: [-96e-9, -96e-9, -4e-9], max: [96e-9, 96e-9, 4e-9] },
    universe: {
      discretization: isFem ? "fem" : "fdm",
      bounds: isFem
        ? { min: [-140e-9, -76e-9, -44e-9], max: [140e-9, 76e-9, 44e-9] }
        : { min: [-96e-9, -96e-9, -4e-9], max: [96e-9, 96e-9, 4e-9] },
      cell_size_m: [4e-9, 4e-9, 2e-9],
      airbox: isFem
        ? { enabled: true, padding_m: 60e-9, max_edge_length_m: 12e-9 }
        : { enabled: false },
    },
    materials: [
      {
        id: "mat_yig",
        name: "Yttrium Iron Garnet (YIG)",
        properties: {
          Ms_A_m: 1.4e5,
          Aex_J_m: 3.7e-12,
          alpha: 2e-4,
          gamma_rad_s_T: 1.76e11,
          Ku1_J_m3: 8.2e5,
          anisotropy_axis: [0, 0, 1],
          dmi_D_J_m2: 1.4e-3,
          dmi_kind: "interfacial",
        },
        references: [],
      },
      {
        id: "mat_cofeb",
        name: "CoFeB Pinning Layer",
        properties: {
          Ms_A_m: 1.15e6,
          Aex_J_m: 1.8e-11,
          alpha: 0.015,
          Ku1_J_m3: 1.2e6,
          anisotropy_axis: [0, 0, 1],
        },
        references: [],
      },
      {
        id: "mat_au",
        name: "Gold / Pt Waveguide Track",
        properties: {
          Ms_A_m: 0,
          conductivity_S_m: 4.1e7,
        },
        references: [],
      },
    ],
    objects: [
      {
        object_id: "obj_yig_film",
        id: "obj_yig_film",
        name: "YIG Film Core",
        type: "magnetic",
        role: "magnetic",
        geometry: isFem
          ? {
              kind: "box",
              geometry_kind: "box",
              geometry_params: { size: [160e-9, 64e-9, 20e-9] },
              bounds_min: [-80e-9, -32e-9, -10e-9],
              bounds_max: [80e-9, 32e-9, 10e-9],
              size: [160e-9, 64e-9, 20e-9],
              center: [0, 0, 0],
            }
          : {
              kind: "box",
              geometry_kind: "box",
              geometry_params: { size: [192e-9, 192e-9, 8e-9] },
              bounds_min: [-96e-9, -96e-9, -4e-9],
              bounds_max: [96e-9, 96e-9, 4e-9],
              size: [192e-9, 192e-9, 8e-9],
              center: [0, 0, 0],
            },
        shape: { kind: "cuboid", size: isFem ? [160e-9, 64e-9, 20e-9] : [192e-9, 192e-9, 8e-9] },
        transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material_ref: "mat_yig",
        material_id: "mat_yig",
        magnetization_ref: "mag_skyrmion_core",
        visible: true,
        magnetic: true,
        allocated_region_ids: ["reg_skyrmion_core", "reg_pinning_ring"],
        physics_stack: [
          { kind: "exchange", enabled: true },
          { kind: "demag", enabled: true },
          { kind: "zeeman", enabled: true, field_T: [0, 0, 0.035] },
          { kind: "dmi", enabled: true, dmi_kind: "interfacial", D_J_m2: 1.4e-3 },
          { kind: "anisotropy", enabled: true, Ku1_J_m3: 8.2e5, axis: [0, 0, 1] },
          { kind: "sot", enabled: true, theta_sh: 0.12, axis: [0, 1, 0], field_like_ratio: 0.25 },
        ],
        physics: {
          exchange: true,
          demag: true,
          zeeman: true,
          dmi: { enabled: true, kind: "interfacial", D_J_m2: 1.4e-3 },
          anisotropy: { enabled: true, kind: "uniaxial", Ku_J_m3: 8.2e5, axis: [0, 0, 1] },
          sot: { enabled: true, theta_sh: 0.12, axis: [0, 1, 0], field_like_ratio: 0.25 },
          stt: { enabled: true, kind: "zhang_li", xi: 0.04, polarization: 0.7 },
          absorbing_boundary: { enabled: true, width_m: 20e-9, damping_scale: 25 },
        },
        regions: [
          { id: "reg_skyrmion_core", name: "Skyrmion Core", priority: 10, geometry: { kind: "cylinder", radius: 36e-9, height: 20e-9 }, material_ref: "mat_yig", material_id: "mat_yig" },
          { id: "reg_pinning_ring", name: "Pinning Annulus", priority: 20, geometry: { kind: "cylinder", radius: 68e-9, height: 20e-9 }, material_ref: "mat_cofeb", material_id: "mat_cofeb" },
        ],
        frozen_spins: [
          {
            id: "frz_edge_pin",
            name: "Left Edge Pinning",
            schema_version: "1.0.0",
            enabled: true,
            selector: { kind: "in_region", object_id: "obj_yig_film", region_id: "reg_pinning_ring" },
            membership: { kind: "region", region_id: "reg_pinning_ring" },
            reference: { kind: "fixed_vector", direction: [0, 0, 1] },
            object_id: "obj_yig_film",
            region_id: "reg_pinning_ring",
            active: true,
          },
        ],
        magnetization: { kind: "skyrmion", radius: 36e-9, core_polarity: -1, helicity_rad: 0.49 },
      },
      {
        object_id: "obj_cpw_track",
        id: "obj_cpw_track",
        name: "CPW RF Antenna",
        type: "antenna",
        role: "antenna",
        geometry: {
          kind: "box",
          geometry_kind: "box",
          geometry_params: { size: [36e-9, 96e-9, 14e-9] },
          bounds_min: [-66e-9, -48e-9, 15e-9],
          bounds_max: [-30e-9, 48e-9, 29e-9],
          size: [36e-9, 96e-9, 14e-9],
          center: [-48e-9, 0, 22e-9],
        },
        shape: { kind: "cuboid", size: [36e-9, 96e-9, 14e-9] },
        transform: { translation: [-48e-9, 0, 22e-9], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material_ref: "mat_au",
        material_id: "mat_au",
        visible: true,
        magnetic: false,
        physics_stack: [],
        regions: [],
        allocated_region_ids: ["reg_cladding"],
        antenna_id: "ant_cpw_01",
      },
    ],
    selections: [],
    couplings: [
      {
        id: "cpl_rkky_01",
        coupling_id: "cpl_rkky_01",
        name: "Interlayer RKKY Exchange",
        kind: "rkky",
        coupling_kind: "rkky",
        source_object_id: "obj_yig_film",
        target_object_id: "obj_cpw_track",
        source: { object: "obj_yig_film", object_id: "obj_yig_film", selector: "top_surface" },
        target: { object: "obj_cpw_track", object_id: "obj_cpw_track", selector: "bottom_surface" },
        source_resolution: { object_id: "obj_yig_film", status: "resolved", resolved_face_count: 144 },
        target_resolution: { object_id: "obj_cpw_track", status: "resolved", resolved_face_count: 144 },
        params: { kind: "rkky", j1_J_m2: -1.2e-3 },
        J_J_m2: -1.2e-3,
        realization_status: "realized",
        enabled: true,
      },
    ],
    spin_transports: [
      {
        id: "st_sot_stack",
        name: "Pt/CoFeB Spin-Orbit Torque",
        object_id: "obj_yig_film",
        kind: "sot",
        theta_sh: 0.14,
        current_density_A_m2: 4.5e11,
        enabled: true,
      },
    ],
    spin_transport: [
      {
        id: "st_sot_stack",
        name: "Pt/CoFeB Spin-Orbit Torque",
        object_id: "obj_yig_film",
        kind: "sot",
        theta_sh: 0.14,
        current_density_A_m2: 4.5e11,
        enabled: true,
      },
    ],
    current_transports: [
      {
        name: "ct_cpw_au",
        kind: "current_transport",
        model: "ohmic_poisson",
        coupling: "one_way",
        conductivity_s_per_m: 4.1e7,
        domain: [{ object_id: "obj_cpw_track", region_id: null }],
        conservative_current_view: {
          stable_vertex_ids: ["v0", "v1"],
          boundary_faces: ["f0"],
          identity: { topology_hash: sha256Hex("cpw-conductor") },
          pins: { ports: ["port_cpw_inlet"] },
          closure: { net_current_a: 0 },
        },
      },
    ],
    spin_torques: [
      {
        id: "st_sot_stack",
        kind: "prescribed_sot",
        schema_version: "prescribed_sot.v1",
        formula_version: "prescribed_sot.fullmag.v1",
        free_layer_thickness_m: 8e-9,
        xi_dl: 0.14,
        xi_fl: 0.03,
        raw_spin_polarization: [0, 1, 0],
        drive: {
          kind: "signed_scalar",
          current_density_Apm2: 4.5e11,
          sigma_hat: [0, 1, 0],
          envelope: null,
        },
        target: { object_id: "obj_yig_film", region_id: null },
      },
    ],
    spin_interfaces: [
      {
        id: "si_pt_cofeb",
        name: "Pt | CoFeB Interface",
        left_object_id: "obj_cpw_track",
        right_object_id: "obj_yig_film",
        g_mix_real_S_m2: 4.2e14,
        g_mix_imag_S_m2: 2.1e13,
        enabled: true,
      },
    ],
    antennas: [
      {
        id: "ant_cpw_01",
        name: "Microstrip CPW Exciter",
        object_id: "obj_cpw_track",
        waveform_id: "wf_sinc_12ghz",
        current_A: 0.025,
        frequency_hz: 9.8e9,
        enabled: true,
      },
    ],
    antenna_port_modes: [
      {
        id: "port_cpw_inlet",
        schema_version: "antenna_port_mode.v2",
        source_object_id: "obj_cpw_track",
        current_transport_id: "ct_cpw_au",
        normalization_current_a: 1.0,
        branches: [
          {
            id: "branch_signal",
            inlet_terminal_ref: "term_sig_in",
            outlet_terminal_ref: "term_sig_out",
            signed_weight: 1.0,
          },
          {
            id: "branch_return",
            inlet_terminal_ref: "term_gnd_in",
            outlet_terminal_ref: "term_gnd_out",
            signed_weight: -1.0,
          },
        ],
      },
    ],
    antenna_field_solve_stages: [
      {
        id: "ant_solve_01",
        source_object_id: "obj_cpw_track",
        current_transport_id: "ct_cpw_au",
        port_mode_ids: ["port_cpw_inlet"],
        model: "quasistatic_conduction_biot_savart3d",
        oersted_realization: "direct_tetra_quadrature",
        conductor_mesh_policy: "auto",
        solver_policy: "direct",
        field_sampling_domain: { kind: "object", object_id: "obj_yig_film" },
        target_refs: [{ kind: "object", object_id: "obj_yig_film" }],
        outputs: [{ id: "out_h_ant_basis", quantity: "H_ant_basis" }],
      },
    ],
    antenna_target_projections: [
      {
        id: "proj_yig_film",
        output_id: "proj_out_yig",
        solution: {
          kind: "stage_output",
          stage_id: "ant_solve_01",
          output_id: "out_h_ant_basis",
        },
        target: { kind: "object", object_id: "obj_yig_film" },
      },
    ],
    solved_antenna_drives: [
      {
        id: "drv_cpw_sinc",
        name: "Broadband Sinc RF Drive (0-20 GHz)",
        port_mode_id: "port_cpw_inlet",
        projection_ref: "proj_yig_film",
        peak_current_a: 0.025,
        time_origin: "stage_local",
        waveform: {
          kind: "sinc_pulse",
          cutoff_hz: 20e9,
          t0: 5e-11,
          amplitude: 1.0,
        },
        activation: { kind: "all_time_evolution" },
      },
    ],
    planar_monitors: [
      {
        id: "planar_mon_core",
        name: "Mid-Plane RF Monitor",
        operator: { kind: "plane_sample" },
        target: { kind: "domain" },
        frame: {
          preset: "xy",
          origin_m: [0, 0, 0],
          normal: [0, 0, 1],
          u_axis: [1, 0, 0],
          v_axis: [0, 1, 0],
          normalization_version: "1.0.0",
          extent: { kind: "target_bounds", padding_m: 0 },
        },
        quantity: "M",
        frequency_hz: 9.8e9,
        sample_interval_s: 2e-12,
        resolution: [96, 96],
        enabled: true,
      },
    ],
    monitors: {
      planar: [
        {
          id: "planar_mon_core",
          name: "Mid-Plane RF Monitor",
          operator: { kind: "plane_sample" },
          target: { kind: "domain" },
          frame: {
            preset: "xy",
            origin_m: [0, 0, 0],
            normal: [0, 0, 1],
            u_axis: [1, 0, 0],
            v_axis: [0, 1, 0],
            normalization_version: "1.0.0",
            extent: { kind: "target_bounds", padding_m: 0 },
          },
          quantity: "M",
          frequency_hz: 9.8e9,
          sample_interval_s: 2e-12,
          resolution: [96, 96],
          enabled: true,
        },
      ],
    },
    field_drives: { drives: [] },
    oersted_fields: [],
    magnetization_assets: [],
    magnetization_constraints: [],
    antenna_spectrum_requests: [],
    outputs: {},
    study: null,
    editor: null,
    current_modules: null,
  };

  const activeLaneCapability = {
    schema_version: "active-lane-capabilities.v2",
    authored: {
      backend: isFem ? "fem" : "fdm",
      discretization: isFem ? "fem" : "fdm",
      device: "gpu",
      precision: "double",
      mode: "strict",
    },
    requested: {
      backend: isFem ? "fem" : "fdm",
      discretization: isFem ? "fem" : "fdm",
      device: "gpu",
      precision: "double",
      mode: "strict",
    },
    resolved: {
      backend: isFem ? "fem" : "fdm",
      discretization: isFem ? "fem" : "fdm",
      device: "gpu",
      precision: "double",
      mode: "strict",
    },
    source: {
      kind: "planner",
      capability_profile_version: "2026.11.15-docs",
      engine_id: isFem ? "fem_gpu_mfem" : "fdm_gpu_cuda",
      authored_intent: "problem_ir.runtime_selection",
      effective_request: "session.runtime_resolution",
    },
    qualification: {
      status: "not_asserted",
      reason: "Documentation fixture mode.",
    },
    operations: {
      grid_build: {
        state: "supported",
        reason_code: "capability_supported",
        reason: "Supported by resolved GPU lane.",
        requires: [isFem ? "discretization:fem" : "discretization:fdm"],
      },
    },
  };

  const capabilitiesResource = {
    profile_version: "2026.11.15-docs",
    schema_version: "capabilities.v2",
    engines: [
      { backend: "fdm", device: "cpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64" },
      { backend: "fdm", device: "gpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64", gpu_name: "NVIDIA RTX A5000" },
      { backend: "fem", device: "cpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64" },
      { backend: "fem", device: "gpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64", gpu_name: "NVIDIA RTX A5000" },
    ],
    discretization: isFem ? "fem" : "fdm",
    requested_backend: isFem ? "fem_gpu" : "fdm_gpu",
    requested_device: "cuda:0",
    resolved_backend: isFem ? "fem_gpu" : "fdm_gpu",
    resolved_device: "NVIDIA RTX A5000",
    resolved_runtime_family: isFem ? "mfem" : "fullmag_fdm",
    supported_discretizations: ["fdm", "fem"],
    supported_backends: ["fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"],
  };

  const sessionStatus = {
    api_contract_version: CONTRACT_VERSION,
    runtime_bundle_version: "2026.11.15-docs",
    session: {
      created_at: "2026-11-15T19:45:00Z",
      name: isStart && scenario === "start-screen-live" ? "fullmag-python-live" : "yig-waveguide",
      session_epoch: `${sessionId}@12`,
      request_scope_epoch: `${sessionId}:12`,
      session_id: sessionId,
      workspace_root: "/workspace/projects/yig_bench_2026",
      script: null,
    },
    capabilities: {
      active_lane: activeLaneCapability,
      algorithms_available: ["rk45", "llg", "eigenmode", "hysteresis"],
      binary_fields: true,
      cell_fields: !isFem,
      eigen_modes: true,
      explicit_topology: isFem,
      gpu_telemetry: true,
      node_fields: isFem,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: !isFem,
    },
    display: {
      active_quantity_id: "M",
      auto_contrast: true,
      colormap: "rdbu_r",
      contrast_max: null,
      contrast_min: null,
      field_component: "z",
      max_points: 10000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 18,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 48,
      y_chosen_size: 48,
    },
    domain: {
      cell_count: isFem ? femTopology.cellCount : 48 * 48,
      discretization: isFem ? "fem" : "fdm",
      generation_id: domainGenId,
    },
    lifecycle: {
      solver: isHysteresis || isEigen ? "completed" : "running",
      session_resource: "active",
      connectivity: "connected",
      commandability: "allowed",
    },
    energies: {
      exchange_J: 1.8e-18,
      demag_J: 0.9e-18,
      zeeman_J: -5.6e-18,
      anisotropy_J: -0.7e-18,
      dmi_J: -0.6e-18,
      total_J: -4.2e-18,
    },
    metrics: {
      steps_per_second: 1420,
      total_steps: 1840,
      uptime_seconds: 128,
    },
    resources: {
      artifact_revision: 1,
      artifacts_revision: 1,
      command_completion_revision: 1,
      commands_revision: 1,
      display_revision: vizRevision,
      domain_generation_id: domainGenId,
      engine_log_revision: 3,
      field_catalog_revision: 2,
      field_revision: 12,
      fields_revision: 12,
      mesh_build_revision: isFem ? 4 : 2,
      mesh_revision: isFem ? 4 : 2,
      mode_composition_revision: 1,
      region_coefficients_revision: 2,
      region_initial_state_revision: 2,
      region_membership_revision: 2,
      region_topology_revision: 2,
      scalars_revision: 12,
      scene_revision: 12,
      simulation_preparation_revision: 1,
      slice_revision: 2,
      solver_profile_revision: 1,
      stages_revision: 3,
      table_revision: 12,
      topology_revision: isFem ? 4 : 2,
      visualization_revision: vizRevision,
      visualization_state_revision: vizRevision,
      workspace_revision: 1,
    },
    run: {
      calibration_id: null,
      requested_device: "cuda:0",
      resolved_device: "NVIDIA RTX A5000",
      run_id: runId,
      selection_reason: "Strict GPU request matched CUDA device",
      solver_steps: 1840,
      solver_time: 1.84e-9,
      stage_count: 3,
      stage_id: stageId,
      stage_index: isHysteresis ? 1 : isEigen ? 2 : 0,
      stage_label: isHysteresis ? "B_x Hysteresis Sweep" : isEigen ? "FMR Eigenmodes" : "Ground State Relax",
      started_at: "2026-11-15T19:45:02Z",
      state: isHysteresis || isEigen ? "completed" : "running",
      step: 1840,
      time_s: 1.84e-9,
    },
    energies: {
      anisotropy: -7.0e-19,
      demag: 9.0e-19,
      dmi: -6.0e-19,
      exchange: 1.8e-18,
      total: -4.2e-18,
      zeeman: -5.6e-18,
    },
    solver: {
      algorithm: "RK45",
      converged: isHysteresis || isEigen,
      dt: 1.25e-13,
      integrator: "RK45",
      max_torque: 8.2e-7,
      max_torque_T: 8.2e-7,
      relaxation_algorithm: "L-BFGS",
      state: isHysteresis || isEigen ? "idle" : "running",
      step: 1840,
      time_s: 1.84e-9,
    },
    project: isSaved
      ? {
          state: "ready",
          project_id: "proj_yig_bench_2026",
          name: "YIG Dispersion & Hysteresis Benchmark",
          path: "/workspace/projects/yig_bench_2026.fmproj",
        }
      : { state: "closed", project_id: null },
  };

  const studyStages = [
    {
      stage_id: "stage_relax_01",
      name: "Ground State Relax",
      kind: "relax",
      order: 0,
      status: "completed",
      max_torque: 1e-6,
      max_time_s: 2.5e-9,
    },
    {
      stage_id: "stage_hysteresis_01",
      name: "B_x Hysteresis Sweep",
      kind: "hysteresis",
      order: 1,
      status: isHysteresis ? "completed" : "queued",
      branch_mode: "major_loop",
      initial_protocol: "positive_saturation",
      measurement_axis: "field_axis",
      orientation: { kind: "preset", preset_name: "in_plane_x" },
      field_min_mT: -60,
      field_max_mT: 60,
      field_step_mT: 3,
      field_min_T: -0.06,
      field_max_T: 0.06,
      num_steps: 41,
      direction: [1, 0.05, 0],
      include_minor_loops: true,
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            kind: "relax",
            method: "llg_overdamped",
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10000,
            on_non_convergence: "continue_with_warning",
          },
        ],
      },
      storage: {
        scalar_history: true,
        magnetization: "selected",
        every_n: 5,
        key_events: true,
        key_event_threshold_dm: 0.02,
      },
    },
    {
      stage_id: "stage_eigen_01",
      name: "FMR Eigenmodes (k=0..25 um^-1)",
      kind: "eigenmode",
      order: 2,
      status: isEigen ? "completed" : "queued",
      num_modes: 8,
      frequency_min_hz: 2e9,
      frequency_max_hz: 16e9,
    },
  ];
  sceneResource.study = {
    requested_backend: isFem ? "fem" : "fdm",
    requested_device: "cuda:0",
    requested_mode: "strict",
    requested_precision: "double",
    stages: studyStages,
  };

  // Hysteresis branches & points conforming to HysteresisPointSchema
  const hystDesc = [];
  const hystAsc = [];
  const hystMinor = [];
  for (let i = 0; i < 41; i += 1) {
    const frac = i / 40;
    const hValDesc = 0.06 - frac * 0.12;
    const hMtDesc = Number((hValDesc * 1000).toFixed(3));
    const mValDesc = Math.tanh((hValDesc + 0.018) / 0.008);
    const mOop = 0.03 * (1 - mValDesc * mValDesc);
    const mAvg = [mValDesc * 0.99, 0.08 * (1 - mValDesc * mValDesc), mOop];
    const pid = i + 1;
    hystDesc.push({
      point_id: pid,
      branch_id: "descending",
      step_index: i,
      field_value_mT: hMtDesc,
      m_parallel: mValDesc,
      m_oop: mOop,
      m_ip: Math.hypot(mAvg[0], mAvg[1]),
      m_avg: mAvg,
      H_T: [hValDesc, 0.003, 0],
      H_proj_T: hValDesc,
      M_norm: mAvg,
      M_proj_norm: mValDesc,
      snapshot_id: i % 8 === 0 || i === 14 ? `hyst_snap_desc_${pid}` : null,
      snapshot_storage_status: i % 8 === 0 || i === 14 ? "available" : "not_saved",
      snapshot_storage_reason: null,
      is_reversal_field: i === 0 || i === 40,
      adaptive_inserted: i === 14 || i === 16,
      has_non_converged_steps: false,
      status: "converged",
      converged: true,
      residual: 4.2e-7,
      settle_time_s: 0.45e-9,
    });
  }
  for (let i = 0; i < 41; i += 1) {
    const frac = i / 40;
    const hValAsc = -0.06 + frac * 0.12;
    const hMtAsc = Number((hValAsc * 1000).toFixed(3));
    const mValAsc = Math.tanh((hValAsc - 0.018) / 0.008);
    const mOop = -0.03 * (1 - mValAsc * mValAsc);
    const mAvg = [mValAsc * 0.99, -0.08 * (1 - mValAsc * mValAsc), mOop];
    const pid = 101 + i;
    hystAsc.push({
      point_id: pid,
      branch_id: "ascending",
      step_index: i,
      field_value_mT: hMtAsc,
      m_parallel: mValAsc,
      m_oop: mOop,
      m_ip: Math.hypot(mAvg[0], mAvg[1]),
      m_avg: mAvg,
      H_T: [hValAsc, 0.003, 0],
      H_proj_T: hValAsc,
      M_norm: mAvg,
      M_proj_norm: mValAsc,
      snapshot_id: i % 8 === 0 || i === 26 ? `hyst_snap_asc_${pid}` : null,
      snapshot_storage_status: i % 8 === 0 || i === 26 ? "available" : "not_saved",
      snapshot_storage_reason: null,
      is_reversal_field: i === 0 || i === 40,
      adaptive_inserted: i === 25 || i === 27,
      has_non_converged_steps: false,
      status: "converged",
      converged: true,
      residual: 3.9e-7,
      settle_time_s: 0.43e-9,
    });
  }
  for (let i = 0; i < 15; i += 1) {
    const hMin = -0.018 + (i / 14) * 0.045;
    const hMtMin = Number((hMin * 1000).toFixed(3));
    const mMin = 0.55 * Math.tanh((hMin - 0.004) / 0.007) - 0.15;
    const mAvg = [mMin, 0.12, 0.03];
    const pid = 201 + i;
    hystMinor.push({
      point_id: pid,
      branch_id: "minor_loop_01",
      step_index: i,
      field_value_mT: hMtMin,
      m_parallel: mMin,
      m_oop: 0.03,
      m_ip: Math.hypot(mAvg[0], mAvg[1]),
      m_avg: mAvg,
      H_T: [hMin, 0.003, 0],
      H_proj_T: hMin,
      M_norm: mAvg,
      M_proj_norm: mMin,
      snapshot_id: i === 7 ? `hyst_snap_minor_${pid}` : null,
      snapshot_storage_status: i === 7 ? "available" : "not_saved",
      snapshot_storage_reason: null,
      is_reversal_field: i === 0 || i === 14,
      adaptive_inserted: false,
      has_non_converged_steps: false,
      status: "converged",
      converged: true,
      residual: 4.8e-7,
      settle_time_s: 0.51e-9,
    });
  }
  const hystPoints = [...hystDesc, ...hystAsc, ...hystMinor];

  // Eigen spectrum & dispersion CSV & FMR response sweep
  const eigenModes = [
    { sample_index: 0, mode_index: 0, raw_mode_index: 0, mode_id: "mode_00", branch_id: "bv_bulk", frequency_hz: 6.42e9, damping_hz: 0.042e9, damping_rate_hz: 0.042e9, q_factor: 76.4, residual: 1.8e-8, residual_norm: 1.8e-8, mode_field_available: true, mode_field_id: "eigen_mode_0_0", mode_field_resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/0/meta", spatial_symmetry: "n=0 (Fundamental Kittel)" },
    { sample_index: 0, mode_index: 1, raw_mode_index: 1, mode_id: "mode_01", branch_id: "bv_bulk", frequency_hz: 7.95e9, damping_hz: 0.055e9, damping_rate_hz: 0.055e9, q_factor: 72.3, residual: 2.3e-8, residual_norm: 2.3e-8, mode_field_available: true, mode_field_id: "eigen_mode_0_1", mode_field_resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/1/meta", spatial_symmetry: "n=1 (Center-Pinned BV)" },
    { sample_index: 0, mode_index: 2, raw_mode_index: 2, mode_id: "mode_02", branch_id: "de_surface", frequency_hz: 9.84e9, damping_hz: 0.068e9, damping_rate_hz: 0.068e9, q_factor: 72.4, residual: 3.1e-8, residual_norm: 3.1e-8, mode_field_available: true, mode_field_id: "eigen_mode_0_2", mode_field_resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/2/meta", spatial_symmetry: "n=2 (DE Surface Mode)" },
    { sample_index: 0, mode_index: 3, raw_mode_index: 3, mode_id: "mode_03", branch_id: "de_surface", frequency_hz: 11.45e9, damping_hz: 0.082e9, damping_rate_hz: 0.082e9, q_factor: 69.8, residual: 4.0e-8, residual_norm: 4.0e-8, mode_field_available: true, mode_field_id: "eigen_mode_0_3", mode_field_resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/3/meta", spatial_symmetry: "n=3 (Radial Edge Mode)" },
    { sample_index: 0, mode_index: 4, raw_mode_index: 4, mode_id: "mode_04", branch_id: "de_surface", frequency_hz: 13.18e9, damping_hz: 0.095e9, damping_rate_hz: 0.095e9, q_factor: 69.4, residual: 5.2e-8, residual_norm: 5.2e-8, mode_field_available: true, mode_field_id: "eigen_mode_0_4", mode_field_resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/4/meta", spatial_symmetry: "n=4 (PSSW Thickness-1)" },
  ];

  const dispersionRows = [
    "sample_index,sample_id,raw_mode_index,mode_id,branch_id,path_s_rad_per_m,frequency_hz,mode_field_available,mode_field_id",
  ];
  for (let si = 0; si <= 24; si += 1) {
    const k = si * 1.0e6;
    const kn = k / 2.4e7;
    const fBv = (6.42 - 0.85 * (1 - Math.exp(-k / 4.5e6)) + 1.95 * kn * kn) * 1e9;
    const fDe = (7.25 + 4.4 * (1 - Math.exp(-k / 7.5e6)) + 1.2 * kn * kn) * 1e9;
    const fPssw = (10.6 + 2.8 * kn * kn) * 1e9;
    const sId = `k-path-sample-${String(si).padStart(5, "0")}`;
    const mf0 = si === 0;
    dispersionRows.push(`${si},${sId},0,mode_bv_${si},bv_bulk,${k},${Math.round(fBv)},${mf0},${mf0 ? "eigen_mode_0_0" : ""}`);
    dispersionRows.push(`${si},${sId},1,mode_de_${si},de_surface,${k},${Math.round(fDe)},${si === 0 || si === 6},${si === 0 ? "eigen_mode_0_2" : ""}`);
    dispersionRows.push(`${si},${sId},2,mode_pssw_${si},pssw_1,${k},${Math.round(fPssw)},false,`);
  }
  const dispersionCsvText = dispersionRows.join("\n");

  const sweepFreqs = [];
  const chiXxIm = [];
  const chiXxRe = [];
  for (let i = 0; i < 141; i += 1) {
    const fGHz = 2.0 + i * 0.1;
    sweepFreqs.push(fGHz * 1e9);
    let im = 0.04;
    let re = 0.2;
    for (const m of eigenModes) {
      const f0 = m.frequency_hz / 1e9;
      const lw = 0.18;
      const amp = m.mode_index === 0 ? 12.5 : m.mode_index === 2 ? 9.4 : 4.2;
      const df = fGHz - f0;
      im += (amp * lw * lw) / (df * df + lw * lw);
      re += (-amp * df * lw) / (df * df + lw * lw);
    }
    chiXxIm.push(im);
    chiXxRe.push(re);
  }

  function jsonResponse(body, extraHeaders = {}, status = 200) {
    return {
      status,
      headers: {
        ...REQUEST_BASE_HEADERS,
        "content-type": "application/json",
        etag: `"doc-${status}-${Buffer.byteLength(JSON.stringify(body))}"`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  function binaryResponse(buffer, rangeHeader, extraHeaders = {}) {
    const etag = `"bin-${buffer.byteLength}-${createHash("sha256").update(buffer).digest("hex").slice(0, 12)}"`;
    const resp = binaryRangeFulfillOptions(buffer, rangeHeader, {
      ...REQUEST_BASE_HEADERS,
      etag,
      "x-fullmag-domain-generation-id": domainGenId,
      ...extraHeaders,
    });
    return resp;
  }

  async function install(context) {
    const lsSeed = {
      "fullmag.control-room.theme": theme,
      ...(instanceTabs ? { "fullmag.instance-tabs.v1": JSON.stringify(instanceTabs) } : {}),
    };

    await context.addInitScript(({ lsSeed, originBase, sessionId }) => {
      try {
        for (const [k, v] of Object.entries(lsSeed)) {
          window.localStorage.setItem(k, v);
        }
      } catch (_) {}

      window.__FULLMAG_CONFIG__ = {
        allowMissingSessionSmoke: true,
        controlRoomApiBase: originBase,
        defaultSessionId: sessionId,
      };

      // Strict backend WebSocket mock: forward only Next.js dev HMR; zero backend WS traffic leaves Playwright.
      const OrigWebSocket = window.WebSocket;
      class MockWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url, protocols) {
          const urlStr = String(url);
          if (urlStr.includes("/_next/")) {
            return protocols !== undefined
              ? new OrigWebSocket(url, protocols)
              : new OrigWebSocket(url);
          }
          super();
          this.url = urlStr;
          this.protocol = Array.isArray(protocols) ? (protocols[0] ?? "") : (protocols ?? "");
          this.readyState = MockWebSocket.CONNECTING;
          this.bufferedAmount = 0;
          this.extensions = "";
          this.binaryType = "blob";
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.onclose = null;

          setTimeout(() => {
            if (this.readyState === MockWebSocket.CLOSED) return;
            this.readyState = MockWebSocket.OPEN;
            const ev = new Event("open");
            if (typeof this.onopen === "function") this.onopen(ev);
            this.dispatchEvent(ev);
          }, 8);
        }

        send(data) {
          if (typeof data === "string" && data.includes("ping")) {
            setTimeout(() => {
              if (this.readyState !== MockWebSocket.OPEN) return;
              const msg = new MessageEvent("message", { data: JSON.stringify({ type: "pong" }) });
              if (typeof this.onmessage === "function") this.onmessage(msg);
              this.dispatchEvent(msg);
            }, 5);
          }
        }

        close(code = 1000, reason = "") {
          this.readyState = MockWebSocket.CLOSED;
          const ev = new CloseEvent("close", { code, reason, wasClean: true });
          if (typeof this.onclose === "function") this.onclose(ev);
          this.dispatchEvent(ev);
        }
      }

      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      });

      // Keep Next.js dev overlay & error portals hidden
      const hidePortal = () => {
        if (document.getElementById("__fm_hide_portal_css")) return;
        const style = document.createElement("style");
        style.id = "__fm_hide_portal_css";
        style.textContent = "nextjs-portal { display: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", hidePortal, { once: true });
      } else {
        hidePortal();
      }
    }, { lsSeed, originBase: "http://127.0.0.1:3274", sessionId });

    // Route cross-port discovery frames/pings cleanly so zero traffic leaks to 3206/3212
    await context.route(/^http:\/\/127\.0\.0\.1:(3206|3212)\/.*/, async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" });
    });

    await context.route("**/v2/**", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const urlObj = new URL(request.url());
      // Normalize /v2/sessions/<sessionId>/... to /v2/sessions/current/... so URL slug routes share handlers cleanly
      const p = urlObj.pathname.replace(/^\/v2\/sessions\/(?!$)(?:[^/]+)\//, "/v2/sessions/current/");
      const q = urlObj.searchParams;
      const rangeHeader = request.headers()["range"];

      if (method === "OPTIONS") {
        await route.fulfill({ status: 204, headers: REQUEST_BASE_HEADERS, body: "" });
        return;
      }

      if (extraRoutes) {
        const custom = await extraRoutes({ method, pathname: p, searchParams: q, request, url: urlObj });
        if (custom) {
          await route.fulfill(custom);
          return;
        }
      }

      const fulfill = async (res) => route.fulfill(res);

      // ---- Platform & Instance Discovery ----
      if (p === "/v2/platform/handshake") {
        return fulfill(jsonResponse({
          api_contract_version: CONTRACT_VERSION,
          runtime_bundle_version: "2026.11.15-docs",
          server_time_utc: "2026-11-15T20:00:00Z",
          capabilities: capabilitiesResource,
        }));
      }
      if (p === "/v2/platform/health") {
        return fulfill(jsonResponse({
          active_session: true,
          status: "healthy",
          api_contract_version: CONTRACT_VERSION,
          runtime_bundle_version: "2026.11.15-docs",
          uptime_seconds: 128,
          backend_ready: true,
        }));
      }
      if (p === "/v2/platform/capabilities") {
        return fulfill(jsonResponse({
          profile_version: "2026.11.15-docs",
          schema_version: "platform_capabilities.v1",
          engines: [
            { backend: "fdm", device: "cpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64" },
            { backend: "fdm", device: "gpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64", gpu_name: "NVIDIA RTX A5000" },
            { backend: "fem", device: "cpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64" },
            { backend: "fem", device: "gpu", mode: "strict", public: true, stability: "production", status: "available", precision: "f64", gpu_name: "NVIDIA RTX A5000" },
          ],
        }));
      }
      if (p === "/v2/platform/compute/nodes") {
        return fulfill(jsonResponse({
          schema_version: "compute_nodes.v1",
          state: "current",
          stale_after_seconds: 30,
          nodes: [
            {
              node_id: "desktop-host",
              state: "current",
              stale_after_seconds: 30,
              node_policy: null,
              snapshot: {
                schema_version: "compute_node_snapshot.v1",
                node_id: "desktop-host",
                inventory_revision: 7,
                sample: {
                  source: "host_os",
                  collected_at: new Date().toISOString(),
                  freshness: { status: "current" },
                },
                cpu: {
                  topology: {
                    status: "available",
                    value: {
                      logical_cpus: [
                        { id: 0, socket_id: 0, numa_node_id: 0, core_id: 0 },
                        { id: 1, socket_id: 0, numa_node_id: 0, core_id: 0 },
                        { id: 2, socket_id: 0, numa_node_id: 0, core_id: 1 },
                        { id: 3, socket_id: 0, numa_node_id: 0, core_id: 1 },
                      ],
                    },
                  },
                  os_constraints: {
                    allowed_logical_cpu_ids: { status: "available", value: [0, 1, 2, 3] },
                    quota: { status: "available", value: { mode: "unlimited" } },
                  },
                  effective_capacity_millis: { status: "available", value: 4000 },
                },
                memory: {
                  total_bytes: { status: "available", value: 137_438_953_472 },
                  available_bytes: { status: "available", value: 98_200_000_000 },
                },
                gpus: {
                  status: "available",
                  value: [
                    {
                      uuid: "GPU-docs-rtx-a5000",
                      name: { status: "available", value: "NVIDIA RTX A5000" },
                      pci_id: { status: "available", value: "0000:01:00.0" },
                      vram_bytes: { status: "available", value: 25_769_803_776 },
                      partition: { status: "available", value: { kind: "full_device" } },
                      topology: { status: "available", value: { numa_node_id: 0, pci_root_id: "0000:00" } },
                    },
                  ],
                },
                enforcement: {
                  cpu_affinity: "supported",
                  cpu_quota: "advisory",
                  memory_cap: "supported",
                  gpu_visibility: "supported",
                  storage_quota: "supported",
                },
              },
            },
          ],
        }));
      }
      if (p === "/v2/platform/startup") {
        return fulfill(jsonResponse({
          status: "ready",
          session_id: sessionId,
          default_route: isStart ? "/home" : "/session/yig-waveguide",
          project: sessionStatus.project,
        }));
      }
      if (p === "/v2/platform/instances") {
        return fulfill(jsonResponse({
          schema_version: "platform.instances.v1",
          first_port: 3200,
          last_port: 3299,
          self_api_instance_id: "inst_fullmag_3274",
          instances: [
            {
              api_instance_id: "inst_fullmag_3274",
              is_self: true,
              port: 3274,
              sessions: [
                {
                  current: true,
                  name: "yig-waveguide",
                  session_id: sessionId,
                  status: "running",
                },
              ],
            },
            {
              api_instance_id: "inst_fullmag_3206",
              is_self: false,
              port: 3206,
              sessions: [
                {
                  current: true,
                  name: "skyrmion-dmi-sweep",
                  session_id: "sess-skyrmion-fdm-3206",
                  status: "completed",
                },
              ],
            },
            {
              api_instance_id: "inst_fullmag_3212",
              is_self: false,
              port: 3212,
              sessions: [
                {
                  current: true,
                  name: "perpendicular-anisotropy-loop",
                  session_id: "sess-hysteresis-cpu-3212",
                  status: "idle",
                },
              ],
            },
          ],
        }));
      }
      if (p.startsWith("/v2/workspace/settings/")) {
        const settingKey = p.slice("/v2/workspace/settings/".length);
        return fulfill(jsonResponse({ key: settingKey, value: settingKey === "telemetry.enabled" ? true : false }));
      }
      if (p === "/v2/workspace/items") {
        return fulfill(jsonResponse({
          outcome: { state: "ready" },
          items: [
            {
              id: "1",
              kind: "project",
              name: "YIG Dispersion & Hysteresis Benchmark",
              path: "/workspace/projects/yig_bench_2026.fmproj",
              project_id: "proj_yig_bench_2026",
              status: "ready",
              pinned: true,
              has_thumbnail: false,
              first_seen_at: "2026-11-12T10:00:00Z",
              last_used_at: "2026-11-15T19:45:00Z",
              modified_at: "2026-11-15T19:45:00Z",
              size_bytes: 184_250_368,
              use_count: 14,
              meta: { discretization: "fem", backend: "fem_gpu", object_count: 2 },
            },
            {
              id: "2",
              kind: "script",
              name: "skyrmion_sot_racetrack.py",
              path: "/workspace/examples/skyrmion_sot_racetrack.py",
              status: "ready",
              pinned: false,
              has_thumbnail: false,
              first_seen_at: "2026-11-14T11:00:00Z",
              last_used_at: "2026-11-15T17:20:00Z",
              modified_at: "2026-11-15T17:20:00Z",
              size_bytes: 4_820,
              use_count: 7,
              meta: { discretization: "fdm", backend: "fdm_gpu" },
            },
            {
              id: "3",
              kind: "result",
              name: "run_sweep_042_fem.zarr",
              path: "/workspace/results/run_sweep_042_fem.zarr",
              status: "ready",
              pinned: false,
              has_thumbnail: false,
              first_seen_at: "2026-11-15T18:10:00Z",
              last_used_at: "2026-11-15T19:42:00Z",
              modified_at: "2026-11-15T19:42:00Z",
              size_bytes: 92_104_000,
              use_count: 3,
              meta: { run_id: "run_sweep_042_fem", status: "completed" },
            },
          ],
        }));
      }
      if (p.startsWith("/v2/workspace/items/")) {
        const itemId = p.split("/").pop();
        const isBench = itemId === "1";
        return fulfill(jsonResponse({
          item: {
            id: itemId || "1",
            kind: isBench ? "project" : itemId === "2" ? "script" : "result",
            name: isBench ? "YIG Dispersion & Hysteresis Benchmark" : itemId === "2" ? "skyrmion_sot_racetrack.py" : "run_sweep_042_fem.zarr",
            path: isBench ? "/workspace/projects/yig_bench_2026.fmproj" : itemId === "2" ? "/workspace/examples/skyrmion_sot_racetrack.py" : "/workspace/results/run_sweep_042_fem.zarr",
            project_id: "proj_yig_bench_2026",
            status: "ready",
            pinned: isBench,
            has_thumbnail: false,
            first_seen_at: "2026-11-12T10:00:00Z",
            last_used_at: "2026-11-15T19:45:00Z",
            modified_at: "2026-11-15T19:45:00Z",
            size_bytes: 184_250_368,
            use_count: 14,
            meta: { discretization: "fem", backend: "fem_gpu", object_count: 2 },
          },
          read_at: "2026-11-15T19:58:00Z",
          linked_results: [],
          events: [
            { at: "2026-11-15T19:45:00Z", kind: "run_completed", actor: "fem-gpu-worker", detail: { stages: 3, converged: true } },
          ],
          detail: {
            kind: "project",
            schema_version: "fmproj.v2",
            revision: 12,
            solver: "fem_gpu",
            can_write: true,
            mode: "readwrite",
            warnings: [],
            summary: {
              model: {
                discretisation: "FEM (P1)",
                materials: ["YIG"],
                ms: "140 kA/m",
                aex: "3.7 pJ/m",
                alpha: "0.0005",
                interactions: ["exchange", "demag", "zeeman"],
              },
              execution: {
                integrator: "RK45",
                tolerance: "1e-6",
                excitation: "CPW RF",
              },
              outputs: {
                frames: 64,
                size_bytes: 184_250_368,
              },
            },
            authors: [{ name: "M. Kowalski", role: "Lead Researcher", affiliation: "Fullmag Lab" }],
            runs: [{ run_id: "run_sweep_042_fem", status: "completed", duration_seconds: 12.4, device: "NVIDIA RTX A5000" }],
            history: [{ at: "2026-11-15T19:45:00Z", kind: "save", revision: 12, summary: "Verified YIG dispersion & hysteresis stages" }],
          },
        }));
      }
      if (p === "/v2/sessions") {
        return fulfill(jsonResponse({
          schema_version: "sessions.v1",
          sessions: [
            {
              session_id: sessionId,
              name: isStart && scenario === "start-screen-live" ? "fullmag-python-live" : "yig-waveguide",
              current: true,
              title: "Interactive Skyrmion Benchmark (fm.connect)",
              status: "running",
              discretization: isFem ? "fem" : "fdm",
              requested_backend: isFem ? "fem_gpu" : "fdm_gpu",
              resolved_backend: isFem ? "fem_gpu" : "fdm_gpu",
              resolved_device: "NVIDIA RTX A5000",
              client_kind: "python_sdk",
              pid: 48210,
              updated_at: "2026-11-15T19:58:12Z",
            },
            {
              session_id: "sess-recent-cofeb-02",
              name: "cofeb-sot-switching",
              current: false,
              title: "CoFeB/Pt SOT Switching Study",
              status: "completed",
              discretization: "fdm",
              requested_backend: "fdm_gpu",
              resolved_backend: "fdm_gpu",
              resolved_device: "NVIDIA RTX A5000",
              client_kind: "control_room",
              updated_at: "2026-11-15T17:20:00Z",
            },
          ],
        }));
      }

      // ---- Persistence / Projects / Recent ----
      const persistedStudyResultMatch =
        /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/study-results(?:\/([^/]+)(?:\/(magnetization|topology|support|scalars))?)?$/.exec(
          p
        );
      if (persistedStudyResultMatch) {
        const reqProjId = decodeURIComponent(persistedStudyResultMatch[1]);
        const reqRunId = decodeURIComponent(persistedStudyResultMatch[2]);
        const reqArtifactId = persistedStudyResultMatch[3]
          ? decodeURIComponent(persistedStudyResultMatch[3])
          : null;
        const reqSub = persistedStudyResultMatch[4] ?? null;
        const savedArtifactSha = "b7d2c1e9f0123456789abcdef0123456789abcdef0123456789abcdef0123456";
        const savedDomGenHex = sha256Hex(`saved-study-domgen-${reqRunId}`);
        const savedTopoHex = sha256Hex(`saved-study-topo-${reqRunId}`);
        const savedSource = {
          attempt_id: "att_01",
          case_id: "case_default",
          ownership_epoch: 1,
          run_id: reqRunId,
          step_id: stageId,
          task_id: "task_01",
        };
        if (!reqArtifactId) {
          return fulfill(jsonResponse({
            project_id: reqProjId,
            revision: "12",
            scene_revision: 12,
            authored_stage_ids: [stageId],
            authored_input_sha256: null,
            next_cursor: null,
            results: [
              {
                accepted_at: "2026-11-15T19:52:00Z",
                artifact_id: "art_stage_result_01",
                artifact_sha256: savedArtifactSha,
                authored_relation: "matching_authored_input",
                authored_stage_id: stageId,
                codec_id: "fmsp.v1",
                codec_version: "1",
                completion: {
                  converged: true,
                  metric_kind: "max_torque_apm",
                  metric_name: "max_torque",
                  metric_unit: "A/m",
                  metric_value: 8.2e-6,
                  reason: "torque",
                  threshold: 1e-5,
                },
                domain_relation: "matching_published_layout",
                initial_state: null,
                predecessor_relation: null,
                project_id: reqProjId,
                source: savedSource,
                study_id: "study_yig_01",
                supports_magnetization_input: true,
              },
            ],
          }));
        }
        if (reqSub === "magnetization") {
          const buf = encodeFmvpV3({
            quantityId: "m",
            grid: fdmData.grid,
            nComp: 3,
            data: new Float64Array(fdmData.mVec),
            domainGenerationId: savedDomGenHex,
            meshTopologyHashHex: savedTopoHex,
            scopeKind: "full",
          });
          const resp = binaryRangeFulfillOptions(buf, request.headers()["range"], {
            "access-control-allow-origin": "*",
            "x-fullmag-source-id": reqArtifactId,
            "x-fullmag-field-generation-id": savedArtifactSha,
            "x-fullmag-domain-generation-id": savedDomGenHex,
            "x-fullmag-mesh-topology-hash": savedTopoHex,
            etag: `"${savedArtifactSha}"`,
          });
          return fulfill({
            status: resp.status,
            headers: {
              ...resp.headers,
              "content-type": "application/octet-stream",
            },
            body: resp.body,
          });
        }
        if (reqSub === "scalars") {
          return fulfill(jsonResponse({
            artifact_id: reqArtifactId,
            columns: ["step", "time", "mx", "my", "mz", "e_total"],
            content_sha256: savedArtifactSha,
            coverage: "solver_series",
            next_start: null,
            rows: [
              [0, 0, 0.99, 0.05, 0.08, -4.1e-18],
              [920, 9.2e-10, 0.42, -0.04, 0.52, -4.18e-18],
              [1840, 1.84e-9, 0.042, -0.018, 0.684, -4.2e-18],
            ],
            series: savedSource,
            total_rows: 3,
          }));
        }
        const sampleCount = fdmData.grid[0] * fdmData.grid[1] * fdmData.grid[2];
        return fulfill(jsonResponse({
          artifact_id: reqArtifactId,
          artifact_sha256: savedArtifactSha,
          domain_generation_id: savedDomGenHex,
          geometry: {
            kind: "fdm",
            grid_cells: fdmData.grid,
            cell_size_m: fdmData.cellSize,
            origin_m: fdmData.bounds.min,
          },
          project_id: reqProjId,
          sample_count: sampleCount,
          source: savedSource,
          step: 1840,
          support_available: false,
          time_s: 1.84e-9,
          topology_fingerprint: savedTopoHex,
        }));
      }
      if (p === "/v2/persistence/projects") {
        return fulfill(jsonResponse({
          projects: [
            {
              project_id: "proj_yig_bench_2026",
              name: "YIG Dispersion & Hysteresis Benchmark",
              path: "/workspace/projects/yig_bench_2026.fmproj",
              discretization: "fem",
              updated_at: "2026-11-15T19:45:00Z",
              run_count: 2,
              size_bytes: 184_250_368,
            },
            {
              project_id: "proj_skyrmion_sot_09",
              name: "Pt/CoFeB Skyrmion Track (SOT)",
              path: "/workspace/projects/skyrmion_sot.fmproj",
              discretization: "fdm",
              updated_at: "2026-11-14T22:15:00Z",
              run_count: 5,
              size_bytes: 92_104_000,
            },
            {
              project_id: "proj_pma_hysteresis_04",
              name: "PMA Nanopillar Hysteresis",
              path: "/workspace/projects/pma_hysteresis.fmproj",
              discretization: "fdm",
              updated_at: "2026-11-13T16:40:00Z",
              run_count: 3,
              size_bytes: 48_910_000,
            },
          ],
        }));
      }
      if (p === "/v2/persistence/projects/proj_yig_bench_2026/runs") {
        return fulfill(jsonResponse({
          project_id: "proj_yig_bench_2026",
          next_cursor: null,
          runs: [
            {
              run_id: "run_sweep_042_fem",
              name: "RF Eigenmode & FMR Sweep #42",
              status: "completed",
              catalog_state: "indexed",
              created_at: "2026-11-15T19:42:00Z",
              discretization: "fem",
              resolved_backend: "fem_gpu",
            },
            {
              run_id: "run_baseline_041_fdm",
              name: "Ground State Baseline #41",
              status: "completed",
              catalog_state: "indexed",
              created_at: "2026-11-15T18:10:00Z",
              discretization: "fdm",
              resolved_backend: "fdm_gpu",
            },
          ],
        }));
      }
      if (p === "/v2/persistence/projects/proj_yig_bench_2026/runs/run_sweep_042_fem") {
        return fulfill(jsonResponse({
          project_id: "proj_yig_bench_2026",
          run_id: "run_sweep_042_fem",
          status: "completed",
          tasks: [
            { task_id: "task_relax", lifecycle: "completed", readiness: { state: "ready" } },
            { task_id: "task_eigen", lifecycle: "completed", readiness: { state: "ready" } },
            { task_id: "task_fmr_sweep", lifecycle: "completed", readiness: { state: "ready" } },
          ],
        }));
      }
      const ssDigest = `sha256:${sha256Hex("ss_eigen_modes_r1")}`;
      if (p === "/v2/persistence/projects/proj_yig_bench_2026/runs/run_sweep_042_fem/solution-sets") {
        return fulfill(jsonResponse({
          schema_version: "fullmag.analysis.solution_set_discovery.v1",
          project_id: "proj_yig_bench_2026",
          run_id: "run_sweep_042_fem",
          next_cursor: null,
          items: [
            {
              solution_set_id: "ss_eigen_modes",
              revision: "1",
              manifest_digest: ssDigest,
              label: "Eigenmode Basis (8 Modes)",
              execution_status: "succeeded",
              assessment_status: "converged",
            },
          ],
        }));
      }
      if (p === "/v2/persistence/projects/proj_yig_bench_2026/runs/run_sweep_042_fem/solution-sets/ss_eigen_modes/revisions/1") {
        return fulfill(jsonResponse({
          schema_version: "fullmag.analysis.solution_revision.v1",
          project_id: "proj_yig_bench_2026",
          run_id: "run_sweep_042_fem",
          solution_set_id: "ss_eigen_modes",
          revision: "1",
          manifest_digest: ssDigest,
          execution_status: "succeeded",
          assessment_status: "converged",
          member_count: 2,
          members: [],
        }));
      }
      if (p === "/v2/persistence/projects/proj_yig_bench_2026/runs/run_sweep_042_fem/solution-sets/ss_eigen_modes/revisions/1/members") {
        return fulfill(jsonResponse({
          schema_version: "fullmag.analysis.solution_member_page.v1",
          project_id: "proj_yig_bench_2026",
          run_id: "run_sweep_042_fem",
          solution_set_id: "ss_eigen_modes",
          revision: "1",
          manifest_digest: ssDigest,
          next_cursor: null,
          items: [
            { member_id: "mode_00", label: "Kittel Mode 6.42 GHz", execution_status: "succeeded", assessment_status: "converged", scalars: { frequency_hz: 6.42e9, q_factor: 76.4 } },
            { member_id: "mode_02", label: "DE Surface Mode 9.84 GHz", execution_status: "succeeded", assessment_status: "converged", scalars: { frequency_hz: 9.84e9, q_factor: 72.4 } },
          ],
        }));
      }

      // ---- Session Status, Workspace, Ribbon & Capabilities ----
      if (p === "/v2/sessions/current/status") {
        return fulfill(jsonResponse(sessionStatus));
      }
      if (p === "/v2/sessions/current/capabilities") {
        return fulfill(jsonResponse(capabilitiesResource));
      }
      if (p === "/v2/sessions/current/capabilities/discretization") {
        return fulfill(jsonResponse({
          requested_discretization: isFem ? "fem" : "fdm",
          resolved_discretization: isFem ? "fem" : "fdm",
          requested_backend: capabilitiesResource.requested_backend,
          resolved_backend: capabilitiesResource.resolved_backend,
          resolved_device: capabilitiesResource.resolved_device,
          available_discretizations: ["fdm", "fem"],
        }));
      }
      if (p === "/v2/sessions/current/workspace") {
        return fulfill(jsonResponse(workspaceSnapshot));
      }
      if (p === "/v2/sessions/current/ui/ribbon") {
        return fulfill(jsonResponse({ schema_version: "ribbon.v1", revision: 1, groups: [] }));
      }

      // ---- Model & Authoring ----
      if (p === "/v2/sessions/current/model/scene") {
        return fulfill(jsonResponse(sceneResource));
      }
      if (p === "/v2/sessions/current/model/universe" || p === "/v2/sessions/current/model/universe/fit") {
        return fulfill(jsonResponse({
          mesh_dirty: false,
          object_bounds_min: [-96e-9, -96e-9, -6e-9],
          object_bounds_max: [96e-9, 96e-9, 10e-9],
          scene_revision: 12,
          study_universe_mesh: isFem
            ? {
                kind: "box",
                center_m: [0, 0, 2e-9],
                size_m: [420e-9, 420e-9, 180e-9],
              }
            : null,
          universe: isFem
            ? {
                mode: "explicit_airbox",
                min_m: [-210e-9, -210e-9, -90e-9],
                max_m: [210e-9, 210e-9, 94e-9],
                padding_m: 114e-9,
              }
            : {
                mode: "fdm_domain",
                min_m: [-96e-9, -96e-9, -6e-9],
                max_m: [96e-9, 96e-9, 10e-9],
              },
        }));
      }
      if (p === "/v2/sessions/current/model/readiness") {
        return fulfill(jsonResponse({ ready: true, status: "ready", checks: [], issues: [] }));
      }
      if (p === "/v2/sessions/current/model/geometry/capabilities") {
        return fulfill(jsonResponse({ csg_boolean: true, extrusion: true, transform: true, supported_shapes: ["cuboid", "cylinder", "ellipsoid", "polyhedron"] }));
      }
      if (p === "/v2/sessions/current/model/geometry/validation") {
        return fulfill(jsonResponse({
          valid: true,
          status: "valid",
          backend_target: capabilitiesResource.resolved_backend,
          dirty: false,
          diagnostics: [],
          issues: [],
        }));
      }
      if (p === "/v2/sessions/current/model/geometry/diagnostics") {
        return fulfill(jsonResponse({ schema_version: "geometry_diagnostics.v1", revision: 12, status: "healthy", objects: sceneResource.objects.map((o) => ({ object_id: o.id, valid: true, volume_m3: 2.048e-22 })) }));
      }
      if (p === "/v2/sessions/current/model/geometry/realizations/current") {
        return fulfill(jsonResponse({
          backend_target: capabilitiesResource.resolved_backend,
          bodies: sceneResource.objects.map((o) => {
            const c = o.geometry?.center_m ?? [0, 0, 0];
            const sz = o.geometry?.size_m ?? [160e-9, 80e-9, 20e-9];
            return {
              body_id: `${o.id}_body`,
              bounds_min: [c[0] - sz[0] / 2, c[1] - sz[1] / 2, c[2] - sz[2] / 2],
              bounds_max: [c[0] + sz[0] / 2, c[1] + sz[1] / 2, c[2] + sz[2] / 2],
              geometry_kind: o.geometry?.kind ?? "box",
              magnetization_ref: o.magnetization_ref ?? null,
              material_ref: o.material_ref ?? "mat_yig",
              object_id: o.id,
              object_name: o.name,
              provenance: ["authored_scene"],
              status: "realized",
              visible: o.visible !== false,
            };
          }),
          bounds_min: sceneResource.bounds.min,
          bounds_max: sceneResource.bounds.max,
          diagnostics: [],
          provenance: [],
          realization_revision: 12,
          region_candidates: [],
          source_scene_revision: 12,
          status: "realized",
        }));
      }
      if (p === "/v2/sessions/current/model/regions" || p === "/v2/sessions/current/model/regions/realized") {
        const regionEntries = [
          {
            id: "reg_skyrmion_core",
            region_id: "reg_skyrmion_core",
            object_id: "obj_yig_film",
            owner_object_id: "obj_yig_film",
            owner_path: "obj_yig_film",
            name: "Skyrmion Core",
            priority: 10,
            enabled: true,
            material_id: "mat_yig",
            material_ref: "mat_yig",
            material_overrides: [],
            material_parameter_fields: [],
            interaction_refs: [],
            magnetization_ref: null,
            mesh_part_ids: [],
            mesh_policy: null,
            bounds_min: [-36e-9, -36e-9, -10e-9],
            bounds_max: [36e-9, 36e-9, 10e-9],
            frame: null,
            realization_policy: "prefer_explicit",
            realization_status: "realized",
            region_kind: "material_region",
            shape: { kind: "cylinder", radius: 36e-9, height: 20e-9 },
            source: "authored_object_region",
            source_body_ids: ["obj_yig_film"],
            source_object_ids: ["obj_yig_film"],
            texture_override: null,
            volume_fraction: 0.24,
          },
          {
            id: "reg_pinning_ring",
            region_id: "reg_pinning_ring",
            object_id: "obj_yig_film",
            owner_object_id: "obj_yig_film",
            owner_path: "obj_yig_film",
            name: "Pinning Annulus",
            priority: 20,
            enabled: true,
            material_id: "mat_cofeb",
            material_ref: "mat_cofeb",
            material_overrides: [],
            material_parameter_fields: [],
            interaction_refs: [],
            magnetization_ref: null,
            mesh_part_ids: [],
            mesh_policy: null,
            bounds_min: [-68e-9, -68e-9, -10e-9],
            bounds_max: [68e-9, 68e-9, 10e-9],
            frame: null,
            realization_policy: "prefer_explicit",
            realization_status: "realized",
            region_kind: "material_region",
            shape: { kind: "cylinder", radius: 68e-9, height: 20e-9 },
            source: "authored_object_region",
            source_body_ids: ["obj_yig_film"],
            source_object_ids: ["obj_yig_film"],
            texture_override: null,
            volume_fraction: 0.42,
          },
        ];
        return fulfill(jsonResponse({
          revision: 12,
          scene_revision: 12,
          region_coefficients_revision: 2,
          region_initial_state_revision: 2,
          region_membership_revision: 2,
          region_topology_revision: 2,
          deferred_diagnostic_count: 0,
          material_parameter_field_count: 0,
          domain_generation_id: domainGenId,
          regions: regionEntries,
          realized_regions: regionLegend,
        }));
      }
      if (p === "/v2/sessions/current/model/regions/diagnostics") {
        return fulfill(jsonResponse({ valid: true, overlaps: [], gaps: [], status: "healthy" }));
      }
      if (p === "/v2/sessions/current/model/region-diagnostics") {
        return fulfill(jsonResponse({
          diagnostics: [],
          region_coefficients_revision: 2,
          region_initial_state_revision: 2,
          region_membership_revision: 2,
          region_topology_revision: 2,
          scene_revision: 12,
        }));
      }
      if (p === "/v2/sessions/current/model/material" || p.startsWith("/v2/sessions/current/model/objects/") && p.endsWith("/material")) {
        return fulfill(jsonResponse({
          revision: 12,
          material_id: "mat_yig",
          name: "Yttrium Iron Garnet (YIG)",
          Ms_A_m: 1.4e5,
          Aex_J_m: 3.7e-12,
          alpha: 2e-4,
          gamma_rad_s_T: 1.76e11,
          Ku1_J_m3: 8.2e5,
          anisotropy_axis: [0, 0, 1],
          dmi_D_J_m2: 1.4e-3,
          dmi_kind: "interfacial",
        }));
      }
      if (p === "/v2/sessions/current/model/material/fields" || p === "/v2/sessions/current/model/material-fields") {
        return fulfill(jsonResponse({ fields: [] }));
      }
      if (p === "/v2/sessions/current/model/physics-graph") {
        return fulfill(jsonResponse({
          schema_version: "physics_graph.v1",
          revision: 12,
          scene_revision: 12,
          modules: [
            {
              id: "current_pt_cofeb",
              kind: "current_transport",
              presentation: { family: "ohm_drift", label: "Pt/CoFeB Charge Transport" },
              applies_to: [{ kind: "object", object_id: "obj_yig_film" }],
              depends_on: [],
              activation: "active",
              capability: "reference_executable",
              source_path: "problem.physics.spin_transport[0]",
            },
            {
              id: "spin_yig_diffusion",
              kind: "spin_transport",
              presentation: { family: "spin_diffusion", label: "Spin Diffusion Channel" },
              applies_to: [{ kind: "object", object_id: "obj_yig_film" }],
              depends_on: ["current_pt_cofeb"],
              activation: "active",
              capability: "reference_executable",
              source_path: "problem.physics.spin_transport[0].channel",
            },
            {
              id: "st_sot_stack",
              kind: "spin_torque",
              presentation: { family: "sot_slonczewski", label: "Pt/CoFeB Spin-Orbit Torque" },
              applies_to: [{ kind: "object", object_id: "obj_yig_film" }],
              depends_on: ["spin_yig_diffusion"],
              activation: "active",
              capability: "reference_executable",
              source_path: "problem.physics.spin_transport[0].torque",
            },
            {
              id: "si_pt_cofeb",
              kind: "spin_interface",
              presentation: { family: "spin_mixing_conductance", label: "Pt | CoFeB HM/FM Interface" },
              applies_to: [{ kind: "cross_object", object_ids: ["obj_cpw_track", "obj_yig_film"] }],
              depends_on: ["spin_yig_diffusion"],
              activation: "active",
              capability: "reference_executable",
              source_path: "problem.physics.spin_interfaces[0]",
            },
          ],
          edges: [
            { from: "current_pt_cofeb", to: "spin_yig_diffusion", kind: "source" },
            { from: "spin_yig_diffusion", to: "st_sot_stack", kind: "source" },
            { from: "spin_yig_diffusion", to: "si_pt_cofeb", kind: "interface" },
          ],
          couplings: sceneResource.couplings,
        }));
      }
      if (p === "/v2/sessions/current/model/current-transports") {
        return fulfill(jsonResponse({
          revision: 12,
          scene_revision: 12,
          transports: sceneResource.current_transports ?? [],
          items: sceneResource.current_transports ?? [],
        }));
      }
      if (p === "/v2/sessions/current/model/spin-torques") {
        return fulfill(jsonResponse({
          items: sceneResource.spin_torques ?? [],
          scene_revision: 12,
        }));
      }
      if (p.startsWith("/v2/sessions/current/model/spin-torques/")) {
        const torqueId = decodeURIComponent(p.slice("/v2/sessions/current/model/spin-torques/".length));
        const item = (sceneResource.spin_torques ?? []).find((t) => t.id === torqueId) ?? sceneResource.spin_torques?.[0] ?? null;
        return fulfill(jsonResponse(item));
      }
      if (p === "/v2/sessions/current/model/oersted-fields") {
        return fulfill(jsonResponse({
          items: sceneResource.oersted_fields ?? [],
          scene_revision: 12,
        }));
      }
      if (p === "/v2/sessions/current/model/transport-validation") {
        return fulfill(jsonResponse({
          validation_version: "1.0.0",
          scene_revision: 12,
          execution: {
            authoring_allowed: true,
            qualification: "reference_executable",
            status: "supported",
            reason: null,
            requested_lane: { device: "gpu", discretization: "fdm", execution_mode: "strict", precision: "double" },
            resolved_lane: { device: "gpu", discretization: "fdm", execution_mode: "strict", precision: "double" },
          },
          semantic: { valid: true, issues: [] },
        }));
      }
      if (p === "/v2/sessions/current/model/planar-monitors") {
        return fulfill(jsonResponse({
          count: sceneResource.planar_monitors.length,
          monitors: sceneResource.planar_monitors,
          scene_revision: 12,
        }));
      }
      if (p.startsWith("/v2/sessions/current/model/planar-monitors/")) {
        const monitorId = decodeURIComponent(p.slice("/v2/sessions/current/model/planar-monitors/".length));
        const monitor =
          sceneResource.planar_monitors.find((m) => m.id === monitorId) ??
          sceneResource.planar_monitors[0];
        return fulfill(jsonResponse({ monitor, scene_revision: 12 }));
      }
      if (p === "/v2/sessions/current/model/couplings") {
        return fulfill(jsonResponse({ couplings: sceneResource.couplings, scene_revision: 12 }));
      }
      if (p === "/v2/sessions/current/model/magnetization/asset") {
        return fulfill(jsonResponse({ asset: null }));
      }
      if (p === "/v2/sessions/current/model/frozen-spins") {
        return fulfill(jsonResponse({
          count: sceneResource.objects[0].frozen_spins.length,
          definitions: sceneResource.objects[0].frozen_spins,
          revision: 12,
          runtime_application: null,
        }));
      }
      if (p.startsWith("/v2/sessions/current/model/frozen-spins/")) {
        return fulfill(jsonResponse({
          definition: sceneResource.objects[0].frozen_spins[0],
          revision: 12,
          runtime_application: null,
          runtime_status: { applied: true, frozen_cell_count: 412, total_cell_count: 2304 },
        }));
      }
      if (p === "/v2/sessions/current/model/spin-transport" || p === "/v2/sessions/current/model/spin-transports" || p.includes("/sot") || p.includes("/stt")) {
        return fulfill(jsonResponse({
          items: sceneResource.spin_transport,
          spin_transport: sceneResource.spin_transport,
          scene_revision: 12,
        }));
      }
      if (p === "/v2/sessions/current/model/spin-interfaces") {
        return fulfill(jsonResponse({
          items: sceneResource.spin_interfaces,
          interfaces: sceneResource.spin_interfaces,
          scene_revision: 12,
        }));
      }
      if (p === "/v2/sessions/current/model/antennas") {
        return fulfill(jsonResponse({ items: sceneResource.antennas, antennas: sceneResource.antennas }));
      }
      if (p.startsWith("/v2/sessions/current/data/antenna/stages/") && p.endsWith("/output-catalog")) {
        const parts = p.split("/");
        const stageId = decodeURIComponent(parts[parts.length - 2] || "ant_solve_01");
        const stage = (sceneResource.antenna_field_solve_stages || []).find((s) => s.id === stageId) ?? {
          id: stageId,
          port_mode_ids: ["port_cpw_inlet"],
          outputs: [{ id: "out_h_ant_basis", quantity: "H_ant_basis" }],
        };
        const outId = stage.outputs?.[0]?.id ?? "out_h_ant_basis";
        const contentDigest = sha256Hex("ant-basis-01");
        return fulfill(
          jsonResponse({
            schema_version: "antenna_stage_output_catalog.v1",
            resource_id: `antenna_stage_output_catalog:${stage.id}`,
            session_id: sessionId,
            session_epoch: `${sessionId}@12`,
            request_scope_epoch: `${sessionId}:12`,
            stage_id: stage.id,
            stage_kind: "antenna_field_solve",
            stage_revision: 12,
            port_mode_id: stage.port_mode_ids?.[0] ?? "port_cpw_inlet",
            solution_id: outId,
            status: "ready",
            diagnostic: null,
            content_digest: sha256Hex(`ant-catalog-${stage.id}`),
            outputs: [
              {
                output_id: outId,
                kind: "per_ampere_basis",
                manifest_ref: `manifests/${stage.id}.json`,
                quantity_ids: [stage.outputs?.[0]?.quantity ?? "H_ant_basis"],
                reused_existing: false,
                solution_ref: {
                  stage_id: stage.id,
                  output_id: outId,
                  asset_id: "asset_ant_basis_01",
                  content_digest: contentDigest,
                },
              },
            ],
          })
        );
      }
      if (p.startsWith("/v2/sessions/current/data/antenna/field-solutions/") && !p.includes("/payloads/")) {
        const solutionId = decodeURIComponent(p.slice("/v2/sessions/current/data/antenna/field-solutions/".length)) || "out_h_ant_basis";
        const contentDigest = sha256Hex("ant-basis-01");
        const projSig = sha256Hex("proj-sig-01");
        return fulfill(
          jsonResponse({
            schema_version: "antenna_field_solution.v1",
            resource_id: `antenna_field_solution:${solutionId}`,
            session_id: sessionId,
            session_epoch: `${sessionId}@12`,
            request_scope_epoch: `${sessionId}:12`,
            stage_id: "ant_solve_01",
            solution_id: solutionId,
            asset_id: "asset_ant_basis_01",
            content_digest: contentDigest,
            source_object_id: "obj_cpw_track",
            current_transport_id: "ct_cpw_au",
            quantity: "H_ant_basis",
            component: "H_ant_basis",
            status: "ready",
            gauge_policy: "coulomb",
            geometry_revision: "12",
            material_revision: "12",
            mesh_digest: sha256Hex("ant-mesh-01"),
            requested_execution: { backend: "fem", device: "cpu" },
            resolved_execution: { backend: "fem", device: "cpu" },
            solver_policy: { method: "biot_savart_quadrature", tolerance: 1e-8 },
            assumptions: [
              "Quasistatic Coulomb gauge magnetostatics",
              "Uniform port cross-section current normalization (1.0 A)",
            ],
            target_projection_signature: projSig,
            signatures: {
              current_solution_signature: sha256Hex("cur-sig-01"),
              field_solution_signature: sha256Hex("fld-sig-01"),
              target_projection_signatures: {
                proj_yig_film: projSig,
              },
            },
            conductor_positions: {
              layout: "interleaved_xyz_f64",
              path: "data/ant/conductor_pos.bin",
              scalar_type: "f64",
              sha256: sha256Hex("cond-pos-01"),
              unit: "m",
              value_count: 144,
            },
            sample_positions: {
              layout: "interleaved_xyz_f64",
              path: "data/ant/sample_pos.bin",
              scalar_type: "f64",
              sha256: sha256Hex("sample-pos-01"),
              unit: "m",
              value_count: 6912,
            },
            sample_carrier: null,
            sample_topology: null,
            bases: [
              {
                port_mode_id: "port_cpw_inlet",
                normalization_current_a: 1.0,
                measured_positive_terminal_current_a: 1.0,
                normalization_scale: 1.0,
                oersted_operator_version: "biot_savart_3d.v2",
                current_balance_certificate_digest: sha256Hex("ant-balance-01"),
                quadrature_diagnostics: { max_relative_residual: 1.2e-6, quadrature_order: 4 },
                quadrature_evidence: null,
                current_density_per_ampere: {
                  layout: "interleaved_xyz_f64",
                  path: "data/ant/j_basis.bin",
                  scalar_type: "f64",
                  sha256: sha256Hex("j-basis-01"),
                  unit: "A/m^2/A",
                  value_count: 144,
                },
                electric_potential_per_ampere: {
                  layout: "scalar_f64",
                  path: "data/ant/phi_basis.bin",
                  scalar_type: "f64",
                  sha256: sha256Hex("phi-basis-01"),
                  unit: "V/A",
                  value_count: 48,
                },
                magnetic_field_per_ampere: {
                  layout: "interleaved_xyz_f64",
                  path: "data/ant/h_basis.bin",
                  scalar_type: "f64",
                  sha256: sha256Hex("h-basis-01"),
                  unit: "A/m/A",
                  value_count: 6912,
                },
              },
            ],
          })
        );
      }
      if (p.startsWith("/v2/sessions/current/model/objects/")) {
        return fulfill(jsonResponse({ object: sceneResource.objects[0], status: "ok", revision: 12 }));
      }

      // ---- Definitions ----
      if (p === "/v2/sessions/current/definitions/planar-monitors") {
        return fulfill(jsonResponse({
          count: sceneResource.planar_monitors.length,
          monitors: sceneResource.planar_monitors,
          scene_revision: 12,
        }));
      }
      if (p.startsWith("/v2/sessions/current/definitions/planar-monitors/")) {
        return fulfill(jsonResponse({ monitor: sceneResource.planar_monitors[0] }));
      }
      if (p.startsWith("/v2/sessions/current/definitions/")) {
        return fulfill(jsonResponse({ items: [] }));
      }

      // ---- Meshing & FEM Topology / Airbox ----
      if (p === "/v2/sessions/current/meshing/capabilities") {
        return fulfill(jsonResponse({ discretization: isFem ? "fem" : "fdm", fem_supported: true, fdm_supported: true, airbox_supported: true }));
      }
      if (p === "/v2/sessions/current/meshing/semantics") {
        return fulfill(jsonResponse({ active_discretization: isFem ? "fem" : "fdm", supports_periodic_pairs: true, supports_shared_domain: true }));
      }
      if (p === "/v2/sessions/current/meshing/summary") {
        return fulfill(jsonResponse({
          revision: isFem ? 4 : 2,
          discretization: isFem ? "fem" : "fdm",
          node_count: isFem ? femTopology.nodeCount : 48 * 48,
          cell_count: isFem ? femTopology.cellCount : 48 * 48,
          facet_count: isFem ? femTopology.facetCount : 0,
          min_quality: 0.78,
          mean_quality: 0.91,
          airbox_enabled: isFem,
        }));
      }
      if (p === "/v2/sessions/current/meshing/builds/current" || p === "/v2/sessions/current/meshing/builds/latest-successful") {
        const targetAirbox = {
          hmax: 12e-9,
          hmin: 3e-9,
          maximum_element_size: 12e-9,
          minimum_element_size: 3e-9,
          growth_rate: 1.35,
          grading: "geometric",
          padding_m: 60e-9,
        };
        return fulfill(jsonResponse({
          build_id: isFem ? "mesh_build_fem_04" : "mesh_build_fdm_02",
          revision: isFem ? 4 : 2,
          status: "succeeded",
          source_scene_revision: 12,
          discretization: isFem ? "fem" : "fdm",
          domain_generation_id: domainGenId,
          topology_hash: sha256Hex("fem-topology-hash"),
          node_count: isFem ? femTopology.nodeCount : 48 * 48,
          cell_count: isFem ? femTopology.cellCount : 48 * 48,
          effective_airbox_target: targetAirbox,
          last_build_error: null,
          last_build_summary: {
            status: "succeeded",
            effective_airbox_target: targetAirbox,
          },
          last_success: {
            source_scene_revision: 12,
            effective_airbox_target: targetAirbox,
            geometry_realization: { revision: 12, status: "realized" },
          },
          provenance: {
            build_id: isFem ? "mesh_build_fem_04" : "mesh_build_fdm_02",
            command_id: "cmd_mesh_build_04",
            completed_at_unix_ms: 1763235900000,
            duration_ms: 420,
            geometry_realization_revision: 12,
            mesh_revision: isFem ? 4 : 2,
            requested_policy_revision: isFem ? 4 : 2,
            source_scene_revision: 12,
          },
          shared_domain_build_report: {
            build_mode: "shared_domain_tet4",
            degraded: false,
            effective_airbox_target: targetAirbox,
            fallbacks_triggered: [],
            operation_statuses: [],
            status: "succeeded",
          },
        }));
      }
      if (p === "/v2/sessions/current/meshing/builds") {
        return fulfill(jsonResponse({ builds: [{ build_id: "mesh_build_fem_04", revision: 4, status: "succeeded" }] }));
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/manifest" ||
        p === "/v2/sessions/current/meshing/meshes/shared-domain/manifest"
      ) {
        const meshParts = [
          { id: "part_yig_core", part_id: "part_yig_core", object_id: "obj_yig_film", marker_id: 1, role: "magnetic", cell_count: femTopology.coreCellCount, element_count: femTopology.coreCellCount, node_count: femTopology.nodeCount, label: "YIG Core Mesh" },
          { id: "part_airbox", part_id: "part_airbox", object_id: "universe_airbox", marker_id: 2, role: "airbox", cell_count: femTopology.airboxCellCount, element_count: femTopology.airboxCellCount, node_count: femTopology.nodeCount, label: "FEM Airbox Envelope" },
        ];
        return fulfill(jsonResponse({
          schema_version: "mesh_shared_domain_manifest.v1",
          mesh_id: isFem ? "mesh_fem_yig_04" : "mesh_fdm_skyrmion_02",
          mesh_name: isFem ? "YIG Waveguide + Airbox Tet4" : "YIG Film Reference Mesh",
          generation_id: domainGenId,
          domain_generation_id: domainGenId,
          revision: isFem ? 4 : 2,
          source_scene_revision: 12,
          validated_for_scene_revision: 12,
          topology_schema_version: 2,
          topology_fingerprint: sha256Hex("fem-topology-hash"),
          topology_hash: sha256Hex("fem-topology-hash"),
          fallbacks_triggered: [],
          domain_mesh_mode: isFem ? "fem_tetrahedral" : "fdm_cartesian",
          node_count: femTopology.nodeCount,
          cell_count: femTopology.cellCount,
          facet_count: femTopology.facetCount,
          element_counts_by_type: { tetrahedron: femTopology.cellCount },
          parts: meshParts,
          mesh_parts: meshParts,
          links: {
            topology: "/v2/sessions/current/meshing/meshes/shared-domain/topology",
          },
        }));
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/topology" ||
        p === "/v2/sessions/current/meshing/meshes/shared-domain/topology" ||
        p === "/v2/sessions/current/data/domain/topology"
      ) {
        const carrierId = urlObj.searchParams.get("carrier_id");
        return fulfill(
          binaryResponse(femTopology.buffer, rangeHeader, {
            "x-fullmag-domain-generation-id": domainGenId,
            ...(carrierId ? { "x-fullmag-carrier-id": carrierId, "x-fullmag-carrier-revision": "1" } : {}),
          }),
        );
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/policy" ||
        p === "/v2/sessions/current/meshing/universe/policy" ||
        p === "/v2/sessions/current/meshing/policies/universe"
      ) {
        const airboxPolicyCfg = {
          airbox_hmax: 12e-9,
          airbox_hmin: 3e-9,
          airbox_growth_rate: 1.35,
          airbox_grading: "geometric",
          airbox_padding_m: 60e-9,
          max_edge_length_m: 12e-9,
          min_edge_length_m: 3e-9,
          growth_rate: 1.35,
          gradation_enabled: true,
        };
        return fulfill(jsonResponse({
          revision: 4,
          config: airboxPolicyCfg,
          effective_config: airboxPolicyCfg,
        }));
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/quality" ||
        p === "/v2/sessions/current/meshing/meshes/shared-domain/quality" ||
        p === "/v2/sessions/current/meshing/universe/quality"
      ) {
        return fulfill(jsonResponse({
          revision: 4,
          min_quality: 0.74,
          mean_quality: 0.91,
          max_aspect_ratio: 2.1,
          histogram: [
            { bin_min: 0.7, bin_max: 0.8, count: 140 },
            { bin_min: 0.8, bin_max: 0.9, count: 680 },
            { bin_min: 0.9, bin_max: 1.0, count: 1420 },
          ],
        }));
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/quality/gates" ||
        p === "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates"
      ) {
        return fulfill(jsonResponse({ revision: 4, passed: true, gates: [{ name: "Min Jacobian Ratio", threshold: 0.25, value: 0.74, passed: true }] }));
      }
      if (p === "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields" || p === "/v2/sessions/current/meshing/shared-domain/realized-size-fields") {
        return fulfill(jsonResponse({ revision: 4, fields: [] }));
      }
      if (
        p === "/v2/sessions/current/meshing/shared-domain/report" ||
        p === "/v2/sessions/current/meshing/universe/report"
      ) {
        return fulfill(jsonResponse({ revision: 4, status: "passed", node_count: femTopology.nodeCount, cell_count: femTopology.cellCount }));
      }
      if (
        p === "/v2/sessions/current/meshing/meshes/shared-domain/cross-section" ||
        p === "/v2/sessions/current/meshing/shared-domain/cross-section"
      ) {
        const plane = q.get("plane") || "yz";
        const positionPercent = Number(q.get("position_percent") ?? 50);
        return fulfill(
          binaryResponse(encodeFmcsV2({ plane, positionPercent }), rangeHeader, {
            etag: `"fmcs-v2-${plane}-${positionPercent}"`,
          }),
        );
      }
      if (p === "/v2/sessions/current/meshing/mesh/periodic_pairs.v1") {
        return fulfill(
          jsonResponse({
            revision: 4,
            schema_version: "periodic_pairs.v1",
            status: "valid",
            certificate_fingerprint: "cert-periodic-demo",
            topology_fingerprint: "topo-fem-airbox-v1",
            pairs: [],
          }),
        );
      }
      if (p.startsWith("/v2/sessions/current/meshing/")) {
        return fulfill(jsonResponse({ revision: 4, items: [], status: "ready" }));
      }

      // ---- Domain, Fields, Scalars, Tables ----
      if (p === "/v2/sessions/current/data/domain/fdm-multilayer-layout") {
        return fulfill(jsonResponse({
          schema_version: "fdm_multilayer_layout.v1",
          available: false,
          backend: isFem ? "fem_gpu" : "fdm_gpu",
          domain_generation_id: domainGenId,
          execution_revision: 12,
          layout_revision: 1,
          observation_revision: 12,
          layers: [],
          airbox: {
            available: false,
            h_demag_available: false,
            h_eff_available: false,
          },
          common_transform_layout: null,
          unavailable_reason: "Single-layer benchmark domain",
        }));
      }
      if (p === "/v2/sessions/current/data/domain/meta") {
        const fdmCellCount = fdmData.grid[0] * fdmData.grid[1] * fdmData.grid[2];
        return fulfill(jsonResponse({
          schema_version: "domain_meta.v1",
          domain_id: sessionId,
          generation_id: domainGenId,
          coordinate_system: "cartesian_si",
          dimension: 3,
          discretization: isFem ? "fem" : "fdm",
          element_type: isFem ? "tetrahedron" : "hexahedron",
          bounds: isFem ? sceneResource.bounds : fdmData.bounds,
          counts: isFem
            ? { boundary_faces: 0, cells: femTopology.cellCount, elements: femTopology.cellCount, nodes: femTopology.nodeCount }
            : { boundary_faces: 0, cells: fdmCellCount, elements: fdmCellCount, nodes: 0 },
          grid: isFem
            ? null
            : {
                origin: fdmData.bounds.min,
                shape: fdmData.grid,
                spacing: fdmData.cellSize,
              },
          mesh: isFem ? { node_count: femTopology.nodeCount, cell_count: femTopology.cellCount, topology_hash: sha256Hex("fem-topology-hash") } : null,
          units: { length: "m", time: "s", field: "A/m" },
        }));
      }
      if (p === "/v2/sessions/current/data/fdm-region-memberships" || p === "/v2/sessions/current/data/fdm/region-memberships") {
        const fdmCellCount = fdmData.grid[0] * fdmData.grid[1] * fdmData.grid[2];
        return fulfill(jsonResponse({
          schema_version: "fdm_region_membership.v2",
          encoding: "FMRM:u32_membership_le",
          freshness: "current",
          domain_generation_id: domainGenId,
          grid_fingerprint: gridFingerprint,
          grid_shape: fdmData.grid,
          counts: fdmData.grid,
          cell_count: fdmCellCount,
          cell_m: fdmData.cellSize,
          origin_m: fdmData.bounds.min,
          mesh_revision: isFem ? 4 : 2,
          region_membership_revision: 1,
          region_legend_fingerprint: legendFingerprint,
          region_legend: regionLegend,
          object_ids: ["obj_yig_film", "obj_cpw_track"],
          magnetic_support: null,
          binary_path: "/v2/sessions/current/data/fdm-region-membership",
          binary_url: "/v2/sessions/current/data/fdm-region-membership",
        }));
      }
      if (
        p === "/v2/sessions/current/data/fdm-region-membership" ||
        p === "/v2/sessions/current/data/fdm/region-memberships/binary" ||
        p.startsWith("/v2/sessions/current/data/fdm-region-membership/")
      ) {
        return fulfill(binaryResponse(fmrmBuffer, rangeHeader));
      }
      if (p === "/v2/sessions/current/data/mesh-region-memberships" || p === "/v2/sessions/current/data/mesh/region-memberships") {
        return fulfill(jsonResponse({
          domain_generation_id: domainGenId,
          memberships: [
            { region_id: "reg_skyrmion_core", object_id: "obj_yig_film", marker_id: 1, cell_count: Math.floor(femTopology.coreCellCount * 0.45) },
            { region_id: "reg_pinning_ring", object_id: "obj_yig_film", marker_id: 2, cell_count: Math.floor(femTopology.coreCellCount * 0.55) },
            { region_id: "airbox", object_id: "universe_airbox", marker_id: 3, cell_count: femTopology.airboxCellCount },
          ],
        }));
      }
      if (p === "/v2/sessions/current/data/quantities") {
        const carrierLocation = isFem ? "node" : "cell";
        return fulfill(jsonResponse({
          schema_version: "quantities.v2",
          quantities: [
            {
              id: "m",
              label: "Magnetization (M)",
              quick_access_label: "M",
              description: "Normalized magnetization vector field",
              unit: "A/m",
              n_comp: 3,
              shape: "vector_field",
              domain: "magnetic_only",
              location: carrierLocation,
              capability_state: "supported",
              solver_capability: "supported",
              requestable: true,
              renderable: true,
              materializable: true,
              materialization_state: "complete",
              materialization_reason_code: null,
              interactive_preview: true,
              publication_state: "interactive",
              normalization_hint: "unit_sphere",
              supports_export: true,
              supports_history: false,
              supports_preview_2d: true,
              supports_preview_3d: true,
            },
            {
              id: "H_demag",
              label: "Demagnetizing Field (H_demag)",
              quick_access_label: "H_demag",
              description: "Dipolar / magnetostatic demagnetizing field",
              unit: "A/m",
              n_comp: 3,
              shape: "vector_field",
              domain: "full_domain",
              location: carrierLocation,
              capability_state: "supported",
              solver_capability: "supported",
              requestable: true,
              renderable: true,
              materializable: true,
              materialization_state: "complete",
              materialization_reason_code: null,
              interactive_preview: true,
              publication_state: "interactive",
              normalization_hint: "max_abs",
              supports_export: true,
              supports_history: false,
              supports_preview_2d: true,
              supports_preview_3d: true,
            },
            {
              id: "H_ant",
              label: "Antenna RF Field (H_ant)",
              quick_access_label: "H_ant",
              description: "Biot-Savart CPW microwave excitation field",
              unit: "A/m",
              n_comp: 1,
              shape: "spatial_scalar",
              domain: "full_domain",
              location: carrierLocation,
              capability_state: "supported",
              solver_capability: "supported",
              requestable: true,
              renderable: true,
              materializable: true,
              materialization_state: "complete",
              materialization_reason_code: null,
              interactive_preview: true,
              publication_state: "interactive",
              normalization_hint: "signed_symmetric",
              supports_export: true,
              supports_history: false,
              supports_preview_2d: true,
              supports_preview_3d: true,
            },
            {
              id: "topological_charge",
              label: "Topological Charge Density",
              quick_access_label: "q_top",
              description: "Skyrmion topological charge density",
              unit: "1/m^2",
              n_comp: 1,
              shape: "spatial_scalar",
              domain: "magnetic_only",
              location: carrierLocation,
              capability_state: "supported",
              solver_capability: "supported",
              requestable: true,
              renderable: true,
              materializable: true,
              materialization_state: "complete",
              materialization_reason_code: null,
              interactive_preview: true,
              publication_state: "interactive",
              normalization_hint: "signed_symmetric",
              supports_export: true,
              supports_history: false,
              supports_preview_2d: true,
              supports_preview_3d: true,
            },
          ],
        }));
      }
      if (p === "/v2/sessions/current/data/fields") {
        const carrierLocation = isFem ? "node" : "cell";
        const mkField = (quantity_id, label, components, domain, unit) => ({
          available: true,
          components,
          domain,
          domain_generation_id: domainGenId,
          field_revision: 12,
          kind: components === 3 ? "vector" : "scalar",
          label,
          location: carrierLocation,
          materialization_error: null,
          materialization_reason_code: null,
          materialization_wall_time_ns: 1200000,
          materialized_at_unix_ms: 1763235001000,
          quantity_id,
          source_revision: 12,
          source_step: 1840,
          source_time_seconds: 1.84e-9,
          spatial: true,
          stale_by_steps: 0,
          state: "complete",
          ui_exposed: true,
          unit,
        });
        return fulfill(jsonResponse({
          domain_generation_id: domainGenId,
          revision: 12,
          quantities: [
            mkField("m", "Magnetization (M)", 3, "magnetic_only", "A/m"),
            mkField("H_demag", "Demagnetizing Field (H_demag)", 3, "full_domain", "A/m"),
            mkField("H_ant", "Antenna RF Field (H_ant)", 1, "full_domain", "A/m"),
            mkField("topological_charge", "Topological Charge Density", 1, "magnetic_only", "1/m^2"),
          ],
        }));
      }
      if (p.startsWith("/v2/sessions/current/data/fields/") && !p.includes("/planar-") && p.endsWith("/meta")) {
        const rawFid = decodeURIComponent(p.split("/")[6] ?? "m");
        const fid = rawFid === "M" ? "m" : rawFid;
        const isScalar = fid === "H_ant" || fid === "topological_charge" || fid === "m_z";
        const nComp = isScalar ? 1 : 3;
        const isFullDom = fid === "H_demag" || fid === "H_ant";
        return fulfill(jsonResponse({
          available: true,
          components: nComp,
          domain: isFullDom ? "full_domain" : "magnetic_only",
          domain_generation_id: domainGenId,
          field_revision: 12,
          kind: isScalar ? "scalar" : "vector",
          label: fid === "H_demag" ? "Demagnetizing Field (H_demag)" : fid === "H_ant" ? "Antenna RF Field (H_ant)" : fid === "topological_charge" ? "Topological Charge Density" : "Magnetization (M)",
          location: isFem ? "node" : "cell",
          quantity_id: fid,
          state: "complete",
          stats: fid === "H_ant" ? { min: -9500, mean: 0, max: 9500 } : { min: -1, mean: 0.12, max: 1 },
          unit: fid === "topological_charge" ? "1/m^2" : "A/m",
        }));
      }
      if (p.startsWith("/v2/sessions/current/data/fields/") && p.endsWith("/availability")) {
        const rawFid = decodeURIComponent(p.split("/")[6] ?? "m");
        const fid = rawFid === "M" ? "m" : rawFid;
        return fulfill(jsonResponse({
          carrier_id: null,
          generation: domainGenId,
          materialized: true,
          pending: false,
          quantity_id: fid,
          reason_code: null,
          revision: 12,
          scope_id: q.get("scope_id") ?? "full",
          scope_kind: q.get("scope_kind") ?? "full",
          state: "complete",
          supported: true,
          target_id: q.get("target_id") ?? "full",
        }));
      }
      if (
        p.startsWith("/v2/sessions/current/data/fields/") &&
        (p.endsWith("/samples/vector") || p.endsWith("/binary"))
      ) {
        const rawFid = decodeURIComponent(p.split("/")[6] ?? "m");
        const fid = rawFid === "M" ? "m" : rawFid;
        const isScalar = fid === "H_ant" || fid === "topological_charge" || fid === "m_z";
        const nComp = isScalar ? 1 : 3;
        const pointCount = isFem
          ? femTopology.nodeCount
          : fdmData.grid[0] * fdmData.grid[1] * fdmData.grid[2];
        const buf = isFem
          ? (fid === "H_ant" ? femHantFmvp : femMFmvp)
          : (fid === "H_demag"
              ? fdmData.hDemagFmvp
              : fid === "topological_charge"
                ? fdmData.topoFmvp
                : fid === "m_z"
                  ? fdmData.mzFmvp
                  : fdmData.mFmvp);
        const headerQty = isFem && fid !== "H_ant" ? "m" : fid;
        return fulfill(binaryResponse(buf, rangeHeader, {
          "x-fullmag-quantity-id": headerQty,
          "x-fullmag-n-comp": String(nComp),
          "x-fullmag-point-count": String(pointCount),
          "x-fullmag-value-count": String(pointCount * nComp),
          "x-fullmag-field-revision": "12",
          "x-fullmag-component": q.get("component") ?? "full",
        }));
      }
      if (p === "/v2/sessions/current/data/observation-frames") {
        const targetRunId = q.get("run_id") ?? runId;
        return fulfill(jsonResponse({
          run_id: targetRunId,
          next_cursor: null,
          frames: [
            {
              accepted_state_ref: {
                generation: { accepted_revision: 12, runtime_epoch: 1 },
                id: {
                  accepted_step: 1840,
                  clock_digest: "clk_1840",
                  domain_digest: "dom_12",
                  plan_digest: "pln_01",
                  run_id: targetRunId,
                  stage_id: stageId,
                  state_digest: "st_1840",
                },
              },
              adapter_id: isFem ? "fem.gpu.m.v1" : "fdm.gpu.m.v1",
              attempt_id: "att_01",
              frame_id: "frame_step_1840",
              grid_cells: isFem ? [0, 0, 0] : [128, 32, 4],
              magnetization_href: `/v2/sessions/current/data/observation-frames/frame_step_1840/magnetization`,
              ownership_epoch: 1,
              quantity_ids: ["m", "H_demag", "H_eff"],
              run_id: targetRunId,
              schema_version: "observation-frame.v1",
              stage_id: stageId,
              state_codec_id: isFem ? "fem-state" : "fdm-state",
              state_codec_version: "1",
              status: "complete",
              task_id: "task_01",
            },
          ],
        }));
      }
      if (p === "/v2/sessions/current/data/scalars") {
        const colsParam = q.get("columns");
        const cols = colsParam ? colsParam.split(",").filter(Boolean) : ["step", "time", "mx", "my", "mz", "e_total"];
        const limitVal = Math.max(1, Number(q.get("limit") ?? 1));
        const scalarMap = {
          step: 1840,
          time: 1.84e-9,
          t: 1.84e-9,
          mx: 0.042,
          my: -0.018,
          mz: 0.684,
          e_total: -4.2e-18,
          e_exch: 1.8e-18,
          e_demag: 0.9e-18,
          e_zeeman: -5.6e-18,
          e_anis: -0.7e-18,
          e_dmi: -0.6e-18,
          max_torque: 8.2e-7,
        };
        const rows = [];
        const rowCount = Math.min(limitVal, tableRowCount);
        for (let idx = 0; idx < rowCount; idx += 1) {
          const stepVal = rowCount === 1 ? 1840 : idx * 15;
          const tVal = stepVal * 1e-12;
          rows.push(
            cols.map((col) => {
              if (rowCount === 1 && col in scalarMap) return scalarMap[col];
              if (col === "step") return stepVal;
              if (col === "time" || col === "t") return tVal;
              if (col === "mx") return Math.exp(-idx * 0.04) * Math.cos(idx * 0.35) * 0.72;
              if (col === "my") return Math.exp(-idx * 0.04) * Math.sin(idx * 0.35) * 0.72;
              if (col === "mz") return 0.64 + 0.34 * (1 - Math.exp(-idx * 0.04));
              return scalarMap[col] ?? 0;
            }),
          );
        }
        return fulfill(jsonResponse({
          columns: cols,
          current_observation: {
            request_scope_epoch: sessionStatus.session.request_scope_epoch,
            run_id: runId,
            scalar_revision: 12,
            session_id: sessionId,
            source_step: 1840,
          },
          observation_frames: [],
          returned_rows: rows.length,
          revision: 12,
          rows,
          total_rows: 1840,
        }));
      }
      if (p === "/v2/sessions/current/data/artifacts") {
        return fulfill(jsonResponse([
          { kind: "zarr", path: "/workspace/artifacts/run_llg_live_007.zarr" },
          { kind: "frequency_domain_json", path: "/workspace/artifacts/yig_eigenmodes.json" },
          { kind: "vtk", path: "/workspace/artifacts/yig_waveguide_m.vtu" },
        ]));
      }
      const liveChartColumns = [
        { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
        { column_id: "t", component: null, dimension: "time", label: "t", quantity_id: "t", reduction: null, unit: "s", value_type: "float" },
        { column_id: "mx", component: "x", dimension: "dimensionless", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
        { column_id: "my", component: "y", dimension: "dimensionless", label: "my", quantity_id: "my", reduction: "mean", unit: "1", value_type: "float" },
        { column_id: "mz", component: "z", dimension: "dimensionless", label: "mz", quantity_id: "mz", reduction: "mean", unit: "1", value_type: "float" },
        { column_id: "E_total", component: null, dimension: "energy", label: "E_total", quantity_id: "e_total", reduction: "sum", unit: "J", value_type: "float" },
        { column_id: "E_exch", component: null, dimension: "energy", label: "E_exch", quantity_id: "e_exch", reduction: "sum", unit: "J", value_type: "float" },
      ];
      function makeTableDescriptor(id, name) {
        return {
          table_id: id,
          name,
          row_count: tableRowCount,
          total_rows: tableRowCount,
          revision: 12,
          schema_revision: 3,
          columns: [],
          columns_href: `/v2/sessions/current/data/tables/${id}/columns`,
          rows_href: `/v2/sessions/current/data/tables/${id}/rows`,
          binary_rows_href: `/v2/sessions/current/data/tables/${id}/rows.bin`,
        };
      }
      if (p === "/v2/sessions/current/data/tables") {
        return fulfill(jsonResponse({
          revision: 12,
          tables: [
            makeTableDescriptor("default", "Default Live Scalars (LLG)"),
            makeTableDescriptor("time_series", "Time Series (LLG)"),
          ],
        }));
      }
      const tableMatch = /^\/v2\/sessions\/current\/data\/tables\/(default|time_series)(?:\/(columns|rows|rows\.bin))?$/.exec(p);
      if (tableMatch) {
        const tid = tableMatch[1];
        const sub = tableMatch[2] || "";
        if (!sub) {
          return fulfill(jsonResponse(makeTableDescriptor(tid, tid === "default" ? "Default Live Scalars (LLG)" : "Time Series (LLG)")));
        }
        if (sub === "columns") {
          return fulfill(jsonResponse(liveChartColumns));
        }
        const reqColsRaw = (q.get("columns") || "step,t,mx,my,mz,E_total,E_exch").split(",").filter(Boolean);
        const colIdx = { step: 0, t: 1, time: 1, mx: 2, my: 3, mz: 4, E_total: 5, e_total: 5, E_exch: 6, e_exch: 6 };
        const dynamicValues = new Float64Array(tableRowCount * reqColsRaw.length);
        for (let r = 0; r < tableRowCount; r += 1) {
          for (let c = 0; c < reqColsRaw.length; c += 1) {
            const ci = colIdx[reqColsRaw[c]];
            dynamicValues[r * reqColsRaw.length + c] = ci != null ? tableValues[r * tableColCount + ci] : r;
          }
        }
        const dynFmtb = encodeFmtbV1({
          revision: 12,
          schemaRevision: 3,
          cursorStart: 0,
          cursorEnd: tableRowCount,
          totalRows: tableRowCount,
          rowCount: tableRowCount,
          columnCount: reqColsRaw.length,
          values: dynamicValues,
        });
        return fulfill(binaryResponse(dynFmtb, rangeHeader, { "content-type": "application/vnd.fullmag.table-rows.v1+octet-stream" }));
      }

      // ---- 2D Planar Sample Endpoints (v2 /fields/.../planar-default & planar-monitors/...) ----
      const planarFieldMatch =
        /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/(planar-default|planar-monitors\/([^/]+))\/(meta|scalar|vectors|empty-mask|mesh-overlay|probe|profile|render\.png)$/.exec(
          p,
        );
      if (planarFieldMatch) {
        const rawFid = decodeURIComponent(planarFieldMatch[1]);
        const fid = rawFid === "M" ? "m" : rawFid;
        const isMonitor = planarFieldMatch[2] !== "planar-default";
        const monitorId = planarFieldMatch[3] ? decodeURIComponent(planarFieldMatch[3]) : "mon_midplane_rf";
        const sub = planarFieldMatch[4];
        const nu = Math.max(8, Number(q.get("resolution_x") ?? vizState.planar.resolution?.width ?? 96) || 96);
        const nv = Math.max(8, Number(q.get("resolution_y") ?? vizState.planar.resolution?.height ?? 96) || 96);
        const plane = q.get("plane") ?? vizState.planar.default_slice?.plane ?? "xy";
        const posFractionRaw = q.get("position_fraction");
        const posMRaw = q.get("position_m");
        const posFraction = posFractionRaw !== null ? Number(posFractionRaw) : (vizState.planar.default_slice?.position_fraction ?? 0.5);
        const component = q.get("component") ?? vizState.planar.component ?? "z";
        const includeMesh = q.get("include_mesh") ?? (isFem ? "true" : "false");
        const quality = q.get("quality") ?? vizState.planar.quality ?? "interactive";
        const scopeKind = q.get("scope_kind") ?? vizState.planar.view_scope?.kind ?? "monitor_target";
        const meshRev = isFem ? "4" : "2";
        const sliceData = generatePlanarSliceData(nu, nv, plane, posFraction, isFem ? "fem" : "fdm", fid);
        const sampleToken = q.get("sample_token") ?? `planar-sample-v3:${plane}:${posFraction}:${vizState.revision}:${nu}x${nv}`;
        const planarSource = isMonitor
          ? {
              kind: "monitor",
              monitor_hash: `monitor-hash-${monitorId}`,
              monitor_id: monitorId,
              monitor_revision: "12",
            }
          : {
              kind: "default",
              default_slice_hash: `default-slice-hash-${plane}`,
              default_slice_revision: "12",
              domain_generation_id: domainGenId,
            };
        const uMinWin = q.get("window_u_min_m") !== null ? Number(q.get("window_u_min_m")) : sliceData.bounds.uMin;
        const uMaxWin = q.get("window_u_max_m") !== null ? Number(q.get("window_u_max_m")) : sliceData.bounds.uMax;
        const vMinWin = q.get("window_v_min_m") !== null ? Number(q.get("window_v_min_m")) : sliceData.bounds.vMin;
        const vMaxWin = q.get("window_v_max_m") !== null ? Number(q.get("window_v_max_m")) : sliceData.bounds.vMax;

        if (sub === "meta") {
          const linkParams = new URLSearchParams();
          linkParams.set("sample_token", sampleToken);
          linkParams.set("component", component);
          linkParams.set("expected_carrier_revision", "12");
          linkParams.set("expected_field_revision", "12");
          linkParams.set("expected_mesh_revision", meshRev);
          linkParams.set(isMonitor ? "expected_monitor_revision" : "expected_source_revision", "12");
          linkParams.set("expected_scene_revision", "12");
          linkParams.set("include_mesh", includeMesh);
          linkParams.set("quality", quality);
          linkParams.set("resolution_x", String(nu));
          linkParams.set("resolution_y", String(nv));
          linkParams.set("scope_kind", scopeKind);
          if (q.get("scope_id")) linkParams.set("scope_id", q.get("scope_id"));
          if (q.get("scope_region_id")) linkParams.set("scope_region_id", q.get("scope_region_id"));
          if (posFractionRaw !== null) linkParams.set("position_fraction", posFractionRaw);
          else if (posMRaw !== null) linkParams.set("position_m", posMRaw);
          if (q.get("window_u_min_m") !== null && q.get("window_u_max_m") !== null && q.get("window_v_min_m") !== null && q.get("window_v_max_m") !== null) {
            linkParams.set("window_u_min_m", q.get("window_u_min_m"));
            linkParams.set("window_u_max_m", q.get("window_u_max_m"));
            linkParams.set("window_v_min_m", q.get("window_v_min_m"));
            linkParams.set("window_v_max_m", q.get("window_v_max_m"));
          }
          const qs = linkParams.toString();
          const basePrefix = `/v2/sessions/current/data/fields/${encodeURIComponent(rawFid)}/${
            isMonitor ? `planar-monitors/${encodeURIComponent(monitorId)}` : "planar-default"
          }`;
          const frameAxes =
            plane === "xz"
              ? { u_axis: [1, 0, 0], v_axis: [0, 0, 1], normal: [0, 1, 0] }
              : plane === "yz"
                ? { u_axis: [0, 1, 0], v_axis: [0, 0, 1], normal: [1, 0, 0] }
                : { u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal: [0, 0, 1] };
          return fulfill(jsonResponse({
            schema_version: "planar_meta.v3",
            basis_order: 1,
            canonical_unit: fid === "topological_charge" ? "1/m^2" : fid === "m" ? "1" : "A/m",
            carrier_revision: "12",
            component,
            etag: `"${sampleToken}"`,
            field_backend: isFem ? "fem_gpu" : "fdm_gpu",
            field_device: "cuda:0",
            field_precision: "f64",
            field_revision: "12",
            field_source: "live",
            fold_count: 0,
            frame: {
              bounds_uv_m: [uMinWin, uMaxWin, vMinWin, vMaxWin],
              full_bounds_uv_m: [sliceData.bounds.uMin, sliceData.bounds.uMax, sliceData.bounds.vMin, sliceData.bounds.vMax],
              origin_m: [0, 0, 0],
              ...frameAxes,
            },
            generation_id: domainGenId,
            integration_order: 2,
            links: {
              empty_mask: `${basePrefix}/empty-mask?${qs}`,
              mesh_overlay: `${basePrefix}/mesh-overlay?${qs}`,
              probe: `${basePrefix}/probe?${qs}`,
              render_png: `${basePrefix}/render.png?${qs}`,
              scalar: `${basePrefix}/scalar?${qs}`,
              vectors: `${basePrefix}/vectors?${qs}`,
            },
            mesh_overlay_descriptor: {
              available: true,
              boundary_classification: isFem ? "exact" : "degraded",
              codec: "fmcs.v4",
              geometry_source: isFem ? "fem_mesh" : "fdm_grid",
            },
            mesh_revision: meshRev,
            non_injective: false,
            observation_frame: null,
            occupancy: {
              empty: 0,
              occupied: nu * nv,
              occupied_measure: (uMaxWin - uMinWin) * (vMaxWin - vMinWin),
              partial: 0,
            },
            operator: vizState.planar.default_slice?.operator ?? { kind: "plane_sample" },
            overlap_count: 0,
            pixel_size_m: [(uMaxWin - uMinWin) / nu, (vMaxWin - vMinWin) / nv],
            quantity_id: rawFid,
            resolution: [nu, nv],
            sample_support: isFem ? "fem_p1" : "fdm_cell",
            sample_token: sampleToken,
            sampler_version: "3.0.0",
            sampling_execution: "gpu",
            sampling_method: "bilinear",
            scalar_max: fid === "H_ant" ? 1.2e4 : 1,
            scalar_min: fid === "H_ant" ? -1.2e4 : -1,
            scene_revision: "12",
            scope_id: q.get("scope_id") ?? null,
            scope_kind: scopeKind,
            scope_region_id: q.get("scope_region_id") ?? null,
            section: {
              cut_element_count: isFem ? 180 : null,
              layer_count: 5,
              layer_index: Math.max(0, Math.min(4, Math.round(posFraction * 4))),
              layer_spacing_m: 5e-9,
              layer_stops_m: [-10e-9, -5e-9, 0, 5e-9, 10e-9],
              navigation_step_kind: isFem ? "fem_node_plane_spacing" : "fdm_cell",
              navigation_step_m: 5e-9,
              normal_axis: plane === "xy" ? "z" : plane === "xz" ? "y" : "x",
              normal_max_m: 10e-9,
              normal_min_m: -10e-9,
              plane,
              requested_coordinate_m: (posFraction - 0.5) * 20e-9,
              requested_fraction: posFraction,
              resolved_coordinate_m: (posFraction - 0.5) * 20e-9,
              stops_kind: isFem ? "fem_node_planes" : "fdm_cell_layers",
            },
            source: planarSource,
          }));
        }
        if (sub === "scalar") {
          return fulfill(binaryResponse(sliceData.scalarBuffer, rangeHeader, { etag: `"${sampleToken}-scalar"` }));
        }
        if (sub === "vectors") {
          return fulfill(binaryResponse(sliceData.vectorsBuffer, rangeHeader, { etag: `"${sampleToken}-vectors"` }));
        }
        if (sub === "empty-mask") {
          return fulfill(binaryResponse(sliceData.emptyMaskBuffer, rangeHeader, { etag: `"${sampleToken}-mask"` }));
        }
        if (sub === "mesh-overlay") {
          return fulfill(binaryResponse(sliceData.meshOverlayBuffer, rangeHeader, { etag: `"${sampleToken}-overlay"` }));
        }
        if (sub === "probe") {
          const uM = Number(q.get("u_m") ?? 12e-9);
          const vM = Number(q.get("v_m") ?? -8e-9);
          return fulfill(jsonResponse({
            cell_id: isFem ? null : 1024,
            element_id: isFem ? 412 : null,
            nearest_node: null,
            nearest_node_status: "not_requested",
            occupancy: "occupied",
            quantity_id: rawFid,
            sampling_method: "bilinear",
            scalar: -0.742,
            source: planarSource,
            u_m: uM,
            v_m: vM,
            vector: [0.42, -0.52, -0.742],
            world_m: [uM, vM, 0],
          }));
        }
        if (sub === "profile") {
          const u0 = Number(q.get("u0_m") ?? -60e-9);
          const v0 = Number(q.get("v0_m") ?? -10e-9);
          const u1 = Number(q.get("u1_m") ?? 60e-9);
          const v1 = Number(q.get("v1_m") ?? 10e-9);
          const lengthM = Math.hypot(u1 - u0, v1 - v0) || 120e-9;
          const points = [];
          for (let i = 0; i < 64; i += 1) {
            const t = i / 63;
            const uM = u0 + (u1 - u0) * t;
            const vM = v0 + (v1 - v0) * t;
            const r = Math.hypot(uM, vM);
            const sk = Math.PI * Math.exp(-(r * r) / Math.pow(36e-9, 2));
            const mzVal = -Math.cos(sk) + 0.16 * Math.sin(t * Math.PI * 4);
            points.push({
              entity_id: i * 12 + 1,
              kind: "uniform",
              occupancy: "occupied",
              s_m: t * lengthM,
              scalar: mzVal,
              u_m: uM,
              v_m: vM,
              vector: [Math.sin(sk) * 0.7, Math.sin(sk) * 0.5, mzVal],
            });
          }
          return fulfill(jsonResponse({
            component,
            length_m: lengthM,
            points,
            quantity_id: rawFid,
            sample_token: sampleToken,
            sampling_method: "bilinear",
            source: planarSource,
            source_entity_kind: isFem ? "element" : "cell",
            u0_m: u0,
            u1_m: u1,
            v0_m: v0,
            v1_m: v1,
          }));
        }
      }

      // ---- 2D Planar Sample Endpoints ----
      if (p === "/v2/sessions/current/data/planar/meta") {
        const planarQuantity = vizState.planar.quantity_id ?? vizState.planar.quantity ?? "M";
        const sliceData = generatePlanarSliceData(
          96,
          96,
          vizState.planar.default_slice.plane,
          Number(q.get("position_fraction") ?? vizState.planar.default_slice.position_fraction),
          isFem ? "fem" : "fdm",
          planarQuantity,
        );
        const token = `planar-sample-v3:${vizState.planar.default_slice.plane}:${q.get("position_fraction") ?? 0.5}:${vizState.revision}`;
        return fulfill(jsonResponse({
          schema_version: "planar_meta.v3",
          sample_token: token,
          domain_generation_id: domainGenId,
          discretization: isFem ? "fem" : "fdm",
          plane: vizState.planar.default_slice.plane,
          position_fraction: vizState.planar.default_slice.position_fraction,
          operator_kind: vizState.planar.default_slice.operator_kind,
          resolution: [sliceData.nu, sliceData.nv],
          bounds: {
            u_min_m: sliceData.bounds.uMin,
            u_max_m: sliceData.bounds.uMax,
            v_min_m: sliceData.bounds.vMin,
            v_max_m: sliceData.bounds.vMax,
          },
          quantity: planarQuantity,
          component: vizState.planar.component,
          scalar_range: { min: -1, max: 1 },
          source: vizState.planar.source,
          mesh_overlay_codec: "fmcs.v4",
          links: {
            scalar: `/v2/sessions/current/data/planar/scalar?token=${encodeURIComponent(token)}`,
            vectors: `/v2/sessions/current/data/planar/vectors?token=${encodeURIComponent(token)}`,
            empty_mask: `/v2/sessions/current/data/planar/empty-mask?token=${encodeURIComponent(token)}`,
            mesh_overlay: `/v2/sessions/current/data/planar/mesh-overlay?token=${encodeURIComponent(token)}`,
            probe: `/v2/sessions/current/data/planar/probe`,
            profile: `/v2/sessions/current/data/planar/profile`,
          },
        }));
      }
      if (p.startsWith("/v2/sessions/current/data/planar/")) {
        const sub = p.split("/").pop();
        const planarQuantity = vizState.planar.quantity_id ?? vizState.planar.quantity ?? "M";
        const sliceData = generatePlanarSliceData(96, 96, vizState.planar.default_slice.plane, 0.5, isFem ? "fem" : "fdm", planarQuantity);
        if (sub === "scalar") return fulfill(binaryResponse(sliceData.scalarBuffer, rangeHeader));
        if (sub === "vectors") return fulfill(binaryResponse(sliceData.vectorsBuffer, rangeHeader));
        if (sub === "empty-mask") return fulfill(binaryResponse(sliceData.emptyMaskBuffer, rangeHeader));
        if (sub === "mesh-overlay") return fulfill(binaryResponse(sliceData.meshOverlayBuffer, rangeHeader));
        if (sub === "probe") {
          return fulfill(jsonResponse({
            u_m: 12.0e-9,
            v_m: -8.0e-9,
            valid: true,
            quantity: "M",
            scalar_value: -0.742,
            vector_value: [0.42, -0.52, -0.742],
            region_id: "reg_skyrmion_core",
          }));
        }
        if (sub === "profile") {
          const samples = [];
          for (let i = 0; i < 64; i += 1) {
            const s = (i / 63) * 192e-9;
            const r = s - 96e-9;
            samples.push({
              distance_m: s,
              u_m: r,
              v_m: 0,
              value: -Math.cos(Math.PI * Math.exp(-(r * r) / Math.pow(36e-9, 2))),
            });
          }
          return fulfill(jsonResponse({
            schema_version: "planar_profile.v1",
            quantity: "M",
            component: "z",
            unit: "",
            length_m: 192e-9,
            samples,
          }));
        }
      }

      // ---- Visualization State (GET / PATCH / PUT) ----
      if (p === "/v2/sessions/current/visualization/mode-compositions/active") {
        return fulfill(jsonResponse({
          artifact_revision: "1",
          composition_id: `comp-${scenario}`,
          layers: [],
          lifecycle: {
            artifact_revision: 1,
            mesh_revision: 12,
            run_id: runId,
            session_id: sessionId,
          },
          phase_clock: {
            master_rate_hz: 1.0,
            synchronized: true,
          },
          revision: 1,
          run_id: runId,
          schema_version: "1.0.0",
          stage_id: stageId,
        }));
      }
      if (p === "/v2/sessions/current/visualization/state") {
        if (method === "PATCH" || method === "PUT") {
          const patch = request.postDataJSON?.() ?? {};
          vizRevision += 1;
          vizState = mergeVizState(vizState, patch, vizRevision);
        }
        return fulfill(jsonResponse(vizState));
      }
      if (p === "/v2/sessions/current/visualization/client-acks") {
        if (method === "POST") {
          const body = request.postDataJSON?.() ?? {};
          return fulfill(jsonResponse({
            client_id: body.client_id ?? "browser-1",
            revision: body.revision ?? vizRevision,
            status: body.status ?? "rendered",
          }));
        }
        return fulfill(jsonResponse({
          latest: {
            client_id: "browser-1",
            revision: vizRevision,
            status: "rendered",
          },
          entries: [],
        }));
      }

      // ---- Simulation / Solver / Commands / Jobs ----
      if (p === "/v2/sessions/current/simulation/preparation") {
        return fulfill(jsonResponse({
          preparation_id: `prep-${scenario}`,
          revision: 1,
          status: "completed",
          started_at_unix_ms: 1763235000000,
          completed_at_unix_ms: 1763235001250,
          stages: [],
          log_tail: [],
          requested_execution: { backend: capabilitiesResource.requested_backend, device: "cuda:0" },
          resolved_execution: { backend: capabilitiesResource.resolved_backend, device: "NVIDIA RTX A5000" },
        }));
      }
      if (p === "/v2/sessions/current/simulation/runs/current" || p === `/v2/sessions/current/simulation/runs/${runId}`) {
        return fulfill(jsonResponse({
          artifact_dir: "/workspace/artifacts",
          run_id: runId,
          session_id: sessionId,
          revision: 12,
          status: sessionStatus.run.state,
          started_at: sessionStatus.run.started_at,
          requested_backend: capabilitiesResource.requested_backend,
          requested_device: capabilitiesResource.requested_device,
          requested_mode: "strict",
          requested_precision: "f64",
          resolved_backend: capabilitiesResource.resolved_backend,
          resolved_device: capabilitiesResource.resolved_device,
          resolved_mode: "strict",
          resolved_precision: "f64",
          resolved_runtime_family: capabilitiesResource.resolved_runtime_family,
          resolved_engine_id: activeLaneCapability.source.engine_id,
          resolved_worker: "gpu-worker-0",
          active_stage_id: stageId,
          solver_steps: 1840,
          total_steps: 2500,
          step: 1840,
          time_s: 1.84e-9,
          progress: isHysteresis || isEigen ? 1.0 : 0.74,
        }));
      }
      if (/^\/v2\/sessions\/current\/simulation\/objects\/[^/]+\/metrics$/.test(p)) {
        return fulfill(jsonResponse({
          object_id: p.split("/")[6],
          mx: 0.042,
          my: -0.018,
          mz: 0.684,
          energy_J: -4.2e-18,
          max_torque: 8.2e-7,
        }));
      }
      if (p === "/v2/sessions/current/simulation/stages/execution") {
        const activeStageIndex = isHysteresis ? 1 : isEigen ? 2 : 0;
        const activeStageKind = isHysteresis ? "hysteresis" : isEigen ? "eigenmode" : "relax";
        const completedStageIndexes = isEigen ? [0, 1, 2] : isHysteresis ? [0, 1] : [0];
        return fulfill(jsonResponse({
          session_id: sessionStatus.session.session_id,
          session_epoch: sessionStatus.session.session_epoch,
          request_scope_epoch: sessionStatus.session.request_scope_epoch,
          run_id: runId,
          revision: 12,
          runtime_state: sessionStatus.run.state,
          active_stage_id: stageId,
          active_stage_index: activeStageIndex,
          active_stage_kind: activeStageKind,
          completed_stage_indexes: completedStageIndexes,
          stage_statuses: studyStages.map((s) => s.status),
          total_stages: studyStages.length,
          stages: studyStages.map((s, index) => ({
            ...s,
            index,
            converged: s.status === "completed",
            progress_percent: s.status === "completed" ? 100 : index === activeStageIndex ? 74 : 0,
            current_settle_step_method: "projected_gradient_bb",
          })),
        }));
      }
      if (p === "/v2/sessions/current/simulation/stages") {
        return fulfill(jsonResponse({
          run_id: runId,
          active_stage_id: stageId,
          stages: studyStages,
        }));
      }
      if (p === "/v2/sessions/current/simulation/stages/results") {
        const activeProjId = sessionStatus.project?.project_id ?? "proj_yig_bench_2026";
        return fulfill(jsonResponse({
          project_id: activeProjId,
          revision: "12",
          scene_revision: 12,
          authored_stage_ids: [stageId],
          authored_input_sha256: null,
          next_cursor: null,
          results: [
            {
              accepted_at: "2026-11-15T19:52:00Z",
              artifact_id: "art_stage_result_01",
              artifact_sha256: "b7d2c1e9f0123456789abcdef0123456789abcdef0123456789abcdef0123456",
              authored_relation: "matching_authored_input",
              authored_stage_id: stageId,
              codec_id: "fmsp.v1",
              codec_version: "1",
              completion: {
                converged: true,
                metric_kind: "max_torque_apm",
                metric_name: "max_torque",
                metric_unit: "A/m",
                metric_value: 8.2e-6,
                reason: "torque",
                threshold: 1e-5,
              },
              domain_relation: "matching_published_layout",
              initial_state: null,
              predecessor_relation: null,
              project_id: activeProjId,
              source: {
                attempt_id: "att_01",
                case_id: "case_default",
                ownership_epoch: 1,
                run_id: runId,
                step_id: stageId,
                task_id: "task_01",
              },
              study_id: "study_yig_01",
              supports_magnetization_input: true,
            },
          ],
        }));
      }
      if (p === "/v2/sessions/current/simulation/stages/results/scalars") {
        return fulfill(jsonResponse({
          artifact_id: "art_stage_result_01",
          columns: ["step", "time", "mx", "my", "mz", "e_total"],
          content_sha256: "b7d2c1e9f0123456789abcdef0123456789abcdef0123456789abcdef0123456",
          coverage: "solver_series",
          next_start: null,
          rows: [
            [0, 0, 0.99, 0.05, 0.08, -4.1e-18],
            [920, 9.2e-10, 0.42, -0.04, 0.52, -4.18e-18],
            [1840, 1.84e-9, 0.042, -0.018, 0.684, -4.2e-18],
          ],
          series: {
            attempt_id: "att_01",
            case_id: "case_default",
            ownership_epoch: 1,
            run_id: runId,
            step_id: stageId,
            task_id: "task_01",
          },
          total_rows: 3,
        }));
      }
      const simStageHystMatch = /^\/v2\/sessions\/current\/simulation\/stages\/([^/]+)\/hysteresis\/(.+)$/.exec(p);
      if (simStageHystMatch) {
        const reqStageId = decodeURIComponent(simStageHystMatch[1]);
        const sub = simStageHystMatch[2];
        if (sub === "progress") {
          return fulfill(jsonResponse({
            stage_id: reqStageId,
            completed_points: hystPoints.length,
            total_points: hystPoints.length,
            current_point_index: 66,
            current_field_mT: 0.0,
            current_m_parallel: -0.914,
            active_branch_id: "ascending",
            state: "completed",
            revision: 12,
          }));
        }
        if (sub === "orientation") {
          return fulfill(jsonResponse({
            orientation: [1, 0.05, 0],
            direction: [1, 0.05, 0],
            measurement_axis: [1, 0, 0],
            axis: [1, 0.05, 0],
            theta_deg: 2.86,
            phi_deg: 0,
            revision: 12,
          }));
        }
        if (sub === "protocol" || sub === "plan") {
          return fulfill(jsonResponse({
            branch_mode: "full_bipolar",
            mode: "bipolar_sweep",
            h_max_T: 0.06,
            step_count: 41,
            include_minor_loops: true,
          }));
        }
        if (sub === "execution-tree") {
          return fulfill(jsonResponse({ stage_id: reqStageId, branches: ["descending", "ascending", "minor_loop_01"] }));
        }
        if (sub === "saturation") {
          return fulfill(jsonResponse({ saturated: true, ms_A_m: 8.0e5, saturation_preparation_field_mT: 60.0 }));
        }
        return fulfill(jsonResponse({ stage_id: reqStageId, steps: [] }));
      }
      if (p === "/v2/sessions/current/simulation/solver/status") {
        const solverState = isHysteresis || isEigen ? "idle" : "running";
        return fulfill(jsonResponse({
          algorithm: "RK45",
          can_accept_commands: true,
          converged: isHysteresis || isEigen,
          dt_s: 1.25e-13,
          dt_seconds: 1.25e-13,
          integrator: "RK45",
          is_busy: !(isHysteresis || isEigen),
          last_error: null,
          max_dm_dt: 1.4e8,
          max_torque: 8.2e-7,
          max_torque_T: 8.2e-7,
          pseudo_time_seconds: 1.84e-9,
          relaxation_algorithm: "L-BFGS",
          revision: 12,
          run_id: runId,
          runtime_state: sessionStatus.run.state,
          runtime_status_code: sessionStatus.run.state,
          runtime_status_kind: sessionStatus.run.state,
          session_status: sessionStatus.run.state,
          state: solverState,
          warnings: [],
          step: 1840,
          time_s: 1.84e-9,
        }));
      }
      if (p === "/v2/sessions/current/simulation/solver/energies/current") {
        return fulfill(jsonResponse({
          time_s: 1.84e-9,
          total_J: -4.2e-18,
          exchange_J: 1.8e-18,
          demag_J: 0.9e-18,
          zeeman_J: -5.6e-18,
          anisotropy_J: -0.7e-18,
          dmi_J: -0.6e-18,
        }));
      }
      if (p === "/v2/sessions/current/simulation/solver/energies/history") {
        return fulfill(jsonResponse({ samples: [] }));
      }
      if (p === "/v2/sessions/current/simulation/object-metrics") {
        return fulfill(jsonResponse({
          objects: [{ object_id: "obj_yig_film", mx: 0.042, my: -0.018, mz: 0.684, energy_J: -4.2e-18 }],
        }));
      }
      if (p === "/v2/sessions/current/simulation/commands") {
        return fulfill(jsonResponse({
          accepted_count: 1,
          can_accept_commands: true,
          commands: [],
          completed_count: 1,
          dispatched_count: 1,
          failed_count: 0,
          pending_count: 0,
          rejected_count: 0,
          revision: 1,
          running_count: 0,
          runtime_controls: [
            { action: "run", enabled: true, reason: null },
            { action: "pause", enabled: true, reason: null },
            { action: "step", enabled: true, reason: null },
            { action: "stop", enabled: true, reason: null },
          ],
        }));
      }

      // ---- Analysis: Hysteresis, Eigenmode, Dispersion, FMR, Results Catalog ----
      const hystFamilyMatch = /^\/v2\/sessions\/current\/analysis\/hysteresis-family\/([^/]+)$/.exec(p);
      if (hystFamilyMatch) {
        return fulfill(jsonResponse({
          stage_id: decodeURIComponent(hystFamilyMatch[1]),
          series: [],
          families: [{ id: "fam_major", label: "Major Hysteresis Loop", branch_ids: ["descending", "ascending"] }],
        }));
      }
      if (p.startsWith("/v2/sessions/current/analysis/hysteresis/") || p === "/v2/sessions/current/analysis/hysteresis") {
        const rest = p.slice("/v2/sessions/current/analysis/hysteresis".length);
        const stageScoped = /^\/(?!branches$|points$|minor-loops$|metrics$|family$|bookmarks$|saturation$|adaptive-refinement$|reversal-fields$)([^/]+)\/(.+)$/.exec(rest);
        const hystStageId = stageScoped ? decodeURIComponent(stageScoped[1]) : "stage_hysteresis_01";
        const hystSub = stageScoped ? stageScoped[2] : rest.replace(/^\//, "");
        if (hystSub === "branches") {
          return fulfill(jsonResponse({
            stage_id: hystStageId,
            revision: 12,
            branches: [
              {
                branch_id: "descending",
                branch_role: "major_descending",
                parent_branch_id: null,
                label: "Descending Sweep (+60 mT -> -60 mT)",
                kind: "major_descending",
                start_field_mT: 60.0,
                end_field_mT: -60.0,
                point_count: hystDesc.length,
                points: hystDesc,
              },
              {
                branch_id: "ascending",
                branch_role: "major_ascending",
                parent_branch_id: "descending",
                label: "Ascending Sweep (-60 mT -> +60 mT)",
                kind: "major_ascending",
                start_field_mT: -60.0,
                end_field_mT: 60.0,
                point_count: hystAsc.length,
                points: hystAsc,
              },
              {
                branch_id: "minor_loop_01",
                branch_role: "minor_recoil",
                parent_branch_id: "ascending",
                label: "Minor Recoil Loop (-18 mT -> +27 mT)",
                kind: "minor",
                start_field_mT: -18.0,
                end_field_mT: 27.0,
                point_count: hystMinor.length,
                points: hystMinor,
              },
            ],
          }));
        }
        if (hystSub === "points") {
          return fulfill(jsonResponse({ stage_id: hystStageId, revision: 12, points: hystPoints }));
        }
        if (hystSub === "minor-loops") {
          return fulfill(jsonResponse({
            stage_id: hystStageId,
            minor_loops: [{
              loop_id: "minor_loop_01",
              branch_id: "minor_loop_01",
              reversal_field_mT: -18.0,
              return_field_mT: 27.0,
              points: hystMinor,
            }],
            loops: [{ loop_id: "minor_loop_01", branch_id: "minor_loop_01", reversal_field_mT: -18.0, return_field_mT: 27.0, return_field_T: 0.027 }],
          }));
        }
        if (hystSub === "metrics") {
          return fulfill(jsonResponse({
            stage_id: hystStageId,
            metrics: {
              H_c: 18.15,
              H_eb: -0.05,
              H_c_plus: 18.1,
              H_c_minus: -18.2,
              M_r_plus: 0.914,
              M_r_minus: -0.914,
              saturation_preparation_field_mT: 60.0,
              loop_closure_summary: {
                status: "closed",
                field_gap_mT: 0.0,
                m_parallel_gap: 0.002,
              },
              switching_field_candidates: [
                { field_value_mT: -18.2, point_id_before: 18, point_id_after: 19, susceptibility_per_mT: 0.145 },
                { field_value_mT: 18.1, point_id_before: 120, point_id_after: 121, susceptibility_per_mT: 0.142 },
              ],
            },
            coercivity_neg_T: -0.0182,
            coercivity_pos_T: 0.0181,
            remanence_norm: 0.914,
            saturation_norm: 0.996,
            squareness: 0.918,
            loop_area_T: 0.071,
          }));
        }
        if (hystSub === "saturation") {
          return fulfill(jsonResponse({ saturated: true, saturation_preparation_field_mT: 60.0, ms_A_m: 8.0e5 }));
        }
        if (hystSub === "family") {
          return fulfill(jsonResponse({ families: [{ id: "fam_major", label: "Major Hysteresis Loop", branch_ids: ["descending", "ascending"] }] }));
        }
        if (hystSub === "bookmarks") {
          return fulfill(jsonResponse({ bookmarks: [{ id: "bm_hc", label: "Coercive Transition", branch_id: "ascending", step_index: 26 }] }));
        }
        if (hystSub === "adaptive-refinement") {
          return fulfill(jsonResponse({ stage_id: hystStageId, inserted_points: [] }));
        }
        if (hystSub === "reversal-fields") {
          return fulfill(jsonResponse({ stage_id: hystStageId, reversal_fields_mT: [60, -60] }));
        }
        return fulfill(jsonResponse({ stage_id: hystStageId, items: [], status: "ok" }));
      }

      const fdStageId = "stage_eigen_01";
      const fdArtifactSetId = "artset_eigen_01";
      const fdCapEntry = (available, label) => ({
        status: available ? "available" : "unavailable",
        reason: available ? `${label} is published.` : `Not enabled: ${label}.`,
      });
      const fdCapabilities = {
        schema_version: "frequency_domain_capabilities.v1",
        boundary: {
          floquet_modal: fdCapEntry(true, "Floquet modal execution"),
          floquet_response: fdCapEntry(true, "Floquet response execution"),
          periodic_pair_diagnostics: fdCapEntry(true, "Periodic-pair diagnostics"),
          static_periodic: fdCapEntry(true, "Static-periodic execution"),
        },
        demag: {
          floquet_dynamic_k: fdCapEntry(true, "Floquet dynamic-k demag"),
          static_periodic_pbc: fdCapEntry(true, "Static periodic PBC demag"),
        },
        dispersion: {
          branch_tracking: fdCapEntry(true, "Tracked dispersion branches"),
          k_path: fdCapEntry(true, "Dispersion k-path"),
          production_cpu: fdCapEntry(true, "Production CPU eigensolver"),
          production_cpu_gamma_k_path: fdCapEntry(true, "Production CPU gamma k-path"),
          production_gpu: fdCapEntry(false, "Production GPU eigensolver"),
          reference_cpu: fdCapEntry(true, "Reference CPU eigensolver"),
        },
        modal: {
          absorption_from_modes: fdCapEntry(true, "Modal absorption"),
          k_path: fdCapEntry(true, "Modal k-path"),
          linewidths: fdCapEntry(true, "Mode linewidths"),
          mode_field_payload: fdCapEntry(true, "Mode field payload"),
          mode_tracking: fdCapEntry(true, "Mode tracking"),
          production_cpu: fdCapEntry(true, "Production CPU modal solver"),
          production_gpu: { status: "production_qualified", reason: "CUDA modal solver available" },
          reference_cpu: fdCapEntry(true, "Reference CPU modal solver"),
        },
        response: {
          frequency_sweep: fdCapEntry(true, "Frequency-response sweep"),
          magnetic_cpu: fdCapEntry(true, "Production CPU response solver"),
          magnetic_gpu: fdCapEntry(true, "Production GPU response solver"),
          magnetoelastic_elastodynamic: fdCapEntry(false, "Elastodynamic magnetoelastic response"),
          magnetoelastic_quasistatic: fdCapEntry(false, "Quasistatic magnetoelastic response"),
          mode_projected: fdCapEntry(true, "Mode-projected response"),
        },
        validation: {
          fmr_k0: fdCapEntry(true, "FMR k=0 validation"),
        },
        visualization: {
          modal_dispersion_chart: fdCapEntry(true, "Modal dispersion chart"),
          modal_spectrum_chart: fdCapEntry(true, "Modal spectrum chart"),
          mode_3d_overlay: fdCapEntry(true, "3D mode overlay"),
          mode_table: fdCapEntry(true, "Mode table"),
          response_field_3d_overlay: fdCapEntry(true, "3D response-field overlay"),
          response_sweep_chart: fdCapEntry(true, "Response-sweep chart"),
        },
      };

      if (
        p === "/v2/sessions/current/analysis/frequency-domain/manifest" ||
        p === "/v2/sessions/current/analysis/frequency-domain/manifest.v1"
      ) {
        const manifestPayload = {
          artifacts: {
            branches_v2_path: "eigen/branches.v2.json",
            dispersion_csv_path: "eigen/dispersion.csv",
            response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
            spectrum_v2_path: "eigen/spectrum.v2.json",
          },
          equilibrium_identity: "eq_remanent_z_12",
          geometry_identity: "geom_yig_waveguide_rev12",
          mesh_identity: "mesh_shared_domain_01",
          observables: [],
          physics: {
            analysis_family: "magnetic_frequency_domain",
            field_units: "dimensionless_delta_m",
            frequency_units: "Hz",
            normalization: "unit_l2",
            phase_convention: "exp_minus_i_omega_t",
          },
          requested_execution: {
            boundary_context: "finite_open",
            calculation_mode: isEigen ? "dispersion_modal" : "free_modes",
            k_sampling: {
              kind: "path",
              points: [
                { k_vector: [0, 0, 0], label: "Γ" },
                { k_vector: [2.4e7, 0, 0], label: "X" },
              ],
              samples_per_segment: [24],
            },
          },
          revision: "12",
          run_id: runId,
          schema_version: "frequency_domain_manifest.v1",
          stage_id: fdStageId,
          stage_kind: "eigenmodes",
          stage_label: "Eigenmode & FMR Dispersion",
          study_product: "modal_eigen",
        };
        const mDigest = `sha256:${sha256Hex(JSON.stringify(manifestPayload))}`;
        return fulfill(jsonResponse({
          schema_version: "frequency_domain_manifest.v1",
          available: true,
          stage_id: fdStageId,
          calculation_mode: isEigen ? "dispersion_modal" : "eigenmode",
          mode_count: eigenModes.length,
          eigen_namespace: "eigen",
          family_namespace: "frequencyDomain",
          existing_frequency_response_namespace_preserved: true,
          floquet_nonzero_k_demag_supported: true,
          floquet_nonzero_k_response_supported: true,
          capabilities: fdCapabilities,
          eigenmodes: {
            status: "ok",
            modal_solver_available: true,
            availability: "ready",
            mode_count: eigenModes.length,
            artifact_refs: ["art_eigen_01"],
            driven_response_available: true,
            dynamic_demag_k_available: true,
            floquet_modal_available: true,
            floquet_response_available: false,
            gpu_available: true,
            static_periodic_response_available: true,
            reason: "Published eigenmode spectrum and dispersion branch results.",
            study_kind: "eigenmodes",
          },
          response: {
            status: "ok",
            driven_response_available: true,
            availability: "ready",
            point_count: sweepFreqs.length,
            artifact_refs: ["art_fmr_01"],
            dynamic_demag_k_available: true,
            floquet_modal_available: false,
            floquet_response_available: false,
            gpu_available: true,
            modal_solver_available: true,
            static_periodic_response_available: false,
            reason: "Published FMR susceptibility sweep.",
            study_kind: "frequency_response",
          },
          result_manifest: {
            status: "ready",
            artifact_path: "frequency_domain/manifest.v1.json",
            artifact_set_id: fdArtifactSetId,
            content_digest: mDigest,
            mesh_generation_id: domainGenId,
            payload: manifestPayload,
            resource_key: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
            revision: mDigest,
            run_id: runId,
            schema_version: "frequency_domain_manifest.v1",
            session_id: sessionStatus.session.session_id,
            stage_id: fdStageId,
          },
        }));
      }
      if (
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2" ||
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v3" ||
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum" ||
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum/v3"
      ) {
        const specPayload = {
          schema_version: "eigen_spectrum.v2",
          stage_id: fdStageId,
          modes: eigenModes,
          samples: [{ sample_index: 0, sample_id: "k-path-sample-00000", modes: eigenModes }],
        };
        const digest = `sha256:${sha256Hex(JSON.stringify(specPayload))}`;
        return fulfill(jsonResponse({
          status: "ready",
          schema_version: "frequency_domain_eigen_spectrum.v1",
          resource_key: p,
          artifact_path: "eigen/spectrum.v2.json",
          artifact_set_id: fdArtifactSetId,
          content_digest: digest,
          mesh_generation_id: domainGenId,
          missing_reason: null,
          payload: specPayload,
          revision: digest,
          run_id: runId,
          session_id: sessionStatus.session.session_id,
          stage_id: fdStageId,
        }));
      }
      if (
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2" ||
        p === "/v2/sessions/current/analysis/frequency-domain/eigen/branches"
      ) {
        const brPayload = {
          schema_version: "eigen_branches.v2",
          branches: [
            { branch_id: "de_surface", label: "Damon-Eshbach Surface", mode_indices: [1] },
            { branch_id: "bv_bulk", label: "Backward Volume", mode_indices: [0] },
            { branch_id: "pssw_1", label: "PSSW n=1", mode_indices: [2] },
          ],
        };
        const digest = `sha256:${sha256Hex(JSON.stringify(brPayload))}`;
        return fulfill(jsonResponse({
          status: "ready",
          schema_version: "frequency_domain_eigen_branches.v1",
          resource_key: p,
          artifact_path: "eigen/branches.v2.json",
          artifact_set_id: fdArtifactSetId,
          content_digest: digest,
          mesh_generation_id: domainGenId,
          missing_reason: null,
          payload: brPayload,
          revision: digest,
          run_id: runId,
          session_id: sessionStatus.session.session_id,
          stage_id: fdStageId,
        }));
      }
      if (p === "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2") {
        return fulfill(jsonResponse({
          status: "ready",
          schema_version: "eigen_diagnostics.v2",
          resource_key: p,
          artifact_path: "eigen/diagnostics.v2.json",
          artifact_set_id: fdArtifactSetId,
          mesh_generation_id: domainGenId,
          run_id: runId,
          stage_id: fdStageId,
          revision: "12",
          session_id: sessionStatus.session.session_id,
          payload: {
            schema_version: "eigen_diagnostics.v2",
            converged: true,
            mode_count: eigenModes.length,
          },
        }));
      }
      if (p === "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion") {
        const digest = `sha256:${sha256Hex(dispersionCsvText)}`;
        return fulfill(jsonResponse({
          artifact_path: "eigen/dispersion.csv",
          artifact_set_id: fdArtifactSetId,
          content_digest: digest,
          content_type: "text/csv; charset=utf-8",
          mesh_generation_id: domainGenId,
          missing_reason: null,
          path_metadata: {
            schema_version: "k_sampling.v1",
            kind: "path",
            points: [
              { k_vector: [0, 0, 0], label: "Γ" },
              { k_vector: [2.4e7, 0, 0], label: "X" },
            ],
            samples_per_segment: [24],
          },
          resource_key: p,
          revision: digest,
          run_id: runId,
          schema_version: "frequency_domain_eigen_dispersion.v1",
          session_id: sessionStatus.session.session_id,
          stage_id: fdStageId,
          status: "ready",
          text: dispersionCsvText,
        }));
      }
      if (p.startsWith("/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/") && p.endsWith("/meta")) {
        const parts = p.split("/");
        const sampleIdx = Number(parts[8] ?? 0);
        const modeIdx = Number(parts[9] ?? 2);
        const m = eigenModes[modeIdx] ?? eigenModes[2];
        return fulfill(jsonResponse({
          status: "ready",
          schema_version: "frequency_domain_field.v1",
          source_family: "eigen_mode",
          quantity: "delta_m",
          value_kind: "complex_vector",
          field_id: m.mode_field_id,
          resource_key: p,
          artifact_path: `/workspace/artifacts/eigen_mode_${sampleIdx}_${modeIdx}.zarr`,
          revision: "12",
          generation_id: domainGenId,
          available_views: ["phase_rotated_real", "real", "imag", "abs", "phase"],
          default_view: "phase_rotated_real",
          default_phase_rad: 0,
          components: ["x", "y", "z"],
          component_count: 3,
          complex_pair_count: 3,
          grid: fdmData.grid,
        }));
      }
      if (p.startsWith("/v2/sessions/current/analysis/frequency-domain/eigen/modes/")) {
        if (p.endsWith("/field/meta")) {
          return fulfill(jsonResponse({
            mode_index: 2,
            frequency_hz: 9.84e9,
            n_comp: 3,
            grid: fdmData.grid,
            domain_generation_id: domainGenId,
            min: -1,
            max: 1,
          }));
        }
        return fulfill(jsonResponse({ mode: eigenModes[2] }));
      }
      if (
        p === "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep" ||
        p === "/v2/sessions/current/analysis/frequency-response/magnetic-sweep"
      ) {
        const respPayload = {
          schema_version: "magnetic_response_sweep.v2",
          frequencies_hz: sweepFreqs,
          chi_xx_imag: chiXxIm,
          chi_xx_real: chiXxRe,
          points: sweepFreqs.map((fHz, idx) => ({
            frequency_index: idx,
            frequency_hz: fHz,
            chi_xx_imag: chiXxIm[idx],
            chi_xx_real: chiXxRe[idx],
            absorbed_power_density: chiXxIm[idx] * 0.85,
            response_amplitude: Math.hypot(chiXxIm[idx], chiXxRe[idx]),
          })),
          peaks: eigenModes.map((m) => ({ frequency_hz: m.frequency_hz, amplitude: 12.5, fwhm_hz: 0.36e9 })),
        };
        const digest = `sha256:${sha256Hex(JSON.stringify(respPayload))}`;
        return fulfill(jsonResponse({
          status: "ready",
          schema_version: "frequency_domain_response_sweep_resource.v1",
          artifact_path: "response/magnetic_response_sweep.v2.json",
          artifact_set_id: fdArtifactSetId,
          content_digest: digest,
          mesh_generation_id: domainGenId,
          missing_reason: null,
          payload: respPayload,
          resource_key: p,
          revision: digest,
          run_id: runId,
          session_id: sessionStatus.session.session_id,
          stage_id: fdStageId,
          ...respPayload,
        }));
      }
      if (p === "/v2/sessions/current/analysis/frequency-domain/fmr/peaks") {
        return fulfill(jsonResponse({
          peaks: eigenModes.slice(0, 3).map((m) => ({
            frequency_hz: m.frequency_hz,
            linewidth_hz: m.damping_hz * 2,
            amplitude: 11.4,
            q_factor: m.q_factor,
          })),
        }));
      }
      const resDatasetsMatch = /^\/v2\/sessions\/current\/analysis\/results\/runs\/([^/]+)\/datasets$/.exec(p);
      if (resDatasetsMatch) {
        const qRunId = decodeURIComponent(resDatasetsMatch[1]);
        const ds = [];
        if (isHysteresis || isSaved) {
          ds.push({
            dataset_id: `result:${qRunId}:stage_hysteresis_01:hysteresis_loop`,
            dataset_revision: "12",
            item_count: hystPoints.length,
            manifest_resource_key: "/v2/sessions/current/analysis/hysteresis/stage_hysteresis_01/points",
            product_kind: "hysteresis_loop",
            run_id: qRunId,
            sample_count: hystPoints.length,
            stage_id: "stage_hysteresis_01",
            status: { completeness: "complete", execution: "published", qualification: "production", resource: "complete" },
            title: "B_x Hysteresis Loop (stage_hysteresis_01)",
          });
        }
        if (isEigen || isSaved) {
          ds.push({
            dataset_id: `result:${qRunId}:stage_eigen_01:eigen_dispersion`,
            dataset_revision: "12",
            item_count: 75,
            manifest_resource_key: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
            product_kind: "eigen_dispersion",
            run_id: qRunId,
            sample_count: 25,
            stage_id: fdStageId,
            status: { completeness: "complete", execution: "published", qualification: "reference", resource: "complete" },
            title: "Spin-Wave Dispersion k-Path (Γ -> X)",
          });
        }
        return fulfill(jsonResponse({ run_id: qRunId, revision: "12", datasets: ds }));
      }
      if (p === "/v2/sessions/current/analysis/postprocessing/definitions") {
        return fulfill(jsonResponse({ revision: "12", definitions: [] }));
      }
      if (p.startsWith("/v2/sessions/current/analysis/")) {
        return fulfill(jsonResponse({ status: "ok", items: [] }));
      }

      // ---- Diagnostics & Persistence ----
      if (p === "/v2/sessions/current/diagnostics/cpu") {
        return fulfill(jsonResponse({
          status: "available",
          model_name: "AMD Ryzen Threadripper PRO 5975WX",
          logical_cpus: 64,
          memory_total_mb: 131072,
          memory_used_mb: 34200,
          utilization_cpu_percent: 42.5,
          process_cpu_percent: 18.4,
          process_rss_mb: 1180,
          process_threads: 16,
          load_average_1m: 6.4,
          load_average_5m: 5.8,
          load_average_15m: 4.9,
          sample_time_unix_ms: Date.now(),
        }));
      }
      if (p === "/v2/sessions/current/diagnostics/gpu") {
        return fulfill(jsonResponse({
          status: "available",
          sample_time_unix_ms: Date.now(),
          devices: [
            {
              index: 0,
              name: "NVIDIA RTX A5000",
              memory_total_mb: 24576,
              memory_used_mb: 3420,
              temperature_c: 64,
              utilization_gpu_percent: 84,
              utilization_memory_percent: 28,
            },
          ],
        }));
      }
      if (p === "/v2/sessions/current/diagnostics/run-performance") {
        return fulfill(jsonResponse({
          steps_per_second: 1420,
          ns_per_day: 24.6,
          stages: [{ stage_id: stageId, elapsed_s: 4.82, solver: "RK45 + FFT Demag (CUDA)" }],
        }));
      }
      if (p === "/v2/sessions/current/diagnostics/solver-profile") {
        return fulfill(jsonResponse({
          revision: 1,
          state: "idle",
          artifact_refs: [],
          aggregates: {
            average_demag_ns: 420_000,
            average_exchange_ns: 180_000,
            average_total_ns: 780_000,
            max_total_ns: 1_120_000,
            sample_count: 1840,
          },
          config: {
            enabled: true,
            emit_engine_log: false,
            max_samples: 64,
            persist_artifact: false,
            sample_every: 10,
            sample_interval_wall_ms: 250,
          },
          latest_samples: [],
          operation_samples: [],
          preview_3d_disabled: false,
          persistence_failed: false,
        }));
      }
      if (p === "/v2/sessions/current/diagnostics/engine-log") {
        return fulfill(jsonResponse({
          lines: [
            "[19:57:02] INFO  Initialized Fullmag GPU runtime on NVIDIA RTX A5000 (CUDA 12.4)",
            "[19:57:03] INFO  Realized domain mesh: 48 x 48 x 1 cells (domainGen=" + domainGenId + ")",
            "[19:57:05] INFO  Stage 'Ground State Relax' converged to torque < 1e-6",
          ],
        }));
      }
      if (p === "/v2/sessions/current/persistence/checkpoints") {
        return fulfill(jsonResponse({
          checkpoints: [
            { checkpoint_id: "ckpt_01840", step: 1840, time_s: 1.84e-9, size_bytes: 4_820_000, created_at: "2026-11-15T19:58:00Z" },
          ],
        }));
      }

      // Catch-all error to fail loudly if the UI hits a route not explicitly handled above!
      const miss = `${method} ${p}${urlObj.search}`;
      unmockedRequests.push(miss);
      return fulfill(jsonResponse({ error: `UNMOCKED_V2_ROUTE: ${miss}` }, {}, 500));
    });
  }

  return {
    install,
    getUnmockedRequests: () => [...unmockedRequests],
    getVizState: () => vizState,
    setVizState: (patch) => {
      vizRevision += 1;
      vizState = mergeVizState(vizState, patch, vizRevision);
    },
  };
}
