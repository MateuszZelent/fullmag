import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * True while an IME (CJK input) is composing text: the Enter that confirms a
 * conversion candidate must not commit the field. `keyCode === 229` covers
 * Safari, which can report `isComposing === false` for that keydown.
 */
export function isImeComposing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
