"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { Button } from "@/shared/ui/Button";
import {
  buildNotificationItem,
  dismissNotificationItems,
  NOTIFICATION_TTL_MS,
  pushNotificationItem,
  type NotificationItem,
} from "./NotificationsSurfaceModel";

export function NotificationsView({
  onDismiss,
  notifications,
}: {
  onDismiss?: (notificationId: string) => void;
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
        <output
          className="fm-notifications__toast"
          data-kind={notification.kind}
          key={notification.id}
        >
          <div className="fm-notifications__toast-header">
            <strong>{notification.title}</strong>
            {onDismiss ? (
              <Button
                aria-label={`Dismiss ${notification.title}`}
                className="fm-notifications__close"
                onClick={() => onDismiss(notification.id)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={14} />
              </Button>
            ) : null}
          </div>
          <span>{notification.detail}</span>
        </output>
      ))}
    </aside>
  );
}

export function NotificationsSurface({
  bus,
}: {
  bus: EventBus<KernelEventMap>;
}) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const dismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>> | null>(null);
  if (dismissTimers.current === null) {
    dismissTimers.current = new Map();
  }

  const dismissNotification = useCallback((notificationId: string) => {
    const timers = dismissTimers.current;
    if (timers === null) return;
    const timer = timers.get(notificationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(notificationId);
    }
    setNotifications((current) =>
      dismissNotificationItems(current, notificationId),
    );
  }, []);

  const scheduleDismiss = useCallback(
    (notificationId: string) => {
      const timers = dismissTimers.current;
      if (timers === null) return;
      const existing = timers.get(notificationId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        timers.delete(notificationId);
        setNotifications((current) =>
          dismissNotificationItems(current, notificationId),
        );
      }, NOTIFICATION_TTL_MS);
      timers.set(notificationId, timer);
    },
    [],
  );

  const handleMeshTopologyRendered = useEffectEvent(
    (payload: KernelEventMap["mesh:topology-rendered"]) => {
      const notification = buildNotificationItem({
        meshRevision: payload.meshRevision,
        rendererId: payload.rendererId,
        type: "mesh-rendered",
      });
      setNotifications((current) =>
        pushNotificationItem(current, notification),
      );
      scheduleDismiss(notification.id);
    },
  );

  const handleResourceLoadFailed = useEffectEvent(
    (payload: KernelEventMap["resource:load-failed"]) => {
      const notification = buildNotificationItem({
        ...payload,
        type: "resource-load-failed",
      });
      setNotifications((current) =>
        pushNotificationItem(current, notification),
      );
      scheduleDismiss(notification.id);
    },
  );

  useEffect(() => {
    const timers = dismissTimers.current;
    if (timers === null) return;
    const unsubscribeMesh = bus.on(
      "mesh:topology-rendered",
      handleMeshTopologyRendered,
    );
    const unsubscribeResourceLoadFailed = bus.on(
      "resource:load-failed",
      handleResourceLoadFailed,
    );
    return () => {
      unsubscribeMesh();
      unsubscribeResourceLoadFailed();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [bus]);

  return (
    <NotificationsView
      notifications={notifications}
      onDismiss={dismissNotification}
    />
  );
}
