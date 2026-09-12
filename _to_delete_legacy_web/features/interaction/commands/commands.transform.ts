/**
 * P3 — Transform Commands
 *
 * Commands for viewport mode switching and transform tools.
 * ADR-002: Camera and Manipulate are mutually exclusive.
 */

import type { CommandDefinition } from "./commandRegistry";
import { registerCommand } from "./commandRegistry";
import { isTargetTransformable } from "../model/selection";
import { useInteractionStore } from "../store/useInteractionStore";

// ── viewport.mode.camera ──────────────────────────────────────

const viewportModeCamera: CommandDefinition = {
  id: "viewport.mode.camera",
  label: "Camera Mode",
  icon: "camera",
  group: "viewport",
  shortcut: "C",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: true,
    active: ctx.viewport.mode === "camera",
  }),
  execute: () => {
    useInteractionStore.getState().setMode("camera");
  },
};

// ── viewport.mode.manipulate ──────────────────────────────────

const viewportModeManipulate: CommandDefinition = {
  id: "viewport.mode.manipulate",
  label: "Manipulate Mode",
  icon: "manipulate",
  group: "viewport",
  shortcut: "M",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: isTargetTransformable(ctx.selection.target),
    active: ctx.viewport.mode === "manipulate",
    reason: isTargetTransformable(ctx.selection.target)
      ? undefined
      : "Select an object or magnetization texture to manipulate",
  }),
  execute: () => {
    useInteractionStore.getState().setMode("manipulate");
  },
};

// ── transform.tool.select ─────────────────────────────────────

const transformToolSelect: CommandDefinition = {
  id: "transform.tool.select",
  label: "Select Tool",
  icon: "cursor",
  group: "transform",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: true,
    active: ctx.viewport.tool === "select",
  }),
  execute: () => {
    useInteractionStore.getState().setTool("select");
  },
};

// ── transform.tool.move ───────────────────────────────────────

const transformToolMove: CommandDefinition = {
  id: "transform.tool.move",
  label: "Move",
  icon: "move",
  group: "transform",
  shortcut: "W",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: isTargetTransformable(ctx.selection.target),
    active: ctx.viewport.mode === "manipulate" && ctx.viewport.tool === "move",
    reason: isTargetTransformable(ctx.selection.target) ? undefined : "Select object or magnetization texture",
  }),
  execute: () => {
    useInteractionStore.getState().setTool("move");
  },
};

// ── transform.tool.rotate ─────────────────────────────────────

const transformToolRotate: CommandDefinition = {
  id: "transform.tool.rotate",
  label: "Rotate",
  icon: "rotate",
  group: "transform",
  shortcut: "E",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: isTargetTransformable(ctx.selection.target),
    active: ctx.viewport.mode === "manipulate" && ctx.viewport.tool === "rotate",
    reason: isTargetTransformable(ctx.selection.target) ? undefined : "Select object or magnetization texture",
  }),
  execute: () => {
    useInteractionStore.getState().setTool("rotate");
  },
};

// ── transform.tool.scale ──────────────────────────────────────

const transformToolScale: CommandDefinition = {
  id: "transform.tool.scale",
  label: "Scale",
  icon: "scale",
  group: "transform",
  shortcut: "R",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: isTargetTransformable(ctx.selection.target),
    active: ctx.viewport.mode === "manipulate" && ctx.viewport.tool === "scale",
    reason: isTargetTransformable(ctx.selection.target) ? undefined : "Select object or magnetization texture",
  }),
  execute: () => {
    useInteractionStore.getState().setTool("scale");
  },
};

// ── Register all ──────────────────────────────────────────────

export function registerTransformCommands(): void {
  registerCommand(viewportModeCamera);
  registerCommand(viewportModeManipulate);
  registerCommand(transformToolSelect);
  registerCommand(transformToolMove);
  registerCommand(transformToolRotate);
  registerCommand(transformToolScale);
}
