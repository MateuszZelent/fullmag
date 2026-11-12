// Pure checks of the 2D toolbar, crop, node inspector and field-layer
// browser scenarios (plan 2026-11-12 Task 12). The browser driver lives in
// smoke-viewport-2d.mjs; everything here is deterministic and node-tested.

/** Accessible names of the six canvas tools, in toolbar order. */
export const PLANAR_TOOL_LABELS = Object.freeze([
  "Navigate",
  "Zoom to box",
  "Crop",
  "Inspect node",
  "Line profile",
  "Measure",
]);

/** Labels the old control strip put over the canvas; none may come back. */
export const REMOVED_CANVAS_CONTROL_LABELS = Object.freeze([
  "Quantity",
  "Scope",
  "Free section",
  "Single layer",
]);

/**
 * Scenario 1: the toolbar shape. `snapshot.tools` are the radio names of the
 * "Canvas tool" group; `snapshot.removedHits` are removed labels found in the
 * 2D stage DOM.
 */
export function assertPlanarToolbarSnapshot(snapshot) {
  const tools = snapshot?.tools ?? [];
  if (tools.length !== PLANAR_TOOL_LABELS.length ||
      tools.some((name, index) => name !== PLANAR_TOOL_LABELS[index])) {
    throw new Error(`2D view tools expose ${JSON.stringify(tools)}, expected ${JSON.stringify(PLANAR_TOOL_LABELS)}`);
  }
  const checked = snapshot?.checked ?? [];
  if (checked.length !== 1) {
    throw new Error(`Exactly one canvas tool must be checked, got ${JSON.stringify(checked)}`);
  }
  const removed = snapshot?.removedHits ?? [];
  if (removed.length > 0) {
    throw new Error(`Removed 2D canvas controls are still rendered: ${removed.join(", ")}`);
  }
  return true;
}

const close = (left, right, span) =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= Math.max(Math.abs(span) * 1e-9, 1e-18);

/** The crop clipped to the full frame bounds, as the backend resolves it. */
export function clampCropToFrame(crop, fullBounds) {
  return [
    Math.max(crop.u_min_m, fullBounds[0]),
    Math.min(crop.u_max_m, fullBounds[1]),
    Math.max(crop.v_min_m, fullBounds[2]),
    Math.min(crop.v_max_m, fullBounds[3]),
  ];
}

/**
 * Scenario 3: a committed crop is sampled as its own window. The metadata
 * bounds equal the crop (clipped to the frame), the full bounds stay the
 * frame, and the sample token differs from the uncropped one.
 */
export function assertCroppedPlanarMeta(meta, crop, uncroppedToken) {
  const bounds = meta?.frame?.bounds_uv_m;
  const full = meta?.frame?.full_bounds_uv_m;
  if (!Array.isArray(bounds) || !Array.isArray(full)) {
    throw new Error("Cropped planar metadata has no window and full bounds");
  }
  const expected = clampCropToFrame(crop, full);
  const span = Math.max(full[1] - full[0], full[3] - full[2]);
  if (!expected.every((value, index) => close(bounds[index], value, span))) {
    throw new Error(`Cropped planar bounds ${JSON.stringify(bounds)} differ from crop ${JSON.stringify(expected)}`);
  }
  if (!meta.sample_token || meta.sample_token === uncroppedToken) {
    throw new Error("Cropped planar sample kept the uncropped sample token");
  }
  return expected;
}

/** Scenario 3: after clearing, the sample covers the full frame again. */
export function assertFullFramePlanarMeta(meta) {
  const bounds = meta?.frame?.bounds_uv_m;
  const full = meta?.frame?.full_bounds_uv_m ?? bounds;
  if (!Array.isArray(bounds) || !Array.isArray(full)) throw new Error("Planar metadata has no bounds");
  const span = Math.max(full[1] - full[0], full[3] - full[2]);
  if (!bounds.every((value, index) => close(value, full[index], span))) {
    throw new Error(`Planar bounds ${JSON.stringify(bounds)} are not the full frame ${JSON.stringify(full)}`);
  }
  return true;
}

/**
 * World-axis range of a frame interval along `axis` ("u" or "v"): ticks are
 * labelled in world coordinates of the dominant world component.
 */
export function frameIntervalWorldRange(frame, axis, min, max) {
  const direction = axis === "u" ? frame?.u_axis : frame?.v_axis;
  const origin = frame?.origin_m;
  if (!Array.isArray(direction) || !Array.isArray(origin)) throw new Error("Planar frame has no axes");
  let dominant = 0;
  for (let index = 1; index < 3; index += 1) {
    if (Math.abs(direction[index]) > Math.abs(direction[dominant])) dominant = index;
  }
  const ends = [origin[dominant] + min * direction[dominant], origin[dominant] + max * direction[dominant]];
  return ends[0] <= ends[1] ? ends : [ends[1], ends[0]];
}

/** Scenario 3: every axis tick lies inside the crop's world range. */
export function assertTicksWithinRange(ticks, range, label) {
  if (!Array.isArray(ticks) || ticks.length < 2) {
    throw new Error(`${label} axis shows fewer than two ticks`);
  }
  const span = Math.abs(range[1] - range[0]);
  const tolerance = Math.max(span * 1e-6, 1e-18);
  const outside = ticks.filter((value) => !(value >= range[0] - tolerance && value <= range[1] + tolerance));
  if (outside.length > 0) {
    throw new Error(`${label} axis ticks ${JSON.stringify(outside)} fall outside the crop ${JSON.stringify(range)}`);
  }
  return true;
}

