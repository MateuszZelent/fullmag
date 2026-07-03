import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { DATA_FIELD_META_PATH } from "@/kernel/api/apiPaths";

import {
  buildNotificationItems,
  dismissNotificationItems,
  pushNotificationItem,
} from "./NotificationsSurfaceModel";
import { NotificationsView } from "./NotificationsSurface";

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

  it("deduplicates repeated viewport delivery events for the same mesh revision", () => {
    const bus = new EventBus<KernelEventMap>();
    const notifications = buildNotificationItems(bus, [
      {
        meshRevision: 4,
        rendererId: "viewport-main",
        type: "mesh-rendered",
      },
      {
        meshRevision: 4,
        rendererId: "viewport-main",
        type: "mesh-rendered",
      },
    ]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe("mesh-rendered:viewport-main:4");
  });

  it("creates an error toast when a quantity resource cannot be loaded", () => {
    const bus = new EventBus<KernelEventMap>();
    const resourceKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=magnitude`;
    const notifications = buildNotificationItems(bus, [
      {
        cause: "Request failed with status 404",
        errorName: "ControlRoomApiError",
        resourceKey,
        revision: null,
        situation: "Loading field metadata for the selected quantity",
        source: "resource-hook",
        status: 404,
        type: "resource-load-failed",
      },
    ]);

    const html = renderToStaticMarkup(
      <NotificationsView notifications={notifications} />,
    );

    expect(html).toContain("data-kind=\"error\"");
    expect(html).toContain("Quantity data unavailable");
    expect(html).toContain("Quantity H_eff");
    expect(html).toContain("field metadata request");
    expect(html).toContain("Status 404");
    expect(html).toContain("Cause ControlRoomApiError");
    expect(html).toContain("Loading field metadata");
    expect(html).toContain("Log resource:load-failed");
  });

  it("keeps only the latest instance when the same notification id is pushed again", () => {
    const initial = [
      {
        detail: "Mesh rev 3; viewport updated by viewport-main.",
        id: "mesh-rendered:viewport-main:3",
        kind: "success" as const,
        title: "Mesh built",
      },
    ];

    const notifications = pushNotificationItem(initial, {
      detail: "Mesh rev 3; viewport updated by viewport-main.",
      id: "mesh-rendered:viewport-main:3",
      kind: "success",
      title: "Mesh built",
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe("mesh-rendered:viewport-main:3");
  });

  it("removes dismissed notifications from the visible list", () => {
    const notifications = dismissNotificationItems(
      [
        {
          detail: "Mesh rev 4; viewport updated by viewport-main.",
          id: "mesh-rendered:viewport-main:4",
          kind: "success" as const,
          title: "Mesh built",
        },
        {
          detail: "Mesh rev 5; viewport updated by viewport-main.",
          id: "mesh-rendered:viewport-main:5",
          kind: "success" as const,
          title: "Mesh built",
        },
      ],
      "mesh-rendered:viewport-main:4",
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe("mesh-rendered:viewport-main:5");
  });
});
