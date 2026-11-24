"use client";

import { homeView } from "@/kernel/layout/homeView";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import type { ModuleHelpContent } from "./physicsShared";

export function PhysicsInteractionHelpDialog({
  content,
  onOpenChange,
  open,
}: {
  content: ModuleHelpContent;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-physics-interaction-help-description">
        <DialogHeader>
          <DialogTitle>{content.title}</DialogTitle>
          <DialogDescription id="fm-physics-interaction-help-description">
            {content.description}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body text-xs">
          <div className="flex flex-col gap-1.5 rounded-[var(--fm-radius-field)] border border-[var(--fm-border-subtle)] bg-[var(--fm-section-bg)] p-3">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--fm-border-subtle)] pb-1.5">
              <span className="text-[var(--fm-text-muted)]">Scope</span>
              <span className="font-medium text-[var(--fm-text-primary)]">{content.scope}</span>
            </div>
            <div className="flex items-center justify-between gap-2 border-b border-[var(--fm-border-subtle)] pb-1.5">
              <span className="text-[var(--fm-text-muted)]">Storage</span>
              <span className="font-medium text-[var(--fm-text-primary)]">{content.storage}</span>
            </div>
            {content.fields.map((field) => (
              <div
                key={field.id}
                className="flex flex-col gap-0.5 border-b border-[var(--fm-border-subtle)] pb-1.5 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--fm-text-primary)]">{field.label}</span>
                  {field.unit ? (
                    <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                      {field.unit}
                    </span>
                  ) : null}
                </div>
                <span className="text-[var(--fm-text-muted)]">{field.description}</span>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          {content.docsPage ? (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
                homeView.openDocs(content.docsPage!);
              }}
            >
              Open in documentation
            </Button>
          ) : null}
          <Button size="sm" type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
