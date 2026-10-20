import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_DRIVE_EDITOR_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error('Managed absolute storage/report paths required');
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), directory) || !inside(realStorage, await realpath(dirname(directory)))) throw new Error('Report root escaped storage');
await mkdir(directory, { recursive: true });
if (!inside(realStorage, await realpath(directory))) throw new Error('Report root escaped real storage');
const url = process.env.CONTROL_ROOM_URL ?? 'http://127.0.0.1:3265/antenna-drive-editor';
const checks = [], errors = [], screenshots = [];
let browser, page, failure = null, evidence = null;
try {
  let playwright;
  try { playwright = await import('playwright'); } catch { playwright = await import('@playwright/test'); }
  const channel = process.env.FULLMAG_ANTENNA_DRIVE_EDITOR_BROWSER_CHANNEL;
  if (channel && !['chrome', 'msedge'].includes(channel)) throw new Error('Unsupported browser channel');
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const fresh = async () => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__antennaDriveEditorFixture) && document.querySelector('[data-testid="drive-editor"]')?.getAttribute('data-resource-status') === 'ready');
  };
  const read = () => page.evaluate(() => window.__antennaDriveEditorFixture.read());
  const peak = () => page.getByTestId('drive-editor').getByRole('textbox', { name: 'Peak current', exact: true });
  const save = () => page.getByTestId('drive-editor').getByRole('button', { name: 'Save drive', exact: true });
  const posts = value => value.calls.filter(call => call.method === 'POST').length;
  const pending = () => page.waitForFunction(() => window.__antennaDriveEditorFixture.read().pending === 1);
  const shot = async name => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true, caret: 'initial' }); screenshots.push(path); };
  const stable = () => page.evaluate(() => {
    const input = document.querySelector('[data-testid="drive-unrelated"]');
    const scroll = document.querySelector('[data-testid="drive-scroll"]');
    const root = document.querySelector('[data-testid="drive-editor"] > *');
    return { root: root === window.__driveRoot, focused: document.activeElement === window.__driveFocus, scroll: scroll.scrollTop,
      disabled: input.disabled, opacity: getComputedStyle(input).opacity,
      opacityAnimations: document.getAnimations().filter(animation => animation.effect?.getKeyframes().some(frame => 'opacity' in frame)).length };
  });
  await fresh();
  await peak().fill('0.01');
  await peak().focus();
  await page.evaluate(() => { window.__driveRoot = document.querySelector('[data-testid="drive-editor"] > *'); window.__driveFocus = document.activeElement; document.querySelector('[data-testid="drive-scroll"]').scrollTop = 35; });
  const before = await stable();
  assert.equal(before.focused, true);
  assert.equal(before.disabled, false);
  assert.equal(before.opacity, '1');
  assert.equal(before.opacityAnimations, 0);
  await page.evaluate(() => {
    const unrelated = document.querySelector('[data-testid="drive-unrelated"]');
    const panel = document.querySelector('[data-testid="drive-editor"]');
    const scroll = document.querySelector('[data-testid="drive-scroll"]');
    const root = panel.firstElementChild;
    const focused = document.activeElement;
    const scrollTop = scroll.scrollTop;
    const watched = new Set();
    for (let node = unrelated; node; node = node.parentElement) watched.add(node);
    const evidence = { attributeChanges: [], failures: [], frames: 0 };
    let frame = null, stopped = false;
    const sample = () => {
      if (panel.firstElementChild !== root) evidence.failures.push('Inspector root replaced');
      if (document.activeElement !== focused) evidence.failures.push('Focus changed');
      if (scroll.scrollTop !== scrollTop) evidence.failures.push('Scroll changed');
      if (unrelated.disabled || getComputedStyle(unrelated).opacity !== '1') evidence.failures.push('Unrelated control changed');
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
    window.__driveMonitor = { finish: () => { sample(); stop(); return evidence; } };
  });
  await save().evaluate(button => { button.click(); button.click(); });
  await pending();
  assert.equal(posts(await read()), 1, 'Double click must issue one POST');
  await peak().fill('0.02');
  const during = await stable();
  assert.deepEqual(during, before, 'Panel/focus/scroll/unrelated controls stable during pending');
  await shot('01-pending-newer-draft');
  await page.evaluate(() => window.__antennaDriveEditorFixture.release());
  await page.waitForFunction(() => window.__antennaDriveEditorFixture.read().canUndo);
  assert.equal(await peak().inputValue(), '0.02');
  assert.deepEqual(await stable(), before, 'Panel/focus/scroll stable through ACK');
  assert.equal((await read()).scene.solved_antenna_drives[0].peak_current_a, 0.01);
  const monitored = await page.evaluate(() => window.__driveMonitor.finish());
  assert.deepEqual(monitored.attributeChanges, [], 'No transient unrelated disabled/style/class mutations');
  assert.deepEqual(monitored.failures, [], 'Continuous pending/ACK stability');
  assert(monitored.frames > 0 && monitored.frames < 900);
  assert((await read()).renders < 120, 'Bounded render commits');
  assert((await read()).calls.length < 40, 'Bounded HTTP requests');
  checks.push({ continuous_pending_ack_monitor: monitored });
  await shot('02-ack-retained-draft');
  checks.push('doublewrite guard; retained newer draft; real history; stable root/focus/scroll; unrelated controls unchanged');
  await page.waitForFunction(() => { const button = [...document.querySelectorAll('[data-testid="drive-editor"] button')].find(button => button.textContent.trim() === 'Save drive'); return Boolean(button && !button.disabled); });
  const previousRevision = (await read()).scene.revision;
  await save().click();
  await pending();
  const second = await read();
  assert.equal(posts(second), 2, 'Preserved draft can be submitted again');
  assert.equal(second.calls.filter(call => call.method === 'POST').at(-1).body.merge_patch.solved_antenna_drives[0].peak_current_a, 0.02);
  await page.evaluate(() => window.__antennaDriveEditorFixture.release());
  await page.waitForFunction(revision => { const state = window.__antennaDriveEditorFixture.read(); return state.scene.revision > revision && state.scene.solved_antenna_drives[0].peak_current_a === 0.02; }, previousRevision);
  assert.equal(await peak().inputValue(), '0.02');
  checks.push('retained draft submitted a second time and committed canonically');
  for (const change of ['session', 'drive']) {
    await fresh(); await peak().fill('0.01'); await save().click(); await pending();
    if (change === 'session') {
      await page.evaluate(() => window.__antennaDriveEditorFixture.switchSession('B'));
      await page.waitForFunction(() => document.querySelector('[data-testid="drive-owner"]')?.textContent === 'restored-model-B');
      await page.evaluate(() => window.__antennaDriveEditorFixture.switchSession('A'));
      await page.waitForFunction(() => document.querySelector('[data-testid="drive-owner"]')?.textContent === 'restored-model-A');
    } else {
      await page.evaluate(() => window.__antennaDriveEditorFixture.switchDrive('drive-b'));
      await page.waitForFunction(() => document.querySelector('[data-testid="drive-editor"]')?.getAttribute('data-drive-id') === 'drive-b');
      await page.evaluate(() => window.__antennaDriveEditorFixture.switchDrive('drive-a'));
      await page.waitForFunction(() => document.querySelector('[data-testid="drive-editor"]')?.getAttribute('data-drive-id') === 'drive-a');
    }
    const prior = await read(); const value = await peak().inputValue();
    await page.evaluate(() => window.__antennaDriveEditorFixture.release());
    await page.waitForFunction(() => window.__antennaDriveEditorFixture.read().pending === 0);
    // Two render frames let queued promise effects settle without a polling delay.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await read();
    assert.equal(after.canUndo, false, 'Stale ACK must not record history');
    assert.equal(after.invalidations, prior.invalidations, 'Stale ACK must not invalidate current resources');
    assert.equal(await peak().inputValue(), value, 'Stale ACK must not adopt committed old-owner values');
    assert.equal(await page.getByText('Antenna drive committed.', { exact: true }).count(), 0);
    await shot(`03-${change}-aba`); checks.push(`${change} ABA rejects stale ACK`);
  }
  for (const malformed of ['amplitude', 'scene_revision', 'scene_id']) {
    await fresh(); await peak().fill('0.01');
    await page.evaluate(kind => window.__antennaDriveEditorFixture.malformedNext(kind), malformed);
    await save().click(); await pending(); const prior = await read();
    await page.evaluate(() => window.__antennaDriveEditorFixture.release());
    await page.getByText(/Drive ACK/).waitFor();
    const after = await read(); assert.equal(after.canUndo, false); assert.equal(after.invalidations, prior.invalidations);
    assert.equal(await peak().inputValue(), '0.01'); checks.push(`${malformed} malformed ACK rejected before history/cache`);
  }
  evidence = await read(); assert.deepEqual(evidence.unexpected, []); assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
  if (page) { try { evidence = await page.evaluate(() => window.__antennaDriveEditorFixture?.read()); await page.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true, caret: 'initial' }); } catch { /* Preserve original failure. */ } }
} finally { if (browser) await browser.close(); }
const report = { schema: 'fullmag_antenna_drive_editor_browser_fixture_v1', state: failure ? 'failed' : 'passed', qualification: 'fixture_only_not_backend_runtime_or_science', production_editor: true, production_hooks: true, production_resource_layer: true, unit_tests: 'not_compiled_not_run', checks, screenshots, errors, evidence, error: failure };
await writeFile(resolve(directory, 'antenna-drive-editor.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
