/**
 * Central reactive application state for Fullmag Runner Console.
 */

import { api } from './api.js';

class AppState {
  constructor() {
    this.currentView = 'overview';
    this.selectedJobId = null;
    this.selectedJobTab = 'timeline';
    this.showAuthModal = false;
    this.theme = localStorage.getItem('fullmag_runner_theme') || 'dark';
    this.autoRefresh = true;
    this.connectionStatus = 'connecting';
    this.lastUpdated = null;
    this.overviewData = null;
    this.healthData = null;
    this.alertsData = [];
    this.alertsError = null;
    this.policiesData = null;
    this.listeners = new Set();
    this.pollTimer = null;

    api.onAuthFailure = () => {
      this.showAuthModal = true;
      this.connectionStatus = 'disconnected';
      this.notify();
    };

    // Listen to document visibility to throttle background refresh
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopPolling();
      } else {
        this.startPolling();
        this.refresh();
      }
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (err) {
        console.error('State listener error:', err);
      }
    }
  }

  setView(view) {
    if (this.currentView !== view) {
      this.currentView = view;
      this.notify();
    }
  }

  openJobDetails(jobId, tab = 'timeline') {
    this.selectedJobId = jobId;
    this.selectedJobTab = tab || 'timeline';
    this.notify();
  }

  closeJobDetails() {
    this.selectedJobId = null;
    this.selectedJobTab = 'timeline';
    this.notify();
  }

  setTheme(theme) {
    this.theme = theme;
    localStorage.setItem('fullmag_runner_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    this.notify();
  }

  toggleTheme() {
    this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
  }

  toggleAutoRefresh() {
    this.autoRefresh = !this.autoRefresh;
    if (this.autoRefresh) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
    this.notify();
  }

  async refresh() {
    try {
      const [overview, health, alertsRes, policiesRes] = await Promise.allSettled([
        api.getOverview(),
        api.getHealth(),
        api.getAlerts(),
        api.getRetentionPolicy(),
      ]);

      if (overview.status === 'rejected') throw overview.reason;
      if (health.status === 'rejected') throw health.reason;

      this.overviewData = overview.value;
      this.healthData = health.value;

      if (alertsRes.status === 'fulfilled') {
        this.alertsData = alertsRes.value || [];
        this.alertsError = null;
      } else {
        this.alertsData = null;
        this.alertsError = alertsRes.reason;
      }

      if (policiesRes.status === 'fulfilled') {
        this.policiesData = policiesRes.value;
      }

      this.connectionStatus = 'connected';
      this.lastUpdated = new Date();
      this.showAuthModal = false;
    } catch (err) {
      if (err.status === 401) {
        this.showAuthModal = true;
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = this.lastUpdated ? 'stale' : 'disconnected';
      }
    }
    this.notify();
  }

  startPolling(intervalMs = 5000) {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.autoRefresh && !document.hidden) {
        this.refresh();
      }
    }, intervalMs);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export const state = new AppState();
