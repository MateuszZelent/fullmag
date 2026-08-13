export function resetInspectorScroll(root: HTMLElement | null): void {
  const viewport = root?.querySelector<HTMLElement>(".fm-scroll-area__viewport");
  viewport?.scrollTo({ behavior: "auto", left: 0, top: 0 });
}
