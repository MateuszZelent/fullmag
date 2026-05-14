import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@/design/theme/ThemeProvider";
import { SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";
import { KernelProvider } from "@/kernel/KernelProvider";

import {
  AppMenuBar,
  resolveApiConnectionErrorDetails,
  resolveHeaderSessionDisplay,
  resolveHydrationSafeHeaderSessionSource,
} from "./AppMenuBar";

describe("AppMenuBar", () => {
  it("renders header controls through shared shadcn-style button primitives", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <KernelProvider>
          <AppMenuBar />
        </KernelProvider>
      </ThemeProvider>,
    );

    expect(html).toContain("fm-button");
    expect(html).toContain("fm-header__nav-item");
    expect(html).toContain("fm-header__action-btn");
    expect(html).toContain("fm-header__app-trigger");
    expect(html).toContain("Command search");
    expect(html).toContain("Runtime controls");
    expect(html).toContain('aria-label="Switch to light theme"');
  });

  it("derives the header title and runtime badge from session status", () => {
    expect(
      resolveHeaderSessionDisplay({
        data: {
          session: {
            name: "Spin-torque run",
          },
          solver: { state: "running" },
        },
        status: "ready",
      }),
    ).toEqual({
      connectionLabel: "Local API",
      indicatorLabel: "Session connected",
      indicatorStatus: "connected",
      sessionBadge: "running",
      subtitle: "Spin-torque run",
    });
  });

  it("keeps the first client header render aligned with SSR session fallback", () => {
    const readyStatus = {
      data: {
        session: {
          name: "arch_waveguide_relax_50nm",
        },
        solver: { state: "relaxed" },
      },
      status: "ready" as const,
    };

    expect(
      resolveHeaderSessionDisplay(
        resolveHydrationSafeHeaderSessionSource(readyStatus, false),
      ),
    ).toMatchObject({
      sessionBadge: "loading",
      subtitle: "Loading session",
    });

    expect(
      resolveHeaderSessionDisplay(
        resolveHydrationSafeHeaderSessionSource(readyStatus, true),
      ),
    ).toMatchObject({
      sessionBadge: "relaxed",
      subtitle: "arch_waveguide_relax_50nm",
    });
  });

  it("builds exact API error details for the status modal", () => {
    const error = Object.assign(
      new Error("API contract version mismatch: expected 1.0.0, got missing"),
      { status: 0 },
    );

    expect(
      resolveApiConnectionErrorDetails({
        apiBase: "http://localhost:8081",
        error,
        latestRequest: {
          durationMs: 12,
          method: "GET",
          outcome: "error",
          path: SESSION_STATUS_PATH,
          requestId: "fm-test",
          status: 200,
        },
      }),
    ).toMatchObject({
      apiBase: "http://localhost:8081",
      errorMessage:
        "API contract version mismatch: expected 1.0.0, got missing",
      errorName: "Error",
      expectedContractVersion: "1.0.0",
      httpStatus: 0,
      requestUrl: "http://localhost:8081/v2/sessions/current/status",
      resourceKey: "session:status",
    });
  });
});
