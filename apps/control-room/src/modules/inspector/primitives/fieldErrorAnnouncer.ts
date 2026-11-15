/**
 * One polite live region shared by every inspector field. Errors are not live
 * regions themselves: a shown (rather than changed) live region is not
 * announced reliably, and per-field assertive alerts interrupt the user.
 */
let announcer: HTMLElement | null = null;
let announceTimer: ReturnType<typeof setTimeout> | undefined;
let announcedOwner: unknown = null;

function region(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (!announcer || !announcer.isConnected) {
    announcer = document.createElement("div");
    announcer.setAttribute("aria-live", "polite");
    announcer.className = "sr-only";
    announcer.dataset.slot = "form-field-error-announcer";
    document.body.append(announcer);
  }
  return announcer;
}

/** Announces after a short delay so the newly focused control is read first. */
export function announceFieldError(owner: unknown, message: string) {
  const live = region();
  if (!live) return;
  clearTimeout(announceTimer);
  live.textContent = "";
  announcedOwner = owner;
  announceTimer = setTimeout(() => {
    live.textContent = message;
  }, 500);
}

/** Clears a resolved field's announcement so it is not found later in the page. */
export function clearFieldErrorAnnouncement(owner: unknown) {
  if (announcedOwner !== owner || !announcer) return;
  clearTimeout(announceTimer);
  announcer.textContent = "";
  announcedOwner = null;
}

const INVALID_CONTROL_SELECTOR =
  'input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"], [role="combobox"][aria-invalid="true"]';

function controlLabel(control: HTMLElement): string {
  const labelled = control.getAttribute("aria-label");
  if (labelled) return labelled;
  const labels = (control as HTMLInputElement).labels;
  return labels?.[0]?.textContent?.trim() ?? "";
}

/**
 * Failed Apply/Commit: move focus to the first invalid control (focus reads its
 * error) and announce a short summary through the shared polite region.
 * Returns the number of invalid controls found.
 */
export function focusFirstInvalid(container: ParentNode | null | undefined, summaryOwner: unknown = focusFirstInvalid): number {
  const root = container ?? (typeof document === "undefined" ? null : document);
  if (!root) return 0;
  const invalid = Array.from(root.querySelectorAll<HTMLElement>(INVALID_CONTROL_SELECTOR))
    .filter((control) => !(control as HTMLInputElement).disabled);
  const first = invalid[0];
  if (!first) {
    announceFieldError(summaryOwner, "Resolve validation errors before applying.");
    return 0;
  }
  first.focus();
  const label = controlLabel(first);
  const count = invalid.length === 1 ? "1 field needs attention" : `${invalid.length} fields need attention`;
  announceFieldError(summaryOwner, label ? `${count}. First: ${label}.` : `${count}.`);
  return invalid.length;
}
