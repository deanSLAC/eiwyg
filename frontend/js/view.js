/**
 * EIWYG - Dashboard Viewer (Read-Only / Frozen View)
 *
 * Loads a saved dashboard by slug, renders all widgets using Gridstack
 * in static mode (no drag/drop/resize), connects via WebSocket to
 * receive live PV updates, and routes those updates to component
 * renderers registered on window.EIWYG_COMPONENTS.
 */

class DashboardViewer {
    constructor() {
        this.slug = this._extractSlug();
        this.grid = null;
        this.ws = null;
        this.dashboard = null;       // Full dashboard response from API
        this.widgets = {};           // id -> widget config
        this.widgetElements = {};    // id -> grid-stack-item DOM element
        this.reconnectDelay = 1000;
        this.maxReconnectDelay = 30000;
        this.reconnectTimer = null;
        this.componentsReady = false;
        this.variables = {};         // Dashboard template variables
    }

    /**
     * Extract the slug from the current URL path.
     * Expected format: /view/{slug}
     */
    _extractSlug() {
        const parts = window.location.pathname.split('/view/');
        return parts.length > 1 ? decodeURIComponent(parts[1]).replace(/\/+$/, '') : null;
    }

    /**
     * Entry point. Called on DOMContentLoaded.
     */
    async init() {
        if (!this.slug) {
            this._showError('Invalid URL', 'No dashboard slug was found in the URL.');
            return;
        }

        // Set the Edit button href now that we have the slug
        const editBtn = document.getElementById('edit-btn');
        if (editBtn) {
            editBtn.href = `${window.EIWYG_BASE || ''}/editor/${encodeURIComponent(this.slug)}`;
        }

        // Wait for components.js to register EIWYG_COMPONENTS
        await this._waitForComponents();

        // Load dashboard data from the API
        const loaded = await this.loadDashboard();
        if (!loaded) return;

        // Initialize the static grid and render widgets
        this.initGrid();
        this.renderWidgets();

        // Connect WebSocket for live PV updates
        this.connectWebSocket();
    }

