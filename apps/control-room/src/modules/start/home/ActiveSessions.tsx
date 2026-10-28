"use client";

import { ArrowRight } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import type { ProjectStatus } from "../model/types";
import { SectionHeader } from "../ui/SectionHeader";
import { StatusPill } from "../ui/StatusPill";

export interface ActiveSession {
  readonly sessionId: string;
  readonly name: string;
  /** Session lifecycle word from the session list, shown as reported. */
  readonly status: string;
  /** The session the workspace behind Home shows. */
  readonly current: boolean;
}

export interface ActiveSessionsProps {
  readonly sessions: readonly ActiveSession[];
  /** Leaves Home for the workspace of the current session. */
  readonly onOpen: () => void;
}

/** The pill colour for a session lifecycle word; the word itself stays visible. */
export function sessionPillStatus(status: string): ProjectStatus {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "awaiting_command":
    case "waiting_for_compute":
    case "completed":
      return "ready";
    case "closed":
    case "stopped":
    case "cancelled":
      return "readonly";
    case "activating":
    case "materializing_script":
    default:
      return "draft";
  }
}

/**
 * Sessions open in this Fullmag instance, including ones a Python script
 * (`fm.connect()`) created. Home lies over the workspace while a session is
 * open, so the current session is one click away.
 */
export function ActiveSessions({ sessions, onOpen }: ActiveSessionsProps) {
  if (sessions.length === 0) return null;
  return (
    <section
      aria-labelledby="fm-start-sessions-title"
      className="fm-start-section"
      data-start-active-sessions=""
    >
      <SectionHeader id="fm-start-sessions-title" title="Active simulations" />
      {sessions.map((session) => (
        <div
          className="fm-start-continue"
          data-session-current={session.current ? "true" : "false"}
          data-session-id={session.sessionId}
          key={session.sessionId}
        >
          <div className="fm-start-continue__body">
            <h3 className="fm-start-continue__name">{session.name || "Untitled simulation"}</h3>
            <div className="fm-start-continue__progress">
              <StatusPill label={session.status} status={sessionPillStatus(session.status)} />
            </div>
            {session.current ? (
              <div className="fm-start-continue__actions">
                <Button onClick={onOpen} type="button" variant="primary">
                  <ArrowRight aria-hidden="true" size={14} />
                  Open simulation
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}