/**
 * Scenario 4: the hover readout names the nearest entity of the backend:
 * FEM mesh nodes, FDM cell centres.
 */
export function assertNodeReadoutHeading(heading, backend) {
  const entity = backend === "fem" ? "node" : "cell";
  const pattern = new RegExp(`·\\s*${entity}\\s+[0-9][0-9,]*$`);
  if (typeof heading !== "string" || !pattern.test(heading.trim())) {
    throw new Error(`Node readout heading ${JSON.stringify(heading)} does not name a ${entity} number`);
  }
  return true;
}

const LAYER_FLAG_KEYS = Object.freeze([
  "visible",
  "raster_visible",
  "vectors_visible",
  "points_visible",
  "mesh_visible",
  "contours_visible",
  "streamlines_visible",
]);

/** Layers that draw something: visible, with at least one drawn pass on. */
export function drawnFieldLayers(planar) {
  const masks = planar?.layers ?? {};
  const passes = [
    ["raster", "raster_visible"],
    ["vectors", "vectors_visible"],
    ["points", "points_visible"],
    ["contours", "contours_visible"],
    ["streamlines", "streamlines_visible"],
  ];
  return (planar?.field_overlays ?? []).filter((layer) =>
    layer.visible !== false && passes.some(([mask, flag]) => masks[mask] !== false && layer[flag] === true));
}

/** Scenario 5: one legend card per visible layer that draws. */
export function assertLegendCardCount(planar, cardCount) {
  const expected = planar?.viewport_colorbar_visible === false ? 0 : drawnFieldLayers(planar).length;
  if (cardCount !== expected) {
    throw new Error(`Legend shows ${cardCount} cards for ${expected} visible field layers`);
  }
  return expected;
}

/** Scenario 5: the reorder moved only `id`, keeping every layer. */
export function assertLayerMoved(beforeIds, afterIds, id, toIndex) {
  const expected = beforeIds.filter((value) => value !== id);
  expected.splice(toIndex, 0, id);
  if (afterIds.length !== beforeIds.length || afterIds.some((value, index) => value !== expected[index])) {
    throw new Error(`Layer order ${JSON.stringify(afterIds)}, expected ${JSON.stringify(expected)}`);
  }
  return true;
}

/** Scenario 6: a view mask never rewrites a layer's own pass flags. */
export function assertLayerFlagsUnchanged(before, after) {
  const pick = (layers) => (layers ?? []).map((layer) =>
    [layer.id, ...LAYER_FLAG_KEYS.map((key) => layer[key] ?? null)]);
  const left = JSON.stringify(pick(before));
  const right = JSON.stringify(pick(after));
  if (left !== right) throw new Error(`Field layer flags changed with a view mask: ${left} -> ${right}`);
  return true;
}

/** Scenario 7: PATCH bodies that commit a default-slice position. */
export function countPositionCommits(patchBodies) {
  return (patchBodies ?? []).filter((body) =>
    Number.isFinite(body?.planar?.default_slice?.position_fraction)).length;
}

/**
 * Scenario 8 (Review Focus 1): the field-layer list a legacy planar state
 * becomes after restore. The drawn base field is appended as layer `all`
 * (drawn under the existing layers), existing layers keep their order and
 * become visible; a hidden base adds nothing.
 */
export function expectedMigratedLayers(legacyPlanar) {
  const overlays = (legacyPlanar?.field_overlays ?? []).map((layer) => ({
    id: layer.id,
    quantity_id: layer.quantity_id,
    component: layer.component,
    visible: true,
  }));
  const raster = legacyPlanar?.layers?.raster === true;
  const vectors = legacyPlanar?.layers?.vectors === true;
  if (raster || vectors) {
    // `all`, or `all-2`, `all-3`… when a layer already owns that id.
    let id = "all";
    for (let suffix = 2; overlays.some((layer) => layer.id === id); suffix += 1) id = `all-${suffix}`;
    overlays.push({
      id,
      quantity_id: legacyPlanar.quantity_id,
      component: legacyPlanar.component,
      visible: true,
      raster_visible: raster,
      vectors_visible: vectors,
    });
  }
  return overlays;
}

/** Scenario 8: the restored layer list matches the migration rule. */
export function assertMigratedLayers(legacyPlanar, restoredPlanar) {
  if (restoredPlanar?.layer_model !== "layers") {
    throw new Error(`Restored legacy session has layer_model ${restoredPlanar?.layer_model}`);
  }
  const expected = expectedMigratedLayers(legacyPlanar);
  const actual = restoredPlanar.field_overlays ?? [];
  if (actual.length !== expected.length) {
    throw new Error(`Restored legacy session has ${actual.length} layers, expected ${expected.length}`);
  }
  expected.forEach((layer, index) => {
    const restored = actual[index];
    for (const [key, value] of Object.entries(layer)) {
      if (restored?.[key] !== value) {
        throw new Error(`Restored layer ${index} ${key} is ${JSON.stringify(restored?.[key])}, expected ${JSON.stringify(value)}`);
      }
    }
  });
  return expected.map((layer) => layer.id);
}
