"use client";

import { useEffect, useState } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

interface MeshRenderedNotification {
  meshRevision: number | string;
  rendererId: string;
  type: "mesh-rendered";
}

type NotificationEvent = MeshRenderedNotification;

export interface NotificationItem {
  detail: string;
  id: string;
  kind: "success";
  title: string;
}

function notificationId(event: NotificationEvent): string {
  return `mesh-rendered:${event.rendererId}:${event.meshRevision}`;
}

export function buildNotificationItems(
  _bus: EventBus<KernelEventMap>,
  events: readonly NotificationEvent[],
): NotificationItem[] {
  return events.slice(-3).map((event) => ({
    detail: `Mesh rev ${event.meshRevision}; viewport updated by ${event.rendererId}.`,
    id: notificationId(event),
    kind: "success",
    title: "Mesh built",
  }));
}

export function NotificationsView({
  notifications,
}: {
  notifications: readonly NotificationItem[];
}) {
  if (notifications.length === 0) return null;

  return (
    <aside
      aria-label="Notifications"
      aria-live="polite"
      className="fm-notifications"
    >
      {notifications.map((notification) => (
        <div
          className="fm-notifications__toast"
          data-kind={notification.kind}
          key={notification.id}
          role="status"
        >
          <strong>{notification.title}</strong>
          <span>{notification.detail}</span>
        </div>
      ))}
    </aside>
  );
}

export function NotificationsSurface({
  bus,
}: {
  bus: EventBus<KernelEventMap>;
}) {
  const [events, setEvents] = useState<NotificationEvent[]>([]);

  useEffect(() => {
    return bus.on("mesh:topology-rendered", (payload) => {
      setEvents((current) => [
        ...current.slice(-2),
        {
          meshRevision: payload.meshRevision,
          rendererId: payload.rendererId,
          type: "mesh-rendered",
        },
      ]);
    });
  }, [bus]);

  return <NotificationsView notifications={buildNotificationItems(bus, events)} />;
}
