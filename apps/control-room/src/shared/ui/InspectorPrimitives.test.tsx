import { readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

vi.mock("@radix-ui/react-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-dialog")>();
  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock("@radix-ui/react-popover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-popover")>();
  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./AlertDialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./Collapsible";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./HoverCard";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "./InputGroup";
import { OverflowText } from "./OverflowText";
import { RadioGroup, RadioGroupItem } from "./RadioGroup";
import { Select, SelectTrigger, SelectValue } from "./Select";
import { ToggleGroup, ToggleGroupItem } from "./ToggleGroup";

const appRoot = process.cwd();

afterEach(() => {
  vi.useRealTimers();
});

describe("Wave 1 inspector UI primitives", () => {
  it("toggles Collapsible aria-expanded and hidden content cleanly", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <Collapsible defaultOpen={false}>
          <CollapsibleTrigger>Magnetization and exchange</CollapsibleTrigger>
          <CollapsibleContent>Ms = 800 kA/m</CollapsibleContent>
        </Collapsible>,
      );
    });

    const trigger = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "collapsible-trigger",
      "collapsible trigger",
    );
    const content = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "collapsible-content",
      "collapsible content",
    );

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(content.getAttribute("id"));
    expect(content.getAttribute("data-state")).toBe("closed");

    await act(async () => {
      trigger.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("data-state")).toBe("open");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("opens HoverCard on keyboard focus and honors openDelay on pointer hover", () => {
    const closedHtml = renderToStaticMarkup(
      <HoverCard defaultOpen={false}>
        <HoverCardTrigger>Ms</HoverCardTrigger>
        <HoverCardContent>Saturation magnetization</HoverCardContent>
      </HoverCard>,
    );
    expect(closedHtml).toContain('data-slot="hover-card-trigger"');
    expect(closedHtml).not.toContain('data-slot="hover-card-content"');

    const openHtml = renderToStaticMarkup(
      <HoverCard open>
        <HoverCardTrigger>Ms</HoverCardTrigger>
        <HoverCardContent>Saturation magnetization (A/m)</HoverCardContent>
      </HoverCard>,
    );
    expect(openHtml).toContain('data-slot="hover-card-content"');
    expect(openHtml).toContain("fm-hover-card");
    expect(openHtml).toContain("Saturation magnetization (A/m)");

    const hoverCardSource = readFileSync(
      path.join(appRoot, "src/shared/ui/HoverCard.tsx"),
      "utf8",
    );
    expect(hoverCardSource).toContain("openDelay = 350");
    expect(hoverCardSource).toContain("closeDelay = 80");
    expect(hoverCardSource).toContain("onFocus");
    expect(hoverCardSource).toContain("context.openImmediately()");
  });

  it("renders AlertDialog with alertdialog role and explicit confirm/cancel controls", () => {
    const onConfirm = vi.fn();
    const html = renderToStaticMarkup(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild tetrahedral mesh?</AlertDialogTitle>
            <AlertDialogDescription>
              Rebuilding clears cached fields for the current stage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={onConfirm}>
              Rebuild mesh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('data-slot="alert-dialog-content"');
    expect(html).toContain('data-slot="alert-dialog-action"');
    expect(html).toContain('data-slot="alert-dialog-cancel"');
    expect(html).toContain("Rebuild tetrahedral mesh?");
    expect(html).toContain("fm-button--danger");

    const alertDialogSource = readFileSync(
      path.join(appRoot, "src/shared/ui/AlertDialog.tsx"),
      "utf8",
    );
    expect(alertDialogSource).toContain("onPointerDownOutside");
    expect(alertDialogSource).toContain("onInteractOutside");
    expect(alertDialogSource).toContain("event.preventDefault()");
  });

  it("supports keyboard roving selection in ToggleGroup and RadioGroup", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onToggleChange = vi.fn();
    const onRadioChange = vi.fn();

    await act(async () => {
      root.render(
        <div>
          <ToggleGroup
            aria-label="Visible layers"
            defaultValue={["surface"]}
            type="multiple"
            onValueChange={onToggleChange}
          >
            <ToggleGroupItem value="surface">Surface</ToggleGroupItem>
            <ToggleGroupItem value="vectors">Vectors</ToggleGroupItem>
          </ToggleGroup>
          <RadioGroup
            aria-label="Clamp mode"
            defaultValue="none"
            onValueChange={onRadioChange}
          >
            <RadioGroupItem value="none">None</RadioGroupItem>
            <RadioGroupItem value="repeat">Repeat</RadioGroupItem>
          </RadioGroup>
        </div>,
      );
    });

    const vectorsToggle = findElement(
      container,
      (el) =>
        el.getAttribute("data-slot") === "toggle-group-item" &&
        el.getAttribute("data-value") === "vectors",
      "vectors toggle",
    );
    await act(async () => {
      vectorsToggle.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(onToggleChange).toHaveBeenCalledWith(["surface", "vectors"]);

    const noneRadio = findElement(
      container,
      (el) =>
        el.getAttribute("data-slot") === "radio-group-item" &&
        el.getAttribute("data-value") === "none",
      "none radio",
    );
    await act(async () => {
      noneRadio.dispatchEvent(
        new TestEvent("keydown", { bubbles: true, key: "ArrowDown" }),
      );
    });
    expect(onRadioChange).toHaveBeenCalledWith("repeat");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("renders InputGroup as a single unified recessed field without double borders", () => {
    const html = renderToStaticMarkup(
      <InputGroup>
        <InputGroupInput aria-label="Saturation magnetization" defaultValue="800" />
        <InputGroupAddon align="inline-end">
          <InputGroupText>kA/m</InputGroupText>
          <InputGroupButton aria-label="Select unit">▾</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );

    expect(html).toContain('data-slot="input-group"');
    expect(html).toContain('data-slot="input-group-control"');
    expect(html).toContain('data-slot="input-group-addon"');
    expect(html).toContain('data-align="inline-end"');
    expect(html).toContain("kA/m");
  });

  it("renders OverflowText without bare title attributes and stays keyboard-focusable", () => {
    const html = renderToStaticMarkup(
      <OverflowText>very_long_waveguide_geometry_identifier_01</OverflowText>,
    );

    expect(html).toContain('data-slot="overflow-text"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("very_long_waveguide_geometry_identifier_01");
    expect(html).not.toContain("title=");
  });

  it("keeps Select chevron at full token contrast without opacity-50", () => {
    const html = renderToStaticMarkup(
      <Select defaultValue="fdm">
        <SelectTrigger aria-label="Solver">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    const selectSource = readFileSync(
      path.join(appRoot, "src/shared/ui/Select.tsx"),
      "utf8",
    );

    expect(html).toContain("text-fm-muted");
    expect(html).toContain("border-fm-control-border");
    expect(html).not.toContain("opacity-50");
    expect(selectSource).not.toContain("opacity-50");
  });

  it("enforces >= 24px touch targets, WCAG control borders, switch thumb contrast, and glass overlays in primitives.css", () => {
    const primitivesCss = readFileSync(
      path.join(appRoot, "src/design/styles/primitives.css"),
      "utf8",
    );

    expect(primitivesCss).toContain("border: 1px solid var(--fm-border-control);");
    expect(primitivesCss).toContain("background: var(--fm-field-bg);");
    expect(primitivesCss).toContain("background: var(--fm-switch-thumb);");
    expect(primitivesCss).toContain("min-block-size: var(--fm-space-6);");
    expect(primitivesCss).toContain("background: var(--fm-glass-strong);");
    expect(primitivesCss).toContain("backdrop-filter: var(--fm-glass-backdrop);");
    expect(primitivesCss).toContain('[data-slot="hover-card-content"]');
    expect(primitivesCss).toContain('[data-slot="alert-dialog-content"]');
  });
});
