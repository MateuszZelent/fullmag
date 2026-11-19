"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/shared/ui/Button";

import { useInstanceDiscovery } from "../resources/instanceDiscoveryResources";
import {
  INSTANCE_TAB_FRAME_NAME,
  instanceOrigin,
  instanceTabs,
  useInstanceTabs,
  usePageLocation,
} from "./instanceTabs";
import {
  answerInstanceTabReady,
  postInstanceTabFramesVisibility,
  postInstanceTabVisibility,
} from "./instanceTabVisibility";

/**
 * Other instances' own Control Rooms, each in a frame of its own origin, so the
 * UI always matches the version of that instance's API (ADR 0069). A frame is
 * created when its tab comes to the front and stays mounted (hidden by
 * visibility) to keep its view state and WebGL context, up to
 * `MAX_MOUNTED_FRAMES` most recently used frames. A hidden frame's document
 * stays visible to itself, so each frame is told whether its tab is in front
 * and pauses its viewport and resource loads while it is not.
 */
export function InstanceTabFrames() {
  const tabs = useInstanceTabs();
  const discovery = useInstanceDiscovery();
  const location = usePageLocation();
  const activePort = tabs.activePort;
  const open = new Set(tabs.openPorts);
  const framed = tabs.framedPorts.filter((port) => open.has(port));
  const known = new Set((discovery.data?.instances ?? []).map((instance) => instance.port));
  const activeUnavailable = activePort !== null && discovery.data !== null && !known.has(activePort);
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  const activeRef = useRef(activePort);
  const framedKey = framed.join(",");

  useEffect(() => {
    activeRef.current = activePort;
    if (location === null) return;
    postInstanceTabFramesVisibility(frames.current, (port) => instanceOrigin(port, location), activePort);
  }, [activePort, framedKey, location]);

  // A frame asks once its listener is installed, which may be after `load`.
  useEffect(() => {
    if (location === null) return undefined;
    const answerReady = (event: MessageEvent) =>
      answerInstanceTabReady(
        event,
        frames.current,
        (port) => instanceOrigin(port, location),
        activeRef.current,
      );
    window.addEventListener("message", answerReady);
    return () => window.removeEventListener("message", answerReady);
  }, [location]);

  return (
    <div
      className="fm-instance-frames"
      data-active-port={activePort ?? undefined}
      data-state={activePort === null ? "hidden" : "visible"}
    >
      {location === null ? null : framed.map((port) => (
        <iframe
          allow="fullscreen; clipboard-read; clipboard-write"
          className="fm-instance-frames__frame"
          data-active={port === activePort || undefined}
          data-instance-port={port}
          key={port}
          name={INSTANCE_TAB_FRAME_NAME}
          onLoad={(event) =>
            postInstanceTabVisibility(
              event.currentTarget,
              instanceOrigin(port, location),
              port === activeRef.current,
            )
          }
          ref={(frame) => {
            if (frame) frames.current.set(port, frame);
            return () => {
              frames.current.delete(port);
            };
          }}
          src={`${instanceOrigin(port, location)}/workspace`}
          title={`Fullmag instance on port ${port}`}
        />
      ))}
      {activeUnavailable ? (
        <div className="fm-instance-frames__unavailable" role="status">
          <p>No Fullmag instance answers on port {activePort}.</p>
          <Button onClick={() => instanceTabs.close(activePort)} type="button" variant="secondary">
            Close tab
          </Button>
        </div>
      ) : null}
    </div>
  );
}
