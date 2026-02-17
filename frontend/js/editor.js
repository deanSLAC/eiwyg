/**
 * EIWYG - EPICS Is What You Get
 * Main Editor Application
 */

'use strict';

/* ── Widget Type Definitions ──────────────────────────────────────── */

const WIDGET_TYPES = [
    { type: 'label',            icon: '\u{1F3F7}\uFE0F', name: 'Label',             w: 3, h: 1 },
    { type: 'text-display',     icon: '\u{1F4DD}',       name: 'Text Display',      w: 3, h: 2 },
    { type: 'numeric-display',  icon: '\u{1F522}',       name: 'Numeric Display',   w: 3, h: 2 },
    { type: 'numeric-input',    icon: '\u2B06\uFE0F\u2B07\uFE0F', name: 'Numeric Input', w: 3, h: 2 },
    { type: 'text-input',       icon: '\u270F\uFE0F',    name: 'Text Input',        w: 3, h: 2 },
    { type: 'slider',           icon: '\u{1F39A}\uFE0F', name: 'Slider',            w: 4, h: 2 },
    { type: 'toggle',           icon: '\u{1F518}',       name: 'Toggle',            w: 2, h: 2 },
    { type: 'led',              icon: '\u{1F4A1}',       name: 'LED',               w: 2, h: 2 },
    { type: 'gauge',            icon: '\u{1F4CA}',       name: 'Gauge',             w: 4, h: 4 },
    { type: 'progress-bar',     icon: '\u{1F4C8}',       name: 'Progress Bar',      w: 4, h: 2 },
    { type: 'motor-control',    icon: '\u2699\uFE0F',    name: 'Motor Control',     w: 4, h: 3 },
    { type: 'enum-selector',    icon: '\u{1F4CB}',       name: 'Enum Selector',     w: 3, h: 2 },
    { type: 'detector-display', icon: '\u{1F52C}',       name: 'Detector Display',  w: 4, h: 4 },
    { type: 'plot',             icon: '\u{1F4C9}',       name: 'Plot',              w: 6, h: 4 },
];

const WIDGET_TYPE_MAP = {};
WIDGET_TYPES.forEach(t => WIDGET_TYPE_MAP[t.type] = t);


/* ── EditorApp Class ──────────────────────────────────────────────── */

class EditorApp {
    constructor() {
        this.grid = null;
        this.ws = null;
        this.widgets = {};           // id -> { id, type, pv, config }
        this.selectedWidgetId = null;
        this.nextWidgetId = 1;
        this.subscribedPVs = new Set();
        this.chatHistory = [];
        this.slug = null;            // slug from URL if editing existing dashboard

        this._init();
    }

    /* ── Initialization ───────────────────────────────────────────── */

    _init() {
        this._detectSlug();
        this._buildPalette();
        this.initGrid();
        this.initWebSocket();
        this._bindTopBar();
        this._bindChatbot();
        this._bindGlobalEvents();

        if (this.slug) {
            this._loadExistingDashboard(this.slug);
        }
    }

