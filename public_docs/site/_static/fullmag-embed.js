(() => {
  if (typeof window === "undefined" || window.parent === window) {
    return;
  }

  const root = document.documentElement;
  root.dataset.fullmagEmbedded = "";

  const applyTheme = (theme) => {
    if (theme !== "dark" && theme !== "light") {
      return;
    }
    root.dataset.theme = theme;
    root.style.colorScheme = theme;

    const pygmentsDark = document.getElementById("pygments_dark_css");
    if (pygmentsDark) {
      pygmentsDark.removeAttribute("media");
      pygmentsDark.disabled = theme !== "dark";
    }

    if (typeof window.updatePygmentsTheme === "function") {
      try {
        window.updatePygmentsTheme(theme);
      } catch {
        // Ignore theme helper errors from third-party Sphinx theme scripts.
      }
    }

    try {
      window.localStorage.setItem("theme", theme);
    } catch {
      // Ignore storage access errors in restricted iframe contexts.
    }
  };

  const resolveRelativeDocPath = () => {
    const contentRoot = root.getAttribute("data-content_root") || root.dataset.contentRoot;
    let relativePath = "";

    if (contentRoot) {
      try {
        const rootUrl = new URL(contentRoot, window.location.href);
        if (window.location.pathname.startsWith(rootUrl.pathname)) {
          relativePath = window.location.pathname.slice(rootUrl.pathname.length);
        }
      } catch {
        // Fall through to pathname normalization.
      }
    }

    if (!relativePath) {
      relativePath = window.location.pathname.replace(/^\/?(?:docs\/)?/, "");
    }

    const normalized = relativePath.replace(/^\/+/, "") || "index.html";
    return `${normalized}${window.location.search || ""}`;
  };

  const decorateExternalLinks = () => {
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const rawHref = anchor.getAttribute("href");
      if (
        !rawHref ||
        rawHref.startsWith("#") ||
        rawHref.startsWith("mailto:") ||
        rawHref.startsWith("tel:") ||
        rawHref.startsWith("javascript:")
      ) {
        return;
      }

      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawHref, window.location.href);
      } catch {
        return;
      }

      if (
        (resolvedUrl.protocol === "http:" || resolvedUrl.protocol === "https:") &&
        resolvedUrl.origin !== window.location.origin
      ) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
      }
    });
  };

  const postToParent = (payload) => {
    try {
      window.parent.postMessage(payload, window.location.origin);
    } catch {
      // Ignore cross-origin postMessage errors if embedded outside Control Room.
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.source === "fullmag-app" && data.type === "theme") {
      applyTheme(data.theme);
    }
  });

  const notifyParentReadyAndNavigated = () => {
    decorateExternalLinks();
    postToParent({
      source: "fullmag-docs",
      type: "ready",
    });
    postToParent({
      source: "fullmag-docs",
      type: "navigated",
      path: resolveRelativeDocPath(),
      title: document.title || "Documentation",
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", notifyParentReadyAndNavigated, {
      once: true,
    });
  } else {
    notifyParentReadyAndNavigated();
  }
})();
