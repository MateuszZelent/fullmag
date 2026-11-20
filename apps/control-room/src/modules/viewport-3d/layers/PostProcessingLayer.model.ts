export function resolveViewport3DPostProcessingPolicy({
  available,
  quantitativeDataVisible,
  renderMode,
}: {
  available: boolean;
  quantitativeDataVisible: boolean;
  renderMode: "scientific" | "presentation";
}): { dataProtected: boolean; enabled: boolean } {
  const dataProtected =
    renderMode === "scientific" && quantitativeDataVisible;
  return { dataProtected, enabled: available && !dataProtected };
}
