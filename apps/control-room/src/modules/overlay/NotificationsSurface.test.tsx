import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

import { buildNotificationItems, NotificationsView } from "./NotificationsSurface";

describe("NotificationsSurface", () => {
  it("creates a viewport delivery toast from mesh topology render events", () => {
    const bus = new EventBus<KernelEventMap>();
    const notifications = buildNotificationItems(bus, [
      {
        meshRevision: 42,
        rendererId: "viewport-main",
        type: "mesh-rendered",
      },
    ]);

    const html = renderToStaticMarkup(
      <NotificationsView notifications={notifications} />,
    );

    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("Mesh built");
    expect(html).toContain("viewport updated");
    expect(html).toContain("rev 42");
  });
});
