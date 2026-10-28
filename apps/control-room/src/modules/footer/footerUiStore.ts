"use client";

import { useSyncExternalStore } from "react";

import type {
  FooterChannelFilter,
  FooterDirectionFilter,
} from "./footerModel";

export interface FooterUiState {
  channel: FooterChannelFilter;
  direction: FooterDirectionFilter;
}

type Listener = () => void;

const INITIAL_STATE: FooterUiState = {
  channel: "transport",
  direction: "all",
};

class FooterUiStore {
  private readonly listeners = new Set<Listener>();
  private state = INITIAL_STATE;

  getSnapshot = (): FooterUiState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setChannel(channel: FooterChannelFilter): void {
    if (this.state.channel === channel) return;
    this.state = { ...this.state, channel };
    this.notify();
  }

  setDirection(direction: FooterDirectionFilter): void {
    if (this.state.direction === direction) return;
    this.state = { ...this.state, direction };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const footerUiStore = new FooterUiStore();

export function useFooterUiState(): FooterUiState {
  return useSyncExternalStore(
    footerUiStore.subscribe,
    footerUiStore.getSnapshot,
    () => INITIAL_STATE,
  );
}

export function setFooterChannelFilter(channel: FooterChannelFilter): void {
  footerUiStore.setChannel(channel);
}

export function setFooterDirectionFilter(direction: FooterDirectionFilter): void {
  footerUiStore.setDirection(direction);
}
