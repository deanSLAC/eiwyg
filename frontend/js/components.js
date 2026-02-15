/**
 * EIWYG Component Registry and Renderer Library
 *
 * Defines how each widget type is rendered and updated with live PV data.
 * All components are designed for synchrotron beamline control systems.
 */

(function () {
    'use strict';

    window.EIWYG_COMPONENTS = {};

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Evaluate colorRanges and return the matching color, or null.
     * Each range: {min: number|null, max: number|null, color: string}
     */
    function getColorForValue(value, colorRanges) {
        if (!colorRanges || !Array.isArray(colorRanges) || colorRanges.length === 0) {
            return null;
        }
        var v = parseFloat(value);
        if (isNaN(v)) return null;
        for (var i = 0; i < colorRanges.length; i++) {
            var r = colorRanges[i];
            var aboveMin = (r.min == null || v >= r.min);
            var belowMax = (r.max == null || v < r.max);
            if (aboveMin && belowMax) {
                return r.color;
            }
        }
        return null;
    }

    /**
     * Format a numeric value with the given precision.
     */
    function formatValue(value, precision) {
        var v = parseFloat(value);
        if (isNaN(v)) return '---';
        if (precision != null && precision >= 0) {
            return v.toFixed(precision);
        }
        return String(v);
    }

    /**
     * Format a number with thousands separators.
     */
    function formatWithCommas(value) {
        var v = parseFloat(value);
        if (isNaN(v)) return '---';
        return v.toLocaleString();
    }

    /**
     * Clamp a value between min and max.
     */
    function clamp(value, min, max) {
        if (min != null && value < min) return min;
        if (max != null && value > max) return max;
        return value;
    }

    /**
     * Dispatch a pv-put custom event.
     */
    function dispatchPvPut(container, pv, value) {
        container.dispatchEvent(new CustomEvent('pv-put', {
            detail: { pv: pv, value: value },
            bubbles: true
        }));
    }

    /**
     * Get a config value with a fallback default.
     */
    function cfg(widget, key, fallback) {
        if (widget.config && widget.config[key] != null) {
            return widget.config[key];
        }
        return fallback;
    }

    /**
     * Apply severity styling. EPICS severity: 0=NO_ALARM, 1=MINOR, 2=MAJOR, 3=INVALID
     */
    function severityClass(severity) {
        switch (severity) {
            case 1: return 'eiwyg-severity-minor';
            case 2: return 'eiwyg-severity-major';
            case 3: return 'eiwyg-severity-invalid';
            default: return '';
        }
    }

    /**
     * Register a component type.
     */
    function registerComponent(type, definition) {
        window.EIWYG_COMPONENTS[type] = definition;
    }

    // -------------------------------------------------------------------------
    // 1. label - Static text, no PV
    // -------------------------------------------------------------------------
    registerComponent('label', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-label');
            var label = cfg(widget, 'label', 'Label');
            var fontSize = cfg(widget, 'fontSize', 16);
            var fontColor = cfg(widget, 'fontColor', '#e2e8f0');
            var bgColor = cfg(widget, 'backgroundColor', null);

            var el = document.createElement('div');
            el.className = 'eiwyg-label-text';
            el.textContent = label;
            el.style.fontSize = fontSize + 'px';
            el.style.color = fontColor;
            if (bgColor) {
                el.style.backgroundColor = bgColor;
            }
            container.appendChild(el);
        },

        update: function () {
            // Static widget - no updates needed
        },

        getSubscribePVs: function () {
            return [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'fontColor', type: 'color', label: 'Font Color' },
            { key: 'backgroundColor', type: 'color', label: 'Background Color' }
        ],

        defaultSize: { w: 3, h: 1 }
    });

    // -------------------------------------------------------------------------
    // 2. text-display - Read-only PV text
    // -------------------------------------------------------------------------
    registerComponent('text-display', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-text-display');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var fontColor = cfg(widget, 'fontColor', '#e2e8f0');

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label" style="color:' + fontColor + '">' + label + '</div>';
            }
            html += '<div class="eiwyg-value" data-role="value" style="font-size:' + (fontSize * 1.5) + 'px">---</div>';
            var units = cfg(widget, 'units', '');
            if (units) {
                html += '<div class="eiwyg-units">' + units + '</div>';
            }
            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var valueEl = container.querySelector('[data-role="value"]');
            if (!valueEl) return;

            var val = pvData.value;
            valueEl.textContent = (val != null) ? String(val) : '---';

            // Apply color ranges
            var rangeColor = getColorForValue(val, cfg(widget, 'colorRanges', null));
            if (rangeColor) {
                valueEl.style.color = rangeColor;
            } else {
                valueEl.style.color = '';
            }

            // Severity
            container.className = container.className.replace(/eiwyg-severity-\w+/g, '');
            var sc = severityClass(pvData.severity);
            if (sc) container.classList.add(sc);
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'fontColor', type: 'color', label: 'Font Color' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'colorRanges', type: 'colorRanges', label: 'Color Ranges' }
        ],

        defaultSize: { w: 3, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 3. numeric-display - Read-only numeric PV
    // -------------------------------------------------------------------------
    registerComponent('numeric-display', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-numeric-display');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var fontColor = cfg(widget, 'fontColor', '#e2e8f0');

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label" style="color:' + fontColor + '">' + label + '</div>';
            }
            html += '<div class="eiwyg-numeric-row">';
            html += '<span class="eiwyg-value eiwyg-numeric-value" data-role="value" style="font-size:' + (fontSize * 1.5) + 'px">---</span>';
            var units = cfg(widget, 'units', '');
            if (units) {
                html += '<span class="eiwyg-units">' + units + '</span>';
            }
            html += '</div>';
            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var valueEl = container.querySelector('[data-role="value"]');
            if (!valueEl) return;

            var precision = cfg(widget, 'precision', null);
            valueEl.textContent = formatValue(pvData.value, precision);

            var rangeColor = getColorForValue(pvData.value, cfg(widget, 'colorRanges', null));
            if (rangeColor) {
                valueEl.style.color = rangeColor;
            } else {
                valueEl.style.color = '';
            }

            container.className = container.className.replace(/eiwyg-severity-\w+/g, '');
            var sc = severityClass(pvData.severity);
            if (sc) container.classList.add(sc);
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'fontColor', type: 'color', label: 'Font Color' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'precision', type: 'number', label: 'Precision' },
            { key: 'colorRanges', type: 'colorRanges', label: 'Color Ranges' }
        ],

        defaultSize: { w: 3, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 4. numeric-input - Writable numeric with +/- buttons
    // -------------------------------------------------------------------------
    registerComponent('numeric-input', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-numeric-input');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var units = cfg(widget, 'units', '');
            var step = cfg(widget, 'step', 1);
            var min = cfg(widget, 'min', null);
            var max = cfg(widget, 'max', null);
            var precision = cfg(widget, 'precision', null);

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }
            html += '<div class="eiwyg-numeric-input-row">';
            html += '<button class="eiwyg-btn eiwyg-btn-minus" data-role="minus">&#x2212;</button>';
            html += '<input type="text" class="eiwyg-input eiwyg-numeric-input-field" data-role="input" value="---" style="font-size:' + fontSize + 'px"';
            if (min != null) html += ' data-min="' + min + '"';
            if (max != null) html += ' data-max="' + max + '"';
            html += '>';
            html += '<button class="eiwyg-btn eiwyg-btn-plus" data-role="plus">+</button>';
            if (units) {
                html += '<span class="eiwyg-units">' + units + '</span>';
            }
            html += '</div>';
            container.innerHTML = html;

            // Store current value on the container
            container._currentValue = 0;

            var inputEl = container.querySelector('[data-role="input"]');
            var minusBtn = container.querySelector('[data-role="minus"]');
            var plusBtn = container.querySelector('[data-role="plus"]');

            minusBtn.addEventListener('click', function () {
                var newVal = clamp(container._currentValue - step, min, max);
                container._currentValue = newVal;
                inputEl.value = formatValue(newVal, precision);
                dispatchPvPut(container, widget.pv, newVal);
            });

            plusBtn.addEventListener('click', function () {
                var newVal = clamp(container._currentValue + step, min, max);
                container._currentValue = newVal;
                inputEl.value = formatValue(newVal, precision);
                dispatchPvPut(container, widget.pv, newVal);
            });

            inputEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    var v = parseFloat(inputEl.value);
                    if (!isNaN(v)) {
                        v = clamp(v, min, max);
                        container._currentValue = v;
                        inputEl.value = formatValue(v, precision);
                        dispatchPvPut(container, widget.pv, v);
                    }
                }
            });

            inputEl.addEventListener('blur', function () {
                var v = parseFloat(inputEl.value);
                if (!isNaN(v)) {
                    v = clamp(v, min, max);
                    container._currentValue = v;
                    inputEl.value = formatValue(v, precision);
                    dispatchPvPut(container, widget.pv, v);
                }
            });
        },

        update: function (container, widget, pvName, pvData) {
            var inputEl = container.querySelector('[data-role="input"]');
            if (!inputEl) return;
            // Only update if the field is not focused (avoid overwriting user typing)
            if (document.activeElement !== inputEl) {
                var precision = cfg(widget, 'precision', null);
                container._currentValue = parseFloat(pvData.value) || 0;
                inputEl.value = formatValue(pvData.value, precision);
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'step', type: 'number', label: 'Step' },
            { key: 'min', type: 'number', label: 'Min' },
            { key: 'max', type: 'number', label: 'Max' },
            { key: 'precision', type: 'number', label: 'Precision' }
        ],

        defaultSize: { w: 4, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 5. text-input - Writable text PV
    // -------------------------------------------------------------------------
    registerComponent('text-input', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-text-input');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }
            html += '<div class="eiwyg-text-input-row">';
            html += '<input type="text" class="eiwyg-input eiwyg-text-input-field" data-role="input" placeholder="Enter value..." style="font-size:' + fontSize + 'px">';
            html += '<button class="eiwyg-btn eiwyg-btn-set" data-role="set">Set</button>';
            html += '</div>';
            container.innerHTML = html;

            var inputEl = container.querySelector('[data-role="input"]');
            var setBtn = container.querySelector('[data-role="set"]');

            function submit() {
                var val = inputEl.value;
                dispatchPvPut(container, widget.pv, val);
            }

            setBtn.addEventListener('click', submit);
            inputEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') submit();
            });
        },

        update: function (container, widget, pvName, pvData) {
            var inputEl = container.querySelector('[data-role="input"]');
            if (!inputEl) return;
            if (document.activeElement !== inputEl) {
                inputEl.value = (pvData.value != null) ? String(pvData.value) : '';
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' }
        ],

        defaultSize: { w: 4, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 6. slider - Writable range slider
    // -------------------------------------------------------------------------
    registerComponent('slider', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-slider');

            var label = cfg(widget, 'label', '');
            var min = cfg(widget, 'min', 0);
            var max = cfg(widget, 'max', 100);
            var step = cfg(widget, 'step', 1);
            var units = cfg(widget, 'units', '');

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }
            html += '<div class="eiwyg-slider-row">';
            html += '<input type="range" class="eiwyg-slider-input" data-role="slider" min="' + min + '" max="' + max + '" step="' + step + '" value="' + min + '">';
            html += '<span class="eiwyg-value eiwyg-slider-value" data-role="value">' + min + '</span>';
            if (units) {
                html += '<span class="eiwyg-units">' + units + '</span>';
            }
            html += '</div>';
            container.innerHTML = html;

            var sliderEl = container.querySelector('[data-role="slider"]');
            var valueEl = container.querySelector('[data-role="value"]');

            sliderEl.addEventListener('input', function () {
                var v = parseFloat(sliderEl.value);
                valueEl.textContent = String(v);
                dispatchPvPut(container, widget.pv, v);
            });
        },

        update: function (container, widget, pvName, pvData) {
            var sliderEl = container.querySelector('[data-role="slider"]');
            var valueEl = container.querySelector('[data-role="value"]');
            if (!sliderEl || !valueEl) return;

            var v = parseFloat(pvData.value);
            if (!isNaN(v)) {
                sliderEl.value = v;
                valueEl.textContent = String(v);
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'min', type: 'number', label: 'Min' },
            { key: 'max', type: 'number', label: 'Max' },
            { key: 'step', type: 'number', label: 'Step' },
            { key: 'units', type: 'text', label: 'Units' }
        ],

        defaultSize: { w: 4, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 7. toggle - On/off switch
    // -------------------------------------------------------------------------
    registerComponent('toggle', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-toggle');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var onColor = cfg(widget, 'onColor', '#22c55e');
            var offColor = cfg(widget, 'offColor', '#64748b');

            var html = '<div class="eiwyg-toggle-row">';
            if (label) {
                html += '<span class="eiwyg-widget-label eiwyg-toggle-label" style="font-size:' + fontSize + 'px">' + label + '</span>';
            }
            html += '<div class="eiwyg-toggle-switch" data-role="switch" data-on-color="' + onColor + '" data-off-color="' + offColor + '">';
            html += '<div class="eiwyg-toggle-track" style="background-color:' + offColor + '">';
            html += '<div class="eiwyg-toggle-thumb"></div>';
            html += '</div>';
            html += '</div>';
            html += '</div>';
            container.innerHTML = html;

            container._toggleState = false;

            var switchEl = container.querySelector('[data-role="switch"]');
            switchEl.addEventListener('click', function () {
                var newVal = container._toggleState ? 0 : 1;
                dispatchPvPut(container, widget.pv, newVal);
            });
        },

        update: function (container, widget, pvName, pvData) {
            var track = container.querySelector('.eiwyg-toggle-track');
            var thumb = container.querySelector('.eiwyg-toggle-thumb');
            if (!track || !thumb) return;

            var isOn = pvData.value != null && pvData.value !== 0 && pvData.value !== '0' && pvData.value !== false;
            container._toggleState = isOn;

            var onColor = cfg(widget, 'onColor', '#22c55e');
            var offColor = cfg(widget, 'offColor', '#64748b');

            if (isOn) {
                track.style.backgroundColor = onColor;
                track.classList.add('eiwyg-toggle-on');
            } else {
                track.style.backgroundColor = offColor;
                track.classList.remove('eiwyg-toggle-on');
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'onColor', type: 'color', label: 'On Color' },
            { key: 'offColor', type: 'color', label: 'Off Color' }
        ],

        defaultSize: { w: 3, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 8. led - Status indicator
    // -------------------------------------------------------------------------
    registerComponent('led', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-led');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var offColor = cfg(widget, 'offColor', '#64748b');

            var html = '<div class="eiwyg-led-row">';
            html += '<div class="eiwyg-led-indicator" data-role="led" style="background-color:' + offColor + '"></div>';
            if (label) {
                html += '<span class="eiwyg-led-label" style="font-size:' + fontSize + 'px">' + label + '</span>';
            }
            html += '</div>';
            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var ledEl = container.querySelector('[data-role="led"]');
            if (!ledEl) return;

            var isOn = pvData.value != null && pvData.value !== 0 && pvData.value !== '0' && pvData.value !== false;
            var onColor = cfg(widget, 'onColor', '#22c55e');
            var offColor = cfg(widget, 'offColor', '#64748b');

            if (isOn) {
                ledEl.style.backgroundColor = onColor;
                ledEl.style.boxShadow = '0 0 8px 3px ' + onColor + '80';
                ledEl.classList.add('eiwyg-led-on');
            } else {
                ledEl.style.backgroundColor = offColor;
                ledEl.style.boxShadow = 'none';
                ledEl.classList.remove('eiwyg-led-on');
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'onColor', type: 'color', label: 'On Color' },
            { key: 'offColor', type: 'color', label: 'Off Color' }
        ],

        defaultSize: { w: 2, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 9. gauge - Semicircular gauge
    // -------------------------------------------------------------------------
    registerComponent('gauge', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-gauge');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var units = cfg(widget, 'units', '');
            var minVal = cfg(widget, 'minValue', 0);
            var maxVal = cfg(widget, 'maxValue', 100);

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }

            // SVG gauge - semicircle
            html += '<div class="eiwyg-gauge-container">';
            html += '<svg viewBox="0 0 200 120" class="eiwyg-gauge-svg">';
            // Background arc
            html += '<path data-role="gauge-bg" d="' + describeArc(100, 100, 80, 180, 360) + '" fill="none" stroke="#334155" stroke-width="14" stroke-linecap="round"/>';
            // Foreground arc (value)
            html += '<path data-role="gauge-fg" d="' + describeArc(100, 100, 80, 180, 180) + '" fill="none" stroke="#3b82f6" stroke-width="14" stroke-linecap="round"/>';
            // Value text
            html += '<text data-role="gauge-value" x="100" y="95" text-anchor="middle" class="eiwyg-gauge-value-text" font-size="24">---</text>';
            // Units text
            if (units) {
                html += '<text x="100" y="115" text-anchor="middle" class="eiwyg-gauge-units-text" font-size="12">' + units + '</text>';
            }
            // Min label
            html += '<text x="15" y="115" text-anchor="middle" class="eiwyg-gauge-minmax-text" font-size="10">' + minVal + '</text>';
            // Max label
            html += '<text x="185" y="115" text-anchor="middle" class="eiwyg-gauge-minmax-text" font-size="10">' + maxVal + '</text>';
            html += '</svg>';
            html += '</div>';
            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var fg = container.querySelector('[data-role="gauge-fg"]');
            var valueText = container.querySelector('[data-role="gauge-value"]');
            if (!fg || !valueText) return;

            var minVal = cfg(widget, 'minValue', 0);
            var maxVal = cfg(widget, 'maxValue', 100);
            var precision = cfg(widget, 'precision', null);
            var v = parseFloat(pvData.value);

            if (isNaN(v)) {
                valueText.textContent = '---';
                return;
            }

            valueText.textContent = formatValue(v, precision);

            // Calculate percentage
            var range = maxVal - minVal;
            var pct = range > 0 ? (v - minVal) / range : 0;
            pct = Math.max(0, Math.min(1, pct));

            // Angle: 180 (left) to 360 (right)
            var endAngle = 180 + (pct * 180);
            if (endAngle <= 180) endAngle = 180.1; // Avoid zero-length arc
            fg.setAttribute('d', describeArc(100, 100, 80, 180, endAngle));

            // Apply color ranges
            var rangeColor = getColorForValue(v, cfg(widget, 'colorRanges', null));
            fg.setAttribute('stroke', rangeColor || '#3b82f6');
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'minValue', type: 'number', label: 'Min Value' },
            { key: 'maxValue', type: 'number', label: 'Max Value' },
            { key: 'precision', type: 'number', label: 'Precision' },
            { key: 'colorRanges', type: 'colorRanges', label: 'Color Ranges' }
        ],

        defaultSize: { w: 3, h: 3 }
    });

    /**
     * SVG arc path helper.
     * Draws an arc centered at (cx, cy) with radius r from startAngle to endAngle (degrees).
     * 0 degrees = 3 o'clock, 90 = 6 o'clock, 180 = 9 o'clock, 270 = 12 o'clock.
     */
    function polarToCartesian(cx, cy, r, angleDeg) {
        var rad = (angleDeg * Math.PI) / 180.0;
        return {
            x: cx + r * Math.cos(rad),
            y: cy + r * Math.sin(rad)
        };
    }

    function describeArc(cx, cy, r, startAngle, endAngle) {
        var start = polarToCartesian(cx, cy, r, endAngle);
        var end = polarToCartesian(cx, cy, r, startAngle);
        var largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
        return [
            'M', start.x, start.y,
            'A', r, r, 0, largeArc, 0, end.x, end.y
        ].join(' ');
    }

    // -------------------------------------------------------------------------
    // 10. progress-bar - Horizontal bar
    // -------------------------------------------------------------------------
    registerComponent('progress-bar', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-progress-bar');

            var label = cfg(widget, 'label', '');
            var units = cfg(widget, 'units', '');

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }
            html += '<div class="eiwyg-progress-track">';
            html += '<div class="eiwyg-progress-fill" data-role="fill" style="width:0%"></div>';
            html += '</div>';
            html += '<div class="eiwyg-progress-info">';
            html += '<span class="eiwyg-value" data-role="value">---</span>';
            if (units) {
                html += '<span class="eiwyg-units">' + units + '</span>';
            }
            html += '</div>';
            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var fillEl = container.querySelector('[data-role="fill"]');
            var valueEl = container.querySelector('[data-role="value"]');
            if (!fillEl || !valueEl) return;

            var minVal = cfg(widget, 'minValue', 0);
            var maxVal = cfg(widget, 'maxValue', 100);
            var precision = cfg(widget, 'precision', null);
            var v = parseFloat(pvData.value);

            if (isNaN(v)) {
                valueEl.textContent = '---';
                fillEl.style.width = '0%';
                return;
            }

            valueEl.textContent = formatValue(v, precision);

            var range = maxVal - minVal;
            var pct = range > 0 ? ((v - minVal) / range) * 100 : 0;
            pct = Math.max(0, Math.min(100, pct));
            fillEl.style.width = pct + '%';

            // Apply color ranges
            var rangeColor = getColorForValue(v, cfg(widget, 'colorRanges', null));
            fillEl.style.backgroundColor = rangeColor || '#3b82f6';
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'minValue', type: 'number', label: 'Min Value' },
            { key: 'maxValue', type: 'number', label: 'Max Value' },
            { key: 'precision', type: 'number', label: 'Precision' },
            { key: 'colorRanges', type: 'colorRanges', label: 'Color Ranges' }
        ],

        defaultSize: { w: 4, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 11. motor-control - Specialized motor widget
    // -------------------------------------------------------------------------
    registerComponent('motor-control', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-motor-control');

            var label = cfg(widget, 'label', widget.pv || 'Motor');
            var units = cfg(widget, 'units', 'mm');
            var precision = cfg(widget, 'precision', 3);
            var showStop = cfg(widget, 'showStop', true);

            var html = '<div class="eiwyg-motor-header">' + label + '</div>';

            // Readback
            html += '<div class="eiwyg-motor-row">';
            html += '<span class="eiwyg-motor-label">Readback:</span>';
            html += '<span class="eiwyg-value eiwyg-motor-readback" data-role="readback">---</span>';
            html += '<span class="eiwyg-units">' + units + '</span>';
            html += '</div>';

            // Setpoint
            html += '<div class="eiwyg-motor-row">';
            html += '<span class="eiwyg-motor-label">Setpoint:</span>';
            html += '<input type="text" class="eiwyg-input eiwyg-motor-setpoint-input" data-role="setpoint-input" value="---">';
            html += '<button class="eiwyg-btn eiwyg-btn-go" data-role="go">Go</button>';
            html += '</div>';

            // Jog + Stop
            html += '<div class="eiwyg-motor-row eiwyg-motor-jog-row">';
            html += '<button class="eiwyg-btn eiwyg-btn-jog" data-role="jog-neg">&#9664; Jog</button>';
            if (showStop) {
                html += '<button class="eiwyg-btn eiwyg-btn-stop" data-role="stop">STOP</button>';
            }
            html += '<button class="eiwyg-btn eiwyg-btn-jog" data-role="jog-pos">Jog &#9654;</button>';
            html += '</div>';

            // Status
            html += '<div class="eiwyg-motor-row eiwyg-motor-status-row">';
            html += '<span class="eiwyg-motor-label">Status:</span>';
            html += '<span class="eiwyg-motor-status-dot" data-role="status-dot">&#x25CF;</span>';
            html += '<span class="eiwyg-motor-status-text" data-role="status-text">Idle</span>';
            html += '</div>';

            container.innerHTML = html;

            // Internal state
            container._motorState = {
                rbv: 0,
                val: 0,
                movn: 0
            };

            var setpointInput = container.querySelector('[data-role="setpoint-input"]');
            var goBtn = container.querySelector('[data-role="go"]');
            var jogNeg = container.querySelector('[data-role="jog-neg"]');
            var jogPos = container.querySelector('[data-role="jog-pos"]');
            var stopBtn = container.querySelector('[data-role="stop"]');
            var step = cfg(widget, 'step', 1);
            var basePv = widget.pv || '';

            // Go button
            goBtn.addEventListener('click', function () {
                var v = parseFloat(setpointInput.value);
                if (!isNaN(v)) {
                    dispatchPvPut(container, basePv + ':VAL', v);
                }
            });

            setpointInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    var v = parseFloat(setpointInput.value);
                    if (!isNaN(v)) {
                        dispatchPvPut(container, basePv + ':VAL', v);
                    }
                }
            });

            // Jog buttons
            jogNeg.addEventListener('click', function () {
                var newVal = container._motorState.val - step;
                dispatchPvPut(container, basePv + ':VAL', newVal);
            });

            jogPos.addEventListener('click', function () {
                var newVal = container._motorState.val + step;
                dispatchPvPut(container, basePv + ':VAL', newVal);
            });

            // Stop button
            if (stopBtn) {
                stopBtn.addEventListener('click', function () {
                    dispatchPvPut(container, basePv + ':VAL', container._motorState.rbv);
                });
            }
        },

        update: function (container, widget, pvName, pvData) {
            var basePv = widget.pv || '';
            var precision = cfg(widget, 'precision', 3);
            var state = container._motorState;
            if (!state) return;

            var suffix = pvName.substring(basePv.length);

            if (suffix === ':RBV') {
                state.rbv = parseFloat(pvData.value) || 0;
                var rbvEl = container.querySelector('[data-role="readback"]');
                if (rbvEl) rbvEl.textContent = formatValue(state.rbv, precision);
            } else if (suffix === ':VAL') {
                state.val = parseFloat(pvData.value) || 0;
                var spInput = container.querySelector('[data-role="setpoint-input"]');
                if (spInput && document.activeElement !== spInput) {
                    spInput.value = formatValue(state.val, precision);
                }
            } else if (suffix === ':MOVN') {
                state.movn = pvData.value;
                var isMoving = pvData.value != null && pvData.value !== 0 && pvData.value !== '0';
                var dotEl = container.querySelector('[data-role="status-dot"]');
                var textEl = container.querySelector('[data-role="status-text"]');
                if (dotEl) {
                    dotEl.style.color = isMoving ? '#22c55e' : '#64748b';
                }
                if (textEl) {
                    textEl.textContent = isMoving ? 'Moving' : 'Idle';
                    textEl.style.color = isMoving ? '#22c55e' : '#94a3b8';
                }
            }
        },

        getSubscribePVs: function (widget) {
            if (!widget.pv) return [];
            return [
                widget.pv + ':RBV',
                widget.pv + ':VAL',
                widget.pv + ':MOVN'
            ];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'units', type: 'text', label: 'Units' },
            { key: 'step', type: 'number', label: 'Jog Step' },
            { key: 'precision', type: 'number', label: 'Precision' },
            { key: 'showStop', type: 'checkbox', label: 'Show STOP Button' }
        ],

        defaultSize: { w: 4, h: 4 }
    });

    // -------------------------------------------------------------------------
    // 12. enum-selector - Dropdown for enum PVs
    // -------------------------------------------------------------------------
    registerComponent('enum-selector', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-enum-selector');

            var label = cfg(widget, 'label', '');
            var fontSize = cfg(widget, 'fontSize', 16);
            var enumLabels = cfg(widget, 'enumLabels', []);

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label">' + label + '</div>';
            }
            html += '<select class="eiwyg-select" data-role="select" style="font-size:' + fontSize + 'px">';
            for (var i = 0; i < enumLabels.length; i++) {
                html += '<option value="' + i + '">' + enumLabels[i] + '</option>';
            }
            if (enumLabels.length === 0) {
                html += '<option value="">No options</option>';
            }
            html += '</select>';
            container.innerHTML = html;

            var selectEl = container.querySelector('[data-role="select"]');
            selectEl.addEventListener('change', function () {
                var idx = parseInt(selectEl.value, 10);
                dispatchPvPut(container, widget.pv, idx);
            });
        },

        update: function (container, widget, pvName, pvData) {
            var selectEl = container.querySelector('[data-role="select"]');
            if (!selectEl) return;

            var v = parseInt(pvData.value, 10);
            if (!isNaN(v)) {
                selectEl.value = v;
            }
        },

        getSubscribePVs: function (widget) {
            return widget.pv ? [widget.pv] : [];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'enumLabels', type: 'stringArray', label: 'Options' }
        ],

        defaultSize: { w: 3, h: 2 }
    });

    // -------------------------------------------------------------------------
    // 13. detector-display - Specialized detector widget
    // -------------------------------------------------------------------------
    registerComponent('detector-display', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-detector-display');

            var label = cfg(widget, 'label', widget.pv || 'Detector');

            var html = '<div class="eiwyg-detector-header">' + label + '</div>';

            // Counts
            html += '<div class="eiwyg-detector-row">';
            html += '<span class="eiwyg-detector-label">Counts:</span>';
            html += '<span class="eiwyg-value eiwyg-detector-counts" data-role="counts">---</span>';
            html += '</div>';

            // Rate
            html += '<div class="eiwyg-detector-row">';
            html += '<span class="eiwyg-detector-label">Rate:</span>';
            html += '<span class="eiwyg-value eiwyg-detector-rate" data-role="rate">---</span>';
            html += '<span class="eiwyg-units">Hz</span>';
            html += '</div>';

            container.innerHTML = html;
        },

        update: function (container, widget, pvName, pvData) {
            var basePv = widget.pv || '';
            var suffix = pvName.substring(basePv.length);

            if (suffix === ':COUNTS') {
                var countsEl = container.querySelector('[data-role="counts"]');
                if (countsEl) {
                    countsEl.textContent = formatWithCommas(pvData.value);
                }
            } else if (suffix === ':RATE') {
                var rateEl = container.querySelector('[data-role="rate"]');
                if (rateEl) {
                    rateEl.textContent = formatWithCommas(pvData.value);
                }
            }
        },

        getSubscribePVs: function (widget) {
            if (!widget.pv) return [];
            return [
                widget.pv + ':COUNTS',
                widget.pv + ':RATE'
            ];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'fontSize', type: 'number', label: 'Font Size' },
            { key: 'precision', type: 'number', label: 'Precision' }
        ],

        defaultSize: { w: 4, h: 3 }
    });

    // -------------------------------------------------------------------------
    // 14. plot - Time-series line chart
    // -------------------------------------------------------------------------
    registerComponent('plot', {
        render: function (container, widget) {
            container.classList.add('eiwyg-widget', 'eiwyg-plot');

            var label = cfg(widget, 'label', 'Plot');
            var fontColor = cfg(widget, 'fontColor', '#e2e8f0');

            var html = '';
            if (label) {
                html += '<div class="eiwyg-widget-label" style="color:' + fontColor + '">' + label + '</div>';
            }
            html += '<div class="eiwyg-plot-wrap" data-role="plot-wrap" style="flex:1;min-height:0;position:relative;">';
            html += '<canvas data-role="plot-canvas"></canvas>';
            html += '</div>';
            container.innerHTML = html;

            // Store per-widget state on the container
            container._plotState = {
                chart: null,
                data: [],          // [{t: timestamp_ms, v: value}, ...]
                historyLoaded: false,
                maxPoints: cfg(widget, 'maxPoints', 500),
                timeWindow: cfg(widget, 'timeWindow', 3600) * 1000, // store in ms
                lineColor: cfg(widget, 'lineColor', '#3b82f6'),
                fillArea: cfg(widget, 'fillArea', false),
                yMin: cfg(widget, 'yMin', null),
                yMax: cfg(widget, 'yMax', null),
                units: cfg(widget, 'units', ''),
                pv: widget.pv || null
            };

            // Fetch history after a short delay to ensure canvas is in DOM
            if (widget.pv && typeof Chart !== 'undefined') {
                setTimeout(function () {
                    _plotFetchHistory(container, widget);
                }, 100);
            }
        },

        update: function (container, widget, pvName, pvData) {
            var state = container._plotState;
            if (!state) return;

            // Refresh config in case it changed
            state.maxPoints = cfg(widget, 'maxPoints', 500);
            state.timeWindow = cfg(widget, 'timeWindow', 3600) * 1000;
            state.lineColor = cfg(widget, 'lineColor', '#3b82f6');
            state.fillArea = cfg(widget, 'fillArea', false);
            state.yMin = cfg(widget, 'yMin', null);
            state.yMax = cfg(widget, 'yMax', null);
            state.units = cfg(widget, 'units', '');

            // If PV changed, reload history
            if (widget.pv && widget.pv !== state.pv) {
                state.pv = widget.pv;
                state.data = [];
                state.historyLoaded = false;
                _plotFetchHistory(container, widget);
                return;
            }

            // Append the new data point
            var ts = (pvData.timestamp || Date.now() / 1000) * 1000; // convert to ms
            var val = parseFloat(pvData.value);
            if (isNaN(val)) return;

            state.data.push({ t: ts, v: val });

            // Enforce max points
            if (state.data.length > state.maxPoints * 1.5) {
                _plotCompact(state);
            }

            // Prune old data outside time window
            var cutoff = Date.now() - state.timeWindow;
            while (state.data.length > 0 && state.data[0].t < cutoff) {
                state.data.shift();
            }

            _plotUpdateChart(container, state);
        },

        getSubscribePVs: function (widget) {
            if (!widget.pv) return [];
            return [widget.pv];
        },

        configFields: [
            { key: 'label', type: 'text', label: 'Label' },
            { key: 'maxPoints', type: 'number', label: 'Max Points' },
            { key: 'timeWindow', type: 'number', label: 'Time Window (s)' },
            { key: 'lineColor', type: 'color', label: 'Line Color' },
            { key: 'fillArea', type: 'checkbox', label: 'Fill Area' }
        ],

        defaultSize: { w: 6, h: 4 }
    });

    // -- Plot helpers ---------------------------------------------------------

    function _plotFetchHistory(container, widget) {
        var state = container._plotState;
        if (!state || !widget.pv) return;

        var windowSec = (state.timeWindow / 1000) || 3600;
        var maxPts = state.maxPoints || 500;
        var url = '/api/pv-history/' + encodeURIComponent(widget.pv)
            + '?window=' + windowSec + '&max_points=' + maxPts;

        fetch(url)
            .then(function (resp) { return resp.json(); })
            .then(function (json) {
                if (!json.data || !container._plotState) return;
                // Merge history — convert seconds timestamps to ms
                var hist = json.data.map(function (p) {
                    return { t: p.t * 1000, v: p.v };
                });
                // Prepend history to any live data that arrived while loading
                var liveData = state.data.filter(function (p) {
                    return hist.length === 0 || p.t > hist[hist.length - 1].t;
                });
                state.data = hist.concat(liveData);
                state.historyLoaded = true;
                _plotUpdateChart(container, state);
            })
            .catch(function (err) {
                console.warn('Plot history fetch error:', err);
            });
    }

    function _plotCompact(state) {
        // Bin-average down to maxPoints
        var target = state.maxPoints;
        var data = state.data;
        if (data.length <= target) return;

        var tMin = data[0].t;
        var tMax = data[data.length - 1].t;
        var binWidth = (tMax - tMin) / target;
        if (binWidth <= 0) return;

        var binned = [];
        var binStart = tMin;
        var tSum = 0, vSum = 0, count = 0;

        for (var i = 0; i < data.length; i++) {
            var p = data[i];
            while (p.t >= binStart + binWidth && count > 0) {
                binned.push({ t: tSum / count, v: vSum / count });
                tSum = 0; vSum = 0; count = 0;
                binStart += binWidth;
                while (p.t >= binStart + binWidth) binStart += binWidth;
            }
            tSum += p.t;
            vSum += p.v;
            count++;
        }
        if (count > 0) {
            binned.push({ t: tSum / count, v: vSum / count });
        }

        state.data = binned;
    }

    function _plotUpdateChart(container, state) {
        if (typeof Chart === 'undefined') return;

        var canvas = container.querySelector('[data-role="plot-canvas"]');
        if (!canvas) return;

        var chartData = state.data.map(function (p) {
            return { x: p.t, y: p.v };
        });

        if (!state.chart) {
            // Create chart
            var ctx = canvas.getContext('2d');
            state.chart = new Chart(ctx, {
                type: 'line',
                data: {
                    datasets: [{
                        data: chartData,
                        borderColor: state.lineColor,
                        backgroundColor: state.fillArea
                            ? state.lineColor + '33'
                            : 'transparent',
                        fill: state.fillArea,
                        borderWidth: 1.5,
                        pointRadius: 0,
                        pointHitRadius: 4,
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: function (items) {
                                    if (!items.length) return '';
                                    return new Date(items[0].parsed.x).toLocaleTimeString();
                                },
                                label: function (item) {
                                    var val = item.parsed.y;
                                    return (val != null ? val.toPrecision(6) : '---')
                                        + (state.units ? ' ' + state.units : '');
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                displayFormats: {
                                    second: 'HH:mm:ss',
                                    minute: 'HH:mm',
                                    hour: 'HH:mm',
                                    day: 'MMM d'
                                }
                            },
                            ticks: {
                                color: '#64748b',
                                maxTicksLimit: 6,
                                font: { size: 10 }
                            },
                            grid: {
                                color: 'rgba(51,65,85,0.4)'
                            }
                        },
                        y: {
                            min: state.yMin != null ? state.yMin : undefined,
                            max: state.yMax != null ? state.yMax : undefined,
                            ticks: {
                                color: '#64748b',
                                maxTicksLimit: 5,
                                font: { size: 10 }
                            },
                            grid: {
                                color: 'rgba(51,65,85,0.4)'
                            }
                        }
                    },
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    }
                }
            });
        } else {
            // Update existing chart
            var ds = state.chart.data.datasets[0];
            ds.data = chartData;
            ds.borderColor = state.lineColor;
            ds.backgroundColor = state.fillArea ? state.lineColor + '33' : 'transparent';
            ds.fill = state.fillArea;

            var yScale = state.chart.options.scales.y;
            yScale.min = state.yMin != null ? state.yMin : undefined;
            yScale.max = state.yMax != null ? state.yMax : undefined;

            state.chart.update('none'); // 'none' skips animation
        }
    }

})();
