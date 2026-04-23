import * as React from "react";

type PossibleRef<T> = React.Ref<T> | undefined;
type RefCleanup = (() => void) | void;

const CALLBACK_REF_LAST_VALUE = new WeakMap<(value: unknown) => unknown, unknown>();

function setRef<T>(ref: PossibleRef<T>, value: T | null): RefCleanup {
  if (typeof ref === "function") {
    const lastValue = CALLBACK_REF_LAST_VALUE.get(ref as (value: unknown) => unknown);
    if (Object.is(lastValue, value)) {
      return;
    }
    CALLBACK_REF_LAST_VALUE.set(ref as (value: unknown) => unknown, value);
    return ref(value);
  }
  if (ref != null) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function isRefObject<T>(ref: PossibleRef<T>): ref is React.MutableRefObject<T | null> {
  return typeof ref === "object" && ref !== null && "current" in ref;
}

export function composeRefs<T>(...refs: PossibleRef<T>[]) {
  return (node: T | null): RefCleanup => {
    let hasCleanup = false;
    const cleanups = refs.map((ref) => {
      const cleanup = setRef(ref, node);
      if (!hasCleanup && typeof cleanup === "function") {
        hasCleanup = true;
      }
      return cleanup;
    });

    if (hasCleanup) {
      return () => {
        for (let index = 0; index < refs.length; index += 1) {
          const cleanup = cleanups[index];
          if (typeof cleanup === "function") {
            cleanup();
            continue;
          }
          // React 19 callback refs can return cleanup callbacks.
          // Clearing plain callback refs here may trigger state updates during
          // commit (e.g. setState ref setters) and cause update-depth loops.
          // We only clear object refs ourselves; callback refs are expected to
          // manage teardown through their returned cleanup when needed.
          const ref = refs[index];
          if (isRefObject(ref)) {
            ref.current = null;
          }
        }
      };
    }
  };
}

export function useComposedRefs<T>(...refs: PossibleRef<T>[]) {
  const refsRef = React.useRef<PossibleRef<T>[]>(refs);

  React.useLayoutEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  return React.useCallback((node: T | null): RefCleanup => {
    return composeRefs(...refsRef.current)(node);
  }, []);
}
