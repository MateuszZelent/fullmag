import { Activity, AlertTriangle, Link2, RefreshCw, type LucideIcon } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import type { BannerIcon, BannerModel } from "../model/bannerModel";

const ICONS: Readonly<Record<BannerIcon, LucideIcon>> = {
  activity: Activity,
  alert: AlertTriangle,
  link: Link2,
  refresh: RefreshCw,
};

export interface ContextBannerProps {
  readonly banner: BannerModel | null;
  readonly onAction?: (actionId: string) => void;
}

/** Tone is carried by an icon and a title as well as the colour of the stripe. */
export function ContextBanner({ banner, onAction }: ContextBannerProps) {
  if (!banner) return null;
  const Icon = ICONS[banner.icon];
  return (
    <div
      className={`fm-start-banner fm-start-banner--${banner.tone}`}
      data-banner={banner.id}
      role={banner.tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="fm-start-banner__icon" size={14} />
      <div className="fm-start-banner__copy">
        <strong>{banner.title}</strong> {banner.body}
        {banner.detail ? (
          <span className="fm-start-banner__detail" title={banner.detail}>
            {banner.detail}
          </span>
        ) : null}
        {banner.actions.length > 0 ? (
          <span className="fm-start-banner__actions">
            {banner.actions.map((action) => (
              <Button
                key={action.id}
                onClick={() => onAction?.(action.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {action.label}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
