import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  followPreparationLogTail,
  isPreparationLogAtBottom,
  SimulationPreparationLogView,
} from "./SimulationPreparationLog";
import type { SimulationPreparationLogEntryView } from "./simulationPreparationModel";

const entries: SimulationPreparationLogEntryView[] = [
  {
    level: "info",
    message: "Building shared-domain mesh",
    stageLabel: "Meshing",
    timestampLabel: "00:00:18.500",
  },
  {
    level: "warning",
    message: "Element quality remains below target",
    stageLabel: "Meshing",
    timestampLabel: "00:00:19.000",
  },
];

describe("SimulationPreparationLog", () => {
  it("recognizes a viewport already following the live tail", () => {
    expect(
      isPreparationLogAtBottom({
        clientHeight: 100,
        scrollHeight: 300,
        scrollTop: 198,
      }),
    ).toBe(true);
    expect(
      isPreparationLogAtBottom({
        clientHeight: 100,
        scrollHeight: 300,
        scrollTop: 120,
      }),
    ).toBe(false);
  });

  it("follows new entries only while the user remains at the bottom", () => {
    const atBottom = { clientHeight: 100, scrollHeight: 360, scrollTop: 200 };
    const scrolledUp = { clientHeight: 100, scrollHeight: 360, scrollTop: 120 };

    followPreparationLogTail(atBottom, true);
    followPreparationLogTail(scrolledUp, false);

    expect(atBottom.scrollTop).toBe(360);
    expect(scrolledUp.scrollTop).toBe(120);
  });

  it("renders a bounded timestamped log without announcing entry churn", () => {
    const html = renderToStaticMarkup(
      <SimulationPreparationLogView
        entries={entries}
        isFollowingTail={true}
        scrollAreaRef={createRef<HTMLDivElement>()}
        onReturnToTail={vi.fn()}
      />,
    );

    expect(html).toContain("Preparation log");
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("00:00:18.500");
    expect(html).toContain("Building shared-domain mesh");
    expect(html).not.toContain("New entries");
  });

  it("shows a new-entry control that returns a scrolled-up view to the tail", () => {
    const onReturnToTail = vi.fn();
    const html = renderToStaticMarkup(
      <SimulationPreparationLogView
        entries={entries}
        isFollowingTail={false}
        scrollAreaRef={createRef<HTMLDivElement>()}
        onReturnToTail={onReturnToTail}
      />,
    );

    expect(html).toContain("New entries");
    expect(html).toContain("Return to live log tail");
  });
});
