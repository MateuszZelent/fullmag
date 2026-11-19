"use client";

import { Check, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";

import { copyTextToClipboard } from "@/shared/browser/copyTextToClipboard";
import { Button } from "@/shared/ui/Button";

function compactIdentifier(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 24) return value;
  return `${characters.slice(0, 12).join("")}…${characters.slice(-8).join("")}`;
}

export function CopyableIdentifier({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const [feedback, setFeedback] = useState<{ value: string; status: "copied" | "failed" } | null>(null);
  const status = feedback?.value === value ? feedback.status : "idle";

  const copy = async () => {
    try {
      await copyTextToClipboard(value);
      setFeedback({ value, status: "copied" });
    } catch {
      setFeedback({ value, status: "failed" });
    }
  };

  return (
    <span className="fm-start-copyable-id">
      <code aria-label={`${label}: ${value}`} className="fm-start-copyable-id__value" title={value}>
        {compactIdentifier(value)}
      </code>
      <Button
        aria-label={status === "copied" ? `Copied full ${label}` : `Copy full ${label}`}
        className="fm-start-copyable-id__action"
        onClick={() => void copy()}
        size="icon"
        title={status === "failed" ? `Could not copy ${label}; retry` : value}
        type="button"
        variant="ghost"
      >
        {status === "copied" ? <Check aria-hidden="true" size={14} /> : status === "failed" ? <RotateCcw aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
      </Button>
      <span aria-live="polite" className="fm-start-visually-hidden">
        {status === "copied" ? `${label} copied` : status === "failed" ? `Could not copy ${label}` : ""}
      </span>
    </span>
  );
}
