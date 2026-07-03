import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";

interface MeshRenderedNotification {
  meshRevision: number | string;
  rendererId: string;
  type: "mesh-rendered";
}

type ResourceLoadFailedNotification = KernelEventMap["resource:load-failed"] & {
  type: "resource-load-failed";
};

type NotificationEvent =
  | MeshRenderedNotification
  | ResourceLoadFailedNotification;
export const NOTIFICATION_TTL_MS = 5000;

export interface NotificationItem {
  detail: string;
  id: string;
  kind: "error" | "success";
  title: string;
}

function notificationId(event: NotificationEvent): string {
  if (event.type === "resource-load-failed") {
    return `resource-load-failed:${event.resourceKey}`;
  }
  return `mesh-rendered:${event.rendererId}:${event.meshRevision}`;
}

export function buildNotificationItem(
  event: NotificationEvent,
): NotificationItem {
  if (event.type === "resource-load-failed") {
    const fieldContext = resolveFieldResourceContext(event.resourceKey);
    const status = event.status === null ? "unknown" : String(event.status);
    const log = `resource:load-failed ${event.source}`;
    const detailPrefix = fieldContext
      ? `Quantity ${fieldContext.quantityId}; ${fieldContext.operation}.`
      : "Runtime resource request failed.";

    return {
      detail: `${detailPrefix} Resource ${event.resourceKey}. Status ${status}. Cause ${event.errorName}: ${event.cause}. Situation ${event.situation}. Log ${log}.`,
      id: notificationId(event),
      kind: "error",
      title: fieldContext ? "Quantity data unavailable" : "Resource load failed",
    };
  }

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

function resolveFieldResourceContext(
  resourceKey: string,
): { operation: string; quantityId: string } | null {
  const metaQuantityId = extractFieldQuantityId(
    resourceKey,
    DATA_FIELD_META_PATH,
  );
  if (metaQuantityId) {
    return { operation: "field metadata request", quantityId: metaQuantityId };
  }

  const vectorQuantityId = extractFieldQuantityId(
    resourceKey,
    DATA_FIELD_VECTOR_PATH,
  );
  if (vectorQuantityId) {
    return { operation: "field vector request", quantityId: vectorQuantityId };
  }

  return null;
}

function extractFieldQuantityId(
  resourceKey: string,
  pathTemplate: string,
): string | null {
  const [prefix, suffix] = pathTemplate.split("{quantity_id}");
  if (!prefix || suffix === undefined) return null;
  const prefixIndex = resourceKey.indexOf(prefix);
  if (prefixIndex < 0) return null;
  const quantityStart = prefixIndex + prefix.length;
  const suffixIndex = resourceKey.indexOf(suffix, quantityStart);
  if (suffixIndex < 0) return null;
  const encodedQuantity = resourceKey.slice(quantityStart, suffixIndex);
  if (!encodedQuantity) return null;
  try {
    return decodeURIComponent(encodedQuantity);
  } catch {
    return encodedQuantity;
  }
}