    _detectSlug() {
        const base = window.EIWYG_BASE || '';
        const path = window.location.pathname;
        const localPath = base && path.startsWith(base) ? path.slice(base.length) : path;
        const match = localPath.match(/^\/editor\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
        if (match) {
            this.slug = match[1];
            document.getElementById('dashboard-slug').value = this.slug;
        }
    }

    /* ── Grid Setup ───────────────────────────────────────────────── */

    initGrid() {
        this.grid = GridStack.init({
            column: 12,
            cellHeight: 60,
            margin: 4,
            float: true,
            animate: true,
            acceptWidgets: '.palette-item',
            removable: false,
            disableOneColumnMode: true,
        }, '#grid');

        // Listen for drop from external palette
        this.grid.on('dropped', (_event, _prevNode, newNode) => {
            if (newNode && newNode.el) {
                const type = newNode.el.getAttribute('data-widget-type')
                    || newNode.el.querySelector('[data-widget-type]')?.getAttribute('data-widget-type');
                if (type) {
                    // Remove the temporary element gridstack created
                    this.grid.removeWidget(newNode.el, true, false);
                    // Add our properly configured widget
                    this.addWidget(type, newNode.x, newNode.y);
                }
            }
        });

        // Listen for resize/move to update stored positions
        this.grid.on('change', (_event, items) => {
            if (items) {
                items.forEach(item => {
                    const wid = item.el?.getAttribute('data-widget-id');
                    if (wid && this.widgets[wid]) {
                        this.widgets[wid].x = item.x;
                        this.widgets[wid].y = item.y;
                        this.widgets[wid].w = item.w;
                        this.widgets[wid].h = item.h;
                    }
                });
            }
        });

        // Click on grid background deselects
        document.getElementById('grid-container').addEventListener('click', (e) => {
            if (e.target.id === 'grid-container' || e.target.id === 'grid' || e.target.classList.contains('grid-stack')) {
                this.selectWidget(null);
            }
        });
    }

    /* ── WebSocket ────────────────────────────────────────────────── */

    initWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}${window.EIWYG_BASE || ''}/ws`;

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (err) {
            console.warn('WebSocket connection failed:', err);
            return;
        }

        this.ws.addEventListener('open', () => {
            console.log('WebSocket connected');
            // Re-subscribe to any existing PVs
            this._syncPVSubscriptions();
        });

        this.ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'pv_update' && msg.pv) {
                    this._handlePVUpdate(msg.pv, msg.value, msg);
                }
            } catch (err) {
                console.warn('Failed to parse WS message:', err);
            }
        });

        this.ws.addEventListener('close', () => {
            console.log('WebSocket closed, reconnecting in 3s...');
            setTimeout(() => this.initWebSocket(), 3000);
        });

        this.ws.addEventListener('error', (err) => {
            console.warn('WebSocket error:', err);
        });
    }

    _syncPVSubscriptions() {
        const currentPVs = new Set();
        Object.values(this.widgets).forEach(w => {
            if (w.pv) currentPVs.add(w.pv);
        });

        // Unsubscribe from PVs no longer in use
        const toUnsub = [...this.subscribedPVs].filter(pv => !currentPVs.has(pv));
        if (toUnsub.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'unsubscribe', pvs: toUnsub }));
        }

        // Subscribe to new PVs
        const toSub = [...currentPVs].filter(pv => !this.subscribedPVs.has(pv));
        if (toSub.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'subscribe', pvs: toSub }));
        }

        this.subscribedPVs = currentPVs;
    }

    _handlePVUpdate(pv, value, msg) {
        Object.values(this.widgets).forEach(widget => {
            if (widget.pv === pv) {
                widget._currentValue = value;
                this._rerenderWidget(widget.id);
            }
        });
    }

    _sendPut(pv, value) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'put', pv, value }));
        }
    }

    /* ── Palette ──────────────────────────────────────────────────── */

    _buildPalette() {
        const palette = document.getElementById('palette');
        WIDGET_TYPES.forEach(wt => {
            const item = document.createElement('div');
            item.className = 'palette-item';
            item.innerHTML = `
                <span class="palette-item-icon">${wt.icon}</span>
                <span class="palette-item-name">${wt.name}</span>
            `;

            // Gridstack external drag attributes
            item.setAttribute('gs-w', wt.w);
            item.setAttribute('gs-h', wt.h);
            item.setAttribute('data-widget-type', wt.type);

            palette.appendChild(item);
        });

        // Set up Gridstack to accept external drags (no HTML5 draggable - let Gridstack handle it)
        GridStack.setupDragIn('.palette-item', {
            appendTo: 'body',
            helper: 'clone',
        });
    }

    /* ── Widget Management ────────────────────────────────────────── */

    addWidget(type, x = 0, y = 0, w, h, existingId, existingConfig, existingPv) {
        const typeDef = WIDGET_TYPE_MAP[type] || WIDGET_TYPES[0];
        const id = existingId || `widget-${this.nextWidgetId++}`;

        // Ensure nextWidgetId stays ahead of all existing IDs
        const numMatch = id.match(/^widget-(\d+)$/);
        if (numMatch) {
            const numPart = parseInt(numMatch[1], 10);
            if (numPart >= this.nextWidgetId) this.nextWidgetId = numPart + 1;
        }

        const config = existingConfig || {
            label: typeDef.name,
            fontSize: 16,
            fontColor: '#e2e8f0',
        };

        const widget = {
            id,
            type,
            x,
            y,
            w: w || typeDef.w,
            h: h || typeDef.h,
            pv: existingPv || null,
            config,
            _currentValue: null,
        };

        this.widgets[id] = widget;

        // Create the Gridstack node
        const contentHtml = this._renderWidgetContent(widget);
        const gsWidget = this.grid.addWidget({
            x: widget.x,
            y: widget.y,
            w: widget.w,
            h: widget.h,
            id: widget.id,
            content: contentHtml,
        });

        gsWidget.setAttribute('data-widget-id', id);

        // Click to select
        const content = gsWidget.querySelector('.grid-stack-item-content');
        content.addEventListener('click', (e) => {
            // Ignore clicks on delete button
            if (e.target.closest('.widget-delete-btn')) return;
            e.stopPropagation();
            this.selectWidget(id);
        });

        // Delete button handler
        const delBtn = content.querySelector('.widget-delete-btn');
        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeWidget(id);
            });
        }

        // If PV is set, subscribe
        if (widget.pv) {
            this._syncPVSubscriptions();
        }

        return id;
    }

    selectWidget(id) {
        // Deselect previous
        if (this.selectedWidgetId) {
            const prevEl = document.querySelector(`[data-widget-id="${this.selectedWidgetId}"]`);
            if (prevEl) prevEl.classList.remove('widget-selected');
        }

        this.selectedWidgetId = id;

        if (id) {
            const el = document.querySelector(`[data-widget-id="${id}"]`);
            if (el) el.classList.add('widget-selected');
            this._showConfig(id);
        } else {
            this._hideConfig();
        }
    }

    updateWidgetConfig(id, updates) {
        const widget = this.widgets[id];
        if (!widget) return;

        // Update config fields
        if (updates.config) {
            Object.assign(widget.config, updates.config);
        }
        if (updates.pv !== undefined) {
            widget.pv = updates.pv;
            this._syncPVSubscriptions();
        }

        // Re-render the widget content
        this._rerenderWidget(id);
    }

    removeWidget(id) {
        const widget = this.widgets[id];
        if (!widget) return;

        const el = document.querySelector(`[data-widget-id="${id}"]`);
        if (el) {
            this.grid.removeWidget(el, true);
        }

        delete this.widgets[id];

        if (this.selectedWidgetId === id) {
            this.selectedWidgetId = null;
            this._hideConfig();
        }

        this._syncPVSubscriptions();
    }

    /* ── Widget Rendering ─────────────────────────────────────────── */

    _renderWidgetContent(widget) {
        // Check if components.js has registered a renderer
        const comps = window.EIWYG_COMPONENTS;
        if (comps && comps[widget.type] && typeof comps[widget.type].render === 'function') {
            try {
                return comps[widget.type].render(widget) +
                    `<button class="widget-delete-btn" title="Delete">&times;</button>`;
            } catch (err) {
                console.warn(`Component render error for ${widget.type}:`, err);
            }
        }

        // Fallback basic renderer
        return this._basicRender(widget);
    }

    _basicRender(widget) {
        const label = widget.config.label || widget.type;
        const pv = widget.pv || '';
        const value = widget._currentValue;
        const fontSize = widget.config.fontSize || 16;
        const fontColor = widget.config.fontColor || '#e2e8f0';

        let valueDisplay = '';
        switch (widget.type) {
            case 'label':
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${label}</div>`;
                break;
            case 'text-display':
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${value !== null && value !== undefined ? value : '--'}</div>`;
                break;
            case 'numeric-display': {
                const precision = widget.config.precision ?? 2;
                const units = widget.config.units || '';
                const numVal = value !== null && value !== undefined ? Number(value).toFixed(precision) : '--';
                const displayColor = this._getColorForValue(value, widget.config) || fontColor;
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${displayColor}">${numVal} <span style="font-size:${Math.max(fontSize - 4, 10)}px;color:var(--text-muted)">${units}</span></div>`;
                break;
            }
            case 'numeric-input': {
                const precision = widget.config.precision ?? 2;
                const units = widget.config.units || '';
                const numVal = value !== null && value !== undefined ? Number(value).toFixed(precision) : '0';
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${numVal} ${units}</div>`;
                break;
            }
            case 'text-input':
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${value !== null && value !== undefined ? value : ''}</div>`;
                break;
            case 'slider': {
                const min = widget.config.min ?? 0;
                const max = widget.config.max ?? 100;
                const val = value !== null && value !== undefined ? value : min;
                const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
                valueDisplay = `
                    <div style="width:100%;padding:0 4px;flex:1;display:flex;flex-direction:column;justify-content:center;">
                        <div style="width:100%;height:8px;background:var(--bg-medium);border-radius:4px;overflow:hidden;">
                            <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:4px;"></div>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;text-align:center;">${val} / ${max}</div>
                    </div>`;
                break;
            }
            case 'toggle': {
                const isOn = Boolean(value);
                const onColor = widget.config.onColor || '#22c55e';
                const offColor = widget.config.offColor || '#64748b';
                const bg = isOn ? onColor : offColor;
                valueDisplay = `<div class="widget-value"><div style="width:40px;height:22px;border-radius:11px;background:${bg};position:relative;transition:background 0.2s;">
                    <div style="width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:2px;${isOn ? 'right:2px' : 'left:2px'};transition:all 0.2s;"></div>
                </div></div>`;
                break;
            }
            case 'led': {
                const isOn = Boolean(value);
                const onColor = widget.config.onColor || '#22c55e';
                const offColor = widget.config.offColor || '#64748b';
                const ledColor = isOn ? onColor : offColor;
                const glow = isOn ? `0 0 8px ${onColor}` : 'none';
                valueDisplay = `<div class="widget-value"><div style="width:24px;height:24px;border-radius:50%;background:${ledColor};box-shadow:${glow};"></div></div>`;
                break;
            }
            case 'gauge': {
                const minVal = widget.config.minValue ?? 0;
                const maxVal = widget.config.maxValue ?? 100;
                const val = value !== null && value !== undefined ? Number(value) : minVal;
                const pct = maxVal > minVal ? Math.min(Math.max(((val - minVal) / (maxVal - minVal)) * 100, 0), 100) : 0;
                const displayColor = this._getColorForValue(val, widget.config) || 'var(--accent)';
                const gaugePrecision = widget.config.precision;
                const gaugeDisplay = (gaugePrecision != null && gaugePrecision >= 0) ? val.toFixed(gaugePrecision) : val;
                valueDisplay = `
                    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px;">
                        <div style="font-size:${fontSize}px;font-weight:700;color:${displayColor};font-family:var(--font-mono);">${gaugeDisplay}</div>
                        <div style="width:100%;height:6px;background:var(--bg-medium);border-radius:3px;margin-top:8px;overflow:hidden;">
                            <div style="width:${pct}%;height:100%;background:${displayColor};border-radius:3px;transition:width 0.3s;"></div>
                        </div>
                        <div style="display:flex;justify-content:space-between;width:100%;font-size:10px;color:var(--text-muted);margin-top:2px;">
                            <span>${minVal}</span><span>${maxVal}</span>
                        </div>
                    </div>`;
                break;
            }
            case 'progress-bar': {
                const minVal = widget.config.minValue ?? 0;
                const maxVal = widget.config.maxValue ?? 100;
                const val = value !== null && value !== undefined ? Number(value) : minVal;
                const pct = maxVal > minVal ? Math.min(Math.max(((val - minVal) / (maxVal - minVal)) * 100, 0), 100) : 0;
                const displayColor = this._getColorForValue(val, widget.config) || 'var(--accent)';
                valueDisplay = `
                    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 4px;">
                        <div style="width:100%;height:12px;background:var(--bg-medium);border-radius:6px;overflow:hidden;">
                            <div style="width:${pct}%;height:100%;background:${displayColor};border-radius:6px;transition:width 0.3s;"></div>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;text-align:center;">${val} / ${maxVal}</div>
                    </div>`;
                break;
            }
            case 'motor-control': {
                valueDisplay = `
                    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
                        <div style="font-size:${fontSize}px;color:${fontColor};font-family:var(--font-mono);">${value !== null && value !== undefined ? value : '--'}</div>
                        <div style="display:flex;gap:6px;">
                            <span style="padding:2px 8px;background:var(--accent);border-radius:4px;font-size:11px;color:#fff;">FWD</span>
                            <span style="padding:2px 8px;background:var(--accent);border-radius:4px;font-size:11px;color:#fff;">REV</span>
                            ${widget.config.showStop !== false ? '<span style="padding:2px 8px;background:var(--danger);border-radius:4px;font-size:11px;color:#fff;">STOP</span>' : ''}
                        </div>
                    </div>`;
                break;
            }
            case 'enum-selector': {
                const labels = widget.config.enumLabels || ['Option A', 'Option B'];
                const current = value !== null && value !== undefined ? value : labels[0];
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${current}</div>`;
                break;
            }
            case 'detector-display': {
                valueDisplay = `
                    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;">
                        <div style="width:80%;height:60%;background:var(--bg-medium);border-radius:4px;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:${fontSize}px;color:${fontColor};">
                            ${value !== null && value !== undefined ? value : 'No Data'}
                        </div>
                    </div>`;
                break;
            }
            case 'plot': {
                const tw = widget.config.timeWindow || 3600;
                let twLabel;
                if (tw >= 86400) twLabel = (tw / 86400) + 'd';
                else if (tw >= 3600) twLabel = (tw / 3600) + 'h';
                else if (tw >= 60) twLabel = (tw / 60) + 'm';
                else twLabel = tw + 's';
                const maxPts = widget.config.maxPoints || 500;
                const lineColor = widget.config.lineColor || '#3b82f6';
                valueDisplay = `
                    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:4px;">
                        <svg viewBox="0 0 200 60" style="width:100%;max-height:50px;opacity:0.7;">
                            <polyline points="0,40 20,35 40,42 60,30 80,33 100,25 120,28 140,20 160,22 180,15 200,18"
                                fill="none" stroke="${lineColor}" stroke-width="2"/>
                        </svg>
                        <div style="font-size:11px;color:var(--text-muted);">${twLabel} window / ${maxPts} pts</div>
                    </div>`;
                break;
            }
            default:
                valueDisplay = `<div class="widget-value" style="font-size:${fontSize}px;color:${fontColor}">${value !== null && value !== undefined ? value : '--'}</div>`;
        }

        return `
            <div class="widget-inner">
                <span class="widget-label">${label}</span>
                ${valueDisplay}
                ${pv ? `<span class="widget-pv">${pv}</span>` : ''}
                <button class="widget-delete-btn" title="Delete">&times;</button>
            </div>
        `;
    }

    _getColorForValue(value, config) {
        if (value === null || value === undefined || !config.colorRanges || config.colorRanges.length === 0) {
            return null;
        }
        const numVal = Number(value);
        if (isNaN(numVal)) return null;

        for (const range of config.colorRanges) {
            const min = range.min !== null && range.min !== undefined ? range.min : -Infinity;
            const max = range.max !== null && range.max !== undefined ? range.max : Infinity;
            if (numVal >= min && numVal <= max) {
                return range.color;
            }
        }
        return null;
    }

    _rerenderWidget(id) {
        const widget = this.widgets[id];
        if (!widget) return;

        const el = document.querySelector(`[data-widget-id="${id}"]`);
        if (!el) return;

        const content = el.querySelector('.grid-stack-item-content');
        if (!content) return;

        const wasSelected = el.classList.contains('widget-selected');
        content.innerHTML = this._renderWidgetContent(widget);

        // Re-bind click
        content.addEventListener('click', (e) => {
            if (e.target.closest('.widget-delete-btn')) return;
            e.stopPropagation();
            this.selectWidget(id);
        });

        // Re-bind delete
        const delBtn = content.querySelector('.widget-delete-btn');
        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeWidget(id);
            });
        }

        if (wasSelected) {
            el.classList.add('widget-selected');
        }
    }

    /* ── Config Panel ─────────────────────────────────────────────── */

    _showConfig(id) {
        const widget = this.widgets[id];
        if (!widget) return;

        document.getElementById('config-empty').style.display = 'none';
        document.getElementById('config-content').style.display = '';

        const body = document.getElementById('config-body');
        body.innerHTML = '';

        const typeDef = WIDGET_TYPE_MAP[widget.type];

        // Widget type display
        body.innerHTML += `
            <div class="config-group">
                <div class="config-group-title">Widget Type</div>
                <div style="font-size:13px;color:var(--text-primary);padding:4px 0;">
                    ${typeDef ? typeDef.icon + ' ' + typeDef.name : widget.type}
                </div>
            </div>
        `;

        // Common fields
        body.innerHTML += `
            <div class="config-group">
                <div class="config-group-title">Common</div>
                <div class="config-field">
                    <label for="cfg-pv">PV Name</label>
                    <input type="text" id="cfg-pv" value="${this._esc(widget.pv || '')}" placeholder="e.g. BEAM:CURRENT">
                </div>
                <div class="config-field">
                    <label for="cfg-label">Label</label>
                    <input type="text" id="cfg-label" value="${this._esc(widget.config.label || '')}">
                </div>
                <div class="config-field">
                    <label for="cfg-fontSize">Font Size</label>
                    <input type="number" id="cfg-fontSize" value="${widget.config.fontSize || 16}" min="8" max="72">
                </div>
                <div class="config-field">
                    <label>Font Color</label>
                    <div class="config-field-row">
                        <input type="color" id="cfg-fontColor" value="${widget.config.fontColor || '#e2e8f0'}">
                        <span id="cfg-fontColor-hex" style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.fontColor || '#e2e8f0'}</span>
                    </div>
                </div>
            </div>
        `;

        // Type-specific fields
        const type = widget.type;

        if (['numeric-display', 'numeric-input'].includes(type)) {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Numeric</div>
                    <div class="config-field">
                        <label for="cfg-units">Units</label>
                        <input type="text" id="cfg-units" value="${this._esc(widget.config.units || '')}">
                    </div>
                    <div class="config-field">
                        <label for="cfg-precision">Precision</label>
                        <input type="number" id="cfg-precision" value="${widget.config.precision ?? 2}" min="0" max="10">
                    </div>
                    <div class="config-field">
                        <label for="cfg-min">Min</label>
                        <input type="number" id="cfg-min" value="${widget.config.min ?? ''}" step="any">
                    </div>
                    <div class="config-field">
                        <label for="cfg-max">Max</label>
                        <input type="number" id="cfg-max" value="${widget.config.max ?? ''}" step="any">
                    </div>
                </div>
            `;
        }

        if (type === 'slider') {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Slider</div>
                    <div class="config-field">
                        <label for="cfg-min">Min</label>
                        <input type="number" id="cfg-min" value="${widget.config.min ?? 0}" step="any">
                    </div>
                    <div class="config-field">
                        <label for="cfg-max">Max</label>
                        <input type="number" id="cfg-max" value="${widget.config.max ?? 100}" step="any">
                    </div>
                    <div class="config-field">
                        <label for="cfg-step">Step</label>
                        <input type="number" id="cfg-step" value="${widget.config.step ?? 1}" step="any" min="0.001">
                    </div>
                </div>
            `;
        }

        if (type === 'toggle') {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Toggle Colors</div>
                    <div class="config-field">
                        <label>On Color</label>
                        <div class="config-field-row">
                            <input type="color" id="cfg-onColor" value="${widget.config.onColor || '#22c55e'}">
                            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.onColor || '#22c55e'}</span>
                        </div>
                    </div>
                    <div class="config-field">
                        <label>Off Color</label>
                        <div class="config-field-row">
                            <input type="color" id="cfg-offColor" value="${widget.config.offColor || '#64748b'}">
                            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.offColor || '#64748b'}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        if (type === 'led') {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">LED Colors</div>
                    <div class="config-field">
                        <label>On Color</label>
                        <div class="config-field-row">
                            <input type="color" id="cfg-onColor" value="${widget.config.onColor || '#22c55e'}">
                            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.onColor || '#22c55e'}</span>
                        </div>
                    </div>
                    <div class="config-field">
                        <label>Off Color</label>
                        <div class="config-field-row">
                            <input type="color" id="cfg-offColor" value="${widget.config.offColor || '#64748b'}">
                            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.offColor || '#64748b'}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        if (['gauge', 'progress-bar'].includes(type)) {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Range</div>
                    <div class="config-field">
                        <label for="cfg-units">Units</label>
                        <input type="text" id="cfg-units" value="${this._esc(widget.config.units || '')}">
                    </div>
                    <div class="config-field">
                        <label for="cfg-precision">Precision</label>
                        <input type="number" id="cfg-precision" value="${widget.config.precision ?? ''}" min="0" max="10">
                    </div>
                    <div class="config-field">
                        <label for="cfg-minValue">Min Value</label>
                        <input type="number" id="cfg-minValue" value="${widget.config.minValue ?? 0}" step="any">
                    </div>
                    <div class="config-field">
                        <label for="cfg-maxValue">Max Value</label>
                        <input type="number" id="cfg-maxValue" value="${widget.config.maxValue ?? 100}" step="any">
                    </div>
                </div>
            `;
        }

        if (type === 'motor-control') {
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Motor</div>
                    <div class="config-field">
                        <div class="config-field-row">
                            <input type="checkbox" id="cfg-showStop" ${widget.config.showStop !== false ? 'checked' : ''}>
                            <label for="cfg-showStop">Show Stop Button</label>
                        </div>
                    </div>
                </div>
            `;
        }

        if (type === 'enum-selector') {
            const labels = (widget.config.enumLabels || []).join(', ');
            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Enum</div>
                    <div class="config-field">
                        <label for="cfg-enumLabels">Labels (comma-separated)</label>
                        <input type="text" id="cfg-enumLabels" value="${this._esc(labels)}">
                    </div>
                </div>
            `;
        }

        if (type === 'plot') {
            const tw = widget.config.timeWindow || 3600;
            // Convert seconds to a human-friendly display
            let twDisplay = tw;
            let twUnit = 'seconds';
            if (tw >= 86400) { twDisplay = tw / 86400; twUnit = 'days'; }
            else if (tw >= 3600) { twDisplay = tw / 3600; twUnit = 'hours'; }
            else if (tw >= 60) { twDisplay = tw / 60; twUnit = 'minutes'; }

            body.innerHTML += `
                <div class="config-group">
                    <div class="config-group-title">Plot Settings</div>
                    <div class="config-field">
                        <label for="cfg-maxPoints">Max Points</label>
                        <input type="number" id="cfg-maxPoints" value="${widget.config.maxPoints || 500}" min="10" max="10000">
                    </div>
                    <div class="config-field">
                        <label for="cfg-timeWindow">Time Window</label>
                        <div class="config-field-row">
                            <input type="number" id="cfg-timeWindowValue" value="${twDisplay}" min="1" step="any" style="width:80px;">
                            <select id="cfg-timeWindowUnit" style="background:var(--bg-darkest);border:1px solid var(--border);border-radius:5px;color:var(--text-primary);padding:5px 8px;font-size:13px;">
                                <option value="60" ${twUnit === 'minutes' ? 'selected' : ''}>min</option>
                                <option value="3600" ${twUnit === 'hours' ? 'selected' : ''}>hr</option>
                                <option value="86400" ${twUnit === 'days' ? 'selected' : ''}>day</option>
                            </select>
                        </div>
                    </div>
                    <div class="config-field">
                        <label>Line Color</label>
                        <div class="config-field-row">
                            <input type="color" id="cfg-lineColor" value="${widget.config.lineColor || '#3b82f6'}">
                            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${widget.config.lineColor || '#3b82f6'}</span>
                        </div>
                    </div>
                    <div class="config-field">
                        <div class="config-field-row">
                            <input type="checkbox" id="cfg-fillArea" ${widget.config.fillArea ? 'checked' : ''}>
                            <label for="cfg-fillArea">Fill Area</label>
                        </div>
                    </div>
                    <div class="config-field">
                        <label for="cfg-yMin">Y Min (optional)</label>
                        <input type="number" id="cfg-yMin" value="${widget.config.yMin ?? ''}" step="any">
                    </div>
                    <div class="config-field">
                        <label for="cfg-yMax">Y Max (optional)</label>
                        <input type="number" id="cfg-yMax" value="${widget.config.yMax ?? ''}" step="any">
                    </div>
                </div>
            `;
        }

        // Color Ranges section for applicable types
        if (['numeric-display', 'numeric-input', 'gauge', 'progress-bar'].includes(type)) {
            const ranges = widget.config.colorRanges || [];
            let rangesHtml = `
                <div class="config-group">
                    <div class="config-group-title">Color Ranges</div>
                    <div class="color-range-list" id="color-range-list">
            `;
            ranges.forEach((r, i) => {
                rangesHtml += this._colorRangeItemHtml(i, r);
            });
            rangesHtml += `
                    </div>
                    <button class="btn btn-sm add-color-range-btn" id="btn-add-color-range">+ Add Range</button>
                </div>
            `;
            body.innerHTML += rangesHtml;
        }

        // Bind change events
        this._bindConfigEvents(id);
    }

    _colorRangeItemHtml(index, range) {
        return `
            <div class="color-range-item" data-range-index="${index}">
                <input type="number" class="cr-min" value="${range.min ?? ''}" placeholder="Min" step="any">
                <span style="color:var(--text-muted);font-size:11px;">to</span>
                <input type="number" class="cr-max" value="${range.max ?? ''}" placeholder="Max" step="any">
                <input type="color" class="cr-color" value="${range.color || '#22c55e'}">
                <button class="color-range-remove" data-range-index="${index}">&times;</button>
            </div>
        `;
    }

    _hideConfig() {
        document.getElementById('config-empty').style.display = '';
        document.getElementById('config-content').style.display = 'none';
    }

    _bindConfigEvents(id) {
        const widget = this.widgets[id];
        if (!widget) return;

        const bindInput = (elemId, handler) => {
            const el = document.getElementById(elemId);
            if (el) el.addEventListener('input', handler);
        };

        const bindChange = (elemId, handler) => {
            const el = document.getElementById(elemId);
            if (el) el.addEventListener('change', handler);
        };

        // PV name
        bindInput('cfg-pv', (e) => {
            this.updateWidgetConfig(id, { pv: e.target.value.trim() });
        });

        // Label
        bindInput('cfg-label', (e) => {
            this.updateWidgetConfig(id, { config: { label: e.target.value } });
        });

        // Font size
        bindInput('cfg-fontSize', (e) => {
            this.updateWidgetConfig(id, { config: { fontSize: parseInt(e.target.value, 10) || 16 } });
        });

        // Font color
        bindInput('cfg-fontColor', (e) => {
            const hexSpan = document.getElementById('cfg-fontColor-hex');
            if (hexSpan) hexSpan.textContent = e.target.value;
            this.updateWidgetConfig(id, { config: { fontColor: e.target.value } });
        });

        // Numeric fields
        bindInput('cfg-units', (e) => {
            this.updateWidgetConfig(id, { config: { units: e.target.value } });
        });
        bindInput('cfg-precision', (e) => {
            this.updateWidgetConfig(id, { config: { precision: parseInt(e.target.value, 10) } });
        });
        bindInput('cfg-min', (e) => {
            this.updateWidgetConfig(id, { config: { min: e.target.value !== '' ? parseFloat(e.target.value) : null } });
        });
        bindInput('cfg-max', (e) => {
            this.updateWidgetConfig(id, { config: { max: e.target.value !== '' ? parseFloat(e.target.value) : null } });
        });
        bindInput('cfg-step', (e) => {
            this.updateWidgetConfig(id, { config: { step: parseFloat(e.target.value) || 1 } });
        });

        // Gauge / progress-bar
        bindInput('cfg-minValue', (e) => {
            this.updateWidgetConfig(id, { config: { minValue: parseFloat(e.target.value) || 0 } });
        });
        bindInput('cfg-maxValue', (e) => {
            this.updateWidgetConfig(id, { config: { maxValue: parseFloat(e.target.value) || 100 } });
        });

        // Toggle / LED colors
        bindInput('cfg-onColor', (e) => {
            this.updateWidgetConfig(id, { config: { onColor: e.target.value } });
        });
        bindInput('cfg-offColor', (e) => {
            this.updateWidgetConfig(id, { config: { offColor: e.target.value } });
        });

        // Motor
        bindChange('cfg-showStop', (e) => {
            this.updateWidgetConfig(id, { config: { showStop: e.target.checked } });
        });

        // Enum labels
        bindInput('cfg-enumLabels', (e) => {
            const labels = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            this.updateWidgetConfig(id, { config: { enumLabels: labels } });
        });

        // Plot fields
        bindInput('cfg-maxPoints', (e) => {
            this.updateWidgetConfig(id, { config: { maxPoints: parseInt(e.target.value, 10) || 500 } });
        });
        const updateTimeWindow = () => {
            const valEl = document.getElementById('cfg-timeWindowValue');
            const unitEl = document.getElementById('cfg-timeWindowUnit');
            if (valEl && unitEl) {
                const seconds = parseFloat(valEl.value) * parseInt(unitEl.value, 10);
                if (seconds > 0) {
                    this.updateWidgetConfig(id, { config: { timeWindow: seconds } });
                }
            }
        };
        bindInput('cfg-timeWindowValue', updateTimeWindow);
        bindChange('cfg-timeWindowUnit', updateTimeWindow);
        bindInput('cfg-lineColor', (e) => {
            this.updateWidgetConfig(id, { config: { lineColor: e.target.value } });
        });
        bindChange('cfg-fillArea', (e) => {
            this.updateWidgetConfig(id, { config: { fillArea: e.target.checked } });
        });
        bindInput('cfg-yMin', (e) => {
            this.updateWidgetConfig(id, { config: { yMin: e.target.value !== '' ? parseFloat(e.target.value) : null } });
        });
        bindInput('cfg-yMax', (e) => {
            this.updateWidgetConfig(id, { config: { yMax: e.target.value !== '' ? parseFloat(e.target.value) : null } });
        });

        // Color ranges
        this._bindColorRangeEvents(id);
    }

    _bindColorRangeEvents(id) {
        const widget = this.widgets[id];
        if (!widget) return;

        const addBtn = document.getElementById('btn-add-color-range');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                if (!widget.config.colorRanges) widget.config.colorRanges = [];
                widget.config.colorRanges.push({ min: null, max: null, color: '#22c55e' });
                this._rerenderWidget(id);
                this._showConfig(id); // Refresh config panel
            });
        }

        // Remove buttons
        document.querySelectorAll('#color-range-list .color-range-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-range-index'), 10);
                if (widget.config.colorRanges) {
                    widget.config.colorRanges.splice(idx, 1);
                    this._rerenderWidget(id);
                    this._showConfig(id);
                }
            });
        });

        // Value changes in existing ranges
        document.querySelectorAll('#color-range-list .color-range-item').forEach(item => {
            const idx = parseInt(item.getAttribute('data-range-index'), 10);
            const minEl = item.querySelector('.cr-min');
            const maxEl = item.querySelector('.cr-max');
            const colorEl = item.querySelector('.cr-color');

            const updateRange = () => {
                if (!widget.config.colorRanges || !widget.config.colorRanges[idx]) return;
                widget.config.colorRanges[idx] = {
                    min: minEl.value !== '' ? parseFloat(minEl.value) : null,
                    max: maxEl.value !== '' ? parseFloat(maxEl.value) : null,
                    color: colorEl.value,
                };
                this._rerenderWidget(id);
            };

            minEl.addEventListener('input', updateRange);
            maxEl.addEventListener('input', updateRange);
            colorEl.addEventListener('input', updateRange);
        });
    }

    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /* ── Serialize / Load ─────────────────────────────────────────── */

    serialize() {
        const widgets = Object.values(this.widgets).map(w => {
            // Get current grid position from Gridstack
            const el = document.querySelector(`[data-widget-id="${w.id}"]`);
            let x = w.x, y = w.y, gw = w.w, gh = w.h;
            if (el) {
                const node = el.gridstackNode;
                if (node) {
                    x = node.x ?? x;
                    y = node.y ?? y;
                    gw = node.w ?? gw;
                    gh = node.h ?? gh;
                }
            }
            return {
                id: w.id,
                type: w.type,
                x,
                y,
                w: gw,
                h: gh,
                pv: w.pv || null,
                config: { ...w.config },
            };
        });

        // Clean internal fields from config
        widgets.forEach(w => {
            delete w.config._currentValue;
        });

        return {
            widgets,
            columns: 12,
        };
    }

    loadConfig(config) {
        // Clear existing
        this.grid.removeAll(true);
        this.widgets = {};
        this.selectedWidgetId = null;
        this._hideConfig();

        if (!config || !config.widgets) return;

        config.widgets.forEach(w => {
            this.addWidget(
                w.type,
                w.x || 0,
                w.y || 0,
                w.w,
                w.h,
                w.id,
                w.config || {},
                w.pv || null,
            );
        });

        this._syncPVSubscriptions();
    }

    /* ── Save / Freeze ────────────────────────────────────────────── */

    async save() {
        const slug = document.getElementById('dashboard-slug').value.trim();
        const title = document.getElementById('dashboard-title').value.trim();
        const description = document.getElementById('dashboard-description').value.trim();
        const username = document.getElementById('dashboard-username').value.trim();

        if (!this._validateSlug(slug)) return false;

        const payload = {
            slug,
            title,
            description,
            username,
            config: this.serialize(),
        };

        try {
            const resp = await fetch(`${window.EIWYG_BASE || ''}/api/dashboards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this._toast(`Save failed: ${err.detail || resp.statusText}`, 'error');
                return false;
            }

            this.slug = slug;
            // Update URL without reload
            const newUrl = `${window.EIWYG_BASE || ''}/editor/${slug}`;
            if (window.location.pathname !== newUrl) {
                window.history.pushState({}, '', newUrl);
            }

            this._toast('Dashboard saved successfully', 'success');
            return true;
        } catch (err) {
            this._toast(`Save failed: ${err.message}`, 'error');
            return false;
        }
    }

    async freeze() {
        const saved = await this.save();
        if (saved) {
            const slug = document.getElementById('dashboard-slug').value.trim();
            window.location.href = `${window.EIWYG_BASE || ''}/view/${slug}`;
        }
    }

    _validateSlug(slug) {
        const errorEl = document.getElementById('slug-error');
        if (!slug) {
            errorEl.textContent = 'Slug is required';
            return false;
        }
        if (slug.length < 3) {
            errorEl.textContent = 'Min 3 characters';
            return false;
        }
        if (slug.length > 64) {
            errorEl.textContent = 'Max 64 characters';
            return false;
        }
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
            errorEl.textContent = 'Lowercase letters, numbers, hyphens only. Must start/end with alphanumeric.';
            return false;
        }
        errorEl.textContent = '';
        return true;
    }

    async _loadExistingDashboard(slug) {
        try {
            const resp = await fetch(`${window.EIWYG_BASE || ''}/api/dashboards/${slug}`);
            if (!resp.ok) {
                if (resp.status === 404) {
                    this._toast('Dashboard not found', 'error');
                }
                return;
            }
            const data = await resp.json();
            document.getElementById('dashboard-title').value = data.title || '';
            document.getElementById('dashboard-description').value = data.description || '';
            document.getElementById('dashboard-username').value = data.username || '';
            document.getElementById('dashboard-slug').value = data.slug || slug;

            if (data.config) {
                this.loadConfig(data.config);
            }
        } catch (err) {
            this._toast(`Failed to load dashboard: ${err.message}`, 'error');
        }
    }

    /* ── Top Bar Bindings ─────────────────────────────────────────── */

    _bindTopBar() {
        document.getElementById('btn-save').addEventListener('click', () => this.save());
        document.getElementById('btn-freeze').addEventListener('click', () => this.freeze());

        // Slug validation on input
        const slugInput = document.getElementById('dashboard-slug');
        slugInput.addEventListener('input', (e) => {
            // Auto-format: lowercase, replace spaces with hyphens
            let val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/--+/g, '-');
            e.target.value = val;
            if (val.length >= 3) {
                this._validateSlug(val);
            } else {
                document.getElementById('slug-error').textContent = '';
            }
        });
    }

    /* ── Chatbot ──────────────────────────────────────────────────── */

    _bindChatbot() {
        const panel = document.getElementById('chatbot-panel');
        const header = document.getElementById('chatbot-header');
        const input = document.getElementById('chatbot-input');
        const sendBtn = document.getElementById('chatbot-send');

        // Toggle collapse
        header.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
        });

        // Send message
        const send = async () => {
            const msg = input.value.trim();
            if (!msg) return;
            input.value = '';

            this._addChatMessage('user', msg);

            try {
                sendBtn.disabled = true;
                sendBtn.innerHTML = '<span class="loading-spinner"></span>';

                const resp = await fetch(`${window.EIWYG_BASE || ''}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: msg,
                        current_config: this.serialize(),
                    }),
                });

                if (!resp.ok) {
                    this._addChatMessage('assistant', 'Sorry, an error occurred. Please try again.');
                    return;
                }

                const data = await resp.json();
                this._addChatMessage('assistant', data.reply, data.suggested_config || null);
            } catch (err) {
                this._addChatMessage('assistant', `Error: ${err.message}`);
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
            }
        };

        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    _addChatMessage(role, text, suggestedConfig = null) {
        const container = document.getElementById('chatbot-messages');
        const msgEl = document.createElement('div');
        msgEl.className = `chat-message ${role}`;
        msgEl.textContent = text;

        if (suggestedConfig) {
            const applyBtn = document.createElement('button');
            applyBtn.className = 'btn btn-sm btn-success chat-apply-btn';
            applyBtn.textContent = 'Apply Suggested Config';
            applyBtn.addEventListener('click', () => {
                this.loadConfig(suggestedConfig);
                this._toast('AI config applied', 'info');
                applyBtn.disabled = true;
                applyBtn.textContent = 'Applied';
            });
            msgEl.appendChild(applyBtn);
        }

        container.appendChild(msgEl);
        container.scrollTop = container.scrollHeight;
    }

    /* ── Global Events ────────────────────────────────────────────── */

    _bindGlobalEvents() {
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Delete selected widget
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedWidgetId) {
                // Only if not focused on an input
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
                    return;
                }
                this.removeWidget(this.selectedWidgetId);
            }

            // Ctrl+S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.save();
            }
        });
    }

    /* ── Toast Notifications ──────────────────────────────────────── */

    _toast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}


/* ── Initialize ───────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    window.editorApp = new EditorApp();
});
