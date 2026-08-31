"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";

import { useTheme } from "@/design/theme/ThemeProvider";
import {
  SIMULATION_SOLVER_STATUS_PATH,
  SESSION_STATUS_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import { readDetailedRuntimeState } from "@/kernel/runtime/runtimeStateDisplay";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import {
  EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { FullmagMark } from "@/shared/brand/FullmagLogo";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { ThemeSwitcher } from "@/shared/ui/ThemeSwitcher";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import {
  APP_DROPDOWN_ITEMS,
  MAIN_MENUS,
  QUICK_ACTIONS,
  RUN_CONTROLS,
  type AppMenuNode,
  type HeaderQuickAction,
} from "./appMenuModel";
import {
  type ApiConnectionErrorDetails,
  headerSessionSourceEquals,
  latestRequestForPath,
  resolveApiConnectionErrorDetails,
  resolveHeaderSessionDisplay,
  resolveHydrationSafeHeaderSessionSource,
  selectHeaderSessionSource,
} from "./AppMenuBarHeaderModel";
import { CommunicationPolicyDialog } from "./CommunicationPolicyDialog";
import { DataPreviewDialog } from "./DataPreviewDialog";
import { MaterialLibraryDialog } from "./MaterialLibraryDialog";
import { RegistryInspectorDialog } from "./RegistryInspectorDialog";
import { DiagnosticRecorderDialog } from "./diagnostic-recorder/DiagnosticRecorderDialog";
import { NewProblemDialog } from "./NewProblemDialog";

function subscribeToHydration(): () => void {
  return () => {};
}

function clientHydratedSnapshot(): boolean {
  return true;
}

function serverHydratedSnapshot(): boolean {
  return false;
}

function noopRefetch(): void {}

function MenuNode({
  isCommandActive,
  isCommandDisabled,
  node,
  onCommand,
}: {
  isCommandActive: (commandId: string) => boolean;
  isCommandDisabled: (commandId: string) => boolean;
  node: AppMenuNode;
  onCommand: (commandId: string, input?: unknown) => void;
}) {
  const disabled = node.disabled || isCommandDisabled(node.id);
  if (node.children?.length) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={disabled}>
          {node.icon}
          <span>{node.label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {node.children.map((child) => (
            <MenuNode
              key={child.id}
              isCommandActive={isCommandActive}
              isCommandDisabled={isCommandDisabled}
              node={child}
              onCommand={onCommand}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  if (node.checkable) {
    return (
      <DropdownMenuCheckboxItem
        checked={isCommandActive(node.id)}
        disabled={disabled}
        onCheckedChange={(checked) => onCommand(node.id, Boolean(checked))}
      >
        {node.icon}
        <span>{node.label}</span>
        {node.shortcut ? (
          <span className="fm-dropdown-shortcut">{node.shortcut}</span>
        ) : null}
      </DropdownMenuCheckboxItem>
    );
  }

  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onCommand(node.id)}
    >
      {node.icon}
      <span>{node.label}</span>
      {node.shortcut ? (
        <span className="fm-dropdown-shortcut">{node.shortcut}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

function HeaderDropdown({
  isCommandActive,
  isCommandDisabled,
  menu,
  onCommand,
}: {
  isCommandActive: (commandId: string) => boolean;
  isCommandDisabled: (commandId: string) => boolean;
  menu: AppMenuNode;
  onCommand: (commandId: string, input?: unknown) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="fm-header__nav-item"
          size="sm"
          type="button"
          variant="ghost"
        >
          {menu.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{menu.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {menu.children?.map((node) => (
          <MenuNode
            key={node.id}
            isCommandActive={isCommandActive}
            isCommandDisabled={isCommandDisabled}
            node={node}
            onCommand={onCommand}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickActionButton({
  action,
  disabled,
  onCommand,
}: {
  action: HeaderQuickAction;
  disabled: boolean;
  onCommand: (commandId: string, input?: unknown) => void;
}) {
  return (
    <Button
      className="fm-header__quick-action"
      disabled={action.disabled || disabled}
      size="sm"
      title={action.label}
      type="button"
      variant="ghost"
      onClick={() => onCommand(action.id)}
    >
      {action.icon}
      <span>{action.label}</span>
    </Button>
  );
}

function ApiConnectionErrorDialog({
  details,
  onOpenChange,
  onRetry,
  open,
}: {
  details: ApiConnectionErrorDetails | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  open: boolean;
}) {
  if (!details) return null;

  const request = details.lastRequest;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="fm-api-connection-error-description"
        aria-label="API connection error details"
      >
        <DialogHeader>
          <DialogTitle>API connection error</DialogTitle>
          <DialogDescription id="fm-api-connection-error-description">
            The session status resource failed. The exact frontend error and
            request target are shown below.
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          <dl className="fm-dialog__details">
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Resource</dt>
              <dd className="fm-dialog__details-value">
                {details.resourceKey}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Request</dt>
              <dd className="fm-dialog__details-value">
                GET {details.requestUrl}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">API base</dt>
              <dd className="fm-dialog__details-value">{details.apiBase}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Contract</dt>
              <dd className="fm-dialog__details-value">
                expected {details.expectedContractVersion}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">HTTP status</dt>
              <dd className="fm-dialog__details-value">
                {details.httpStatus ?? request?.status ?? "not available"}
              </dd>
            </div>
            {request ? (
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Request id</dt>
                <dd className="fm-dialog__details-value">
                  {request.requestId}
                </dd>
              </div>
            ) : null}
          </dl>
          <pre className="fm-dialog__error">
            {details.errorStack ?? `${details.errorName}: ${details.errorMessage}`}
          </pre>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" type="button" variant="ghost">
              Close
            </Button>
          </DialogClose>
          <Button size="sm" type="button" onClick={onRetry}>
            Retry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AppMenuDialogState {
  apiDialogError: Error | null;
  communicationOpen: boolean;
  dataPreviewOpen: boolean;
  materialLibraryOpen: boolean;
  registryOpen: boolean;
  threadManagerOpen: boolean;
}

type AppMenuDialogAction =
  | { error: Error | null; type: "api-error" }
  | { open: boolean; type: "communication" }
  | { open: boolean; type: "data-preview" }
  | { open: boolean; type: "material-library" }
  | { open: boolean; type: "registry" }
  | { open: boolean; type: "thread-manager" };

const APP_MENU_DIALOG_INITIAL_STATE: AppMenuDialogState = {
  apiDialogError: null,
  communicationOpen: false,
  dataPreviewOpen: false,
  materialLibraryOpen: false,
  registryOpen: false,
  threadManagerOpen: false,
};

function appMenuDialogReducer(
  state: AppMenuDialogState,
  action: AppMenuDialogAction,
): AppMenuDialogState {
  switch (action.type) {
    case "api-error":
      return state.apiDialogError === action.error
        ? state
        : { ...state, apiDialogError: action.error };
    case "communication":
      return state.communicationOpen === action.open
        ? state
        : { ...state, communicationOpen: action.open };
    case "data-preview":
      return state.dataPreviewOpen === action.open
        ? state
        : { ...state, dataPreviewOpen: action.open };
    case "material-library":
      return state.materialLibraryOpen === action.open
        ? state
        : { ...state, materialLibraryOpen: action.open };
    case "registry":
      return state.registryOpen === action.open
        ? state
        : { ...state, registryOpen: action.open };
    case "thread-manager":
      return state.threadManagerOpen === action.open
        ? state
        : { ...state, threadManagerOpen: action.open };
  }
}

export function AppMenuBar() {
  const sessions = useSessionCollection();

  return sessions.state === "ready" ? (
    <SessionAppMenuBar />
  ) : (
    <NoSessionAppMenuBar state={sessions.state} />
  );
}

function NoSessionAppMenuBar({
  state,
}: {
  readonly state: "error" | "loading" | "no-session";
}) {
  const kernel = useKernel();
  const { theme, setTheme } = useTheme();
  const [newProblemOpen, setNewProblemOpen] = useState(false);
  const commandContext = createCommandContext("menu", kernel, {
    sourceDetail: "app-menu",
  });
  useEffect(
    () => kernel.bus.on("workspace:new-problem-requested", () => {
      setNewProblemOpen(true);
    }),
    [kernel.bus],
  );
  const runCommand = (commandId: string, input?: unknown) => {
    if (kernel.commands.get(commandId)) {
      void kernel.commands.execute(commandId, commandContext, input);
    }
  };
  const isCommandDisabled = (commandId: string) => {
    if (commandId === "workspace.new-problem" && state !== "no-session") {
      return true;
    }
    const command = kernel.commands.get(commandId);
    return command ? !kernel.commands.isEnabled(commandId, commandContext) : false;
  };

  return (
    <header className="fm-header">
      <div className="fm-header__brand">
        <FullmagMark size={20} className="fm-header__logo" />
        <div className="fm-header__brand-copy">
          <span className="fm-header__title">Fullmag</span>
          <span className="fm-header__subtitle">
            {state === "no-session"
              ? "No active session"
              : state === "loading"
                ? "Checking sessions"
                : "Session list unavailable"}
          </span>
        </div>
      </div>
      {APP_DROPDOWN_ITEMS.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="fm-header__app-trigger"
              size="sm"
              type="button"
              variant="secondary"
            >
              Fullmag
              <ChevronDown size={12} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Application</DropdownMenuLabel>
            {APP_DROPDOWN_ITEMS.map((item) => (
              <DropdownMenuItem
                disabled={isCommandDisabled(item.id)}
                key={item.id}
                onSelect={() => runCommand(item.id)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <nav className="fm-header__nav" aria-label="Main menu">
        {MAIN_MENUS.map((menu) => (
          <HeaderDropdown
            key={menu.id}
            isCommandActive={(commandId) => kernel.commands.isActive(commandId, commandContext)}
            isCommandDisabled={isCommandDisabled}
            menu={menu}
            onCommand={runCommand}
          />
        ))}
      </nav>
      <button
        className="fm-header__search"
        title="Command search (Ctrl+Shift+P)"
        type="button"
        onClick={() => runCommand("workspace.command-palette")}
      >
        <Search size={13} aria-hidden="true" />
        <span>Command search</span>
      </button>
      <div className="fm-header__separator" />
      <div className="fm-header__run-controls" aria-label="Runtime controls">
        {RUN_CONTROLS.map((action) => (
          <Button
            key={action.id}
            className="fm-header__run-btn"
            data-run-control={action.id}
            disabled={(action.disabled || isCommandDisabled(action.id)) || undefined}
            aria-label={action.label}
            size="icon"
            title={action.label}
            type="button"
            variant="ghost"
            onClick={() => runCommand(action.id)}
          >
            {action.icon}
          </Button>
        ))}
      </div>
      <div className="fm-header__actions">
        <ThemeSwitcher theme={theme} onThemeChange={setTheme} />
      </div>
      <NewProblemDialog
        hasActiveSession={false}
        open={state === "no-session" && newProblemOpen}
        onOpenChange={setNewProblemOpen}
      />
    </header>
  );
}

function SessionAppMenuBar() {
  const kernel = useKernel();
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientHydratedSnapshot,
    serverHydratedSnapshot,
  );
  const sessionStatus = useSessionStatusSelector(selectHeaderSessionSource, {
    isEqual: headerSessionSourceEquals,
  });
  const visibleSessionStatus = resolveHydrationSafeHeaderSessionSource(
    sessionStatus,
    hydrated,
  );
  const [dialogState, dispatchDialogState] = useReducer(
    appMenuDialogReducer,
    APP_MENU_DIALOG_INITIAL_STATE,
  );
  const [newProblemOpen, setNewProblemOpen] = useState(false);
  const setDataPreviewOpen = (open: boolean) =>
    dispatchDialogState({ open, type: "data-preview" });
  const setCommunicationOpen = (open: boolean) =>
    dispatchDialogState({ open, type: "communication" });
  const setRegistryOpen = (open: boolean) =>
    dispatchDialogState({ open, type: "registry" });
  const setThreadManagerOpen = (open: boolean) =>
    dispatchDialogState({ open, type: "thread-manager" });
  const setMaterialLibraryOpen = (open: boolean) =>
    dispatchDialogState({ open, type: "material-library" });
  useEffect(() => {
    return kernel.bus.on("diagnostics:recorder-open-requested", () => {
      dispatchDialogState({ open: true, type: "thread-manager" });
    });
  }, [kernel.bus]);
  useEffect(() => kernel.bus.on("workspace:new-problem-requested", () => {
    setNewProblemOpen(true);
  }), [kernel.bus]);
  const visualizationSnapshot = useObjectVisualizationSelector((snapshot) =>
    dialogState.registryOpen ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  );
  const runtimeResourceData = useRuntimeCommandControlResourceData();
  const sessionDisplay = resolveHeaderSessionDisplay(
    visibleSessionStatus,
    readDetailedRuntimeState(runtimeResourceData[SIMULATION_SOLVER_STATUS_PATH]),
  );
  const visualizationState = useVisualizationStateResource({ enabled: true });
  const visualizationSyncSnapshot = useSyncExternalStore(
    (onStoreChange) => kernel.visualizationSync.subscribe(onStoreChange),
    () => kernel.visualizationSync.getSnapshot(),
    () => kernel.visualizationSync.getSnapshot(),
  );
  const apiErrorDetails = useMemo(() => {
    if (!hydrated || !sessionStatus.error) return null;

    return resolveApiConnectionErrorDetails({
      apiBase: kernel.api.getBaseUrl(),
      error: sessionStatus.error,
      latestRequest: latestRequestForPath(
        kernel.diagnostics.list(),
        SESSION_STATUS_PATH,
      ),
    });
  }, [hydrated, kernel, sessionStatus.error]);
  const apiDialogOpen = Boolean(
    apiErrorDetails && dialogState.apiDialogError === sessionStatus.error,
  );
  const openApiDialog = () => {
    if (hydrated && sessionStatus.error) {
      dispatchDialogState({ error: sessionStatus.error, type: "api-error" });
    }
  };
  const onApiDialogOpenChange = (open: boolean) => {
    if (open) openApiDialog();
    else dispatchDialogState({ error: null, type: "api-error" });
  };
  const commandContext = createCommandContext("menu", kernel, {
    resourceData: runtimeResourceData,
    sourceDetail: "app-menu",
  });
  const runCommand = (commandId: string, input?: unknown) => {
    if (commandId === "tools.registry-inspector") {
      setRegistryOpen(true);
      return;
    }
    if (commandId === "tools.thread-manager") {
      setThreadManagerOpen(true);
      return;
    }
    if (commandId === "tools.material-library") {
      setMaterialLibraryOpen(true);
      return;
    }
    if (commandId === "tools.data-preview") {
      setDataPreviewOpen(true);
      return;
    }
    if (commandId === "tools.communication") {
      setCommunicationOpen(true);
      return;
    }
    if (kernel.commands.get(commandId)) {
      void kernel.commands.execute(commandId, commandContext, input);
    }
  };
  const isCommandDisabled = (commandId: string): boolean => {
    const command = kernel.commands.get(commandId);
    return command ? !kernel.commands.isEnabled(commandId, commandContext) : false;
  };
  const isCommandActive = (commandId: string): boolean =>
    kernel.commands.isActive(commandId, commandContext);

  return (
    <header className="fm-header">
      <div className="fm-header__brand">
        <FullmagMark size={20} className="fm-header__logo" />
        <div className="fm-header__brand-copy">
          <span className="fm-header__title">Fullmag</span>
          <span className="fm-header__subtitle">{sessionDisplay.subtitle}</span>
        </div>
      </div>

      {APP_DROPDOWN_ITEMS.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="fm-header__app-trigger"
              size="sm"
              type="button"
              variant="secondary"
            >
              Fullmag
              <ChevronDown size={12} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Application</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {APP_DROPDOWN_ITEMS.map((node) => (
              <MenuNode
                key={node.id}
                isCommandActive={isCommandActive}
                isCommandDisabled={isCommandDisabled}
                node={node}
                onCommand={runCommand}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <nav className="fm-header__nav" aria-label="Main menu">
        {MAIN_MENUS.map((menu) => (
          <HeaderDropdown
            key={menu.id}
            isCommandActive={isCommandActive}
            isCommandDisabled={isCommandDisabled}
            menu={menu}
            onCommand={runCommand}
          />
        ))}
      </nav>

      <div className="fm-header__quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <QuickActionButton
            key={action.id}
            action={action}
            disabled={isCommandDisabled(action.id)}
            onCommand={runCommand}
          />
        ))}
      </div>

      <button
        className="fm-header__search"
        title="Command search (Ctrl+Shift+P)"
        type="button"
        onClick={() => runCommand("workspace.command-palette")}
      >
        <Search size={13} aria-hidden="true" />
        <span>Command search</span>
      </button>

      <button
        className="fm-header__session-indicator"
        data-clickable={visibleSessionStatus.error ? "true" : undefined}
        type="button"
        onClick={openApiDialog}
        aria-expanded={apiDialogOpen ? true : undefined}
        aria-haspopup={visibleSessionStatus.error ? "dialog" : undefined}
        title={
          visibleSessionStatus.error
            ? "Open API error details"
            : sessionDisplay.indicatorLabel
        }
      >
        <span
          className="fm-header__session-dot"
          data-status={sessionDisplay.indicatorStatus}
          aria-label={sessionDisplay.indicatorLabel}
        />
        <span>{sessionDisplay.connectionLabel}</span>
        <span className="fm-header__session-badge">
          {sessionDisplay.sessionBadge}
        </span>
      </button>

      <ApiConnectionErrorDialog
        details={apiErrorDetails}
        onOpenChange={onApiDialogOpenChange}
        onRetry={sessionStatus.refetch ?? noopRefetch}
        open={apiDialogOpen}
      />

      <RegistryInspectorDialog
        open={dialogState.registryOpen}
        snapshot={visualizationSnapshot}
        syncSnapshot={visualizationSyncSnapshot}
        visualizationState={visualizationState.data}
        onOpenChange={setRegistryOpen}
        onRetryMutation={() => {
          void kernel.visualizationSync.retryRejectedMutation();
        }}
      />

      <DiagnosticRecorderDialog
        kernel={kernel}
        onOpenChange={setThreadManagerOpen}
        open={dialogState.threadManagerOpen}
      />

      <MaterialLibraryDialog
        onOpenChange={setMaterialLibraryOpen}
        open={dialogState.materialLibraryOpen}
      />

      <DataPreviewDialog
        onOpenChange={setDataPreviewOpen}
        open={dialogState.dataPreviewOpen}
      />

      <CommunicationPolicyDialog
        onOpenChange={setCommunicationOpen}
        open={dialogState.communicationOpen}
      />

      <NewProblemDialog
        hasActiveSession
        open={newProblemOpen}
        onOpenChange={setNewProblemOpen}
      />

      <div className="fm-header__separator" />

      <div className="fm-header__run-controls" aria-label="Runtime controls">
        {RUN_CONTROLS.map((action) => (
          <Button
            key={action.id}
            className="fm-header__run-btn"
            data-run-control={action.id}
            disabled={
              (action.disabled || isCommandDisabled(action.id)) || undefined
            }
            aria-label={action.label}
            size="icon"
            title={action.label}
            type="button"
            variant="ghost"
            onClick={() => runCommand(action.id)}
          >
            {action.icon}
          </Button>
        ))}
      </div>

      <div className="fm-header__separator" />

      <div className="fm-header__actions">
        <ThemeSwitcher theme={theme} onThemeChange={setTheme} />
      </div>
    </header>
  );
}
