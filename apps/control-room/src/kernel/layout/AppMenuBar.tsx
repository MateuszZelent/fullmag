"use client";

import { ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useTheme } from "@/design/theme/ThemeProvider";
import {
  EXPECTED_API_CONTRACT_VERSION,
  SESSION_STATUS_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import { useKernel } from "@/kernel/KernelContext";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
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

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function resolveHeaderSessionDisplay(
  status: HeaderSessionSource,
): HeaderSessionDisplay {
  const connected = status.status === "ready";
  const failed = status.status === "error";

  return {
    connectionLabel: connected ? "Local API" : "API pending",
    indicatorLabel: failed
      ? "Session status unavailable"
      : connected
        ? "Session connected"
        : "Session connecting",
    indicatorStatus: failed ? "error" : connected ? "connected" : "connecting",
    sessionBadge: readString(status.data?.solver?.state, status.status),
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
    if (entry?.path === path) return entry;
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
  isCommandDisabled,
  node,
  onCommand,
}: {
  isCommandDisabled: (commandId: string) => boolean;
  node: AppMenuNode;
  onCommand: (commandId: string) => void;
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
              isCommandDisabled={isCommandDisabled}
              node={child}
              onCommand={onCommand}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
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
  isCommandDisabled,
  menu,
  onCommand,
}: {
  isCommandDisabled: (commandId: string) => boolean;
  menu: AppMenuNode;
  onCommand: (commandId: string) => void;
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
            isCommandDisabled={isCommandDisabled}
            node={node}
            onCommand={onCommand}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickActionButton({ action }: { action: HeaderQuickAction }) {
  return (
    <Button
      className="fm-header__quick-action"
      disabled={action.disabled}
      size="sm"
      title={action.label}
      type="button"
      variant="ghost"
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
  const sessionStatus = useSessionStatus();
  const sessionDisplay = resolveHeaderSessionDisplay(sessionStatus);
  const [apiDialogError, setApiDialogError] = useState<Error | null>(null);
  const apiErrorDetails = useMemo(() => {
    if (!sessionStatus.error) return null;

    return resolveApiConnectionErrorDetails({
      apiBase: kernel.api.getBaseUrl(),
      error: sessionStatus.error,
      latestRequest: latestRequestForPath(
        kernel.diagnostics.list(),
        SESSION_STATUS_PATH,
      ),
    });
  }, [kernel, sessionStatus.error]);
  const apiDialogOpen = Boolean(
    apiErrorDetails && apiDialogError === sessionStatus.error,
  );
  const openApiDialog = () => {
    if (sessionStatus.error) setApiDialogError(sessionStatus.error);
  };
  const onApiDialogOpenChange = (open: boolean) => {
    if (open) openApiDialog();
    else setApiDialogError(null);
  };
  const commandContext = createCommandContext("menu", kernel);
  const runCommand = (commandId: string) => {
    if (kernel.commands.get(commandId)) {
      void kernel.commands.execute(commandId, commandContext);
    }
  };
  const isCommandDisabled = (commandId: string): boolean => {
    const command = kernel.commands.get(commandId);
    return command ? !kernel.commands.isEnabled(commandId, commandContext) : false;
  };

  return (
    <header className="fm-header">
      <div className="fm-header__brand">
        <div className="fm-header__logo" aria-hidden="true" />
        <div className="fm-header__brand-copy">
          <span className="fm-header__title">Fullmag</span>
          <span className="fm-header__subtitle">{sessionDisplay.subtitle}</span>
        </div>
      </div>

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
              isCommandDisabled={isCommandDisabled}
              node={node}
              onCommand={runCommand}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="fm-header__nav" aria-label="Main menu">
        {MAIN_MENUS.map((menu) => (
          <HeaderDropdown
            key={menu.id}
            isCommandDisabled={isCommandDisabled}
            menu={menu}
            onCommand={runCommand}
          />
        ))}
      </nav>

      <div className="fm-header__quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <QuickActionButton key={action.id} action={action} />
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
        data-clickable={sessionStatus.error ? "true" : undefined}
        type="button"
        onClick={openApiDialog}
        onFocus={openApiDialog}
        onPointerEnter={openApiDialog}
        aria-expanded={apiDialogOpen ? true : undefined}
        aria-haspopup={sessionStatus.error ? "dialog" : undefined}
        title={
          sessionStatus.error
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
        onRetry={sessionStatus.refetch}
        open={apiDialogOpen}
      />

      <div className="fm-header__separator" />

      <div className="fm-header__run-controls" aria-label="Runtime controls">
        {RUN_CONTROLS.map((action) => (
          <Button
            key={action.id}
            className="fm-header__run-btn"
            data-run-control={action.id}
            disabled={
              action.disabled || isCommandDisabled(action.id)
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
