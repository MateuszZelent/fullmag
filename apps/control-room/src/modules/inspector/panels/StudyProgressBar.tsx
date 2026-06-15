export function StudyProgressBar({
  indeterminate = false,
  label,
  statusLabel,
  value,
}: {
  indeterminate?: boolean;
  label: string;
  statusLabel?: string;
  value: number | null;
}) {
  const pct = value ?? 0;
  return (
    <div
      className={
        indeterminate
          ? "fm-study-progress fm-study-progress--indeterminate"
          : "fm-study-progress"
      }
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={indeterminate ? undefined : (value ?? undefined)}
      role="progressbar"
    >
      <span className="fm-study-progress__bar" style={{ width: `${pct}%` }} />
      <span className="fm-study-progress__label">
        {statusLabel ?? (value == null ? "pending" : `${pct}%`)}
      </span>
    </div>
  );
}
