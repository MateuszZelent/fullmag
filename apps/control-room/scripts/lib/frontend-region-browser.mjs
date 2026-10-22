import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resetInspectorDocumentBudget } from "./inspector-request-budget.mjs";

export async function qualifyFrontendRegionBrowser({ page, fixture, outputDir, workspaceUrl, fulfillJson }) {
  const original = structuredClone({ scene: fixture.scene, revision: fixture.revision, manifest: fixture.manifest });
  const originalViewport = page.viewportSize();
  const evidence = { scope: "Production region Inspector with intercepted API; no backend or physics qualification", status: "running", mutations: [], scenarios: [], screenshots: [] };
  const regionId = "audit-core";
  const nodeId = `model:object:film:regions:${regionId}`;
  const shape = { kind: "csg", expression: { op: "difference", left: { kind: "sphere", radius: 12e-9 }, right: { kind: "sphere", radius: 4e-9 } } };
  const overrides = [
    { parameter: "alpha", value: { kind: "constant", value: 0 } },
    { parameter: "aex", value: { kind: "constant", value: 0 } },
    { parameter: "ku2", priority: 9, value: { kind: "constant", unit: "J/m^3", value: [1, 2, 3] } },
    { parameter: "ms", value: { kind: "linear", base: 800e3, gradient: [1, 2, 3], frame: "object" } },
  ];
  const readonlyField = { assignment_id: "audit-vector", owner_object: "film", region_id: regionId, parameter: "ku2", value: { kind: "constant", unit: "J/m^3", value: [2, 3, 4] } };
  const editableField = { assignment_id: "audit-scalar", owner_object: "film", region_id: regionId, parameter: "alpha", value: { kind: "constant", value: 0 } };
  const secondEditableField = { assignment_id: "audit-second-scalar", owner_object: "film", region_id: regionId, parameter: "ku1", value: { kind: "constant", value: 42 } };
  const object = fixture.scene.objects.find((entry) => entry.id === "film");
  assert.ok(object, "The Film fixture is required.");
  object.regions = [{ region_id: regionId, name: "Audit core", shape, material_overrides: overrides, enabled: true, frame: "object", priority: 1 }];
  object.material_parameter_fields = [readonlyField, editableField, secondEditableField];
  let acknowledge = null;
  let pending = false;
  const regionPath = `/v2/sessions/current/model/objects/film/regions/${regionId}`;
  const requests = [];
  function advanceRevision() {
    fixture.revision += 1;
    fixture.scene.revision = fixture.revision;
    fixture.manifest.source_scene_revision = fixture.revision;
  }
  advanceRevision();
  const intercept = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/v2/sessions/current/model/regions" && request.method() === "GET") {
      return fulfillJson(route, { scene_revision: fixture.revision, geometry_realization_revision: 0, regions: object.regions.map((region) => ({ ...region, owner_object_id: "film", source: "authored_object_region", source_object_ids: ["film"], source_body_ids: [], mesh_part_ids: [], interaction_refs: [], bounds_min: [0, 0, 0], bounds_max: [1e-7, 1e-7, 1e-7], material_ref: object.material_ref })) });
    }
    if (path === regionPath && request.method() === "PATCH") {
      const body = request.postDataJSON();
      evidence.mutations.push({ path, body });
      pending = true;
      await new Promise((resolveAck) => { acknowledge = resolveAck; });
      Object.assign(object.regions[0], body.patch);
      advanceRevision();
      pending = false;
      return fulfillJson(route, fixture.scene);
    }
    if (path === "/v2/sessions/current/model/transactions" && request.method() === "POST" && request.postDataJSON()?.kind === "patch_object_material_fields") {
      const body = request.postDataJSON();
      evidence.mutations.push({ path, body });
      object.material_parameter_fields = structuredClone(body.fields);
      advanceRevision();
      return fulfillJson(route, { committed_scene: fixture.scene, scene_revision: fixture.revision, revision: fixture.revision });
    }
    return route.fallback();
  };
  async function waitUntil(predicate, message) {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await page.waitForTimeout(25);
    }
  }
  async function selectNode(id) {
    for (const parent of ["model:objects", "model:object:film", "model:object:film:regions", ...(id === nodeId ? [] : [nodeId])]) {
      const target = page.locator(`[data-node-id="${parent}"]`);
      await target.waitFor({ state: "visible" });
      if (await target.getAttribute("aria-expanded") === "false") await target.locator(".fm-explorer-tree-row__branch").click();
    }
    await page.locator(`[data-node-id="${id}"]`).click();
  }
  async function capture(name) {
    const file = `frontend-region-${name}.png`;
    await page.locator(".fm-inspector").screenshot({ path: resolve(outputDir, file) });
    evidence.screenshots.push(file);
  }
  await page.route("**/v2/**", intercept);
  try {
    if (originalViewport) await page.setViewportSize({ ...originalViewport, height: 720 });
    resetInspectorDocumentBudget(fixture.requestBudget, "frontend-region-lossless");
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const inspector = page.locator(".fm-inspector");
    await inspector.waitFor({ state: "visible", timeout: 60_000 });
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await page.getByRole("searchbox", { name: "Filter explorer" }).fill("");
    await selectNode(nodeId);
    const name = inspector.getByRole("textbox", { name: "Region name", exact: true });
    await name.fill("Renamed audit core");
    await name.focus();
    const baseline = await inspector.evaluate((element) => {
      element.dataset.regionAuditIdentity = "same-region";
      document.activeElement.dataset.regionAuditFocus = "name";
      const scroller = element.querySelector(".fm-inspector__content .fm-scroll-area__viewport");
      if (!scroller) throw new Error("Inspector content viewport is missing.");
      scroller.scrollTop = Math.min(40, scroller.scrollHeight - scroller.clientHeight);
      const fields = Array.from(element.querySelectorAll("input,select,textarea"), (field, index) => {
        field.dataset.regionAuditControl = String(index);
        const opacity = [];
        for (let parent = field; parent && element.contains(parent); parent = parent.parentElement) opacity.push(getComputedStyle(parent).opacity);
        return { id: String(index), disabled: field.disabled, opacity };
      });
      return { scrollTop: scroller.scrollTop, fields };
    });
    assert.ok(baseline.scrollTop > 0, "Stability must measure a nonzero Inspector content scroll offset.");
    async function assertStable(phase) {
      const observed = await inspector.evaluate((element) => ({
        marker: element.dataset.regionAuditIdentity,
        scrollTop: element.querySelector(".fm-inspector__content .fm-scroll-area__viewport")?.scrollTop,
        fields: Array.from(element.querySelectorAll("input,select,textarea"), (field) => {
          const opacity = [];
          for (let parent = field; parent && element.contains(parent); parent = parent.parentElement) opacity.push(getComputedStyle(parent).opacity);
          return { id: field.dataset.regionAuditControl, disabled: field.disabled, opacity };
        }),
        focus: document.activeElement?.dataset.regionAuditFocus,
        opacityAnimations: element.getAnimations({ subtree: true }).filter((animation) => (animation.effect?.getKeyframes?.() ?? []).some((frame) => Object.hasOwn(frame, "opacity"))).length,
      }));
      assert.equal(observed.marker, "same-region", `${phase}: Inspector remounted.`);
      assert.equal(observed.focus, "name", `${phase}: input focus lost.`);
      assert.equal(observed.opacityAnimations, 0, `${phase}: opacity animation.`);
      assert.deepEqual(observed.fields, baseline.fields, `${phase}: field identity, disabled state or opacity changed.`);
      assert.ok(Math.abs(observed.scrollTop - baseline.scrollTop) <= 1, `${phase}: scroll moved.`);
      return observed;
    }
    const applyRegion = inspector.getByRole("button", { name: "Apply Region", exact: true });
    const renameResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === regionPath);
    await applyRegion.evaluate((button) => button.click());
    await waitUntil(() => pending, "Region PATCH was not submitted.");
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".fm-inspector button")).some((button) => button.textContent.trim() === "Apply Region" && button.disabled));
    const renamePatch = evidence.mutations.at(-1).body.patch;
    assert.equal(renamePatch.name, "Renamed audit core");
    assert.deepEqual(renamePatch.shape, shape, "Rename destroyed the CSG expression.");
    assert.equal(Object.hasOwn(renamePatch, "material_overrides"), false, "Rename needlessly rebuilt material overrides.");
    const pendingState = await assertStable("pending");
    await capture("rename-pending");
    acknowledge();
    assert.equal((await renameResponse).status(), 200);
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".fm-inspector button")).some((button) => button.textContent.trim() === "Apply Region" && !button.disabled));
    await inspector.getByText("Object region updated.", { exact: true }).waitFor();
    const ackState = await assertStable("ACK");
    assert.equal(await name.inputValue(), "Renamed audit core");
    assert.deepEqual(object.regions[0].material_overrides, overrides);
    evidence.scenarios.push({ name: "rename-preserves-csg-overrides-and-inspector", pendingState, ackState });

    await selectNode(`${nodeId}:magnetic-parameters`);
    const scalar = inspector.getByRole("textbox", { name: "Local override", exact: true }).first();
    await scalar.waitFor();
    assert.equal(Number(await scalar.inputValue()), 0, "Legal alpha zero became a default.");
    assert.equal(await inspector.getByText("Read-only override", { exact: true }).count(), 2);
    const parameter = inspector.getByRole("combobox", { name: "Override 1", exact: true });
    await parameter.selectOption("ku1");
    const inherited = await inspector.locator(".fm-region-inherited-parameters .fm-inspector-field-row__label").allTextContents();
    assert.ok(inherited.includes("alpha") && !inherited.includes("ku1"), "Inheritance labels describe the old override parameter.");
    await parameter.selectOption("alpha");
    await scalar.fill("0.125");
    await scalar.press("Tab");
    const scalarResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === regionPath);
    await inspector.getByRole("button", { name: "Apply Region", exact: true }).click();
    await waitUntil(() => pending, "Scalar override PATCH was not submitted.");
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".fm-inspector button")).some((button) => button.textContent.trim() === "Apply Region" && button.disabled));
    const materialPatch = evidence.mutations.at(-1).body.patch.material_overrides;
    assert.deepEqual(materialPatch[0], { parameter: "alpha", value: { kind: "constant", value: 0.125 } });
    assert.deepEqual(materialPatch.slice(1), overrides.slice(1), "Editing alpha changed a zero, vector, gradient, or metadata.");
    acknowledge();
    assert.equal((await scalarResponse).status(), 200);
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".fm-inspector button")).some((button) => button.textContent.trim() === "Apply Region" && !button.disabled));
    await inspector.getByText("Object region updated.", { exact: true }).waitFor();
    evidence.scenarios.push({ name: "scalar-edit-preserves-other-payloads", overrides: materialPatch });
    await page.waitForFunction(() => document.querySelector(".fm-inspector__action-btn--apply")?.disabled === true);
    assert.equal(await inspector.locator(".fm-inspector__action-bar").getByRole("button", { name: "Apply", exact: true }).isDisabled(), true,
      "A successfully acknowledged region still enables the global Apply action.");
    await selectNode(nodeId);
    await name.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("dialog").count(), 0, "A successfully acknowledged region remained dirty.");
    await selectNode(`${nodeId}:magnetic-parameters`);
    await scalar.waitFor();
    assert.equal(Number(await scalar.inputValue()), 0.125);
    evidence.scenarios.push({ name: "acknowledged-scalar-is-clean-without-revert" });

    const fieldValues = inspector.getByRole("textbox", { name: "Value", exact: true });
    const fieldValue = fieldValues.first();
    await fieldValue.waitFor();
    assert.equal(await fieldValues.count(), 2, "Editable scalar fields or the readonly vector were misclassified.");
    assert.equal(Number(await fieldValue.inputValue()), 0);
    await fieldValue.fill("0.2");
    await fieldValue.press("Tab");
    const fieldResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON()?.kind === "patch_object_material_fields");
    await inspector.getByRole("button", { name: "Apply Fields", exact: true }).click();
    await waitUntil(() => evidence.mutations.length === 3, "Material field transaction was not submitted.");
    const fields = evidence.mutations.at(-1).body.fields;
    assert.deepEqual(fields.find((field) => field.assignment_id === readonlyField.assignment_id), readonlyField);
    assert.deepEqual(fields.find((field) => field.assignment_id === editableField.assignment_id), { ...editableField, value: { kind: "constant", value: 0.2 } });
    assert.deepEqual(fields.find((field) => field.assignment_id === secondEditableField.assignment_id), secondEditableField);
    assert.equal((await fieldResponse).status(), 200);
    await inspector.getByText("Material fields updated.", { exact: true }).waitFor();
    assert.equal(await inspector.getByRole("button", { name: "Apply Fields", exact: true }).isDisabled(), true, "The acknowledged material field draft should be clean.");
    assert.equal(Number(await fieldValue.inputValue()), 0.2);
    await capture("material-fields-preserved");
    evidence.scenarios.push({ name: "field-edit-retains-vector-and-optional-metadata", fields });

    async function verifyRemovalDraftIdentity({ label, removeLabel, revertLabel, applyLabel }) {
      const inputs = inspector.getByRole("textbox", { name: label, exact: true });
      const rows = inspector.locator(".fm-region-override").filter({ has: page.getByRole("textbox", { name: label, exact: true }) });
      const revertButton = inspector.locator(".fm-inspector-panel").getByRole("button", { name: revertLabel, exact: true });
      const mutationCount = evidence.mutations.length;
      assert.equal(await inputs.count(), 2);
      const secondBaseline = await inputs.nth(1).inputValue();
      await inputs.first().fill("-");
      await rows.first().getByRole("button", { name: removeLabel, exact: true }).click();
      assert.equal(await inputs.count(), 1);
      assert.equal(await inputs.first().inputValue(), secondBaseline, `${label}: removed entry's raw text leaked into its successor.`);
      await revertButton.click();
      assert.equal(await inputs.count(), 2);
      await inputs.nth(1).fill("-");
      await inputs.nth(1).evaluate((input) => { input.dataset.retainedDraftIdentity = "retained-second"; });
      await rows.first().getByRole("button", { name: removeLabel, exact: true }).click();
      assert.equal(await inputs.count(), 1);
      assert.equal(await inputs.first().inputValue(), "-", `${label}: removing an earlier entry discarded the surviving invalid draft.`);
      assert.equal(await inputs.first().getAttribute("data-retained-draft-identity"), "retained-second", `${label}: surviving input was remounted.`);
      assert.equal(await inputs.first().getAttribute("aria-invalid"), "true");
      const apply = inspector.getByRole("button", { name: applyLabel, exact: true });
      if (applyLabel === "Apply Fields") {
        assert.equal(await apply.isDisabled(), true, "Invalid material field text must block Apply Fields.");
      } else {
        await apply.click();
        await inspector.getByText(/Correct Local override before applying/).waitFor();
      }
      assert.equal(evidence.mutations.length, mutationCount, `${label}: invalid text was submitted as a previous numeric value.`);
      await capture(`${label === "Value" ? "field" : "override"}-retained-invalid-draft`);
      await revertButton.click();
      assert.equal(await inputs.count(), 2);
      assert.equal(await inputs.nth(1).inputValue(), secondBaseline);
      assert.equal(evidence.mutations.length, mutationCount, `${label}: a removal or revert unexpectedly wrote to the backend.`);
      return { label, removedDraftDoesNotLeak: true, survivingRawTextAndNodeRetained: true, invalidApplyBlocked: true, revertRestoresBaseline: true };
    }
    evidence.scenarios.push({ name: "override-removal-preserves-draft-identity", ...await verifyRemovalDraftIdentity({ label: "Local override", removeLabel: "Remove Override", revertLabel: "Revert", applyLabel: "Apply Region" }) });
    evidence.scenarios.push({ name: "field-removal-preserves-draft-identity", ...await verifyRemovalDraftIdentity({ label: "Value", removeLabel: "Remove Field", revertLabel: "Revert Fields", applyLabel: "Apply Fields" }) });
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error?.stack ?? String(error);
    throw error;
  } finally {
    acknowledge?.();
    await page.unroute("**/v2/**", intercept);
    if (originalViewport) await page.setViewportSize(originalViewport);
    fixture.scene = original.scene;
    fixture.revision = original.revision;
    fixture.manifest = original.manifest;
    evidence.requests = requests;
    await writeFile(resolve(outputDir, "frontend-region-browser.json"), JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
