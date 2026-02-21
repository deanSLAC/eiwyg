/**
 * EIWYG - Load Dashboard Page
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {

    /* ── Tab switching ────────────────────────────────────────────── */

    const tabs = document.querySelectorAll('.search-tab');
    const tabUsername = document.getElementById('tab-username');
    const tabDescription = document.getElementById('tab-description');

    // Hide LLM-powered description search when disabled
    if (!window.EIWYG_LLM_ENABLED) {
        const descTab = document.querySelector('.search-tab[data-tab="description"]');
        if (descTab) descTab.style.display = 'none';
        tabDescription.style.display = 'none';
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const which = tab.getAttribute('data-tab');
            if (which === 'username') {
                tabUsername.style.display = '';
                tabDescription.style.display = 'none';
            } else {
                tabUsername.style.display = 'none';
                tabDescription.style.display = '';
            }
        });
    });

    /* ── Search by Username ───────────────────────────────────────── */

    const searchUsernameInput = document.getElementById('search-username');
    const btnSearchUsername = document.getElementById('btn-search-username');

    const searchByUsername = async () => {
        const username = searchUsernameInput.value.trim();
        if (!username) return;

        showLoading();

        try {
            const resp = await fetch(`${window.EIWYG_BASE || ''}/api/dashboards?username=${encodeURIComponent(username)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderResults(data);
        } catch (err) {
            showError(`Search failed: ${err.message}`);
        }
    };

    btnSearchUsername.addEventListener('click', searchByUsername);
    searchUsernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchByUsername();
    });

    /* ── Search by Description ────────────────────────────────────── */

    const searchDescInput = document.getElementById('search-description');
    const btnSearchDesc = document.getElementById('btn-search-description');

    const searchByDescription = async () => {
        const query = searchDescInput.value.trim();
        if (!query) return;

        showLoading();

        try {
            const resp = await fetch(`${window.EIWYG_BASE || ''}/api/search-dashboards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderResults(data);
        } catch (err) {
            showError(`Search failed: ${err.message}`);
        }
    };

    btnSearchDesc.addEventListener('click', searchByDescription);
    searchDescInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchByDescription();
    });

    /* ── Render Results ───────────────────────────────────────────── */

    const resultsArea = document.getElementById('results-area');

    const renderResults = (dashboards) => {
        if (!dashboards || dashboards.length === 0) {
            resultsArea.innerHTML = '<div class="results-empty">No dashboards found</div>';
            return;
        }

        resultsArea.innerHTML = dashboards.map(d => {
            const created = formatDate(d.created_at);
            return `
                <div class="dashboard-card" data-slug="${escHtml(d.slug)}">
                    <div class="dashboard-card-header">
                        <div>
                            <div class="dashboard-card-title">${escHtml(d.title || d.slug)}</div>
                            <div class="dashboard-card-slug">${escHtml(d.slug)}</div>
                        </div>
                        <div class="dashboard-card-actions">
                            <a href="${window.EIWYG_BASE || ''}/editor/${encodeURIComponent(d.slug)}" class="btn-edit">Edit</a>
                            <a href="${window.EIWYG_BASE || ''}/view/${encodeURIComponent(d.slug)}" class="btn-view">View</a>
                            <button class="btn-delete" data-slug="${escHtml(d.slug)}" data-title="${escHtml(d.title || d.slug)}">Delete</button>
                        </div>
                    </div>
                    ${d.description ? `<div class="dashboard-card-desc">${escHtml(d.description)}</div>` : ''}
                    <div class="dashboard-card-meta">
                        <span>By: ${escHtml(d.username || 'Unknown')}</span>
                        <span>Created: ${created}</span>
                    </div>
                </div>
            `;
        }).join('');

        // Bind delete buttons
        resultsArea.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                const slug = btn.getAttribute('data-slug');
                const title = btn.getAttribute('data-title');
                showDeleteModal(slug, title);
            });
        });
    };

    /* ── Delete Modal ─────────────────────────────────────────────── */

    const showDeleteModal = (slug, title) => {
        closeDeleteModal();

        const overlay = document.createElement('div');
        overlay.className = 'delete-modal-overlay';
        overlay.id = 'delete-modal-overlay';

        overlay.innerHTML = `
            <div class="delete-modal">
                <h3>Are you sure?</h3>
                <p>Delete dashboard "<strong>${escHtml(title)}</strong>"?</p>
                <label>Enter pw to confirm:</label>
                <input type="text" id="delete-modal-pw" class="delete-modal-input" placeholder="pw">
                <div id="delete-modal-error" class="delete-modal-error"></div>
                <div class="delete-modal-actions">
                    <button class="delete-modal-btn delete-modal-btn-danger" id="delete-modal-confirm">Confirm Delete</button>
                    <button class="delete-modal-btn delete-modal-btn-cancel" id="delete-modal-cancel">Cancel</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('delete-modal-confirm').addEventListener('click', async () => {
            const pw = document.getElementById('delete-modal-pw').value.trim();
            const errorEl = document.getElementById('delete-modal-error');
            errorEl.textContent = '';

            try {
                const resp = await fetch(`${window.EIWYG_BASE || ''}/api/dashboards/${encodeURIComponent(slug)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pw }),
                });

                if (resp.ok) {
                    closeDeleteModal();
                    // Remove the card from the DOM
                    const card = resultsArea.querySelector(`.dashboard-card[data-slug="${slug}"]`);
                    if (card) {
                        card.style.transition = 'opacity 0.3s';
                        card.style.opacity = '0';
                        setTimeout(() => card.remove(), 300);
                    }
                    showToast('Dashboard deleted', 'success');
                } else if (resp.status === 403) {
                    errorEl.textContent = 'Incorrect pw.';
                } else {
                    const err = await resp.json().catch(() => ({}));
                    errorEl.textContent = err.detail || 'Delete failed.';
                }
            } catch (err) {
                errorEl.textContent = `Error: ${err.message}`;
            }
        });

        document.getElementById('delete-modal-cancel').addEventListener('click', closeDeleteModal);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDeleteModal();
        });
    };

    const closeDeleteModal = () => {
        const overlay = document.getElementById('delete-modal-overlay');
        if (overlay) overlay.remove();
    };

    const showToast = (message, type = 'info') => {
        const toast = document.createElement('div');
        toast.className = `load-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };

    const showLoading = () => {
        resultsArea.innerHTML = '<div class="loading-area"><span class="loading-spinner"></span> Searching...</div>';
    };

    const showError = (msg) => {
        resultsArea.innerHTML = `<div class="results-empty" style="color:var(--danger);">${escHtml(msg)}</div>`;
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return dateStr;
        }
    };

    const escHtml = (str) => {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };

});
