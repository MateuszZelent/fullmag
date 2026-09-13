import { state } from '../state.js';

const NAV_ITEMS = [
  { id: 'overview', label: 'Przegląd', icon: '📊', desc: 'Aktywny build, stan i trendy' },
  { id: 'queue', label: 'Kolejka', icon: '⏳', desc: 'Zadania aktywne i oczekujące' },
  { id: 'history', label: 'Historia', icon: '📜', desc: 'Zakończone kompilacje' },
  { id: 'storage', label: 'Storage', icon: '💾', desc: 'Pojemność, zasoby i retencja' },
  { id: 'processes', label: 'Procesy i zasoby', icon: '⚙️', desc: 'Koordynator i kontenery' },
  { id: 'logs', label: 'Logi', icon: '📋', desc: 'Strumień zdarzeń i stdout/stderr' },
  { id: 'policies', label: 'Polityki', icon: '🛡️', desc: 'Konfiguracja ochrony dysku' },
  { id: 'diagnostics', label: 'Diagnostyka', icon: '🩺', desc: 'Audyt, alerty i raport' },
];

export function renderSidebar(container) {
  const current = state.currentView;

  container.innerHTML = `
    <aside class="sidebar">
      <nav class="sidebar-nav">
        <ul class="nav-list">
          ${NAV_ITEMS.map(item => `
            <li class="nav-item">
              <button class="nav-btn ${item.id === current ? 'active' : ''}" data-view="${item.id}" title="${item.desc}">
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-label">${item.label}</span>
              </button>
            </li>
          `).join('')}
        </ul>
      </nav>

      <div class="sidebar-footer">
        <div class="slot-indicator">
          <span class="slot-dot ${state.overviewData?.active_build ? 'busy' : 'idle'}"></span>
          <div class="slot-text">
            <span class="slot-label">Slot kompilacji:</span>
            <span class="slot-val">${state.overviewData?.active_build ? 'Zajęty (1/1)' : 'Wolny (0/1)'}</span>
          </div>
        </div>
        <div class="version-tag font-mono">v1.2.0-runner-ui</div>
      </div>
    </aside>
  `;

  // Attach navigation listeners
  container.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const view = e.currentTarget.getAttribute('data-view');
      if (view) {
        state.setView(view);
      }
    });
  });
}
