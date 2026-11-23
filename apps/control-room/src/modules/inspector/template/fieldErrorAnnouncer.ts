const ANNOUNCER_DEBOUNCE_MS = 120;
const ANNOUNCER_SLOT = "inspector-field-error-announcer";

const activeFieldErrors = new Map<string, string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnnouncedFieldId: string | null = null;
let announcerNode: HTMLElement | null = null;

function ensureAnnouncerElement(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) {
    return null;
  }

  if (
    announcerNode &&
    announcerNode.ownerDocument === document &&
    document.body.contains(announcerNode)
  ) {
    return announcerNode;
  }

  const existing = document.body.querySelector<HTMLElement>(
    `[data-slot="${ANNOUNCER_SLOT}"]`,
  );
  if (existing) {
    announcerNode = existing;
    return existing;
  }

  const node = document.createElement("div");
  node.className = "fm-visually-hidden";
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  node.setAttribute("data-slot", ANNOUNCER_SLOT);
  document.body.appendChild(node);
  announcerNode = node;
  return node;
}

/**
 * Announces field validation errors through a single page-wide polite live region
 * with a 120 ms debounce (`modern-web-guidance: accessible-error-announcement`).
 */
export function announceFieldError(fieldId: string, message: string | null): void {
  const trimmed = message?.trim() ?? "";

  if (!trimmed) {
    activeFieldErrors.delete(fieldId);
  } else {
    activeFieldErrors.set(fieldId, trimmed);
    lastAnnouncedFieldId = fieldId;
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const node = ensureAnnouncerElement();
    if (!node) return;

    if (activeFieldErrors.size === 0) {
      node.textContent = "";
      return;
    }

    const messageToSpeak =
      (lastAnnouncedFieldId ? activeFieldErrors.get(lastAnnouncedFieldId) : undefined) ??
      Array.from(activeFieldErrors.values()).at(-1) ??
      "";
    node.textContent = messageToSpeak;
  }, ANNOUNCER_DEBOUNCE_MS);
}

/** Clears pending timers and tracked messages (useful for deterministic test teardown). */
export function resetFieldErrorAnnouncer(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  activeFieldErrors.clear();
  lastAnnouncedFieldId = null;
  if (announcerNode) {
    announcerNode.textContent = "";
    announcerNode = null;
  }
}
