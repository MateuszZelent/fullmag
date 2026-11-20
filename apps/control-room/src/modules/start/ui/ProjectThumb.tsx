"use client";

import { FileWarning, ImageOff } from "lucide-react";
import { useState } from "react";

import { pinThumbnail } from "../model/thumbnailCache";
import type { ProjectStatus } from "../model/types";

export interface ProjectThumbProps {
  readonly src?: string;
  readonly status: ProjectStatus;
  /** Rows load lazily; the inspector preview is what the user is looking at. */
  readonly eager?: boolean;
  readonly size: "row" | "card" | "preview" | "continue";
}

function Placeholder({ missing }: { readonly missing: boolean }) {
  const Icon = missing ? FileWarning : ImageOff;
  return (
    <span aria-hidden="true" className="fm-start-thumb__placeholder" data-missing={missing}>
      <Icon size={16} />
    </span>
  );
}

function ThumbImage({ eager, src }: { readonly eager: boolean; readonly src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder missing={false} />;
  // The data plane already delivers a thumbnail, including browser-local blob URLs.
  // The adjacent project title supplies the accessible name.
  /* eslint-disable @next/next/no-img-element */
  return (
    // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- Browser-local thumbnails have no server optimizer.
    <img
      alt=""
      className="fm-start-thumb__img"
      decoding="async"
      loading={eager ? "eager" : "lazy"}
      onError={() => setFailed(true)}
      onLoad={(event) => pinThumbnail(src, event.currentTarget)}
      src={src}
    />
  );
  /* eslint-enable @next/next/no-img-element */
}

/**
 * A render is data, so the frame keeps the viewport background in both themes
 * and a project with no result shows a muted placeholder, never a broken image.
 */
export function ProjectThumb({ eager = false, size, src, status }: ProjectThumbProps) {
  const missing = status === "missing";
  return (
    <span className={`fm-start-thumb fm-start-thumb--${size}`} data-slot="thumbnail">
      {missing || !src ? (
        <Placeholder missing={missing} />
      ) : (
        // Keyed so a changed source resets the failed state instead of
        // inheriting the previous image's error.
        <ThumbImage eager={eager} key={src} src={src} />
      )}
    </span>
  );
}
