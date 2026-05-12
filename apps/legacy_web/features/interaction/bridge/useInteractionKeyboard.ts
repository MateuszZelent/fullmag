/**
 * Interaction — Keyboard Shortcut Handler
 *
 * Maps keyboard events to command registry execution.
 * Mount via `useInteractionKeyboard()` in the app shell.
 */

"use client";

import { useEffect } from "react";
import { getAllCommands, executeCommand } from "../commands/commandRegistry";

/**
 * Global keyboard shortcut handler for interaction commands.
 * Attaches to `window` keydown and dispatches matching commands.
 *
 * Skips shortcuts when the active element is an input, textarea,
 * select, or contentEditable — to avoid conflicts with text editing.
 */
export function useInteractionKeyboard(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Build shortcut string
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const shortcut = parts.join("+");

      // Find matching command
      const commands = getAllCommands();
      const match = commands.find((cmd) => cmd.shortcut === shortcut);
      if (!match) return;

      e.preventDefault();
      e.stopPropagation();

      // executeCommand auto-builds context from stores when called without explicit ctx
      void executeCommand(match.id);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
