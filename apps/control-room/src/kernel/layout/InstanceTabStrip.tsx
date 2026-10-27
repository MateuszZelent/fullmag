"use client";

import { ExternalLink, House, X } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { useInstanceDiscovery } from "../resources/instanceDiscoveryResources";
import { useSessionCollection } from "../resources/useSessionCollection";
import { homeView, useHomeViewOpen } from "./homeView";
import { instanceTabLabel, sessionTone } from "./instanceTabModel";
import { instanceOrigin, instanceTabs, useInstanceTabs, usePageLocation } from "./instanceTabs";

const HOME_TAB = "home";
const SESSION_TAB = "session";
const INSTANCE_TAB_PREFIX = "instance:";

function selectTab(next: string): void {
  if (next === HOME_TAB) {
    instanceTabs.activate(null);
    homeView.open();
  } else if (next === SESSION_TAB) {
    instanceTabs.activate(null);
    homeView.close();
  } else if (next.startsWith(INSTANCE_TAB_PREFIX)) {
    instanceTabs.activate(Number(next.slice(INSTANCE_TAB_PREFIX.length)));
  }
}

function closeTab(port: number, element: HTMLElement): void {
  const item = element.closest(".fm-instance-tabs__item");
  const next = item?.nextElementSibling?.querySelector<HTMLButtonElement>('[role="tab"]')
    ?? item?.previousElementSibling?.querySelector<HTMLButtonElement>('[role="tab"]')
    ?? element.closest(".fm-instance-tabs")?.querySelector<HTMLButtonElement>('[data-tab-kind="home"]');
  instanceTabs.close(port);
  requestAnimationFrame(() => next?.focus());
}

/**
 * Home, this instance's session and one tab per other Fullmag instance on the
 * host (ADR 0069). Switching tabs never stops a session: Home and other
 * instances lie over the mounted workspace.
 */
export function InstanceTabStrip() {
  const sessions = useSessionCollection();
  const tabs = useInstanceTabs();
  const homeOpen = useHomeViewOpen();
  const location = usePageLocation();
  const current = sessions.resource.data?.sessions.find((entry) => entry.current) ?? null;
  // Instance status refreshes while it is on screen: Home (always shown
  // without a session) or any open instance tab. An idle workspace with no
  // instance tabs issues no discovery requests.
  const discovery = useInstanceDiscovery({
    live: homeOpen || current === null || tabs.openPorts.length > 0,
  });
  const instances = new Map(
    (discovery.data?.instances ?? []).map((instance) => [instance.port, instance]),
  );
  const discoveryKnown = discovery.data !== null;

  const value = tabs.activePort !== null
    ? `${INSTANCE_TAB_PREFIX}${tabs.activePort}`
    : current && !homeOpen
      ? SESSION_TAB
      : HOME_TAB;

  return (
    <nav aria-label="Sessions" className="fm-instance-tabs" data-instance-tabs="">
      <Tabs onValueChange={selectTab} value={value}>
        <TabsList aria-label="Open sessions" className="fm-instance-tabs__list">
          <TabsTrigger className="fm-instance-tabs__tab" data-tab-kind="home" value={HOME_TAB}>
            <House aria-hidden="true" size={13} />
            Home
          </TabsTrigger>
          {current ? (
            <TabsTrigger
              className="fm-instance-tabs__tab"
              data-tab-kind="session"
              title={`${current.name} — ${current.status}`}
              value={SESSION_TAB}
            >
              <span aria-hidden="true" className="fm-instance-tabs__dot" data-tone={sessionTone(current.status)} />
              <span className="fm-instance-tabs__name">{current.name || "Untitled simulation"}</span>
            </TabsTrigger>
          ) : null}
          {tabs.openPorts.map((port) => {
            const instance = instances.get(port);
            const session = instance?.sessions.find((entry) => entry.current);
            const unavailable = discoveryKnown && !instance;
            const label = instanceTabLabel(instance);
            return (
              <div className="fm-instance-tabs__item" key={port}>
                <TabsTrigger
                  className="fm-instance-tabs__tab"
                  data-instance-port={port}
                  onKeyDown={(event) => {
                    if (event.key !== "Delete") return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeTab(port, event.currentTarget);
                  }}
                  data-tab-kind="instance"
                  data-unavailable={unavailable || undefined}
                  title={`${label} — port ${port}${session ? ` — ${session.status}` : ""}`}
                  value={`${INSTANCE_TAB_PREFIX}${port}`}
                >
                  <span
                    aria-hidden="true"
                    className="fm-instance-tabs__dot"
                    data-tone={unavailable ? "failed" : sessionTone(session?.status)}
                  />
                  <span className="fm-instance-tabs__name">{label}</span>
                  <span className="fm-instance-tabs__port">:{port}</span>
                </TabsTrigger>
                <Button
                  aria-label={`Close tab ${label} (port ${port})`}
                  className="fm-instance-tabs__close"
                  onClick={(event) => closeTab(port, event.currentTarget)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" size={12} />
                </Button>
              </div>
            );
          })}
        </TabsList>
      </Tabs>
      {tabs.activePort !== null && location !== null ? (
        // An instance older than tab support refuses to be framed; it can
        // still be opened on its own.
        <a
          className="fm-instance-tabs__popout"
          href={`${instanceOrigin(tabs.activePort, location)}/workspace`}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" size={12} />
          Open in window
        </a>
      ) : null}
    </nav>
  );
}
