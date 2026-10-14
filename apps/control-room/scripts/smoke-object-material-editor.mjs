import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_OBJECT_MATERIAL_EDITOR_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error('Managed absolute storage/report paths required');
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), directory) || !inside(realStorage, await realpath(dirname(directory)))) throw new Error('Report root escaped storage');
await mkdir(directory, { recursive: true });
if (!inside(realStorage, await realpath(directory))) throw new Error('Report root escaped real storage');
const url = process.env.CONTROL_ROOM_URL ?? 'http://127.0.0.1:3266/object-material-editor';
const checks = [], errors = [], screenshots = [];
let browser, page, failure = null, evidence = null;
try {
  let playwright;
  try { playwright = await import('playwright'); } catch { playwright = await import('@playwright/test'); }
  const channel = process.env.FULLMAG_OBJECT_MATERIAL_EDITOR_BROWSER_CHANNEL;
  if (channel && !['chrome', 'msedge'].includes(channel)) throw new Error('Unsupported browser channel');
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const fresh = async () => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__objectMaterialEditorFixture) && document.querySelector('[data-testid="material-editor"]')?.getAttribute('data-resource-status') === 'ready');
  };
  const read = () => page.evaluate(() => window.__objectMaterialEditorFixture.read());
  const ms = () => page.getByTestId('material-editor').getByRole('textbox', { name: 'Ms', exact: true });
  const create = () => page.getByRole('button', { name: 'Create and assign', exact: true });
  const writes = value => value.calls.filter(call => ['POST', 'PATCH'].includes(call.method));
  const pending = () => page.waitForFunction(() => window.__objectMaterialEditorFixture.read().pending === 1);
  const prepare = async () => {
    await page.getByRole('textbox', { name: 'New material ID', exact: true }).fill('mat:new');
    await page.getByRole('textbox', { name: 'New material name', exact: true }).fill('New material');
    await page.getByRole('textbox', { name: 'New Ms', exact: true }).fill('900000');
    await page.getByRole('textbox', { name: 'New A', exact: true }).fill('1.3e-11');
    await page.getByRole('spinbutton', { name: 'New alpha', exact: true }).fill('0.01');
    await page.getByRole('textbox', { name: 'New Ku1', exact: true }).fill('');
  };
  const child = async () => {
    await page.evaluate(() => window.__objectMaterialEditorFixture.switchKind('object.material'));
    await ms().waitFor();
    await page.waitForFunction(() => { const input = document.querySelector('[aria-label="Ms"]'); return Boolean(input && !input.disabled); });
  };
  const shot = async name => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true, caret: 'initial' }); screenshots.push(path); };
  const stable = () => page.evaluate(() => {
    const input = document.querySelector('[data-testid="material-unrelated"]');
    const scroll = document.querySelector('[data-testid="material-scroll"]');
    const root = document.querySelector('[data-testid="material-editor"] > *');
    return { root: root === window.__materialRoot, focused: document.activeElement === window.__materialFocus, scroll: scroll.scrollTop,
      disabled: input.disabled, opacity: getComputedStyle(input).opacity,
      opacityAnimations: document.getAnimations().filter(animation => animation.effect?.getKeyframes().some(frame => 'opacity' in frame)).length };
  });
  for (const editBack of [false, true]) {
    await fresh(); await prepare();
    const assignmentRoot = await page.evaluate(() => { window.__materialAssignmentRoot = document.querySelector('[data-testid="material-editor"] > *'); return Boolean(window.__materialAssignmentRoot); });
    assert.equal(assignmentRoot, true);
    await create().click(); await pending();
    assert.equal(writes(await read()).length, 1, 'One create issues exactly one transaction');
    await page.evaluate(() => window.__objectMaterialEditorFixture.release());
    await page.waitForFunction(() => window.__objectMaterialEditorFixture.read().pending === 1 && window.__objectMaterialEditorFixture.read().calls.some(call => call.method === 'PATCH'));
    await child();
    assert.equal(await page.evaluate(() => window.__materialAssignmentRoot === document.querySelector('[data-testid="material-editor"] > *')), true, 'Real material child keeps production panel root');
    await ms().fill('810000');
    if (editBack) await ms().fill('800000');
    await ms().focus();
    await page.evaluate(() => { window.__materialRoot = document.querySelector('[data-testid="material-editor"] > *'); window.__materialFocus = document.activeElement; document.querySelector('[data-testid="material-scroll"]').scrollTop = 35; });
    const before = await stable();
    assert.equal(before.focused, true); assert.equal(before.disabled, false); assert.equal(before.opacity, '1'); assert.equal(before.opacityAnimations, 0);
    await page.evaluate(() => {
    const unrelated = document.querySelector('[data-testid="material-unrelated"]');
    const panel = document.querySelector('[data-testid="material-editor"]');
    const scroll = document.querySelector('[data-testid="material-scroll"]');
    const root = panel.firstElementChild;
    const focused = document.activeElement;
    const scrollTop = scroll.scrollTop;
    const unrelatedInputs = [unrelated, panel.querySelector('[aria-label="alpha"]'), panel.querySelector('[aria-label="Aex"]')];
    if (unrelatedInputs.some(input => !input)) throw new Error('Unrelated production fields missing');
    const watched = new Set();
    for (const input of unrelatedInputs) for (let node = input; node; node = node.parentElement) watched.add(node);
    const evidence = { attributeChanges: [], failures: [], frames: 0 };
    let frame = null, stopped = false;
    const sample = () => {
      if (panel.firstElementChild !== root) evidence.failures.push('Inspector root replaced');
      if (document.activeElement !== focused) evidence.failures.push('Focus changed');
      if (scroll.scrollTop !== scrollTop) evidence.failures.push('Scroll changed');
      for (const input of unrelatedInputs) if (!input.isConnected || input.disabled || getComputedStyle(input).opacity !== '1') evidence.failures.push('Unrelated control changed');
      const opacityAnimations = document.getAnimations().filter(animation => animation.effect?.getKeyframes().some(keyframe => 'opacity' in keyframe));
      if (opacityAnimations.length) evidence.failures.push('Active opacity animation');
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (watched.has(record.target) && ['disabled', 'style', 'class'].includes(record.attributeName)) {
          evidence.attributeChanges.push({ tag: record.target.tagName, attribute: record.attributeName, before: record.oldValue, after: record.target.getAttribute(record.attributeName) });
        }
      }
      sample();
      if (evidence.attributeChanges.length > 200 || evidence.failures.length > 200) { evidence.failures.push('Observer budget exceeded'); stop(); }
    });
    const stop = () => { stopped = true; observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['disabled', 'style', 'class'] });
    const tick = () => {
      if (stopped) return;
      evidence.frames++;
      sample();
      if (evidence.frames >= 900) { evidence.failures.push('Frame budget exceeded'); stop(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.__materialMonitor = { finish: () => { sample(); stop(); return evidence; } };
  });
    await shot(editBack ? 'edit-back-pending' : 'newer-pending');
    await page.evaluate(() => window.__objectMaterialEditorFixture.release());
    await page.waitForFunction(() => window.__objectMaterialEditorFixture.read().canUndo);
    // Wait for resource adoption as well as history recording.
    await page.waitForFunction(() => document.querySelector('[data-testid="material-editor"]')?.getAttribute('data-resource-status') === 'ready' && [...document.querySelectorAll('[data-testid="material-editor"] *')].some(element => element.textContent === 'New material'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await ms().inputValue(), editBack ? '800000' : '810000', 'Later same-field edit survives assignment ACK, including edit-back');
    assert.deepEqual(await stable(), before);
    const after = await read();
    assert.equal(after.scene.objects.find(object => object.id === 'object-a')?.material_ref, 'mat:new');
    assert.equal(after.scene.materials.find(material => material.id === 'mat:new')?.properties?.Ms, 900000, 'Backend base differs from retained draft');
    assert.equal(writes(after).length, 2); assert.equal(writes(after)[0].body.base_revision, 1); assert.equal(writes(after)[1].body.base_revision, 2);
    const monitored = await page.evaluate(() => window.__materialMonitor.finish());
    assert.deepEqual(monitored.attributeChanges, []); assert.deepEqual(monitored.failures, []); assert(monitored.frames > 0 && monitored.frames < 900);
    assert(after.renders < 160); assert(after.calls.length < 60); assert.deepEqual(after.unexpected, []);
    checks.push({ case: editBack ? 'edit-back' : 'newer-field', monitored, writes: writes(after), renders: after.renders, requests: after.calls.length });
    await shot(editBack ? 'edit-back-ack' : 'newer-ack');
  }
  for (const change of ['object', 'session', 'history']) {
    await fresh(); await prepare(); await create().click(); await pending();
    if (change === 'object') {
      await page.evaluate(() => window.__objectMaterialEditorFixture.switchObject('object-b'));
      await page.waitForFunction(() => document.querySelector('[data-testid="material-editor"]')?.getAttribute('data-object-id') === 'object-b');
      await page.evaluate(() => window.__objectMaterialEditorFixture.switchObject('object-a'));
      await page.waitForFunction(() => document.querySelector('[data-testid="material-editor"]')?.getAttribute('data-object-id') === 'object-a');
    } else if (change === 'session') {
      await page.evaluate(() => window.__objectMaterialEditorFixture.switchSession('B'));
      await page.waitForFunction(() => document.querySelector('[data-testid="material-owner"]')?.textContent === 'session-B');
      await page.evaluate(() => window.__objectMaterialEditorFixture.switchSession('A'));
      await page.waitForFunction(() => document.querySelector('[data-testid="material-owner"]')?.textContent === 'session-A');
    } else await page.evaluate(() => window.__objectMaterialEditorFixture.resetHistory());
    // Wait for scope switch GETs before measuring stale-ACK effects.
    await page.waitForFunction(() => document.querySelector('[data-testid="material-editor"]')?.getAttribute('data-resource-status') === 'ready');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await read();
    await page.evaluate(() => window.__objectMaterialEditorFixture.release());
    await page.waitForFunction(() => window.__objectMaterialEditorFixture.read().pending === 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await read();
    assert.equal(after.canUndo, false); assert.equal(after.invalidations, before.invalidations, 'Old ACK must not invalidate current resources');
    assert.equal(writes(after).length, 1, 'Old create ACK must not continue assignment');
    assert.equal(after.scene.objects.find(object => object.id === 'object-a')?.material_ref, 'mat:base');
    assert.equal(await page.getByText('Material created and assigned.', { exact: true }).count(), 0);
    assert.deepEqual(after.unexpected, []); assert(after.calls.length < 60); assert(after.renders < 160);
    checks.push({ case: `${change}-fence`, writes: writes(after), requests: after.calls.length, renders: after.renders });
    await shot(`${change}-fence`);
  }
  evidence = await read(); assert.deepEqual(evidence.unexpected, []); assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
  if (page) { try { evidence = await page.evaluate(() => window.__objectMaterialEditorFixture?.read()); await page.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true, caret: 'initial' }); } catch { /* Preserve original failure. */ } }
} finally { if (browser) await browser.close(); }
const report = { schema: 'fullmag_object_material_editor_browser_fixture_v1', state: failure ? 'failed' : 'passed', qualification: 'fixture_only_not_backend_runtime_or_science', production_editor: true, production_hooks: true, production_resource_layer: true, unit_tests: 'not_compiled_not_run', checks, screenshots, errors, evidence, error: failure };
await writeFile(resolve(directory, 'object-material-editor.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
