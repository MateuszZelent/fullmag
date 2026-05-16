"use client";

import { useSyncExternalStore } from "react";

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
}

type Listener = () => void;

const INITIAL_STATE: CommandPaletteState = {
  isOpen: false,
  query: "",
};

class CommandPaletteStore {
  private listeners = new Set<Listener>();
  private state = INITIAL_STATE;

  getSnapshot = (): CommandPaletteState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setState(patch: Partial<CommandPaletteState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  open(): void {
    this.setState({ isOpen: true });
  }

  close(): void {
    this.setState({ isOpen: false, query: "" });
  }

  toggle(): void {
    this.setState({
      isOpen: !this.state.isOpen,
      query: this.state.isOpen ? "" : this.state.query,
    });
  }

  setQuery(query: string): void {
    this.setState({ query });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const commandPaletteStore = new CommandPaletteStore();

export function useCommandPaletteSnapshot(): CommandPaletteState {
  return useSyncExternalStore(
    commandPaletteStore.subscribe,
    commandPaletteStore.getSnapshot,
    commandPaletteStore.getSnapshot,
  );
}
