"use client";

import { Badge } from "./badge";

export type Tone = "default" | "accent" | "info" | "warn" | "danger" | "success";

interface StatusBadgeProps {
  label: string;
  tone?: Tone;
  pulse?: boolean;
}

export default function StatusBadge({
  label,
  tone = "default",
  pulse = false,
}: StatusBadgeProps) {
  const variantMap: Record<Tone, any> = {
    default: "secondary",
    accent: "accent",
    info: "info",
    warn: "warn",
    danger: "destructive",
    success: "success",
  };

  return (
    <Badge variant={variantMap[tone]} showDot pulse={pulse}>
      {label}
    </Badge>
  );
}
