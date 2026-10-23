import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Render proof for the shared Inspector recipe; uses no backend or solver. */
export async function qualifyInspectorTheme({ page, outputDir }) {
  const root = page.getByTestId("inspector-theme-fixture");
  await root.waitFor({ state: "visible" });
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const evidence = { themes: [], screenshots: [], colorChanges: 0 };
  try {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const width of [480, 300]) {
        await root.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
        const name = root.getByRole("textbox", { name: "Sample name", exact: true });
        await name.focus();
        await page.mouse.move(0, 0);
        await page.waitForFunction(() => {
          const field = document.querySelector('[data-testid="inspector-theme-fixture"] input[aria-label="Sample name"]');
          const probe = document.createElement("span");
          probe.style.color = "var(--fm-accent)";
          field.parentElement.append(probe);
          const borderSettled = getComputedStyle(field).borderColor === getComputedStyle(probe).color;
          probe.style.color = "var(--fm-control-surface)";
          const backgroundSettled = getComputedStyle(field).backgroundColor === getComputedStyle(probe).color;
          probe.remove();
          return borderSettled && backgroundSettled;
        });
        const metrics = await root.evaluate((element) => {
          const field = element.querySelector('input[aria-label="Sample name"]');
          const select = element.querySelector("select");
          const textarea = element.querySelector("textarea");
          const disabled = element.querySelector("input:disabled");
          const invalid = element.querySelector('[aria-invalid="true"]');
          const row = field.closest('[data-slot="inspector-property-row"]');
          const style = getComputedStyle(field);
          const resolvedColor = (token) => {
            const probe = document.createElement("span");
            probe.style.color = `var(${token})`;
            element.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          };
          return {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            cssHeight: style.height,
            flexBasis: style.flexBasis,
            parentDirection: getComputedStyle(field.parentElement).flexDirection,
            height: field.getBoundingClientRect().height,
            selectHeight: select.getBoundingClientRect().height,
            textareaHeight: textarea.getBoundingClientRect().height,
            disabledOpacity: getComputedStyle(disabled).opacity,
            invalidBorder: getComputedStyle(invalid).borderColor,
            focusBorder: style.borderColor,
            fieldBackground: style.backgroundColor,
            expectedBackground: resolvedColor("--fm-control-surface"),
            expectedFocus: resolvedColor("--fm-accent"),
            expectedInvalid: resolvedColor("--fm-danger"),
            radixHeight: element.querySelector('[data-slot="select-trigger"]').getBoundingClientRect().height,
            unitHeight: element.querySelector(".fm-inspector-quantity-unit").getBoundingClientRect().height,
            columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
            labelStarts: Array.from(element.querySelectorAll('[data-slot="inspector-property-label"], .fm-inspector-form-field__label, .fm-inspector-field-row__label'), (label) =>
              label.getBoundingClientRect().left - element.getBoundingClientRect().left),
            overflow: element.scrollWidth > element.clientWidth + 1,
          };
        });
        await writeFile(resolve(outputDir, `inspector-theme-${theme}-${width}.json`), JSON.stringify(metrics, null, 2));
        const filename = `inspector-theme-${theme}-${width}.png`;
        await root.screenshot({ path: resolve(outputDir, filename) });
        evidence.screenshots.push(filename);
        evidence.themes.push({ theme, width, ...metrics });
        assert.equal(metrics.fontSize, "12px");
        assert.equal(metrics.fontWeight, "400");
        assert.equal(metrics.height, 30);
        assert.equal(metrics.selectHeight, 30);
        assert.equal(metrics.radixHeight, 30);
        assert.ok(metrics.unitHeight >= 28 && metrics.unitHeight <= 30);
        assert.ok(metrics.textareaHeight >= 96);
        assert.equal(metrics.disabledOpacity, "1");
        assert.equal(metrics.invalidBorder, metrics.expectedInvalid);
        assert.equal(metrics.focusBorder, metrics.expectedFocus);
        assert.equal(metrics.fieldBackground, metrics.expectedBackground);
        assert.equal(metrics.columns, width === 300 ? 1 : 2);
        assert.ok(metrics.labelStarts.length > 0 && metrics.labelStarts.every((left) => Math.abs(left - metrics.labelStarts[0]) < 0.5),
          `${theme}/${width} property labels do not share the same inset`);
        assert.equal(metrics.overflow, false, `${theme}/${width} overflows`);
      }
    }
    assert.notEqual(evidence.themes[0].fieldBackground, evidence.themes[2].fieldBackground, "Light/dark field surfaces did not change");
    const tokenPreview = root.getByRole("textbox", { name: "Theme color value", exact: true });
    assert.equal(await tokenPreview.inputValue(), "var(--fm-accent)");
    assert.equal(await root.getByRole("textbox", { name: "Automatic color value", exact: true }).inputValue(), "");
    assert.equal(await root.getByTestId("inspector-theme-color-changes").innerText(), "0");
    const picker = root.getByLabel("Sample color picker", { exact: true });
    await picker.focus();
    assert.equal(await picker.evaluate((element) => element === document.activeElement), true);
    await picker.fill("#123456");
    assert.equal(await root.getByRole("textbox", { name: "Sample color value", exact: true }).inputValue(), "#123456");
    await root.getByRole("textbox", { name: "Sample color value", exact: true }).fill("var(--fm-accent)");
    assert.equal(await root.getByRole("textbox", { name: "Sample color value", exact: true }).inputValue(), "var(--fm-accent)");
    assert.equal(await root.getByRole("textbox", { name: "Disabled color value", exact: true }).isDisabled(), true);
    evidence.colorChanges = Number(await root.getByTestId("inspector-theme-color-changes").innerText());
    assert.equal(evidence.colorChanges, 2, "Rendering or theme changes emitted a color mutation");
    return evidence;
  } finally {
    await root.evaluate((element) => { element.style.width = "100%"; });
    await page.evaluate((theme) => {
      if (theme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", theme);
    }, originalTheme);
  }
}
