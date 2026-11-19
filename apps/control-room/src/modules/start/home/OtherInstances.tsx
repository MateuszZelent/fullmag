"use client";

import { ExternalLink } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { SectionHeader } from "../ui/SectionHeader";
import { StatusPill } from "../ui/StatusPill";
import { sessionPillStatus } from "./ActiveSessions";

export interface OtherInstance {
  /** Control Room port of the instance; its origin also serves its API. */
  readonly port: number;
  /** Its current session, or null when it has none open. */
  readonly session: { readonly name: string; readonly status: string } | null;
}

export interface OtherInstancesProps {
  readonly instances: readonly OtherInstance[];
  /** Opens (or brings to the front) the instance's tab. */
  readonly onOpen: (port: number) => void;
}

/**
 * Other Fullmag instances running on this computer (ADR 0069), e.g. other
 * Docker DEV groups. Each opens in its own tab next to Home.
 */
export function OtherInstances({ instances, onOpen }: OtherInstancesProps) {
  if (instances.length === 0) return null;
  return (
    <section
      aria-labelledby="fm-start-instances-title"
      className="fm-start-section"
      data-start-other-instances=""
    >
      <SectionHeader id="fm-start-instances-title" title="Other instances on this computer" />
      {instances.map((instance) => (
        <div
          className="fm-start-continue"
          data-instance-port={instance.port}
          key={instance.port}
        >
          <div className="fm-start-continue__body">
            <h3 className="fm-start-continue__name">
              {instance.session?.name || "No open session"}
            </h3>
            <div className="fm-start-continue__progress">
              {instance.session ? (
                <StatusPill
                  label={instance.session.status}
                  status={sessionPillStatus(instance.session.status)}
                />
              ) : null}
              <span className="fm-start-continue__detail">Port {instance.port}</span>
            </div>
            <div className="fm-start-continue__actions">
              <Button onClick={() => onOpen(instance.port)} type="button" variant="secondary">
                <ExternalLink aria-hidden="true" size={14} />
                Open in tab
              </Button>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
