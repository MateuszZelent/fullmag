"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";

import type { CommandContext, CommandContribution, CommandId } from "@/kernel/commands/commandTypes";

import {
  useCommandDetailResource,
  useStudyRuntimeCommandResourceData,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { ModuleProps } from "@/kernel/types";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/Command";

import { MeshBuildDialog } from "./MeshBuildDialog";
import { NotificationsSurface } from "./NotificationsSurface";
import { useCommandPalette } from "./useCommandPalette";
import { type PaletteCommandItem, filterPaletteCommands, resolvePaletteCommandItems, projectWorkspacePaletteCommands, executePaletteCommand, paletteCommandResourceData } from "./CommandPaletteModule.model";

function groupCommands(
  commands: readonly PaletteCommandItem[],
): Array<[string, PaletteCommandItem[]]> {
  const grouped = new Map<string, PaletteCommandItem[]>();

  for (const item of commands) {
    const { command } = item;
    const group = command.category ?? command.group;
    grouped.set(group, [...(grouped.get(group) ?? []), item]);
  }

  return Array.from(grouped.entries());
}

interface CommandPaletteViewProps {
  commandContext?: CommandContext | null;
  commands: readonly CommandContribution[];
  isOpen: boolean;
  onClose: () => void;
  onExecute: (commandId: CommandId) => void;
  onOpenCommandDetail?: (commandId: string) => void;
  onQueryChange: (query: string) => void;
  query: string;
}

export function CommandPaletteView({
  commandContext = null,
  commands,
  isOpen,
  onClose,
  onExecute,
  onOpenCommandDetail,
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
  const commandItems = resolvePaletteCommandItems(
    filteredCommands,
    commandContext,
  );

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <Dialog.Overlay className="fm-command-palette__overlay" />
      <Dialog.Content className="fm-command-palette" aria-label="Command palette">
        <Dialog.Title className="fm-command-palette__title">
          Command palette
        </Dialog.Title>
        <Dialog.Description className="fm-command-palette__description">
          Search and run workspace commands.
        </Dialog.Description>
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={onQueryChange}
            placeholder="Search commands"
          />
          <CommandList>
            <CommandEmpty>No commands found.</CommandEmpty>
            {groupCommands(commandItems).map(([group, groupItems]) => (
              <CommandGroup key={group} heading={group}>
                {groupItems.map(({ active, activeResource, command, disabled, disabledReason }) => (
                  <CommandItem
                    key={command.id}
                    data-active={active}
                    disabled={disabled}
                    title={disabledReason ?? (active ? "Command active" : undefined)}
                    value={`${command.title} ${command.id}`}
                    onSelect={() => {
                      if (!disabled) onExecute(command.id);
                    }}
                  >
                    <span className="fm-command-palette__item-title">
                      {command.title}
                    </span>
                    <span className="fm-command-palette__item-meta">
                      {disabledReason ?? (active ? "active" : command.shortcut ?? command.id)}
                    </span>
                    {activeResource?.kind === "command" ? (
                      <button
                        className="fm-command-palette__item-detail"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenCommandDetail?.(activeResource.commandId);
                        }}
                      >
                        Detail
                      </button>
                    ) : null}
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
  const sessions = useSessionCollection();
  const identity = useSessionResourceIdentity();
  const hasSession = sessions.state === "ready" && identity !== null;
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
    return kernel.bus.subscribe("command:submitted", ({ commandId }) => {
      if (commandId !== "workspace.command-palette") {
        close();
      }
    });
  }, [close, kernel.bus]);

  if (!hasSession) {
    return isOpen ? (
      <ProjectWorkspaceCommandPalette
        canCreateProblem={sessions.state === "no-session"}
        close={close}
        commands={commands}
        kernel={kernel}
        query={query}
        setQuery={setQuery}
      />
    ) : null;
  }

  return (
    <>
      {isOpen ? (
        <OpenCommandPalette
          close={close}
          commands={commands}
          kernel={kernel}
          query={query}
          setQuery={setQuery}
        />
      ) : null}
      <MeshBuildDialog kernel={kernel} />
      <NotificationsSurface bus={kernel.bus} />
    </>
  );
}

function ProjectWorkspaceCommandPalette({
  canCreateProblem,
  close,
  commands,
  kernel,
  query,
  setQuery,
}: {
  canCreateProblem: boolean;
  close: () => void;
  commands: readonly CommandContribution[];
  kernel: ModuleProps["kernel"];
  query: string;
  setQuery: (query: string) => void;
}) {
  const commandContext = useMemo(
    () =>
      createCommandContext("palette", kernel, {
        sessionScopeKey: null,
        sourceDetail: "command-palette",
      }),
    [kernel],
  );
  const available = useMemo(
    () => projectWorkspacePaletteCommands(commands, canCreateProblem),
    [canCreateProblem, commands],
  );

  return (
    <CommandPaletteView
      commandContext={commandContext}
      commands={available}
      isOpen
      query={query}
      onClose={close}
      onExecute={(commandId) => {
        void executePaletteCommand(kernel.commands, commandId, commandContext);
      }}
      onQueryChange={setQuery}
    />
  );
}

function OpenCommandPalette({
  close,
  commands,
  kernel,
  query,
  setQuery,
}: {
  close: () => void;
  commands: readonly CommandContribution[];
  kernel: ModuleProps["kernel"];
  query: string;
  setQuery: (query: string) => void;
}) {
  const runtimeResourceData = useStudyRuntimeCommandResourceData();
  const visualizationState = useVisualizationStateResource();
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const commandDetail = useCommandDetailResource(selectedCommandId);
  const resourceData = useMemo(
    () => paletteCommandResourceData(runtimeResourceData, visualizationState.data),
    [runtimeResourceData, visualizationState.data],
  );
  const commandContext = useMemo(
    () =>
      createCommandContext("palette", kernel, {
        resourceData,
        sourceDetail: "command-palette",
      }),
    [kernel, resourceData],
  );

  return (
    <>
      <CommandPaletteView
        commandContext={commandContext}
        commands={commands}
        isOpen
        query={query}
        onClose={close}
        onOpenCommandDetail={setSelectedCommandId}
        onExecute={(commandId) => {
          void executePaletteCommand(
            kernel.commands,
            commandId,
            commandContext,
          );
        }}
        onQueryChange={setQuery}
      />
      <CommandDetailDialog
        commandId={selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) setSelectedCommandId(null);
        }}
      />
    </>
  );
}
