/**
 * Notifications feature – toast/banner notification types and store.
 */
import { create } from "zustand";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message?: string;
  timestamp: number;
  dismissed: boolean;
  autoHideMs?: number;
}

export interface NotificationStoreState {
  notifications: Notification[];
  push: (level: NotificationLevel, title: string, message?: string, autoHideMs?: number) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
  clear: () => void;
}

let nextId = 1;

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  notifications: [],

  push: (level, title, message, autoHideMs) => {
    const id = `notif-${nextId++}`;
    const notification: Notification = {
      id,
      level,
      title,
      message,
      timestamp: Date.now(),
      dismissed: false,
      autoHideMs,
    };
    set((s) => ({ notifications: [...s.notifications, notification] }));
    return id;
  },

  dismiss: (id) =>
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, dismissed: true } : n,
      ),
    })),

  dismissAll: () =>
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, dismissed: true })),
    })),

  clear: () => set({ notifications: [] }),
}));
