/**
 * Master entry point for Fullmag Runner Console.
 */

import { state } from './state.js';
import { api } from './api.js';
import { renderTopBar } from './components/TopBar.js';
import { renderSidebar } from './components/Sidebar.js';
import { renderBlockBanner } from './components/BlockBanner.js';
import { renderBuildDetailsModal } from './components/BuildDetailsModal.js';
import { renderAuthModal } from './components/AuthModal.js';
import { renderOverviewView } from './views/OverviewView.js';
import { renderQueueView } from './views/QueueView.js';
import { renderHistoryView } from './views/HistoryView.js';
import { renderStorageView } from './views/StorageView.js';
import { renderProcessesView } from './views/ProcessesView.js';
import { renderLogsView } from './views/LogsView.js';
import { renderPoliciesView } from './views/PoliciesView.js';
import { renderDiagnosticsView } from './views/DiagnosticsView.js';

function init() {
  const topBarContainer = document.getElementById('topbar-container');
  const sidebarContainer = document.getElementById('sidebar-container');
  const bannerContainer = document.getElementById('banner-container');
  const mainContainer = document.getElementById('main-content');
  const modalContainer = document.getElementById('modal-container');

  // Sync hash routing if present
  const hash = window.location.hash.replace('#', '');
  if (['overview', 'queue', 'history', 'storage', 'processes', 'logs', 'policies', 'diagnostics'].includes(hash)) {
    state.currentView = hash;
  }

  window.addEventListener('hashchange', () => {
    const newHash = window.location.hash.replace('#', '');
    if (['overview', 'queue', 'history', 'storage', 'processes', 'logs', 'policies', 'diagnostics'].includes(newHash)) {
      state.setView(newHash);
    }
  });

  // Set initial theme
  document.documentElement.setAttribute('data-theme', state.theme);

  let currentMountedView = null;
  let activeViewHandle = null;
  let currentMountedJobId = null;
  let detailsModalHandle = null;
  let isAuthModalMounted = false;

  // Render function called whenever state changes
  function render() {
    // Update URL hash
    if (window.location.hash !== `#${state.currentView}`) {
      window.history.replaceState(null, '', `#${state.currentView}`);
    }

    renderTopBar(topBarContainer);
    renderSidebar(sidebarContainer);
    renderBlockBanner(bannerContainer);

    const viewChanged = state.currentView !== currentMountedView;
    if (viewChanged) {
      if (activeViewHandle && typeof activeViewHandle.destroy === 'function') {
        try { activeViewHandle.destroy(); } catch (_) {}
      }
      currentMountedView = state.currentView;
      switch (state.currentView) {
        case 'overview':
          activeViewHandle = renderOverviewView(mainContainer);
          break;
        case 'queue':
          activeViewHandle = renderQueueView(mainContainer);
          break;
        case 'history':
          activeViewHandle = renderHistoryView(mainContainer);
          break;
        case 'storage':
          activeViewHandle = renderStorageView(mainContainer);
          break;
        case 'processes':
          activeViewHandle = renderProcessesView(mainContainer);
          break;
        case 'logs':
          activeViewHandle = renderLogsView(mainContainer);
          break;
        case 'policies':
          activeViewHandle = renderPoliciesView(mainContainer);
          break;
        case 'diagnostics':
          activeViewHandle = renderDiagnosticsView(mainContainer);
          break;
        default:
          activeViewHandle = renderOverviewView(mainContainer);
      }
    } else {
      // Periodic background refresh without rebuilding the DOM if view provides update()
      if (activeViewHandle && typeof activeViewHandle.update === 'function') {
        try { activeViewHandle.update(); } catch (_) {}
      }
    }

    // Modal lifecycle management without DOM recreation or tab resetting
    updateModals();
  }

  function updateModals() {
    // 1. Build Details Modal
    if (state.selectedJobId) {
      let detailsWrap = modalContainer.querySelector('#details-modal-wrap');
      if (!detailsWrap || currentMountedJobId !== state.selectedJobId) {
        if (detailsModalHandle && typeof detailsModalHandle.destroy === 'function') {
          try { detailsModalHandle.destroy(); } catch (_) {}
          detailsModalHandle = null;
        }
        if (!detailsWrap) {
          detailsWrap = document.createElement('div');
          detailsWrap.id = 'details-modal-wrap';
          modalContainer.appendChild(detailsWrap);
        }
        currentMountedJobId = state.selectedJobId;
        detailsModalHandle = renderBuildDetailsModal(detailsWrap);
      } else {
        if (detailsModalHandle && typeof detailsModalHandle.update === 'function') {
          try { detailsModalHandle.update(state.selectedJobTab); } catch (_) {}
        }
      }
    } else {
      if (currentMountedJobId !== null) {
        if (detailsModalHandle && typeof detailsModalHandle.destroy === 'function') {
          try { detailsModalHandle.destroy(); } catch (_) {}
          detailsModalHandle = null;
        }
        modalContainer.querySelector('#details-modal-wrap')?.remove();
        currentMountedJobId = null;
      }
    }

    // 2. Auth Modal
    if (state.showAuthModal) {
      if (!isAuthModalMounted) {
        let authWrap = modalContainer.querySelector('#auth-modal-wrap');
        if (!authWrap) {
          authWrap = document.createElement('div');
          authWrap.id = 'auth-modal-wrap';
          modalContainer.appendChild(authWrap);
        }
        isAuthModalMounted = true;
        renderAuthModal(authWrap);
      }
    } else {
      if (isAuthModalMounted) {
        modalContainer.querySelector('#auth-modal-wrap')?.remove();
        isAuthModalMounted = false;
      }
    }
  }

  state.subscribe(render);

  // Initial load
  render();
  state.refresh().then(() => {
    state.startPolling();
  });
}

document.addEventListener('DOMContentLoaded', init);
