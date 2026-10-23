/** Native color inputs require a literal opaque hex, rather than a CSS variable.
 * This is only the initial chooser value for an unrepresentable text color;
 * it is never applied to the model without a user color selection. */
export const NATIVE_COLOR_PICKER_FALLBACK = "#ffffff";
