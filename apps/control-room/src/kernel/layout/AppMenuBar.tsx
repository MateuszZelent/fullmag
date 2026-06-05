"use client";

import { ChevronDown, Search } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { useTheme } from "@/design/theme/ThemeProvider";
import {
  EXPECTED_API_CONTRACT_VERSION,
  SIMULATION_SOLVER_STATUS_PATH,
  SESSION_STATUS_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import { useKernel } from "@/kernel/KernelContext";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import {
  formatRuntimeStateLabel,
  readDetailedRuntimeState,
  resolveEffectiveRuntimeState,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
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
import { CommunicationPolicyDialog } from "./CommunicationPolicyDialog";
import { DataPreviewDialog } from "./DataPreviewDialog";
import { RegistryInspectorDialog } from "./RegistryInspectorDialog";
import { ThreadManagerDialog } from "./ThreadManagerDialog";

interface HeaderSessionDisplay {
  connectionLabel: string;
  indicatorLabel: string;
  indicatorStatus: "connected" | "connecting" | "error";
  sessionBadge: string;
  subtitle: string;
}

interface HeaderSessionSource {
  data: {
    session?: { name?: unknown } | null;
    solver?: { state?: unknown } | null;
  } | null;
  error?: Error | null;
  refetch?: () => void;
  status: ResourceStatus;
}

interface ApiConnectionErrorDetails {
  apiBase: string;
  errorMessage: string;
  errorName: string;
  errorStack: string | null;
  expectedContractVersion: string;
  httpStatus: number | null;
  lastRequest: RequestDiagnosticEntry | null;
  requestUrl: string;
  resourceKey: string;
}

const HYDRATING_HEADER_SESSION_SOURCE: HeaderSessionSource = {
  data: null,
  error: null,
  status: "loading",
};

export function selectHeaderSessionSource(
  status: HeaderSessionSource,
): HeaderSessionSource {
  return {
    data: status.data
      ? {
          session: { name: status.data.session?.name },
          solver: { state: status.data.solver?.state },
        }
      : null,
    error: status.error ?? null,
    refetch: status.refetch,
    status: status.status,
  };
}

export function headerSessionSourceEquals(
  previous: HeaderSessionSource,
  next: HeaderSessionSource,
): boolean {
  return (
    previous.status === next.status &&
    previous.error === next.error &&
    previous.data?.session?.name === next.data?.session?.name &&
    previous.data?.solver?.state === next.data?.solver?.state
  );
}

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

export function resolveHydrationSafeHeaderSessionSource(
  status: HeaderSessionSource,
  hydrated: boolean,
): HeaderSessionSource {
  return hydrated ? status : HYDRATING_HEADER_SESSION_SOURCE;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function resolveHeaderSessionDisplay(
  status: HeaderSessionSource,
  detailedRuntimeState?: string | null,
): HeaderSessionDisplay {
  const hasSessionData = status.data !== null;
  const connected =
    status.status === "ready" || (status.status === "stale" && hasSessionData);
  const failed = status.status === "error";
  const runtimeState = resolveEffectiveRuntimeState({
    detailedRuntimeState,
    sessionSolverState: status.data?.solver?.state,
  });

  return {
    connectionLabel: connected ? "Local API" : "API pending",
    indicatorLabel: failed
      ? "Session status unavailable"
      : connected
        ? "Session connected"
        : "Session connecting",
    indicatorStatus: failed ? "error" : connected ? "connected" : "connecting",
    sessionBadge: runtimeState
      ? formatRuntimeStateLabel(runtimeState)
      : status.status,
    subtitle: readString(
      status.data?.session?.name,
      connected ? "Unnamed session" : "Loading session",
    ),
  };
}

function errorHttpStatus(error: Error): number | null {
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function resolveResourceUrl(apiBase: string, path: string): string {
  try {
    return new URL(path, `${apiBase.replace(/\/+$/, "")}/`).toString();
  } catch {
    return `${apiBase.replace(/\/+$/, "")}${path}`;
  }
}

function latestRequestForPath(
  entries: readonly RequestDiagnosticEntry[],
  path: string,
): RequestDiagnosticEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.path === path && entry.direction === "rx") return entry;
  }

  return null;
}

export function resolveApiConnectionErrorDetails({
  apiBase,
  error,
  latestRequest,
}: {
  apiBase: string;
  error: Error;
  latestRequest?: RequestDiagnosticEntry | null;
}): ApiConnectionErrorDetails {
  return {
    apiBase,
    errorMessage: error.message,
    errorName: error.name,
    errorStack: error.stack ?? null,
    expectedContractVersion: EXPECTED_API_CONTRACT_VERSION,
    httpStatus: errorHttpStatus(error),
    lastRequest: latestRequest ?? null,
    requestUrl: resolveResourceUrl(apiBase, SESSION_STATUS_PATH),
    resourceKey: "session:status",
  };
}

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
      <DialogContent aria-label="API connection error details">
        <DialogHeader>
          <DialogTitle>API connection error</DialogTitle>
          <DialogDescription>
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

export function AppMenuBar() {
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
  const [apiDialogError, setApiDialogError] = useState<Error | null>(null);
  const [dataPreviewOpen, setDataPreviewOpen] = useState(false);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [threadManagerOpen, setThreadManagerOpen] = useState(false);
  const visualizationSnapshot = useObjectVisualizationSelector((snapshot) =>
    registryOpen ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
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
    apiErrorDetails && apiDialogError === sessionStatus.error,
  );
  const openApiDialog = () => {
    if (hydrated && sessionStatus.error) setApiDialogError(sessionStatus.error);
  };
  const onApiDialogOpenChange = (open: boolean) => {
    if (open) openApiDialog();
    else setApiDialogError(null);
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

      <label className="fm-header__search">
        <Search size={13} aria-hidden="true" />
        <input
          aria-label="Command search"
          placeholder="Command search (Ctrl+Shift+P)"
          readOnly
          type="text"
        />
      </label>

      <button
        className="fm-header__session-indicator"
        data-clickable={visibleSessionStatus.error ? "true" : undefined}
        type="button"
        onClick={openApiDialog}
        onFocus={openApiDialog}
        onPointerEnter={openApiDialog}
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
        open={registryOpen}
        snapshot={visualizationSnapshot}
        syncSnapshot={visualizationSyncSnapshot}
        visualizationState={visualizationState.data}
        onOpenChange={setRegistryOpen}
      />

      <ThreadManagerDialog
        kernel={kernel}
        onOpenChange={setThreadManagerOpen}
        open={threadManagerOpen}
      />

      <DataPreviewDialog
        onOpenChange={setDataPreviewOpen}
        open={dataPreviewOpen}
      />

      <CommunicationPolicyDialog
        onOpenChange={setCommunicationOpen}
        open={communicationOpen}
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
