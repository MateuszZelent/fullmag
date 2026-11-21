"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Viewport3DFrameCommitQueue } from "../model/viewport3DFrameCommitQueue";

const Viewport3DFrameCommitQueueContext =
  createContext<Viewport3DFrameCommitQueue<unknown> | null>(null);

export function Viewport3DFrameCommitQueueProvider<TFrameState>({
  children,
  queue,
}: {
  children: ReactNode;
  queue: Viewport3DFrameCommitQueue<TFrameState>;
}) {
  return (
    <Viewport3DFrameCommitQueueContext.Provider
      value={queue as Viewport3DFrameCommitQueue<unknown>}
    >
      {children}
    </Viewport3DFrameCommitQueueContext.Provider>
  );
}

export function useViewport3DFrameCommitQueue<TFrameState>() {
  return useContext(Viewport3DFrameCommitQueueContext) as
    | Viewport3DFrameCommitQueue<TFrameState>
    | null;
}
