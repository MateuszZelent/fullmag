import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resetInspectorDocumentBudget } from "./inspector-request-budget.mjs";

const VIEWPORT_WIDTHS = [640, 899, 1024, 1280];
const MAIN_MENU_LABELS = ["File", "Edit", "View", "Simulation", "Tools", "Help"];
const FILM_NODE_ID = "model:object:film";
const INSPECTOR_MARKER = "responsive-dock-stability";

export async function qualifyFrontendResponsiveBrowser({
  page,
  fixture,
  outputDir,
  workspaceUrl,
}) {
  await mkdir(outputDir, { recursive: true });

  const originalViewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const initialRequestIndex = fixture.requests.length;
  const initialMutationCount = fixture.unknownMutationPaths.length;
  const initialGeometryWrites = fixture.geometryMutationBodies.length;
  const initialTextureWrites = fixture.textureMutationBodies.length;
  const initialGridCommands = fixture.gridCommandBodies.length;
  const initialBudgetViolation = fixture.requestBudgetViolation;
  const evidence = {
    schema: "fullmag_frontend_responsive_browser_audit_v1",
    status: "running",
    scope: "fixture-backed Control Room UI; viewport and keyboard checks only",
    workspace_url: workspaceUrl,
    requested_widths: VIEWPORT_WIDTHS,
    about_toolchain_requested_widths: [320, 640],
    scenarios: [],
    screenshots: [],
    no_backend_edits_or_solve: null,
    fixture_requests: [],
    responsive_section: null,
    about_toolchain_responsive: null,
    restoration: { status: "pending", errors: [] },
  };

  let inspector = null;
  let nameInput = null;
  let scrollViewport = null;
  let originalName = null;
  let originalScrollTop = 0;
  let responsiveDraft = null;
  let originalSelectionId = null;
  let originalRibbonTab = null;
  let homeViewOpened = false;
  let failure = null;

  async function capture(width) {
    const filename = "frontend-responsive-" + width + ".png";
    await page.screenshot({
      path: resolve(outputDir, filename),
      fullPage: true,
    });
    evidence.screenshots.push(filename);
    return filename;
  }

  async function runScenario(name, action) {
    const result = { name, status: "passed" };
    try {
      result.details = await action();
    } catch (error) {
      result.status = "failed";
      result.error = error?.stack ?? String(error);
      evidence.scenarios.push(result);
      throw error;
    }
    evidence.scenarios.push(result);
    return result.details;
  }

  async function waitForLayout() {
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        ),
    );
  }

  async function readInspectorDraftIdentity() {
    // Start hides the workspace from the accessibility tree while keeping its
    // React tree mounted. Inspect the saved DOM nodes even while hidden.
    return page.evaluate(() => {
      const refs = window.__frontendResponsiveInspectorRefs;
      return {
        rootConnected: refs?.root?.isConnected === true,
        inputConnected: refs?.input?.isConnected === true,
        rootSame: refs?.root === document.querySelector(".fm-inspector"),
        inputSame: refs?.input === refs?.root?.querySelector('input[aria-label="Name"]'),
        rootMarker: refs?.root?.dataset.frontendResponsiveMarker ?? null,
        inputMarker: refs?.input?.dataset.frontendResponsiveMarker ?? null,
        value: refs?.input?.value ?? null,
      };
    });
  }

  async function focusedLabel() {
    return page.evaluate(() =>
      (document.activeElement?.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  }

  async function waitForMenuFocus(rootMarker = null) {
    await page.waitForFunction((excludedMarker) => {
      const active = document.activeElement;
      const menu = active?.closest('[role="menu"]');
      if (!menu || (excludedMarker && menu.dataset.responsiveRootMenu === excludedMarker)) return false;
      const selector = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
      const enabled = Array.from(menu.querySelectorAll(selector)).some((item) =>
        item.closest('[role="menu"]') === menu && item.getAttribute("aria-disabled") !== "true");
      return enabled
        ? active.matches(selector) && active.getAttribute("aria-disabled") !== "true"
        : active === menu;
    }, rootMarker, { timeout: 5_000 });
  }

  async function closeMenus() {
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("Escape");
    }
  }

  async function checkCompactMenus(width) {
    const compactNav = page.locator(".fm-header__compact-nav");
    const desktopNav = page.locator(".fm-header__nav");
    assert.equal(await compactNav.isVisible(), true, "Compact main menu is missing at " + width + "px.");
    assert.equal(await desktopNav.isVisible(), false, "Desktop navigation should be hidden at " + width + "px.");

    const trigger = page.getByRole("button", { name: "Open main menu", exact: true });
    await trigger.waitFor({ state: "visible" });
    const rootMenu = page.getByRole("menu").first();
    const discoveredLabels = [];
    const keyboardActions = [];

    for (const menuLabel of MAIN_MENU_LABELS) {
      await closeMenus();
      await trigger.focus();
      await page.keyboard.press("Enter");
      await rootMenu.waitFor({ state: "visible" });
      const directLabels = (await rootMenu.getByRole("menuitem").allTextContents())
        .map(normalizeLabel)
        .filter((label) => MAIN_MENU_LABELS.includes(label));
      for (const label of directLabels) {
        if (!discoveredLabels.includes(label)) discoveredLabels.push(label);
      }

      await rootMenu.evaluate((element) => {
        element.dataset.responsiveRootMenu = "true";
      });
      let activeLabel = await focusedLabel();
      const focusTrail = [activeLabel];
      let navigationTimeout = null;
      for (let attempt = 0; attempt < MAIN_MENU_LABELS.length + 3 && activeLabel !== menuLabel; attempt += 1) {
        const expectedLabel = MAIN_MENU_LABELS[MAIN_MENU_LABELS.indexOf(activeLabel) + 1] ?? "Start";
        await page.keyboard.press("ArrowDown");
        try {
          await page.waitForFunction((label) => {
            const active = document.activeElement;
            return active?.closest('[role="menu"]')?.dataset.responsiveRootMenu === "true" &&
              active.getAttribute("role") === "menuitem" &&
              (active.textContent ?? "").replace(/\s+/g, " ").trim() === label;
          }, expectedLabel, { timeout: 5_000 });
        } catch (error) {
          navigationTimeout = { expectedLabel, message: error.message };
        }
        activeLabel = await focusedLabel();
        focusTrail.push(activeLabel);
        if (navigationTimeout) break;
      }
      if (activeLabel !== menuLabel) {
        evidence.compact_menu_failure = {
          width,
          requested: menuLabel,
          focusTrail,
          navigationTimeout,
          items: await rootMenu.getByRole("menuitem").evaluateAll((items) => items.map((item) => ({
            text: (item.textContent ?? "").replace(/\s+/g, " ").trim(),
            role: item.getAttribute("role"),
            disabled: item.hasAttribute("disabled"),
            ariaDisabled: item.getAttribute("aria-disabled"),
            tabIndex: item.tabIndex,
            highlighted: item.hasAttribute("data-highlighted"),
            collectionItem: item.hasAttribute("data-radix-collection-item"),
          }))),
          menus: await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"]'))
            .filter((menu) => menu.getClientRects().length > 0)
            .map((menu) => ({ marker: menu.dataset.responsiveRootMenu, label: menu.getAttribute("aria-label"), text: menu.textContent?.slice(0, 2000) }))),
        };
        console.error("Compact menu keyboard failure: " + JSON.stringify(evidence.compact_menu_failure));
      }
      assert.equal(activeLabel, menuLabel, "Arrow navigation could not reach " + menuLabel + " at " + width + "px.");

      await page.keyboard.press("ArrowRight");
      await waitForMenuFocus("true");
      const focusedAction = await page.evaluate(() => {
        const active = document.activeElement;
        const menu = active?.closest('[role="menu"]');
        const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).filter((item) => item.closest('[role="menu"]') === menu) : [];
        return {
          label: (active?.textContent ?? "").replace(/\s+/g, " ").trim(),
          role: active?.getAttribute("role") ?? null,
          ariaDisabled: active?.getAttribute("aria-disabled") ?? null,
          tabIndex: active instanceof HTMLElement ? active.tabIndex : null,
          itemCount: items.length,
          enabledCount: items.filter((item) => item.getAttribute("aria-disabled") !== "true").length,
          disabledReasons: items.filter((item) => item.getAttribute("aria-disabled") === "true").map((item) => item.querySelector(".fm-dropdown-reason")?.textContent?.trim() ?? ""),
          isInSubmenu: Boolean(
            active?.closest('[role="menu"]') &&
              active.closest('[role="menu"]')?.dataset.responsiveRootMenu !== "true",
          ),
        };
      });
      assert.equal(focusedAction.isInSubmenu, true, "The " + menuLabel + " action was not reached by keyboard.");
      if (focusedAction.enabledCount > 0) {
        assert.ok(focusedAction.role?.startsWith("menuitem"), "The " + menuLabel + " submenu did not focus an available action.");
        assert.notEqual(focusedAction.ariaDisabled, "true", "The first keyboard action in " + menuLabel + " is disabled.");
      } else {
        assert.equal(focusedAction.role, "menu", "A submenu with unavailable actions must retain its keyboard focus.");
        assert.ok(focusedAction.itemCount > 0, "The " + menuLabel + " submenu is empty.");
        assert.ok(focusedAction.disabledReasons.every(Boolean), "Unavailable actions in " + menuLabel + " do not explain their disabled state.");
      }
      assert.ok(focusedAction.label, "The first keyboard action in " + menuLabel + " has no accessible text.");
      keyboardActions.push({ menu: menuLabel, firstAction: focusedAction });
      await closeMenus();
    }

    assert.deepEqual(
      discoveredLabels.sort(),
      [...MAIN_MENU_LABELS].sort(),
      "The compact menu does not expose every existing main-menu group at " + width + "px.",
    );
    return { mode: "compact", menuLabels: discoveredLabels, keyboardActions };
  }

  async function checkDesktopMenus(width) {
    const compactNav = page.locator(".fm-header__compact-nav");
    const desktopNav = page.getByRole("navigation", { name: "Main menu", exact: true });
    assert.equal(await desktopNav.isVisible(), true, "Desktop navigation is missing at " + width + "px.");
    assert.equal(await compactNav.isVisible(), false, "Compact menu should be hidden at " + width + "px.");

    const keyboardActions = [];
    const discoveredLabels = [];
    for (const menuLabel of MAIN_MENU_LABELS) {
      const trigger = desktopNav.getByRole("button", { name: menuLabel, exact: true });
      await trigger.waitFor({ state: "visible" });
      discoveredLabels.push(menuLabel);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await waitForMenuFocus();
      await page.keyboard.press("ArrowDown");
      await waitForMenuFocus();
      const activeAction = await page.evaluate(() => {
        const active = document.activeElement;
        const menu = active?.closest('[role="menu"]');
        const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).filter((item) => item.closest('[role="menu"]') === menu) : [];
        return {
          label: (active?.textContent ?? "").replace(/\s+/g, " ").trim(),
          role: active?.getAttribute("role") ?? null,
          ariaDisabled: active?.getAttribute("aria-disabled") ?? null,
          itemCount: items.length,
          enabledCount: items.filter((item) => item.getAttribute("aria-disabled") !== "true").length,
          disabledReasons: items.filter((item) => item.getAttribute("aria-disabled") === "true").map((item) => item.querySelector(".fm-dropdown-reason")?.textContent?.trim() ?? ""),
        };
      });
      if (activeAction.enabledCount > 0) {
        assert.ok(activeAction.role?.startsWith("menuitem"), "Arrow navigation failed inside " + menuLabel + " at " + width + "px.");
        assert.notEqual(activeAction.ariaDisabled, "true", "Keyboard focus landed on a disabled action in " + menuLabel + ".");
      } else {
        assert.equal(activeAction.role, "menu", "A menu with unavailable actions must retain keyboard focus.");
        assert.ok(activeAction.itemCount > 0, "The " + menuLabel + " menu is empty.");
        assert.ok(activeAction.disabledReasons.every(Boolean), "Unavailable actions in " + menuLabel + " do not explain their disabled state.");
      }
      assert.ok(activeAction.label, "Keyboard action in " + menuLabel + " has no accessible text.");
      keyboardActions.push({ menu: menuLabel, action: activeAction });
      await closeMenus();
    }

    assert.deepEqual(
      discoveredLabels,
      MAIN_MENU_LABELS,
      "The desktop navigation does not expose every existing main-menu group at " + width + "px.",
    );
    return { mode: "desktop", menuLabels: discoveredLabels, keyboardActions };
  }

  try {
    await runScenario("responsive-dock-and-header-at-four-widths", async () => {
      resetInspectorDocumentBudget(fixture.requestBudget, "frontend-responsive-workspace");
      await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator(".fm-explorer").waitFor({ state: "visible", timeout: 60_000 });
      await page.locator(".fm-inspector").waitFor({ state: "visible", timeout: 60_000 });

      const activeRow = page.locator('.fm-explorer-tree-row[data-active="true"]').first();
      originalSelectionId = await activeRow.count() ? await activeRow.getAttribute("data-node-id") : null;
      await page.locator('[data-node-id="' + FILM_NODE_ID + '"]').waitFor({ state: "visible" });
      await page.locator('[data-node-id="' + FILM_NODE_ID + '"]').click();

      inspector = page.locator(".fm-inspector");
      nameInput = inspector.getByRole("textbox", { name: "Name", exact: true });
      scrollViewport = page.locator(".fm-inspector__content .fm-scroll-area__viewport").first();
      await nameInput.waitFor({ state: "visible" });
      originalName = await nameInput.inputValue();
      responsiveDraft = originalName + " responsive draft";
      originalScrollTop = await scrollViewport.evaluate((element) => element.scrollTop);
      const originalRibbonTabLocator = page.locator(
        '[role="tablist"][aria-label="Ribbon tabs"] [role="tab"][aria-selected="true"]',
      ).first();
      if (await originalRibbonTabLocator.count()) {
        originalRibbonTab = normalizeLabel(await originalRibbonTabLocator.innerText());
      }

      await nameInput.fill(responsiveDraft);
      await nameInput.focus();
      const scrollProbe = await scrollViewport.evaluate((element) => {
        const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.min(24, maxScrollTop);
        return {
          clientHeight: element.clientHeight,
          maxScrollTop,
          scrollHeight: element.scrollHeight,
          targetScrollTop: element.scrollTop,
        };
      });
      await inspector.evaluate((root, marker) => {
        const input = root.querySelector('input[aria-label="Name"]');
        if (!input) throw new Error("The local Inspector Name input was not found.");
        root.dataset.frontendResponsiveMarker = marker;
        input.dataset.frontendResponsiveMarker = marker;
        window.__frontendResponsiveInspectorRefs = { root, input };
      }, INSPECTOR_MARKER);
      assert.equal(await nameInput.inputValue(), responsiveDraft, "The Name edit was not retained as a local draft.");

      const widthResults = [];
      for (const width of VIEWPORT_WIDTHS) {
        await nameInput.focus();
        await page.setViewportSize({ width, height: originalViewport.height });
        await waitForLayout();

        const state = await inspector.evaluate((root, targetScrollTop) => {
          const refs = window.__frontendResponsiveInspectorRefs;
          const input = root.querySelector('input[aria-label="Name"]');
          const scroll = root.querySelector(".fm-inspector__content .fm-scroll-area__viewport");
          const opacityAnimations = root
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running" || animation.playState === "pending")
            .filter((animation) =>
              (animation.effect?.getKeyframes() ?? []).some((frame) =>
                Object.prototype.hasOwnProperty.call(frame, "opacity"),
              ),
            )
            .map((animation) => ({
              name: animation.animationName ?? null,
              playState: animation.playState,
            }));
          return {
            marker: root.dataset.frontendResponsiveMarker ?? null,
            rootSame: refs?.root === root,
            inputSame: refs?.input === input,
            inputFocused: document.activeElement === input,
            inputValue: input?.value ?? null,
            scrollTop: scroll?.scrollTop ?? null,
            targetScrollTop,
            opacityAnimations,
          };
        }, scrollProbe.targetScrollTop);
        assert.equal(state.marker, INSPECTOR_MARKER, "Inspector marker disappeared at " + width + "px.");
        assert.equal(state.rootSame, true, "Inspector root remounted at " + width + "px.");
        assert.equal(state.inputSame, true, "Inspector Name input remounted at " + width + "px.");
        assert.equal(state.inputFocused, true, "Inspector Name focus was lost at " + width + "px.");
        assert.equal(state.inputValue, responsiveDraft, "Inspector draft changed at " + width + "px.");
        assert.ok(
          Math.abs((state.scrollTop ?? -1) - state.targetScrollTop) <= 1,
          "Inspector scroll position changed at " + width + "px.",
        );
        assert.deepEqual(state.opacityAnimations, [], "Inspector ran an opacity animation at " + width + "px.");

        const measurements = await page.evaluate(() => {
          const group = document.querySelector("[data-workspace-column-group]");
          const groupRect = group?.getBoundingClientRect();
          const panels = group
            ? Array.from(group.querySelectorAll(":scope > [data-panel]"))
                .map((panel) => {
                  const rect = panel.getBoundingClientRect();
                  return {
                    id:
                      panel.id ||
                      panel.getAttribute("data-panel-id") ||
                      panel.getAttribute("data-slot-id") ||
                      "unnamed-panel",
                    width: Number(rect.width.toFixed(2)),
                    left: Number(rect.left.toFixed(2)),
                    right: Number(rect.right.toFixed(2)),
                    visible: rect.width > 0 && rect.height > 0,
                  };
                })
            : [];
          const header = document.querySelector(".fm-header");
          const search = header?.querySelector(".fm-header__search");
          const runControlsContainer = header?.querySelector(".fm-header__run-controls");
          const runControlsRect = runControlsContainer?.getBoundingClientRect();
          const runControls = header
            ? Array.from(header.querySelectorAll(".fm-header__run-controls button"))
                .filter((button) => button.getClientRects().length > 0)
                .map((button) => {
                  const rect = button.getBoundingClientRect();
                  return {
                    label: button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent?.trim() || "",
                    left: Number(rect.left.toFixed(2)),
                    right: Number(rect.right.toFixed(2)),
                    width: Number(rect.width.toFixed(2)),
                  insideContainer: Boolean(
                    runControlsRect &&
                      rect.left >= runControlsRect.left - 1 &&
                      rect.right <= runControlsRect.right + 1,
                  ),
                  };
                })
            : [];
          const searchRect = search?.getBoundingClientRect();
          const sectionControls = Array.from(
            document.querySelectorAll(
              '[aria-label], [title], [role="button"], [role="menuitem"], [role="tab"], .fm-dock-column__handle',
            ),
          )
            .map((element) => ({
              label:
                element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                element.textContent?.replace(/\s+/g, " ").trim() ||
                "",
              visible: element.getClientRects().length > 0,
            }))
            .filter((entry) => entry.visible && entry.label.toLowerCase().includes("section"));
          const aux = group?.querySelector('[data-slot-id="viewport-aux"]');
          const auxRect = aux?.getBoundingClientRect();
          const explorerTabs = document.querySelector(".fm-explorer-tabs");
          const mainPanel = document.getElementById("workspace-main");
          const bottomPanel = document.getElementById("panel-bottom");
          return {
            viewportWidth: window.innerWidth,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            group: group && groupRect
              ? {
                  clientWidth: group.clientWidth,
                  scrollWidth: group.scrollWidth,
                  overflow: Math.max(0, group.scrollWidth - group.clientWidth),
                  left: Number(groupRect.left.toFixed(2)),
                  right: Number(groupRect.right.toFixed(2)),
                  width: Number(groupRect.width.toFixed(2)),
                }
              : null,
            panels,
            verticalDock: {
              mainHeight: mainPanel?.getBoundingClientRect().height ?? 0,
              bottomHeight: bottomPanel?.getBoundingClientRect().height ?? 0,
            },
            explorerTabs: explorerTabs
              ? {
                  clientWidth: explorerTabs.clientWidth,
                  scrollWidth: explorerTabs.scrollWidth,
                  overflowX: getComputedStyle(explorerTabs).overflowX,
                  tabs: Array.from(explorerTabs.querySelectorAll('[role="tab"]'), (tab) => ({
                    label: tab.textContent?.trim(),
                    clientWidth: tab.clientWidth,
                    scrollWidth: tab.scrollWidth,
                  })),
                }
              : null,
            header: header
              ? {
                  clientWidth: header.clientWidth,
                  scrollWidth: header.scrollWidth,
                  overflow: Math.max(0, header.scrollWidth - header.clientWidth),
                  right: Number(header.getBoundingClientRect().right.toFixed(2)),
                  search: searchRect
                    ? {
                        visible: search.getClientRects().length > 0,
                        left: Number(searchRect.left.toFixed(2)),
                        right: Number(searchRect.right.toFixed(2)),
                      }
                    : null,
                  runControlsContainer: runControlsContainer && runControlsRect
                    ? {
                        clientWidth: runControlsContainer.clientWidth,
                        scrollWidth: runControlsContainer.scrollWidth,
                        overflow: Math.max(
                          0,
                          runControlsContainer.scrollWidth - runControlsContainer.clientWidth,
                        ),
                        left: Number(runControlsRect.left.toFixed(2)),
                        right: Number(runControlsRect.right.toFixed(2)),
                      }
                    : null,
                  runControls,
                }
              : null,
            auxViewport: auxRect
              ? {
                  visible: aux.getClientRects().length > 0,
                  width: Number(auxRect.width.toFixed(2)),
                  left: Number(auxRect.left.toFixed(2)),
                  right: Number(auxRect.right.toFixed(2)),
                }
              : null,
            sectionControls,
          };
        });

        evidence.last_measurements = measurements;
        assert.ok(measurements.group, "Workspace dock group is missing at " + width + "px.");
        assert.ok(measurements.group.width > 0, "Workspace dock group has no width at " + width + "px.");
        assert.ok(measurements.group.overflow <= 1, "Workspace dock group overflows horizontally at " + width + "px.");
        assert.ok(measurements.group.left >= -1, "Workspace dock group starts outside the viewport at " + width + "px.");
        assert.ok(
          measurements.group.right <= width + 1,
          "Workspace dock group extends beyond the viewport at " + width + "px.",
        );
        assert.ok(measurements.panels.length >= 2, "Expected visible workspace panels at " + width + "px.");
        assert.ok(
          measurements.panels.every((panel) => panel.visible && panel.width > 0),
          "A workspace panel is hidden or has no width at " + width + "px.",
        );
        assert.ok(
          ["panel-left", "viewport-main", "panel-right"].every((panelId) =>
            measurements.panels.some((panel) => panel.id === panelId),
          ),
          "A primary dock panel is missing at " + width + "px: " + JSON.stringify(measurements.panels),
        );
        assert.ok(measurements.header, "Workspace header is missing at " + width + "px.");
        const verticalPanelHeight = measurements.verticalDock.mainHeight + measurements.verticalDock.bottomHeight;
        assert.ok(measurements.verticalDock.bottomHeight > 0, "Default footer panel is missing at " + width + "px.");
        assert.ok(
          measurements.verticalDock.bottomHeight >= verticalPanelHeight * 0.12 - 2 &&
            measurements.verticalDock.mainHeight >= verticalPanelHeight * 0.42 - 2,
          "Vertical dock percentage minima were treated as pixels at " + width + "px: " + JSON.stringify(measurements.verticalDock),
        );
        assert.ok(measurements.explorerTabs?.tabs.length > 0, "Explorer tabs are missing at " + width + "px.");
        assert.ok(
          measurements.explorerTabs.tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1),
          "Explorer tab text overflows its button at " + width + "px: " + JSON.stringify(measurements.explorerTabs),
        );
        if (measurements.explorerTabs.scrollWidth > measurements.explorerTabs.clientWidth + 1) {
          assert.ok(
            ["auto", "scroll"].includes(measurements.explorerTabs.overflowX),
            "Overflowing Explorer tabs cannot be scrolled at " + width + "px.",
          );
        }
        assert.ok(measurements.header.overflow <= 1, "Workspace header clips horizontal content at " + width + "px.");
        assert.ok(
          measurements.header.right <= width + 1,
          "Workspace header extends beyond the viewport at " + width + "px.",
        );
        assert.ok(
          measurements.header.search?.visible &&
            measurements.header.search.left >= -1 &&
            measurements.header.search.right <= width + 1,
          "Command search is clipped at " + width + "px.",
        );
        assert.ok(
          measurements.header.runControls.length > 0 &&
            measurements.header.runControlsContainer?.overflow <= 1 &&
            measurements.header.runControls.every(
              (control) =>
                control.insideContainer &&
                control.left >= -1 &&
                control.right <= width + 1,
            ),
          "Runtime controls are missing or clipped at " + width + "px.",
        );
        assert.ok(
          measurements.documentScrollWidth <= measurements.documentClientWidth + 1,
          "The page has horizontal overflow at " + width + "px.",
        );

        const menuEvidence =
          width < 900 ? await checkCompactMenus(width) : await checkDesktopMenus(width);
        await nameInput.focus();
        await capture(width);
        const result = {
          width,
          height: originalViewport.height,
          inspector: state,
          layout: measurements,
          menus: menuEvidence,
          screenshot: "frontend-responsive-" + width + ".png",
        };
        widthResults.push(result);
      }

      evidence.responsive_section = {
        aux_viewport_visible_at_any_width: widthResults.some((entry) => entry.layout.auxViewport?.visible),
        section_controls_visible_at_any_width: widthResults.some((entry) =>
          entry.layout.sectionControls.length > 0,
        ),
        availability: widthResults.map((entry) => ({
          width: entry.width,
          auxViewport: entry.layout.auxViewport,
          sectionControls: entry.layout.sectionControls,
        })),
      };
      return {
        selectedNodeId: FILM_NODE_ID,
        originalName,
        localDraft: responsiveDraft,
        inspectorScrollProbe: scrollProbe,
        widths: widthResults,
        rootAndInputIdentityPreserved: true,
        focusAndScrollPreserved: true,
        opacityAnimations: [],
      };
    });

    await runScenario("about-toolchain-at-320-and-640-css-pixels", async () => {
      await closeMenus();
      await page.setViewportSize({ width: 1280, height: originalViewport.height });
      await waitForLayout();

      const mainMenu = page.getByRole("navigation", { name: "Main menu", exact: true });
      const startButton = mainMenu.getByRole("button").first();
      await startButton.waitFor({ state: "visible" });
      assert.equal(normalizeLabel(await startButton.innerText()), "Start", "The workspace Start command is missing.");
      const localNameDraftBeforeHome = await nameInput.inputValue();
      assert.equal(localNameDraftBeforeHome, responsiveDraft, "The responsive Inspector draft changed before opening Start.");
      const requestBudgetBeforeHome = {
        documentId: fixture.requestBudget.documentId,
        documentLabel: fixture.requestBudget.documentLabel,
      };
      const stateFailures = [];
      await startButton.focus();
      await page.keyboard.press("Enter");
      homeViewOpened = true;

      const startScreen = page.locator(".fm-start");
      await startScreen.waitFor({ state: "visible" });
      const recordDraftIdentity = (state, context) => {
        if (!state.rootConnected || !state.inputConnected || !state.rootSame || !state.inputSame
          || state.rootMarker !== INSPECTOR_MARKER || state.inputMarker !== INSPECTOR_MARKER) {
          stateFailures.push("The local Inspector Name draft DOM identity changed " + context + ".");
        }
        if (state.value !== responsiveDraft) {
          stateFailures.push("The local Inspector Name draft value changed " + context + ".");
        }
      };
      const draftIdentityWhileHome = await readInspectorDraftIdentity();
      recordDraftIdentity(draftIdentityWhileHome, "while Start was open");
      const localNameDraftWhileHome = draftIdentityWhileHome.value;
      const startRail = page.getByRole("navigation", { name: "Start screen sections", exact: true });
      await startRail.waitFor({ state: "visible" });
      const currentSection = startRail.locator('button[aria-current="page"]');
      await currentSection.waitFor({ state: "visible" });
      await currentSection.focus();

      const railFocusTrail = [await focusedLabel()];
      if (railFocusTrail[0] === "About") {
        await page.keyboard.press("ArrowUp");
        railFocusTrail.push(await focusedLabel());
      }
      for (let attempt = 0; attempt < 7 && railFocusTrail.at(-1) !== "About"; attempt += 1) {
        await page.keyboard.press("ArrowDown");
        railFocusTrail.push(await focusedLabel());
      }
      assert.equal(railFocusTrail.at(-1), "About", "Arrow keys could not reach the About section.");
      const aboutSectionButton = startRail.getByRole("button", { name: "About", exact: true });
      const aboutFocus = await aboutSectionButton.evaluate((button) => ({
        active: document.activeElement === button,
        current: button.getAttribute("aria-current"),
        tabIndex: button.tabIndex,
      }));
      assert.equal(aboutFocus.active, true, "Arrow navigation did not focus the About button.");
      assert.equal(
        aboutFocus.tabIndex,
        aboutFocus.current === "page" ? 0 : -1,
        "The focused About button does not match the Start rail's roving tab semantics.",
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".fm-start")?.dataset.section === "about");
      assert.equal(await aboutSectionButton.getAttribute("aria-current"), "page");
      assert.deepEqual(
        await aboutSectionButton.evaluate((button) => ({
          active: document.activeElement === button,
          tabIndex: button.tabIndex,
        })),
        { active: true, tabIndex: 0 },
        "Enter did not select About while preserving keyboard focus and tab semantics.",
      );

      const aboutCategories = page.getByRole("navigation", { name: "About section categories", exact: true });
      const toolchainCategory = aboutCategories.getByRole("button", { name: "Toolchain & System", exact: true });
      await toolchainCategory.waitFor({ state: "visible" });
      assert.ok(await toolchainCategory.evaluate((button) => button.tabIndex >= 0));
      await toolchainCategory.focus();
      assert.equal(await focusedLabel(), "Toolchain & System");
      await page.keyboard.press("Enter");
      const toolchainHeading = page.getByRole("heading", { name: "Toolchain Declarations", exact: true });
      await toolchainHeading.waitFor({ state: "visible" });
      assert.equal(
        await toolchainCategory.evaluate((button) => button.classList.contains("fm-about-nav-tab--active")),
        true,
        "Enter did not open the Toolchain & System category.",
      );

      const widthResults = [];
      const geometryFailures = [];
      const keyboard = {
        openedStartWithEnter: true,
        aboutArrowFocusTrail: railFocusTrail,
        activatedAboutWithEnter: true,
        activatedToolchainWithEnter: true,
        returnedToWorkspaceWithEnter: false,
      };
      evidence.about_toolchain_responsive = {
        widths: widthResults,
        keyboard,
        geometryFailures,
        noHorizontalClipping: null,
      };
      const requestedWidths = [
        { width: 320, layoutEquivalent: "320 CSS px reflow viewport", zoomChanged: false },
        {
          width: 640,
          layoutEquivalent: "1280 CSS px at 200% zoom equivalent; browser zoom unchanged",
          zoomChanged: false,
        },
      ];

      for (const target of requestedWidths) {
        await page.setViewportSize({ width: target.width, height: originalViewport.height });
        await page.locator(".fm-about-toolchain").scrollIntoViewIfNeeded();
        await waitForLayout();
        const measurements = await page.evaluate(() => {
          const metrics = (element) => {
            if (!(element instanceof HTMLElement)) return null;
            const rect = element.getBoundingClientRect();
            return {
              visible: element.getClientRects().length > 0,
              left: Number(rect.left.toFixed(2)),
              right: Number(rect.right.toFixed(2)),
              width: Number(rect.width.toFixed(2)),
              top: Number(rect.top.toFixed(2)),
              bottom: Number(rect.bottom.toFixed(2)),
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              overflowX: getComputedStyle(element).overflowX,
            };
          };
          const heading = document.getElementById("fm-about-toolchain-title");
          const section = heading?.closest("section");
          const chips = Array.from(document.querySelectorAll(".fm-about-toolchain .fm-about-badge-chip"));
          return {
            viewport: {
              width: window.innerWidth,
              documentClientWidth: document.documentElement.clientWidth,
              documentScrollWidth: document.documentElement.scrollWidth,
            },
            start: metrics(document.querySelector(".fm-start")),
            content: metrics(document.querySelector(".fm-start__content")),
            contentInner: metrics(document.querySelector(".fm-start__content-inner")),
            section: metrics(section),
            toolchain: metrics(section?.querySelector(".fm-about-toolchain")),
            chips: chips.map((chip) => {
              const name = chip.querySelector(":scope > span:first-child");
              const version = chip.querySelector(":scope > .fm-about-badge-chip__version");
              return {
                nameText: name?.textContent?.replace(/\s+/g, " ").trim() ?? "",
                versionText: version?.textContent?.replace(/\s+/g, " ").trim() ?? "",
                chip: metrics(chip),
                name: metrics(name),
                version: metrics(version),
              };
            }),
          };
        });

        evidence.last_measurements = measurements;
        const screenshot = "frontend-about-toolchain-" + target.width + ".png";
        widthResults.push({
          viewportWidthCssPx: target.width,
          layoutEquivalent: target.layoutEquivalent,
          browserZoomChanged: target.zoomChanged,
          measurements,
          screenshot,
        });
        evidence.about_toolchain_responsive.widths = widthResults;
        await page.screenshot({ path: resolve(outputDir, screenshot), fullPage: true });
        evidence.screenshots.push(screenshot);

        const recordFailure = (condition, message) => {
          if (!condition) geometryFailures.push(target.width + " CSS px: " + message);
        };
        const withinHorizontalBounds = (child, parent) => Boolean(
          child && parent && child.left >= parent.left - 1 && child.right <= parent.right + 1,
        );
        const recordNoHorizontalOverflow = (element, label) => {
          recordFailure(
            Boolean(element) && element.scrollWidth <= element.clientWidth + 1,
            label + " overflows horizontally: " + JSON.stringify(element),
          );
        };
        recordFailure(
          measurements.viewport.width === target.width,
          "Browser viewport differs from the requested CSS width: " + JSON.stringify(measurements.viewport),
        );
        recordFailure(measurements.start?.visible && measurements.start.width > 0, "Start screen is missing.");
        recordFailure(measurements.content?.visible && measurements.content.width > 0, "Start content is missing.");
        recordFailure(measurements.contentInner?.visible, "Start content container is missing.");
        recordFailure(measurements.section?.visible, "Toolchain section is missing.");
        recordFailure(measurements.toolchain?.visible, "Toolchain chips are missing.");
        recordFailure(measurements.chips.length > 0, "No toolchain declarations were rendered.");
        recordFailure(
          measurements.viewport.documentScrollWidth <= measurements.viewport.documentClientWidth + 1,
          "Document has horizontal overflow: " + JSON.stringify(measurements.viewport),
        );
        recordFailure(
          withinHorizontalBounds(measurements.start, { left: 0, right: target.width }),
          "Start screen extends outside the viewport: " + JSON.stringify(measurements.start),
        );
        recordNoHorizontalOverflow(measurements.start, "Start screen");
        recordFailure(
          withinHorizontalBounds(measurements.content, measurements.start),
          "Start content is clipped by the screen: " + JSON.stringify(measurements.content),
        );
        recordFailure(
          withinHorizontalBounds(measurements.contentInner, measurements.content),
          "Start content container is clipped: " + JSON.stringify(measurements.contentInner),
        );
        recordFailure(
          withinHorizontalBounds(measurements.toolchain, measurements.contentInner),
          "Toolchain declarations are clipped by the content container: " + JSON.stringify(measurements.toolchain),
        );
        recordNoHorizontalOverflow(measurements.content, "Start content");
        recordNoHorizontalOverflow(measurements.contentInner, "Start content container");
        recordNoHorizontalOverflow(measurements.toolchain, "Toolchain declarations");
        for (const chip of measurements.chips) {
          recordFailure(Boolean(chip.nameText), "Toolchain chip has no name.");
          recordFailure(Boolean(chip.versionText), "Toolchain chip has no version: " + chip.nameText);
          recordFailure(chip.chip?.visible && chip.chip.width > 0, "Toolchain chip is hidden: " + chip.nameText);
          recordFailure(chip.name?.visible && chip.version?.visible, "Toolchain name or version is hidden: " + chip.nameText);
          recordFailure(
            withinHorizontalBounds(chip.chip, measurements.toolchain),
            "Toolchain chip is clipped: " + JSON.stringify(chip),
          );
          recordFailure(
            withinHorizontalBounds(chip.name, chip.chip) && withinHorizontalBounds(chip.version, chip.chip),
            "Toolchain name or version is outside its chip: " + JSON.stringify(chip),
          );
          recordNoHorizontalOverflow(chip.chip, "Toolchain chip " + chip.nameText);
          recordNoHorizontalOverflow(chip.name, "Toolchain name " + chip.nameText);
          recordNoHorizontalOverflow(chip.version, "Toolchain version " + chip.nameText);
        }
        evidence.about_toolchain_responsive.geometryFailures = geometryFailures;
      }

      await page.setViewportSize({ width: 1280, height: originalViewport.height });
      await waitForLayout();
      const draftIdentityAfterReflow = await readInspectorDraftIdentity();
      recordDraftIdentity(draftIdentityAfterReflow, "after Start reflow");
      const returnToWorkspace = mainMenu.getByRole("button").first();
      await returnToWorkspace.waitFor({ state: "visible" });
      const returnLabel = normalizeLabel(await returnToWorkspace.innerText());
      assert.ok(
        ["Back to simulation", "Back to project", "Start"].includes(returnLabel),
        "The keyboard workspace return command is missing: " + returnLabel,
      );
      await returnToWorkspace.focus();
      await page.keyboard.press("Enter");
      await startScreen.waitFor({ state: "hidden" });
      homeViewOpened = false;
      keyboard.returnedToWorkspaceWithEnter = true;

      const nameDraftCountAfterReturn = await nameInput.count();
      const localNameDraftAfterReturn = nameDraftCountAfterReturn > 0
        ? await nameInput.inputValue()
        : null;
      const draftIdentityAfterReturn = await readInspectorDraftIdentity();
      recordDraftIdentity(draftIdentityAfterReturn, "after returning from Start");
      if (localNameDraftAfterReturn !== responsiveDraft) {
        stateFailures.push("The local Inspector Name draft changed or was unmounted after returning from Start.");
      }
      const requestBudgetAfterHome = {
        documentId: fixture.requestBudget.documentId,
        documentLabel: fixture.requestBudget.documentLabel,
      };
      if (
        requestBudgetAfterHome.documentId !== requestBudgetBeforeHome.documentId ||
        requestBudgetAfterHome.documentLabel !== requestBudgetBeforeHome.documentLabel
      ) {
        stateFailures.push("The Start scenario reset the existing request budget document.");
      }

      const failures = [...geometryFailures, ...stateFailures];
      const result = {
        widths: widthResults,
        keyboard,
        localNameDraft: {
          beforeHome: localNameDraftBeforeHome,
          whileHome: localNameDraftWhileHome,
          afterReturn: localNameDraftAfterReturn,
          preserved: stateFailures.every((failure) => !failure.includes("Name draft")),
          identity: { whileHome: draftIdentityWhileHome, afterReflow: draftIdentityAfterReflow, afterReturn: draftIdentityAfterReturn },
        },
        requestBudget: {
          before: requestBudgetBeforeHome,
          after: requestBudgetAfterHome,
          unchanged: requestBudgetBeforeHome.documentId === requestBudgetAfterHome.documentId &&
            requestBudgetBeforeHome.documentLabel === requestBudgetAfterHome.documentLabel,
        },
        geometryFailures,
        stateFailures,
        noHorizontalClipping: geometryFailures.length === 0,
      };
      evidence.about_toolchain_responsive = result;
      assert.deepEqual(failures, [], "About Toolchain responsive checks failed: " + JSON.stringify(failures));
      return result;
    });

    await runScenario("ribbon-range-accessible-name", async () => {
      const tabList = page.locator('[role="tablist"][aria-label="Ribbon tabs"]');
      const viewTab = tabList.getByRole("tab", { name: "View", exact: true });
      await viewTab.waitFor({ state: "visible" });
      await viewTab.click();

      const surfaceTrigger = page.locator('[data-action-id="view-surface"]');
      await surfaceTrigger.waitFor({ state: "visible" });
      await surfaceTrigger.focus();
      await page.keyboard.press("ArrowDown");
      const menu = page.locator(".fm-ribbon-menu");
      await menu.waitFor({ state: "visible" });
      const ranges = menu.locator('input[type="range"]');
      const rangeCount = await ranges.count();
      const sliders = [];
      for (let index = 0; index < rangeCount; index += 1) {
        const range = ranges.nth(index);
        const details = await range.evaluate((input) => ({
          ariaLabel: input.getAttribute("aria-label"),
          disabled: input.disabled,
          tabIndex: input.tabIndex,
          value: input.value,
        }));
        assert.ok(details.ariaLabel?.trim(), "Ribbon range input has no accessible name.");
        const slider = page.getByRole("slider", { name: details.ariaLabel, exact: true });
        assert.equal(await slider.count(), 1, "Ribbon slider is not exposed under its aria-label.");
        assert.equal(await slider.isVisible(), true, "Ribbon slider is not visible.");
        assert.ok(details.tabIndex >= 0 || details.disabled, "Ribbon slider is not keyboard focusable.");
        sliders.push(details);
      }
      assert.ok(rangeCount > 0, "The View surface menu did not render its existing range controls.");
      await page.keyboard.press("Escape");
      return {
        ribbonTab: "View",
        actionId: "view-surface",
        sliderCount: rangeCount,
        sliders,
        accessibleNamesVerified: true,
        valuesChanged: false,
      };
    });

    const newRequests = fixture.requests.slice(initialRequestIndex);
    const forbiddenWrites = newRequests.filter(
      (request) =>
        request.startsWith("POST /v2/sessions/current/model/transactions") ||
        request.startsWith("POST /v2/sessions/current/simulation/commands"),
    );
    assert.deepEqual(forbiddenWrites, [], "Responsive audit attempted an Inspector edit or Solve command.");
    assert.equal(
      fixture.unknownMutationPaths.length,
      initialMutationCount,
      "Responsive audit triggered an unexpected API mutation.",
    );
    assert.equal(fixture.geometryMutationBodies.length, initialGeometryWrites, "Responsive audit wrote object geometry.");
    assert.equal(fixture.textureMutationBodies.length, initialTextureWrites, "Responsive audit wrote magnetization.");
    assert.equal(fixture.gridCommandBodies.length, initialGridCommands, "Responsive audit issued a grid or Solve command.");
    assert.equal(fixture.requestBudgetViolation, initialBudgetViolation, "Responsive audit exceeded the fixture request budget.");
    evidence.no_backend_edits_or_solve = true;
    evidence.fixture_requests = newRequests;
    evidence.request_counts = Object.fromEntries(fixture.requestCounts);
    evidence.status = "passed";
  } catch (error) {
    failure = error;
    evidence.status = "failed";
    evidence.error = error?.stack ?? String(error);
    console.error("Responsive audit failure measurements: " + JSON.stringify(evidence.last_measurements ?? null));
    try {
      const filename = "frontend-responsive-failure.png";
      await page.screenshot({ path: resolve(outputDir, filename), fullPage: true });
      evidence.screenshots.push(filename);
    } catch {
      // The structured report remains useful if the page cannot be captured.
    }
  } finally {
    async function restore(label, action) {
      try {
        await action();
      } catch (error) {
        evidence.restoration.errors.push(label + ": " + (error?.message ?? String(error)));
      }
    }

    await restore("close menus", closeMenus);
    if (homeViewOpened) {
      await restore("return from Start screen", async () => {
        await page.setViewportSize({ width: 1280, height: originalViewport.height });
        const startScreen = page.locator(".fm-start");
        if (!(await startScreen.isVisible())) {
          homeViewOpened = false;
          return;
        }
        const mainMenu = page.getByRole("navigation", { name: "Main menu", exact: true });
        const returnToWorkspace = mainMenu.getByRole("button").first();
        await returnToWorkspace.waitFor({ state: "visible" });
        await returnToWorkspace.focus();
        await page.keyboard.press("Enter");
        await startScreen.waitFor({ state: "hidden" });
        homeViewOpened = false;
      });
    }
    if (nameInput && originalName !== null) {
      await restore("Name draft", async () => {
        if (await nameInput.count()) await nameInput.fill(originalName);
      });
    }
    if (originalSelectionId && originalSelectionId !== FILM_NODE_ID) {
      await restore("selection", async () => {
        const originalRow = page.locator('[data-node-id="' + originalSelectionId + '"]');
        if (await originalRow.count()) await originalRow.click();
      });
    }
    if (scrollViewport) {
      await restore("Inspector scroll", async () => {
        if (await scrollViewport.count()) {
          await scrollViewport.evaluate((element, value) => {
            element.scrollTop = value;
          }, originalScrollTop);
        }
      });
    }
    if (originalRibbonTab) {
      await restore("Ribbon tab", async () => {
        const tab = page
          .locator('[role="tablist"][aria-label="Ribbon tabs"]')
          .getByRole("tab", { name: originalRibbonTab, exact: true });
        if (await tab.count()) await tab.click();
      });
    }
    await restore("viewport", async () => {
      await page.setViewportSize(originalViewport);
    });
    await restore("Inspector marker", async () => {
      await page.evaluate(() => {
        const refs = window.__frontendResponsiveInspectorRefs;
        refs?.root?.removeAttribute("data-frontend-responsive-marker");
        refs?.input?.removeAttribute("data-frontend-responsive-marker");
        delete window.__frontendResponsiveInspectorRefs;
      });
    });
    evidence.restoration.status = evidence.restoration.errors.length === 0 ? "passed" : "failed";
    evidence.fixture_requests ??= fixture.requests.slice(initialRequestIndex);
    evidence.request_counts ??= Object.fromEntries(fixture.requestCounts);
    if (evidence.restoration.errors.length > 0 && !failure) {
      failure = new Error("Responsive browser audit could not restore all workspace state.");
      evidence.status = "failed";
      evidence.error = failure.message;
    }
    await writeFile(
      resolve(outputDir, "frontend-responsive-browser.json"),
      JSON.stringify(evidence, null, 2),
    );
  }

  if (failure) throw failure;
  return {
    scenarios: evidence.scenarios,
    screenshots: evidence.screenshots,
    evidence,
  };
}

function normalizeLabel(value) {
  return value.replace(/\s+/g, " ").trim();
}
