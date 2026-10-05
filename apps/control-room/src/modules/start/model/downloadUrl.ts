/**
 * Starts a browser download of `url` without leaving the page. The server
 * answers with `Content-Disposition: attachment`, so the anchor works across
 * origins (the `download` attribute alone would be ignored there). The body is
 * streamed by the browser, never read into the page.
 */
export function startDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export const RESULTS_DOWNLOAD_NO_BACKEND =
  "Downloading results needs a Fullmag backend that serves the workspace database.";
export const RESULTS_DOWNLOAD_NO_FOLDER =
  "No result folder is linked to this project, so there is nothing to download.";
export const RESULTS_DOWNLOAD_FOLDER_MISSING = "The result folder is missing.";
