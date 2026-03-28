"use client";

import s from "./MetricTile.module.css";

type Tone = "default" | "accent" | "info" | "warn" | "danger";

interface MetricTileProps {
  label: string;
  value: string;
  detail?: string;
  progress?: number;
  tone?: Tone;
}

export default function MetricTile({
  label,
  value,
  detail,
  progress,
  tone = "default",
}: MetricTileProps) {
  const normalized =
    progress != null ? Math.max(0, Math.min(progress, 100)) : null;

  return (
    <article className={s.uiMetric} data-tone={tone}>
      <header>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </header>
      <strong>{value}</strong>
      {normalized != null && (
        <progress className={s.bar} value={normalized} max={100} aria-hidden="true" />
      )}
    </article>
  );
}
