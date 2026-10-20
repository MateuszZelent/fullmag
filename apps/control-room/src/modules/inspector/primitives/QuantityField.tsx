"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { FormField, type FormFieldHelp } from "./FormField";
import {
  createQuantityFieldDraftStore,
  EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY,
  type QuantityFieldDraftStore,
  type QuantityFieldDraftSummary,
} from "./quantityFieldDraftStore";

export type QuantityFieldParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: "incomplete" | "invalid"; message?: string };

const QuantityFieldDraftContext = createContext<QuantityFieldDraftStore | null>(null);

/** Shares one raw-draft store with every QuantityField rendered below it. */
export function QuantityFieldDraftScope({
  children,
  store,
}: {
  children: ReactNode;
  store: QuantityFieldDraftStore;
}) {
  return (
    <QuantityFieldDraftContext.Provider value={store}>
      {children}
    </QuantityFieldDraftContext.Provider>
  );
}

const serverSummary = () => EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY;

/**
 * Owns a panel-level raw-draft store. Drafts are discarded when the edited
 * target identity changes; the selection guard keeps unresolved drafts from
 * reaching that point unnoticed.
 */
export function useQuantityFieldDraftScope(identityKey: string): {
  store: QuantityFieldDraftStore;
  summary: QuantityFieldDraftSummary;
} {
  const [store] = useState(createQuantityFieldDraftStore);
  const summary = useSyncExternalStore(store.subscribe, store.getSummary, serverSummary);
  const identityRef = useRef(identityKey);
  useLayoutEffect(() => {
    if (identityRef.current === identityKey) return;
    identityRef.current = identityKey;
    store.clear();
  }, [identityKey, store]);
  return { store, summary };
}

const subscribeNothing = () => () => {};
const zeroVersion = () => 0;

/**
 * Raw-draft state of a known set of field keys in the enclosing scope. Lets a
 * sub-section block its own Apply on uncommitted/invalid text and discard only
 * its own drafts on Revert, without touching sibling sections.
 */
export function useQuantityFieldDraftKeys(keys: readonly string[]): {
  invalidLabels: readonly string[];
  pending: boolean;
  remove: () => void;
} {
  const store = useContext(QuantityFieldDraftContext);
  useSyncExternalStore(
    store?.subscribe ?? subscribeNothing,
    store?.getVersion ?? zeroVersion,
    zeroVersion,
  );
  const entries = store ? keys.map((key) => store.get(key)) : [];
  const invalidLabels = entries.flatMap((entry) =>
    entry && entry.status !== "valid" ? [entry.label] : [],
  );
  return {
    invalidLabels,
    pending: entries.some((entry) => entry !== undefined),
    remove: () => {
      if (!store) return;
      for (const key of keys) store.remove(key);
    },
  };
}

const serverEntry = () => undefined;

export interface QuantityFieldProps<T> {
  disabled?: boolean;
  /** Stable key within the draft scope; keeps raw text across remounts. */
  draftKey?: string;
  /** Equality used to skip no-op commits. Defaults to Object.is. */
  equals?: (left: T, right: T) => boolean;
  /** Validation error for the committed value (shown when no raw draft error). */
  error?: string;
  format: (value: T) => string;
  help?: FormFieldHelp | string;
  hint?: string;
  inline?: boolean;
  /** Fallback message for unparsable text. */
  invalidMessage?: string;
  label: string;
  mono?: boolean;
  onCommit: (value: T) => void;
  parse: (text: string) => QuantityFieldParseResult<T>;
  placeholder?: string;
  unit?: string;
  unitControl?: ReactNode;
  value: T;
}

/**
 * Text field for a typed quantity. Keystrokes only update the raw text; the
 * text is parsed and committed on blur or Enter. Text that cannot be parsed
 * stays visible and is reported to the surrounding draft scope instead of
 * being replaced by the previous value. Escape restores the committed value.
 */
export function QuantityField<T>({
  disabled,
  draftKey,
  equals = Object.is,
  error,
  format,
  help,
  hint,
  inline,
  invalidMessage = "Enter a valid value",
  label,
  mono,
  onCommit,
  parse,
  placeholder,
  unit,
  unitControl,
  value,
}: QuantityFieldProps<T>) {
  const scopedStore = useContext(QuantityFieldDraftContext);
  const [localStore] = useState(createQuantityFieldDraftStore);
  const store = scopedStore ?? localStore;
  const autoKey = useId();
  const key = draftKey ?? autoKey;
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(key),
    serverEntry,
  );
  const [focused, setFocused] = useState(false);
  const formatted = format(value);
  const text = entry?.rawText ?? formatted;

  // Auto-keyed drafts cannot be found again after unmount; drop them.
  useEffect(() => {
    if (draftKey) return;
    return () => store.remove(autoKey);
  }, [autoKey, draftKey, store]);

  const report = (rawText: string) => {
    if (rawText === formatted) {
      store.remove(key);
      return;
    }
    const parsed = parse(rawText);
    store.report(key, {
      label,
      message: parsed.ok ? null : (parsed.message ?? null),
      rawText,
      status: parsed.ok ? "valid" : parsed.status,
    });
  };

  const commit = () => {
    const current = store.get(key);
    if (!current) return;
    const parsed = parse(current.rawText);
    if (!parsed.ok) return;
    store.remove(key);
    if (!equals(parsed.value, value)) onCommit(parsed.value);
  };

  const showDraftError =
    entry !== undefined &&
    entry.status !== "valid" &&
    (!focused || entry.status === "invalid");
  const draftError = showDraftError ? (entry.message ?? invalidMessage) : undefined;
  const visibleError = draftError ?? error;

  return (
    <FormField
      disabled={disabled}
      error={visibleError}
      help={help}
      hint={hint}
      inline={inline}
      inputMode="decimal"
      invalid={Boolean(visibleError)}
      label={label}
      mono={mono}
      placeholder={placeholder}
      type="text"
      unit={unit}
      unitControl={unitControl}
      value={text}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(event) => report(event.target.value)}
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape" && entry) {
          event.preventDefault();
          store.remove(key);
        }
      }}
    />
  );
}
