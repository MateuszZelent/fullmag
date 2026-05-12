import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

interface FeedbackBannerProps {
  kind: "error" | "success" | "warning";
  message: string;
}

/**
 * Inline feedback banner shown inside inspector sections after a transaction.
 * Left-border color, icon, and background tint vary by kind.
 */
export function FeedbackBanner({ kind, message }: FeedbackBannerProps) {
  const Icon =
    kind === "error" ? AlertCircle : kind === "warning" ? AlertTriangle : CheckCircle2;
  return (
    <div className="fm-inspector-feedback" data-kind={kind} role="alert">
      <Icon className="fm-inspector-feedback__icon" size={13} aria-hidden="true" />
      <span className="fm-inspector-feedback__message">{message}</span>
    </div>
  );
}
