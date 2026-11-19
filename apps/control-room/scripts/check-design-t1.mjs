#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFile(resolve(appRoot, path), "utf8");

const [button, base, primitives, theme, tokens, telemetry] = await Promise.all([
  source("src/shared/ui/Button.tsx"),
  source("src/design/styles/base.css"),
  source("src/design/styles/primitives.css"),
  source("src/design/styles/theme.css"),
  source("src/design/styles/tokens.css"),
  source("src/design/styles/footer-telemetry.css"),
]);

function ensure(condition, message) {
  assert.ok(condition, message);
}

function themeBlock(name) {
  const marker = new RegExp(`\\[data-theme="${name}"\\]\\s*\\{`).exec(theme);
  ensure(marker, `theme.css has a [data-theme="${name}"] block`);
  let depth = 1;
  let index = marker.index + marker[0].length;
  const start = index;
  while (index < theme.length && depth > 0) {
    if (theme[index] === "{") depth += 1;
    if (theme[index] === "}") depth -= 1;
    index += 1;
  }
  ensure(depth === 0, `theme.css [data-theme="${name}"] block is closed`);
  return theme.slice(start, index - 1);
}

function declarations(block) {
  return new Map(
    [...block.matchAll(/^\s*(--fm-[\w-]+)\s*:\s*([^;]+);/gm)]
      .map(([, name, value]) => [name, value.trim()]),
  );
}

function hexRgb(value, label) {
  ensure(/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value), `${label} is a direct 3- or 6-digit hex color; got ${value}`);
  const raw = value.slice(1);
  const pairs = raw.length === 3
    ? [...raw].map((digit) => digit + digit)
    : raw.match(/.{2}/g);
  return pairs.map((pair) => Number.parseInt(pair, 16) / 255);
}

function resolveColor(values, name, visited = new Set()) {
  ensure(!visited.has(name), `no token alias cycle while resolving ${name}`);
  visited.add(name);
  const value = values.get(name);
  ensure(value, `theme defines ${name}`);
  if (value.startsWith("#")) return hexRgb(value, name);
  const alias = /^var\((--fm-[\w-]+)\)$/.exec(value);
  ensure(alias, `${name} resolves directly to a supported color token; got ${value}`);
  return resolveColor(values, alias[1], visited);
}

