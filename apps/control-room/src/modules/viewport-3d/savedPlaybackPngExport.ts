import { viewport3dStore } from "./viewport3dStore";
import { captureViewport3DImage } from "./viewport3dImageExport";

export async function downloadSavedPlaybackPng(
  canvas: HTMLCanvasElement,
  filename: string,
): Promise<void> {
  const { appearance } = viewport3dStore.getSnapshot();
  const blob = await captureViewport3DImage(canvas, {
    annotations: appearance.exportAnnotations,
    background: appearance.exportBackground,
    scale: appearance.exportScale,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
