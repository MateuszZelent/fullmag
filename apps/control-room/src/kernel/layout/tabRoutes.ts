import type { DiscoveredInstance } from "../api/apiTypes";

/**
 * Addresses of the Control Room tabs. The tab in front is mirrored in the
 * page URL so a reload, a bookmark and the browser's Back/Forward reach the
 * same tab:
 *
 * - `/home` — Home;
 * - `/session/<slug>` — this instance's session;
 * - `/session/<slug>?port=<port>` — the session of another instance's tab;
 * - `/instance/<port>` — another instance's tab while it has no session.
 *
 * `/` and `/workspace` are aliases that resolve to whichever tab is in front.
 * Every address serves the same page; switching tabs never reloads it.
 */
export type TabRoute =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly slug: string; readonly port: number | null }
  | { readonly kind: "instance"; readonly port: number }
  | { readonly kind: "default" };

const MAX_SLUG_LENGTH = 96;

function parsePort(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port <= 65_535 ? port : null;
}

/** The URL-safe form of a session name: lower case, `-` between words. */
export function sessionSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export function parseTabRoute(pathname: string, search: string): TabRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "home") return { kind: "home" };
  if (segments.length === 2 && segments[0] === "instance") {
    const port = parsePort(segments[1]);
    return port === null ? { kind: "default" } : { kind: "instance", port };
  }
  if (segments.length === 2 && segments[0] === "session") {
    let name: string;
    try {
      name = decodeURIComponent(segments[1]);
    } catch {
      return { kind: "default" };
    }
    const port = parsePort(new URLSearchParams(search).get("port"));
    return { kind: "session", slug: sessionSlug(name), port };
  }
  return { kind: "default" };
}

export function formatTabRoute(route: Exclude<TabRoute, { kind: "default" }>): string {
  switch (route.kind) {
    case "home":
      return "/home";
    case "instance":
      return `/instance/${route.port}`;
    case "session":
      return `/session/${encodeURIComponent(route.slug)}${route.port === null ? "" : `?port=${route.port}`}`;
  }
}

/**
 * The address of `route` that keeps the query parameters a tab address does
 * not own, such as diagnostic flags read on load. Only `port` is replaced.
 */
export function tabRouteHref(route: Exclude<TabRoute, { kind: "default" }>, search: string): string {
  const [pathname, ownQuery = ""] = formatTabRoute(route).split("?");
  const params = new URLSearchParams(search);
  params.delete("port");
  for (const [key, value] of new URLSearchParams(ownQuery)) params.set(key, value);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Which tab an address names, regardless of the session it shows: a renamed
 * or replaced session stays in the same tab.
 */
export function tabRouteKey(route: TabRoute): string | null {
  switch (route.kind) {
    case "home":
      return "home";
    case "instance":
      return `instance:${route.port}`;
    case "session":
      return route.port === null ? "session" : `instance:${route.port}`;
    case "default":
      return null;
  }
}

/** The session an instance tab shows: its current one, as the tab label does. */
function instanceSession(instance: DiscoveredInstance | undefined) {
  return instance?.sessions.find((entry) => entry.current) ?? instance?.sessions[0];
}

export interface ActiveTabState {
  readonly homeOpen: boolean;
  readonly activePort: number | null;
  /** This instance's current session, or null when it has none. */
  readonly currentSessionName: string | null;
  /** Discovered instances by port, or null before discovery answered. */
  readonly instances: ReadonlyMap<number, DiscoveredInstance> | null;
}

/** The address of the tab in front, mirroring the tab strip's selection. */
export function activeTabRoute(state: ActiveTabState): Exclude<TabRoute, { kind: "default" }> {
  if (state.activePort !== null) {
    const session = instanceSession(state.instances?.get(state.activePort));
    return session
      ? { kind: "session", slug: sessionSlug(session.name), port: state.activePort }
      : { kind: "instance", port: state.activePort };
  }
  if (state.currentSessionName !== null && !state.homeOpen) {
    return { kind: "session", slug: sessionSlug(state.currentSessionName), port: null };
  }
  return { kind: "home" };
}

/** What opening an address does to the tabs. */
export type TabRouteAction =
  | { readonly kind: "home" }
  | { readonly kind: "session" }
  | { readonly kind: "instance"; readonly port: number }
  | { readonly kind: "none" };

export interface TabRouteContext {
  /** This instance's current session, or null when it has none. */
  readonly currentSessionName: string | null;
  /** Discovered instances, or null while discovery has not answered. */
  readonly instances: readonly DiscoveredInstance[] | null;
}

/**
 * Resolve a requested address into a tab, or `"wait"` until discovery
 * answers. A session that is no longer open anywhere on this host falls back
 * to Home, which lists what is.
 */
export function resolveTabRoute(route: TabRoute, context: TabRouteContext): TabRouteAction | "wait" {
  switch (route.kind) {
    case "default":
      return { kind: "none" };
    case "home":
      return { kind: "home" };
    case "instance":
      return { kind: "instance", port: route.port };
    case "session": {
      if (route.port !== null) return { kind: "instance", port: route.port };
      if (
        context.currentSessionName !== null &&
        sessionSlug(context.currentSessionName) === route.slug
      ) {
        return { kind: "session" };
      }
      if (context.instances === null) return "wait";
      const match = context.instances.find((instance) => {
        const session = instanceSession(instance);
        return !instance.is_self && session !== undefined && sessionSlug(session.name) === route.slug;
      });
      return match ? { kind: "instance", port: match.port } : { kind: "home" };
    }
  }
}

/**
 * Whether moving from the address in the bar to `next` adds a history entry.
 * Switching tabs does; resolving an alias, a session renamed in place, or
 * leaving a tab that was closed only corrects the address.
 */
export function tabRouteChangePushes(
  current: TabRoute,
  next: TabRoute,
  openPorts: readonly number[],
): boolean {
  const currentKey = tabRouteKey(current);
  if (currentKey === null || currentKey === tabRouteKey(next)) return false;
  const currentPort =
    current.kind === "instance" ? current.port : current.kind === "session" ? current.port : null;
  return currentPort === null || openPorts.includes(currentPort);
}
