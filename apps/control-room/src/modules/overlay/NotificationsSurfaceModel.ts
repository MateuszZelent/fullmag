import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

interface MeshRenderedNotification {
  meshRevision: number | string;
  rendererId: string;
  type: "mesh-rendered";
}

type NotificationEvent = MeshRenderedNotification;
export const NOTIFICATION_TTL_MS = 5000;

export interface NotificationItem {
  detail: string;
  id: string;
  kind: "success";
  title: string;
}

function notificationId(event: NotificationEvent): string {
  return `mesh-rendered:${event.rendererId}:${event.meshRevision}`;
}

export function buildNotificationItem(
  event: NotificationEvent,
): NotificationItem {
  return {
    detail: `Mesh rev ${event.meshRevision}; viewport updated by ${event.rendererId}.`,
    id: notificationId(event),
    kind: "success",
    title: "Mesh built",
  };
}

export function pushNotificationItem(
  notifications: readonly NotificationItem[],
  notification: NotificationItem,
): NotificationItem[] {
  const deduped = notifications.filter((item) => item.id !== notification.id);
  return [...deduped, notification].slice(-3);
}

export function dismissNotificationItems(
  notifications: readonly NotificationItem[],
  notificationId: string,
): NotificationItem[] {
  return notifications.filter((item) => item.id !== notificationId);
}

export function buildNotificationItems(
  _bus: EventBus<KernelEventMap>,
  events: readonly NotificationEvent[],
): NotificationItem[] {
  return events.reduce<NotificationItem[]>(
    (current, event) => pushNotificationItem(current, buildNotificationItem(event)),
    [],
  );
}