function luminance(rgb) {
  const [red, green, blue] = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

function mixSrgb(first, second, secondWeight) {
  return first.map((channel, index) => channel * (1 - secondWeight) + second[index] * secondWeight);
}

const reports = [];
const themes = new Map([
  ["dark", declarations(themeBlock("dark"))],
  ["light", declarations(themeBlock("light"))],
]);
const surfaceTokens = [
  "--fm-bg-app",
  "--fm-bg-chrome",
  "--fm-bg-panel",
  "--fm-bg-panel-raised",
  "--fm-bg-surface",
  "--fm-bg-hover",
  "--fm-bg-selected",
];
const categoryNames = ["runtime", "solver", "magnetization", "energy"];

for (const [name, values] of themes) {
  const primary = resolveColor(values, "--fm-text-primary");
  const secondary = resolveColor(values, "--fm-text-secondary");
  const tertiary = resolveColor(values, "--fm-text-tertiary");
  const disabled = resolveColor(values, "--fm-text-disabled");
  const disabledBg = resolveColor(values, "--fm-bg-disabled");
  const accent = resolveColor(values, "--fm-accent");
  const textOnAccent = resolveColor(values, "--fm-text-on-accent");
  const mutedToken = values.get("--fm-text-muted");

  ensure(mutedToken === "var(--fm-text-tertiary)", `${name} muted remains a compatible alias to accessible tertiary text`);
  ensure(values.get("--fm-text-disabled") !== values.get("--fm-text-tertiary"), `${name} disabled is independent from tertiary`);

  // Hierarchy: each text role stands out from the app background at least as much as the next one.
  const app = resolveColor(values, "--fm-bg-app");
  ensure(
    contrast(primary, app) >= contrast(secondary, app) && contrast(secondary, app) >= contrast(tertiary, app),
    `${name} text hierarchy primary >= secondary >= tertiary on --fm-bg-app`,
  );

  for (const [role, color] of [["secondary", secondary], ["tertiary", tertiary]]) {
    for (const surfaceToken of surfaceTokens) {
      const ratio = contrast(color, resolveColor(values, surfaceToken));
      ensure(ratio >= 4.5, `${name} ${role} on ${surfaceToken} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
      reports.push(`${name} ${role}/${surfaceToken}: ${ratio.toFixed(2)}:1`);
    }
  }

  // WCAG 2.1 SC 1.4.3 exempts inactive controls from 4.5:1. Disabled text stays
  // readable (3:1) but must be visibly dimmer than every active text role.
  const disabledRatio = contrast(disabled, disabledBg);
  ensure(disabledRatio >= 3, `${name} disabled text/background is ${disabledRatio.toFixed(2)}:1 (needs 3:1)`);
  for (const [role, color] of [["secondary", secondary], ["tertiary", tertiary]]) {
    const separation = contrast(disabled, color);
    ensure(separation >= 1.5, `${name} disabled vs ${role} is ${separation.toFixed(2)}:1 (needs 1.5:1)`);
    reports.push(`${name} disabled vs ${role}: ${separation.toFixed(2)}:1`);
  }
  const primaryRatio = contrast(textOnAccent, accent);
  ensure(primaryRatio >= 4.5, `${name} primary button text/accent is ${primaryRatio.toFixed(2)}:1`);
  reports.push(`${name} disabled/bg: ${disabledRatio.toFixed(2)}:1`);
  reports.push(`${name} primary/accent: ${primaryRatio.toFixed(2)}:1`);

  for (const category of categoryNames) {
    const color = resolveColor(values, `--fm-category-${category}`);
    for (const tint of [0.08, 0.03]) {
      const tintedSurface = mixSrgb(resolveColor(values, "--fm-bg-panel-raised"), color, tint);
      const ratio = contrast(tertiary, tintedSurface);
      ensure(ratio >= 4.5, `${name} tertiary on ${category} telemetry hover tint ${Math.round(tint * 100)}% is ${ratio.toFixed(2)}:1`);
      reports.push(`${name} telemetry ${category}/${Math.round(tint * 100)}%: ${ratio.toFixed(2)}:1`);
    }
  }
}

const focusToken = /^\s*--fm-focus-ring\s*:\s*([^;]+);/m.exec(tokens)?.[1] ?? "";
ensure(focusToken.includes("var(--fm-bg-app)") && focusToken.includes("var(--fm-accent)"), "focus ring uses current theme surface and accent tokens");
ensure(primitives.includes(".fm-button:focus-visible") && primitives.includes("box-shadow: var(--fm-focus-ring);"), "Button focus-visible uses the shared theme-aware focus ring");
ensure(!base.includes(".fm-button"), "base.css has no duplicate Button rules");
ensure((primitives.match(/\.fm-button\s*\{/g) ?? []).length === 1, "primitives.css is the sole owner of the Button base rule");

const buttonVariants = button.slice(button.indexOf("const buttonVariants"), button.indexOf("export interface ButtonProps"));
ensure(buttonVariants.includes('"fm-button"'), "Button CVA selects its FM base class");
ensure(!/(?:\bbg-fm-|\btext-fm-|\bborder-fm-|\bh-fm-control-|\bshadow-fm-|\b(?:active|hover|focus-visible):)/.test(buttonVariants), "Button CVA has no duplicate Tailwind visual/state classes");
for (const className of ["fm-button--primary", "fm-button--secondary", "fm-button--ghost", "fm-button--danger", "fm-button--sm", "fm-button--md", "fm-button--icon"]) {
  ensure(primitives.includes(`.${className}`), `primitives.css defines ${className}`);
}
ensure(primitives.includes('.fm-button[aria-disabled="true"]') && primitives.includes("opacity: var(--fm-disabled-opacity);"), "disabled and aria-disabled Button states use explicit tokens without whole-control opacity");
ensure(primitives.includes("color: var(--fm-text-disabled);") && primitives.includes("background: var(--fm-bg-disabled);"), "disabled Button uses independent disabled roles");
ensure(primitives.includes("background: var(--fm-accent);") && primitives.includes("color: var(--fm-text-on-accent);"), "primary Button keeps accessible text on the accent in hover and default state");
ensure(primitives.includes("min-height: var(--fm-control-height-sm);") && primitives.includes("min-height: var(--fm-control-height-md);"), "Button size classes consume semantic control-height tokens");
ensure(!telemetry.includes("data-fm-theme"), "telemetry does not use the stale data-fm-theme selector");
ensure(telemetry.includes("var(--fm-bg-panel-raised) 92%, var(--fm-metric-color)"), "telemetry hover tint is bounded to 8% category color");
ensure(telemetry.includes("var(--fm-bg-panel-raised) 97%, var(--fm-metric-color)"), "telemetry hover tint fades to 3% category color");
const groupRules = telemetry.split("\n").filter((line) => line.includes(".fm-footer-telemetry__metric[data-group="));
ensure(groupRules.length === categoryNames.length, "telemetry defines each category group once");
for (const category of categoryNames) {
  ensure(groupRules.some((line) => line.includes(`data-group="${category}"`) && line.includes(`var(--fm-category-${category})`)), `telemetry group ${category} uses its semantic category token`);
}
ensure(groupRules.every((line) => !line.includes("#")), "telemetry group rules contain no hard-coded hex colors");

console.log("T1 standalone source check passed.");
console.log(reports.join("\n"));
