(() => {
  const applyStatusClasses = () => {
    const meta = document.querySelector('meta[name="fullmag-doc-status-map"]');
    if (!meta) return;

    let statusMap;
    try {
      statusMap = JSON.parse(meta.content);
    } catch {
      return;
    }

    document.querySelectorAll('nav a[href], .toctree-wrapper a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.includes('://')) return;
      const path = new URL(link.href, document.baseURI).pathname.replace(/^\/+/, '');
      const target = Object.keys(statusMap).find((candidate) =>
        path.endsWith(candidate.replace(/^\/+/, ''))
      );
      if (!target) return;

      const state = statusMap[target] === 'planned' ? 'planned' : 'active';
      link.classList.add(`fm-doc-status-${state}`);
      link.parentElement?.classList.add(`fm-doc-status-${state}`);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStatusClasses, { once: true });
  } else {
    applyStatusClasses();
  }
})();