    /**
     * Wait until window.EIWYG_COMPONENTS is available.
     * Shows a loading message while waiting. Times out after 10 seconds.
     */
    _waitForComponents() {
        return new Promise((resolve) => {
            if (window.EIWYG_COMPONENTS) {
                this.componentsReady = true;
                resolve();
                return;
            }

            const loadingEl = document.getElementById('view-loading');
            if (loadingEl) {
                loadingEl.querySelector('span').textContent = 'Loading components...';
            }

            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 100;
                if (window.EIWYG_COMPONENTS) {
                    clearInterval(interval);
                    this.componentsReady = true;
                    resolve();
                } else if (elapsed >= 10000) {
                    // Timeout -- proceed anyway; widgets will render with fallback
                    clearInterval(interval);
                    console.warn('EIWYG_COMPONENTS did not load within 10 seconds. Proceeding with fallback rendering.');
                    resolve();
                }
            }, 100);
        });
    }

    /**
     * Fetch the dashboard configuration from the REST API.
     * Returns true on success, false on failure.
     */
    async loadDashboard() {
        try {
            const resp = await fetch(`${window.EIWYG_BASE || ''}/api/dashboards/${encodeURIComponent(this.slug)}`);

            if (resp.status === 404) {
                this._showError('Dashboard not found',
                    'The dashboard you are looking for does not exist or may have been removed.');
                return false;
            }

            if (!resp.ok) {
                this._showError('Failed to load dashboard',
                    `Server returned status ${resp.status}. Please try again later.`);
                return false;
            }

            this.dashboard = await resp.json();

            // Update page title
            const title = this.dashboard.title || this.slug;
            document.title = `${title} - EIWYG`;
            const titleEl = document.getElementById('dashboard-title');
            if (titleEl) {
                titleEl.textContent = title;
            }

            // Index widgets by id
            const config = this.dashboard.config || {};
            const widgetList = config.widgets || [];
            for (const w of widgetList) {
                this.widgets[w.id] = w;
            }

            // Load dashboard variables
            this.variables = config.variables || {};

            // Load theme
            this.theme = config.theme || 'blue-dream';

            return true;
        } catch (err) {
            console.error('Failed to load dashboard:', err);
            this._showError('Connection error',
                'Could not connect to the server. Please check your network connection and try again.');
            return false;
        }
    }

    /**
     * Initialize Gridstack in fully static (read-only) mode.
     */
    initGrid() {
        const config = this.dashboard.config || {};
        const columns = config.columns || 12;

        this.grid = GridStack.init({
            column: columns,
            cellHeight: 60,
            margin: 4,
            staticGrid: true,           // No drag, drop, or resize
            disableOneColumnMode: true,  // Keep layout on narrow screens
            float: true,
        }, '#dashboard-grid');

        // Show the grid wrapper, hide loading
        const loadingEl = document.getElementById('view-loading');
        const gridWrapper = document.getElementById('view-grid-wrapper');
        if (loadingEl) loadingEl.style.display = 'none';
        if (gridWrapper) gridWrapper.style.display = '';

        // Apply theme (set on html element so it overrides :root variables)
        document.documentElement.setAttribute('data-theme', this.theme);

        // TV static animation for Vintage theme
        if (this.theme === 'vintage') {
            const canvas = document.getElementById('tv-static-overlay');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                const drawNoise = () => {
                    canvas.width = window.innerWidth;
                    canvas.height = window.innerHeight;
                    const imageData = ctx.createImageData(canvas.width, canvas.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        const v = Math.random() * 255;
                        data[i] = v;
                        data[i + 1] = v;
                        data[i + 2] = v;
                        data[i + 3] = 255;
                    }
                    ctx.putImageData(imageData, 0, 0);
                };
                setInterval(drawNoise, 120);
                window.addEventListener('resize', drawNoise);
            }
        }
    }

    /**
     * Render all widgets into the Gridstack grid using EIWYG_COMPONENTS.
     */
    renderWidgets() {
        const config = this.dashboard.config || {};
        const widgetList = config.widgets || [];

        for (const widget of widgetList) {
            this._renderWidget(widget);
        }
    }

    /**
     * Render a single widget into the grid.
     */
    _renderWidget(widget) {
        // Add widget to gridstack with an empty container first
        const gridItem = this.grid.addWidget({
            x: widget.x,
            y: widget.y,
            w: widget.w,
            h: widget.h,
            id: widget.id,
            content: `<div id="widget-content-${widget.id}" class="widget-content-container"></div>`,
        });

        // Store the element reference
        this.widgetElements[widget.id] = gridItem;

        // Find the actual live container in the DOM and render into it
        const container = gridItem.querySelector('.widget-content-container');
        const components = window.EIWYG_COMPONENTS;
        const renderer = components ? components[widget.type] : null;

        // Resolve variables in PV name for rendering
        const resolvedPv = widget.pv ? resolveVariables(widget.pv, this.variables) : null;
        const resolvedWidget = { ...widget, pv: resolvedPv };

        if (container && renderer && typeof renderer.render === 'function') {
            renderer.render(container, resolvedWidget);
        } else if (container) {
            // Fallback rendering
            container.innerHTML = `
                <div class="widget-inner">
                    <div class="widget-label">${this._escapeHtml(widget.config?.label || widget.type)}</div>
                    <div class="widget-value" data-widget-id="${widget.id}">--</div>
                    <div class="widget-pv">${this._escapeHtml(widget.pv || 'No PV')}</div>
                </div>
            `;
        }

        // Listen for pv-put custom events from interactive widgets
        const itemContent = gridItem.querySelector('.grid-stack-item-content');
        if (itemContent) {
            itemContent.addEventListener('pv-put', (e) => {
                const { pv, value } = e.detail || {};
                if (pv !== undefined && value !== undefined) {
                    this.handlePut(pv, value);
                }
            });
        }
    }

    /**
     * Collect all PV names that need to be subscribed to across all widgets.
     */
    _collectPVs() {
        const pvSet = new Set();
        const components = window.EIWYG_COMPONENTS;

        for (const widget of Object.values(this.widgets)) {
            // Create a view of the widget with resolved PV for subscription
            const resolvedPv = widget.pv ? resolveVariables(widget.pv, this.variables) : null;

            // Check if the component defines a getSubscribePVs method
            const renderer = components ? components[widget.type] : null;
            if (renderer && typeof renderer.getSubscribePVs === 'function') {
                // Pass a widget copy with resolved PV so getSubscribePVs uses the resolved name
                const resolvedWidget = { ...widget, pv: resolvedPv };
                const pvs = renderer.getSubscribePVs(resolvedWidget);
                if (Array.isArray(pvs)) {
                    pvs.forEach(pv => { if (pv) pvSet.add(pv); });
                }
            } else if (resolvedPv) {
                pvSet.add(resolvedPv);
            }
        }

        return Array.from(pvSet);
    }

    /**
     * Connect to the WebSocket endpoint and subscribe to all PVs.
     */
    connectWebSocket() {
        // Clear any pending reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}${window.EIWYG_BASE || ''}/ws`;

        this._setConnectionStatus('reconnecting', 'Connecting...');

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (err) {
            console.error('WebSocket creation failed:', err);
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this._setConnectionStatus('connected', 'Connected');
            this.reconnectDelay = 1000; // Reset backoff on successful connect

            // Subscribe to all PVs
            const pvs = this._collectPVs();
            if (pvs.length > 0) {
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    pvs: pvs,
                }));
                console.log(`Subscribed to ${pvs.length} PVs`);
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'pv_update') {
                    this.handlePVUpdate(msg.pv, {
                        value: msg.value,
                        timestamp: msg.timestamp,
                        severity: msg.severity,
                    });
                }
            } catch (err) {
                console.error('Failed to parse WebSocket message:', err);
            }
        };

        this.ws.onclose = (event) => {
            console.log('WebSocket closed:', event.code, event.reason);
            this.ws = null;
            this._setConnectionStatus('disconnected', 'Disconnected');
            this._scheduleReconnect();
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            // onclose will fire after this, which handles reconnection
        };
    }

    /**
     * Schedule a WebSocket reconnection with exponential backoff.
     */
    _scheduleReconnect() {
        if (this.reconnectTimer) return; // Already scheduled

        this._setConnectionStatus('reconnecting', `Reconnecting in ${Math.round(this.reconnectDelay / 1000)}s...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectWebSocket();
        }, this.reconnectDelay);

        // Exponential backoff with cap
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }

    /**
     * Route a PV update to the correct widget(s).
     */
    handlePVUpdate(pvName, pvData) {
        // Update the "last updated" timestamp in the status bar
        this._updateLastUpdated(pvData.timestamp);

        const components = window.EIWYG_COMPONENTS;

        // Find all widgets that use this PV and update them
        for (const [id, widget] of Object.entries(this.widgets)) {
            // Resolve variables in the widget PV for matching
            const resolvedPv = widget.pv ? resolveVariables(widget.pv, this.variables) : null;
            const resolvedWidget = { ...widget, pv: resolvedPv };

            // Determine if this widget cares about this PV
            let relevant = false;

            const renderer = components ? components[widget.type] : null;
            if (renderer && typeof renderer.getSubscribePVs === 'function') {
                const pvs = renderer.getSubscribePVs(resolvedWidget);
                relevant = Array.isArray(pvs) && pvs.includes(pvName);
            } else {
                relevant = (resolvedPv === pvName);
            }

            if (!relevant) continue;

            const el = this.widgetElements[id];
            if (!el) continue;

            const container = el.querySelector('.widget-content-container') ||
                              el.querySelector('.grid-stack-item-content');
            if (!container) continue;

            // Use component updater if available (pass resolved widget for PV matching)
            if (renderer && typeof renderer.update === 'function') {
                renderer.update(container, resolvedWidget, pvName, pvData);
            } else {
                // Fallback: update the .widget-value element
                const valueEl = container.querySelector(`[data-widget-id="${id}"]`) ||
                                container.querySelector('.widget-value');
                if (valueEl) {
                    const val = pvData.value;
                    const precision = widget.config?.precision;
                    if (typeof val === 'number' && precision != null) {
                        valueEl.textContent = val.toFixed(precision);
                    } else {
                        valueEl.textContent = val != null ? String(val) : '--';
                    }
                }
            }

            // Brief flash animation on update
            el.classList.remove('widget-pv-flash');
            // Force reflow to restart the animation
            void el.offsetWidth;
            el.classList.add('widget-pv-flash');
        }
    }

    /**
     * Send a PV put (write) command over the WebSocket.
     * Used by interactive widgets like numeric-input, slider, toggle, etc.
     */
    handlePut(pv, value) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot put PV -- WebSocket is not connected');
            return;
        }

        this.ws.send(JSON.stringify({
            type: 'put',
            pv: pv,
            value: value,
        }));
    }

    /**
     * Update the "last updated" timestamp in the status bar.
     */
    _updateLastUpdated(timestamp) {
        const el = document.getElementById('status-updated');
        if (!el) return;

        let date;
        if (timestamp) {
            // EPICS timestamps are Unix epoch seconds (possibly with fractional)
            date = new Date(timestamp * 1000);
        } else {
            date = new Date();
        }

        const pad = (n) => String(n).padStart(2, '0');
        const formatted = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
                          `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        el.textContent = `Last updated: ${formatted}`;
    }

    /**
     * Update the connection status indicator in the status bar.
     */
    _setConnectionStatus(state, text) {
        const dot = document.getElementById('connection-dot');
        const label = document.getElementById('connection-text');

        if (dot) {
            dot.className = 'connection-dot ' + state;
        }
        if (label) {
            label.textContent = text;
        }
    }

    /**
     * Show an error message in the main content area.
     */
    _showError(title, message) {
        const loadingEl = document.getElementById('view-loading');
        const gridWrapper = document.getElementById('view-grid-wrapper');
        const errorEl = document.getElementById('view-error');

        if (loadingEl) loadingEl.style.display = 'none';
        if (gridWrapper) gridWrapper.style.display = 'none';

        if (errorEl) {
            const titleEl = errorEl.querySelector('.view-error-title');
            const msgEl = errorEl.querySelector('.view-error-message');
            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.textContent = message;
            errorEl.style.display = '';
        }
    }

    /**
     * Simple HTML escaping for rendering user-provided text.
     */
    _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// ── Bootstrap ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const viewer = new DashboardViewer();
    viewer.init();

    // Expose for debugging
    window._eiwyg_viewer = viewer;
});
