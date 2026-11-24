import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "playwright/test";

test.use({
  browserName: "chromium",
  screenshot: "only-on-failure",
  viewport: { width: 1440, height: 1000 },
  launchOptions: {
    executablePath: process.env.FULLMAG_QA_CHROMIUM || undefined,
    args: ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

test("two Python model previews coexist with the current FDM session", async ({ page }, info) => {
  test.setTimeout(240_000);
  const origin = new URL(process.env.FULLMAG_QA_URL!);
  const fixture = JSON.parse(await readFile(process.env.FULLMAG_QA_FIXTURE!, "utf8"));
  expect(process.env.FULLMAG_QA_ALLOW_ABL_WRITE).toBe("1");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(origin.hostname);
  expect(origin.protocol).toBe("http:");
  expect(fixture.origin).toBe(origin.origin);
  expect(fixture.name).toMatch(/^ABL browser QA [0-9a-f]{32}$/);
  const currentIdentity = async () => {
    const response = await page.request.get(new URL("/v2/sessions/current/status", origin).href);
    expect(response.ok()).toBe(true);
    const status = await response.json();
    expect(status.session).toMatchObject({ ...fixture.pin, name: fixture.name });
    return { ...fixture.pin, runId: status.run?.run_id ?? null, solver: status.lifecycle.solver };
  };
  const original = await currentIdentity();
  const previews = new Set<string>();
  const previewUrl = (id: string) => new URL(`/v2/sessions/previews/${id}`, origin).href;
  const start = page.getByRole("tab", { name: "Home", exact: true });
  const canvas = page.locator("[data-session-preview-viewport] canvas");

  const openPreview = async (name: string, dimensions: string) => {
    await start.click();
    const file = page.getByLabel("Import a file", { exact: true });
    if (await file.count() === 0) await page.getByRole("button", { name: "Import", exact: true }).first().click();
    const source = info.outputPath(name + ".py");
    await writeFile(source, `
import fullmag as fm
study = fm.study(${JSON.stringify(name)})
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(160e-9, 80e-9, 40e-9))
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(${dimensions}), name="Film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1, 0, 0)
study.demag(enabled=False)
study.stages.add_run(stage_id="wave", until=1e-12)
`);
    await file.setInputFiles(source);
    await page.getByRole("button", { name: "Open model preview…" }).click();
    const [response] = await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/v2/sessions/previews/from-script"
        && response.request().method() === "POST"),
      page.getByRole("button", { name: "Run script and open preview" }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(201);
    const preview = await response.json();
    expect(preview).toMatchObject({ name, current: false, status: "preview" });
    expect(preview.session_id).toMatch(/^preview-[a-f0-9]{32}$/);
    previews.add(preview.session_id);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
      const gl = node.getContext("webgl2");
      return Boolean(gl && !gl.isContextLost() && gl.drawingBufferWidth > 0 && gl.drawingBufferHeight > 0);
    })).toBe(true);
    return preview.session_id as string;
  };

  try {
    await page.goto(new URL("/workspace", origin).href);
    await expect(page.getByRole("tab", { name: fixture.name, exact: true })).toBeVisible({ timeout: 120_000 });
    const first = await openPreview("First QA preview", "100e-9, 20e-9, 10e-9");
    const second = await openPreview("Second QA preview", "20e-9, 60e-9, 20e-9");
    expect(second).not.toBe(first);
    const list = await page.request.get(new URL("/v2/sessions", origin).href);
    expect(await list.json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ session_id: fixture.pin.session_id, current: true }),
        expect.objectContaining({ session_id: first, current: false, status: "preview" }),
        expect.objectContaining({ session_id: second, current: false, status: "preview" }),
      ]),
    });
    await page.getByRole("tab", { name: "First QA preview", exact: true }).click();
    await expect(page.getByRole("heading", { name: "First QA preview" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Second QA preview" })).toBeVisible();
    expect((await page.reload())?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Second QA preview" })).toBeVisible();
    await expect(canvas).toBeVisible();
    await page.screenshot({ path: info.outputPath("two-previews.png") });

    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Second QA preview", exact: true })).toHaveCount(0);
    expect((await page.request.get(previewUrl(second))).status()).toBe(404);
    expect((await page.request.get(previewUrl(first))).status()).toBe(200);
    await page.getByRole("tab", { name: fixture.name, exact: true }).click();
    await expect(page.locator("#fm-main-content.fm-workspace-body")).toBeVisible();
    expect(await currentIdentity()).toEqual(original);
  } finally {
    await Promise.all([...previews].map((id) => page.request.delete(previewUrl(id))));
  }
});
