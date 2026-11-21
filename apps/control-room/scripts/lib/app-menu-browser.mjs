/**
 * Opens a top-level application menu (File, Tools, ...) in either header
 * layout: the full menubar on wide screens, or the "Main menu" button that
 * folds the same menus into submenus on narrower ones.
 */
async function resolveAppMenuTrigger(page, name, timeout) {
  const bar = page.getByRole("button", { name, exact: true });
  const compact = page.getByRole("button", { name: "Main menu", exact: true });
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await bar.first().isVisible().catch(() => false)) return { bar: bar.first() };
    if (await compact.first().isVisible().catch(() => false)) return { compact: compact.first() };
    if (Date.now() > deadline) {
      throw new Error(`Neither the "${name}" menubar button nor the "Main menu" button became visible.`);
    }
    await page.waitForTimeout(100);
  }
}

/** Waits until the header can open the named menu in its current layout. */
export async function waitForAppMenu(page, name, { timeout = 30_000 } = {}) {
  await resolveAppMenuTrigger(page, name, timeout);
}

/** Opens the named menu so its command menuitems are visible. */
export async function openAppMenu(page, name, { timeout = 30_000 } = {}) {
  const trigger = await resolveAppMenuTrigger(page, name, timeout);
  if (trigger.bar) {
    await trigger.bar.click();
    return;
  }
  await trigger.compact.click();
  const submenu = page.getByRole("menuitem", { name, exact: true });
  await submenu.waitFor({ state: "visible", timeout });
  await submenu.click();
}
