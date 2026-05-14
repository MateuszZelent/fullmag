"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type {
  CommandContext,
  CommandContribution,
  CommandId,
} from "@/kernel/commands/commandTypes";
import type { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { ModuleProps } from "@/kernel/types";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/Command";

import { MeshBuildDialog } from "./MeshBuildDialog";
import { useCommandPalette } from "./useCommandPalette";
import { Viewport3DSettingsDialog } from "../viewport-3d/components/Viewport3DSettingsDialog";

export function filterPaletteCommands(
  commands: readonly CommandContribution[],
  query: string,
): CommandContribution[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return [...commands];

  return commands.filter((command) => {
    const haystack = [
      command.id,
      command.title,
      command.group,
      command.category,
      command.shortcut,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function executePaletteCommand(
  commands: CommandRegistry,
  commandId: CommandId,
  context: CommandContext,
): Promise<unknown> {
  return commands.execute(commandId, context);
}

function groupCommands(
  commands: readonly CommandContribution[],
): Array<[string, CommandContribution[]]> {
  const grouped = new Map<string, CommandContribution[]>();

  for (const command of commands) {
    const group = command.category ?? command.group;
    grouped.set(group, [...(grouped.get(group) ?? []), command]);
  }

  return Array.from(grouped.entries());
}

interface CommandPaletteViewProps {
  commands: readonly CommandContribution[];
  isOpen: boolean;
  onClose: () => void;
  onExecute: (commandId: CommandId) => void;
  onQueryChange: (query: string) => void;
  query: string;
}

export function CommandPaletteView({
  commands,
  isOpen,
  onClose,
  onExecute,
  onQueryChange,
  query,
}: CommandPaletteViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredCommands = filterPaletteCommands(commands, query);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <Dialog.Overlay className="fm-command-palette__overlay" />
      <Dialog.Content className="fm-command-palette" aria-label="Command palette">
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={onQueryChange}
            placeholder="Search commands"
          />
          <CommandList>
            <CommandEmpty>No commands found.</CommandEmpty>
            {groupCommands(filteredCommands).map(([group, groupItems]) => (
              <CommandGroup key={group} heading={group}>
                {groupItems.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={`${command.title} ${command.id}`}
                    onSelect={() => onExecute(command.id)}
                  >
                    <span className="fm-command-palette__item-title">
                      {command.title}
                    </span>
                    <span className="fm-command-palette__item-meta">
                      {command.shortcut ?? command.id}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export default function CommandPaletteModule({ kernel }: ModuleProps) {
  const {
    close,
    isOpen,
    query,
    setQuery,
  } = useCommandPalette();
  const commandVersion = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => kernel.commands.getVersion(),
  );
  const commands = useMemo(
    () => {
      void commandVersion;
      return kernel.commands.all();
    },
    [commandVersion, kernel.commands],
  );

  useEffect(() => {
    return kernel.bus.on("command:submitted", ({ commandId }) => {
      if (commandId !== "workspace.command-palette") {
        close();
      }
    });
  }, [close, kernel.bus]);

  return (
    <>
      <CommandPaletteView
        commands={commands}
        isOpen={isOpen}
        query={query}
        onClose={close}
        onExecute={(commandId) => {
          void executePaletteCommand(
            kernel.commands,
            commandId,
            createCommandContext("palette", kernel),
          );
        }}
        onQueryChange={setQuery}
      />
      <MeshBuildDialog kernel={kernel} />
      <Viewport3DSettingsDialog />
    </>
  );
}
