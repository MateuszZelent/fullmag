"use client";

import { useEffect, useRef, useState } from "react";

import type { DiscoveredInstance } from "../api/apiTypes";
import { useInstanceDiscovery } from "../resources/instanceDiscoveryResources";
import { useSessionCollection } from "../resources/useSessionCollection";
import { homeView, useHomeViewOpen } from "./homeView";
import { instanceTabLabel } from "./instanceTabModel";
import { instanceTabs, isEmbeddedInstanceTab, useInstanceTabs } from "./instanceTabs";
import {
  activeTabRoute,
  parseTabRoute,
  resolveTabRoute,
  tabRouteChangePushes,
  tabRouteHref,
  tabRouteKey,
  type TabRoute,
  type TabRouteAction,
} from "./tabRoutes";

const APP_TITLE = "Fullmag Control Room";
const NO_INSTANCES: readonly DiscoveredInstance[] = [];

function locationRoute(): TabRoute {
  return parseTabRoute(window.location.pathname, window.location.search);
}

function applyTabRouteAction(action: TabRouteAction, hasSession: boolean): void {
  switch (action.kind) {
    case "home":
      instanceTabs.activate(null);
      // Without a session Home is the whole page, not a view over a workspace.
      if (hasSession) homeView.open();
      return;
    case "session":
      instanceTabs.activate(null);
      homeView.close();
      return;
    case "instance":
      instanceTabs.open(action.port);
      return;
    case "none":
      return;
  }
}

/**
 * Keeps the page address and the tab in front in step (see `tabRoutes.ts`).
 * The address on load and after Back/Forward selects a tab; selecting a tab
 * writes its address, as a new history entry when the tab changes. Nothing
 * here navigates: every tab address serves this same page.
 */
export function TabRouteSync() {
  const sessions = useSessionCollection();
  const tabs = useInstanceTabs();
  const homeOpen = useHomeViewOpen();
  const discovery = useInstanceDiscovery();
  // The address to honour once the data it names is known: the page's own
  // address on load, then each Back/Forward.
  const [requested, setRequested] = useState<TabRoute | null>(() =>
    typeof window === "undefined" ? null : locationRoute(),
  );
  const handled = useRef<TabRoute | null>(null);

  useEffect(() => {
    const onPopState = () => setRequested(locationRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const collection = sessions.resource.data;
  const current = collection?.sessions.find((entry) => entry.current) ?? null;
  const currentSessionName = current ? current.name : null;
  // A failed discovery is no instances, so an address never waits on it forever.
  const instances = discovery.data?.instances ?? (discovery.status === "error" ? NO_INSTANCES : null);

  useEffect(() => {
    if (!collection || isEmbeddedInstanceTab()) return;
    // Opening an address only corrects the address bar afterwards.
    let correction = false;
    if (requested !== null && handled.current !== requested) {
      const action = resolveTabRoute(requested, { currentSessionName, instances });
      if (action === "wait") return;
      handled.current = requested;
      applyTabRouteAction(action, currentSessionName !== null);
      correction = true;
    }

    // Read the stores, which the request above may just have changed.
    const { activePort, openPorts } = instanceTabs.getSnapshot();
    const byPort = instances ? new Map(instances.map((instance) => [instance.port, instance])) : null;
    const route = activeTabRoute({
      homeOpen: homeView.isOpen(),
      activePort,
      currentSessionName,
      instances: byPort,
    });
    document.title = `${
      route.kind === "home"
        ? "Home"
        : activePort !== null
          ? instanceTabLabel(byPort?.get(activePort))
          : currentSessionName || "Untitled simulation"
    } | ${APP_TITLE}`;

    const shown = locationRoute();
    // Until discovery names an instance's session, keep the address that
    // already points at its tab.
    if (route.kind === "instance" && byPort === null && tabRouteKey(shown) === tabRouteKey(route)) {
      return;
    }
    const href = tabRouteHref(route, window.location.search);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    if (!correction && tabRouteChangePushes(shown, route, openPorts)) {
      window.history.pushState(null, "", href);
    } else {
      window.history.replaceState(null, "", href);
    }
  }, [collection, currentSessionName, homeOpen, instances, requested, tabs.activePort, tabs.openPorts]);

  return null;
}
