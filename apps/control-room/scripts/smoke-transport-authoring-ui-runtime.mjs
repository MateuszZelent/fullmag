export async function runTransportAuthoringSmoke(deps) {
  let fixtureServer = null;
  let browser = null;
  let cdp = null;
  let result;
  let failure = null;

  try {
    fixtureServer = await deps.startFixtureServer();
    browser = await deps.startChromium();
    cdp = await deps.connectCdp(browser.wsUrl);
    result = await deps.run({ browser, cdp, fixtureServer });
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    };

    if (cdp) await cleanup(() => cdp.close());
    if (browser) {
      await cleanup(() => deps.stopChromium(browser.process));
      await cleanup(() => deps.removeProfile(browser.userDataDir));
    }
    if (fixtureServer) await cleanup(() => fixtureServer.close());
  }

  if (failure) throw failure;
  return result;
}

export async function startChromium(deps) {
  const userDataDir = deps.createProfile();
  let child = null;
  try {
    const executable = deps.findExecutable();
    child = deps.spawnBrowser(executable, userDataDir);
    const wsUrl = await deps.waitForDevTools(child);
    return { process: child, userDataDir, wsUrl };
  } catch (error) {
    if (child) await deps.stopChromium(child).catch(() => undefined);
    deps.removeProfile(userDataDir);
    throw error;
  }
}
