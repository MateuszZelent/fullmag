import * as React from "react";

type PossibleRef<T> = React.Ref<T> | undefined;
type RefCleanup = (() => void) | void;
type CallbackRef = (value: unknown) => RefCleanup;

const CALLBACK_REF_LAST_VALUE = new WeakMap<
  CallbackRef,
  { cleanup: RefCleanup; value: unknown }
>();

function setRef<T>(ref: PossibleRef<T>, value: T | null): RefCleanup {
  if (typeof ref === "function") {
    const callbackRef = ref as CallbackRef;
    if (value === null) {
      CALLBACK_REF_LAST_VALUE.delete(callbackRef);
      return;
    }
    const previous = CALLBACK_REF_LAST_VALUE.get(callbackRef);
    if (previous && Object.is(previous.value, value)) {
      return previous.cleanup;
    }
    const cleanup = callbackRef(value);
    CALLBACK_REF_LAST_VALUE.set(callbackRef, { cleanup, value });
    return cleanup;
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
            const ref = refs[index];
            if (typeof ref === "function") {
              CALLBACK_REF_LAST_VALUE.delete(ref as CallbackRef);
            }
            continue;
          }
          // React 19 callback refs can return cleanup callbacks. Plain callback
          // refs are not cleared through null because Radix uses state-setting
          // ref callbacks, and calling those during detach can recurse through
          // commit. Object refs still need explicit clearing.
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
  const refsRef = React.useRef(refs);
  refsRef.current = refs;

  // Radix passes inline callback refs that can update internal state. In React
  // 19, changing the composed callback identity every render detaches and
  // reattaches those refs during commit, which can produce update-depth loops.
  return React.useCallback((node: T | null): RefCleanup => {
    return composeRefs(...refsRef.current)(node);
  }, []);
}
