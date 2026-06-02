export function StudyProgressBar({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const pct = value ?? 0;
  return (
    <div
      className="fm-study-progress"
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value ?? undefined}
      role="progressbar"
    >
      <span className="fm-study-progress__bar" style={{ width: `${pct}%` }} />
      <span className="fm-study-progress__label">
        {value == null ? "pending" : `${pct}%`}
      </span>
    </div>
  );
}
