/**
 * app.js
 * Main application logic handling UI, DOM events, and calculations.
 */

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(reg => console.log('Service Worker registered', reg))
            .catch(err => console.error('Service Worker registration failed', err));
    });
}


document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize IndexedDB
    try {
        await window.AppDB.init();
        console.log('IndexedDB initialized');
    } catch (e) {
        console.error('Failed to initialize DB', e);
        showToast('Gagal memuat database lokal', 'error');
    }

    // 2. Initialize SyncManager
    window.SyncManager.init();

    // 3. App State & DOM Elements
    const appState = {
        session: await window.AppDB.getSession(),
        storeTargets: [],
        users: [],
        products: [],
        dashboardFilter: { start: null, end: null }
    };

    const elements = {
        screens: {
            login: document.getElementById('login-screen'),
            app: document.getElementById('app-screen')
        },
        sidebar: {
            el: document.getElementById('sidebar'),
            openBtn: document.getElementById('open-sidebar'),
            closeBtn: document.getElementById('close-sidebar'),
            navItems: document.querySelectorAll('.nav-item'),
            userName: document.getElementById('active-user-name'),
            storeBadge: document.getElementById('active-store-badge'),
            logoutBtn: document.getElementById('btn-logout')
        },
        panels: document.querySelectorAll('.panel'),
        pageTitle: document.getElementById('current-page-title'),
        forms: {
            login: document.getElementById('login-form'),
            visit: document.getElementById('visit-form'),
            storeTarget: document.getElementById('store-target-form'),
            user: document.getElementById('user-form'),
            product: document.getElementById('product-form'),
            editVisit: document.getElementById('edit-visit-form')
        },
        overlay: document.getElementById('loading-overlay')
    };

    // --- UTILITIES ---
    const showToast = (message, type = 'info') => {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let icon = 'info';
        if(type === 'success') icon = 'check-circle';
        if(type === 'error') icon = 'alert-circle';

        toast.innerHTML = `
            <i data-lucide="${icon}"></i>
            <span>${message}</span>
        `;
        container.appendChild(toast);
        if (window.lucide) lucide.createIcons();
        
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };
    window.app = { showToast, loadDashboardData, refreshSyncQueueUI }; // Expose globally for sync.js

    const formatCurrency = (amount) => {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount || 0);
    };

    const showLoading = () => elements.overlay.classList.remove('hidden');
    const hideLoading = () => elements.overlay.classList.add('hidden');

    // Get today's date as YYYY-MM-DD
    const getTodayDate = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };

    // --- AUTH & INITIALIZATION ---
    const checkAuth = async () => {
        if (appState.session) {
            elements.screens.login.classList.remove('active');
            elements.screens.app.classList.remove('hidden');
            setTimeout(() => elements.screens.app.classList.add('active'), 10);
            
            elements.sidebar.userName.textContent = appState.session.username;
            elements.sidebar.storeBadge.textContent = appState.session.storeName;
            
            if (appState.session.role !== 'Admin') {
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
            } else {
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
            }

            if (window.SyncManager.isOnline) {
                await window.SyncManager.fetchInitialData();
            }
            
            await loadStoreTargets();
            await loadProducts();
            await loadDashboardData();

            // Set default visit date to today
            const visitDateInput = document.getElementById('visit-date');
            if (visitDateInput) visitDateInput.value = getTodayDate();
        } else {
            elements.screens.app.classList.remove('active');
            setTimeout(() => elements.screens.app.classList.add('hidden'), 300);
            elements.screens.login.classList.add('active');
        }
    };

    if (window.SyncManager.isOnline) {
        window.SyncManager.fetchInitialData().catch(e => console.error("Background fetch failed", e));
    }

    // Login Submission
    elements.forms.login.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value.trim();
        
        showLoading();
        
        try {
            let user = null;
            let cachedUser = await window.AppDB.get(window.AppDB.STORES.USERS, username);
            
            if (!cachedUser && window.SyncManager.isOnline) {
                await window.SyncManager.fetchInitialData();
                cachedUser = await window.AppDB.get(window.AppDB.STORES.USERS, username);
            }

            if (cachedUser && cachedUser.password === password) {
                user = cachedUser;
            } else if (username === 'admin' && password === 'admin123') {
                user = { username: 'admin', role: 'Admin', storeName: 'Semua Store' };
            } else if (username === 'store1' && password === 'store1') {
                user = { username: 'store1', role: 'Store', storeName: 'Store Jakarta' };
            } else {
                throw new Error('Username atau password salah');
            }

            appState.session = user;
            await window.AppDB.saveSession(user);
            showToast('Login berhasil', 'success');
            checkAuth();
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            hideLoading();
        }
    });

    // Logout
    elements.sidebar.logoutBtn.addEventListener('click', async () => {
        await window.AppDB.clearSession();
        appState.session = null;
        checkAuth();
    });

    // --- NAVIGATION ---
    elements.sidebar.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.getAttribute('data-target');
            
            elements.sidebar.navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            elements.panels.forEach(panel => {
                panel.classList.remove('active');
                panel.classList.add('hidden');
                if (panel.id === `panel-${targetId}`) {
                    panel.classList.add('active');
                    panel.classList.remove('hidden');
                }
            });

            elements.pageTitle.textContent = item.textContent.trim();

            if (window.innerWidth <= 1024) {
                elements.sidebar.el.classList.remove('open');
            }

            if (targetId === 'dashboard') loadDashboardData();
            if (targetId === 'sinkronisasi') refreshSyncQueueUI();
            if (targetId === 'validasi') { loadStoreTargetsUI(); loadProductsUI(); }
            if (targetId === 'form-kunjungan') { updateFormTargetLabel(); renderProdukRows(); }
            if (targetId === 'manajemen-user') loadUsersUI();
        });
    });

    // Mobile Sidebar Toggle
    elements.sidebar.openBtn.addEventListener('click', () => {
        elements.sidebar.el.classList.add('open');
    });
    elements.sidebar.closeBtn.addEventListener('click', () => {
        elements.sidebar.el.classList.remove('open');
    });

    // --- MODAL MANAGEMENT ---
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.getAttribute('data-modal');
            if (modalId) document.getElementById(modalId).classList.add('hidden');
        });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });

    // --- DATA LOADING & UI ---
    async function loadStoreTargets() {
        const targets = await window.AppDB.getAll(window.AppDB.STORES.STORE_TARGETS);
        appState.storeTargets = targets || [];
        updateFormTargetLabel();
    }

    async function loadProducts() {
        const products = await window.AppDB.getAll(window.AppDB.STORES.PRODUCTS);
        appState.products = products || [];
    }

    function updateFormTargetLabel() {
        if (!appState.session) return;
        const myStoreTarget = appState.storeTargets.find(t => t.storeName === appState.session.storeName);
        const targetValue = myStoreTarget ? myStoreTarget.target : 0;
        
        document.getElementById('label-store-name').textContent = appState.session.storeName;
        document.getElementById('calc-target-omset').textContent = formatCurrency(targetValue);
        document.getElementById('calc-target-omset').dataset.value = targetValue;
        calculateFormValues();
    }

    // --- DASHBOARD FILTER ---
    const filterDateStart = document.getElementById('filter-date-start');
    const filterDateEnd = document.getElementById('filter-date-end');

    document.getElementById('btn-apply-filter').addEventListener('click', () => {
        const start = filterDateStart.value;
        const end = filterDateEnd.value;
        if (!start || !end) {
            showToast('Pilih tanggal awal dan akhir', 'error');
            return;
        }
        if (new Date(start) > new Date(end)) {
            showToast('Tanggal awal tidak boleh lebih besar dari tanggal akhir', 'error');
            return;
        }
        appState.dashboardFilter = { start, end };
        loadDashboardData();
        showToast(`Filter: ${formatDate(start)} – ${formatDate(end)}`, 'info');
    });

    document.getElementById('btn-reset-filter').addEventListener('click', () => {
        filterDateStart.value = '';
        filterDateEnd.value = '';
        appState.dashboardFilter = { start: null, end: null };
        loadDashboardData();
        showToast('Filter direset', 'info');
    });

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function filterVisitsByDate(visits) {
        const { start, end } = appState.dashboardFilter;
        if (!start || !end) return visits;
        const startDate = new Date(start + 'T00:00:00');
        const endDate = new Date(end + 'T23:59:59');
        return visits.filter(v => {
            const vDate = new Date(v.visitDate || v.timestamp || parseInt(v.id));
            return vDate >= startDate && vDate <= endDate;
        });
    }

    // --- DASHBOARD DATA ---
    async function loadDashboardData() {
        if (!appState.session) return;
        const visits = await window.AppDB.getAll(window.AppDB.STORES.VISITS);
        
        let myVisits = appState.session.role === 'Admin' 
            ? visits 
            : visits.filter(v => v.storeName === appState.session.storeName);

        // Apply date filter
        myVisits = filterVisitsByDate(myVisits);

        let tVisit = 0, tDeals = 0, tOmset = 0;
        myVisits.forEach(v => {
            tVisit += (parseInt(v.visitBaru) || 0);
            tDeals += (parseInt(v.totalDeals) || 0);
            tOmset += (parseInt(v.omset) || 0);
            // Add omset from other products
            if (v.produkLainnya && Array.isArray(v.produkLainnya)) {
                v.produkLainnya.forEach(p => { tOmset += (parseInt(p.omset) || 0); });
            }
        });

        const konversiDeals = tVisit > 0 ? ((tDeals / tVisit) * 100).toFixed(1) : 0;
        
        let myTarget = 0;
        if (appState.session.role === 'Admin') {
            appState.storeTargets.forEach(t => myTarget += (parseInt(t.target) || 0));
        } else {
            const myTargetObj = appState.storeTargets.find(t => t.storeName === appState.session.storeName);
            myTarget = myTargetObj ? parseInt(myTargetObj.target) : 0;
        }
        
        const konversiOmset = myTarget > 0 ? ((tOmset / myTarget) * 100).toFixed(1) : 0;

        document.getElementById('kpi-visit-baru').textContent = tVisit;
        document.getElementById('kpi-total-deals').textContent = tDeals;
        document.getElementById('kpi-konversi-deals').textContent = `${konversiDeals}%`;
        document.getElementById('kpi-omset').textContent = formatCurrency(tOmset);
        document.getElementById('kpi-konversi-omset').textContent = `${konversiOmset}%`;

        // Update Table
        const tbody = document.getElementById('recent-visits-body');
        tbody.innerHTML = '';
        if (myVisits.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Belum ada data kunjungan</td></tr>';
        } else {
            const sorted = myVisits.sort((a,b) => new Date(b.visitDate || b.timestamp || b.id) - new Date(a.visitDate || a.timestamp || a.id)).slice(0, 20);
            sorted.forEach(v => {
                const tr = document.createElement('tr');
                const displayDate = v.visitDate 
                    ? formatDate(v.visitDate) 
                    : new Date(v.timestamp || parseInt(v.id)).toLocaleDateString('id-ID');
                const visitOmset = (parseInt(v.omset) || 0) + ((v.produkLainnya || []).reduce((s, p) => s + (parseInt(p.omset) || 0), 0));
                tr.innerHTML = `
                    <td>${displayDate}</td>
                    <td>${v.storeName}</td>
                    <td>${v.visitBaru}</td>
                    <td>${v.totalDeals}</td>
                    <td>${formatCurrency(visitOmset)}</td>
                    <td>
                        <div class="action-btns">
                            <button class="btn-action-edit btn-edit-visit" data-id="${v.id}" title="Edit">
                                <i data-lucide="edit-3"></i>
                            </button>
                            <button class="btn-action-delete btn-delete-visit" data-id="${v.id}" title="Hapus">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
        
        if (window.lucide) lucide.createIcons();
        setupVisitTableActions();
        renderCharts(myVisits);
    }

    function setupVisitTableActions() {
        document.querySelectorAll('.btn-edit-visit').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idVal = btn.getAttribute('data-id');
                const id = idVal.startsWith('L-') ? idVal : parseInt(idVal);
                const visits = await window.AppDB.getAll(window.AppDB.STORES.VISITS);
                const visit = visits.find(v => v.id === id);
                if (!visit) return;

                // Populate modal
                document.getElementById('edit-visit-id').value = visit.id;
                document.getElementById('edit-visit-date').value = visit.visitDate || '';
                document.getElementById('edit-visit-baru').value = visit.visitBaru || 0;
                document.getElementById('edit-deals-offline').value = visit.dealsOffline || 0;
                document.getElementById('edit-deals-referal').value = visit.dealsReferal || 0;
                document.getElementById('edit-deals-box').value = visit.dealsBox || 0;
                document.getElementById('edit-visit-repair').value = visit.visitRepair || 0;
                document.getElementById('edit-visit-buyback').value = visit.visitBuyback || 0;
                document.getElementById('edit-pengambilan-baru').value = visit.pengambilanBaru || 0;
                document.getElementById('edit-pengambilan-repair').value = visit.pengambilanRepair || 0;
                document.getElementById('edit-qty-cincin').value = visit.qtyCincin || 0;
                document.getElementById('edit-omset').value = visit.omset || 0;

                document.getElementById('modal-edit-visit').classList.remove('hidden');
                if (window.lucide) lucide.createIcons();
            });
        });

        document.querySelectorAll('.btn-delete-visit').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idVal = btn.getAttribute('data-id');
                const id = idVal.startsWith('L-') ? idVal : parseInt(idVal);
                if (!confirm('Yakin ingin menghapus data kunjungan ini?')) return;
                
                // 1. Update cache (IndexedDB) immediately
                await window.AppDB.delete(window.AppDB.STORES.VISITS, id);
                
                // 2. Optimistic Queue check
                const queue = await window.AppDB.getSyncQueue();
                let removed = false;
                for (const item of queue) {
                    if (item.action === 'addVisit' && item.payload && item.payload.id === id) {
                        await window.AppDB.removeFromSyncQueue(item.id);
                        removed = true;
                        break;
                    }
                }
                if (!removed) {
                    await window.AppDB.addToSyncQueue('deleteVisit', { id: id });
                }
                
                // 3. Update UI immediately
                showToast('Data kunjungan dihapus', 'success');
                await loadDashboardData();
                
                if (window.SyncManager.isOnline) {
                    window.SyncManager.syncNow();
                }
            });
        });
    }

    // Edit Visit Form Submit
    elements.forms.editVisit.addEventListener('submit', async (e) => {
        e.preventDefault();
        showLoading();
        const idVal = document.getElementById('edit-visit-id').value;
        const id = idVal.startsWith('L-') ? idVal : parseInt(idVal);
        const visits = await window.AppDB.getAll(window.AppDB.STORES.VISITS);
        const original = visits.find(v => v.id === id);
        if (!original) { hideLoading(); return; }

        const dOff = parseInt(document.getElementById('edit-deals-offline').value) || 0;
        const dRef = parseInt(document.getElementById('edit-deals-referal').value) || 0;
        const dBox = parseInt(document.getElementById('edit-deals-box').value) || 0;
        const vBaru = parseInt(document.getElementById('edit-visit-baru').value) || 0;
        const totalDeals = dOff + dRef + dBox;
        const konversiDeals = vBaru > 0 ? ((totalDeals / vBaru) * 100).toFixed(1) + '%' : '0%';
        
        const myTargetObj = appState.storeTargets.find(t => t.storeName === original.storeName);
        const myTarget = myTargetObj ? parseInt(myTargetObj.target) : 0;
        const omset = parseInt(document.getElementById('edit-omset').value) || 0;
        const konversiOmset = myTarget > 0 ? ((omset / myTarget) * 100).toFixed(1) + '%' : '0%';

        const updated = {
            ...original,
            visitDate: document.getElementById('edit-visit-date').value,
            visitBaru: vBaru,
            dealsOffline: dOff,
            dealsReferal: dRef,
            dealsBox: dBox,
            totalDeals,
            konversiDeals,
            visitRepair: parseInt(document.getElementById('edit-visit-repair').value) || 0,
            visitBuyback: parseInt(document.getElementById('edit-visit-buyback').value) || 0,
            pengambilanBaru: parseInt(document.getElementById('edit-pengambilan-baru').value) || 0,
            pengambilanRepair: parseInt(document.getElementById('edit-pengambilan-repair').value) || 0,
            qtyCincin: parseInt(document.getElementById('edit-qty-cincin').value) || 0,
            omset,
            konversiOmset
        };

        // 1. Update cache (IndexedDB) immediately
        await window.AppDB.put(window.AppDB.STORES.VISITS, updated);
        
        // 2. Optimistic Queue check
        const updatedInQueue = await window.AppDB.updateSyncQueuePayload('addVisit', id, updated);
        if (!updatedInQueue) {
            await window.AppDB.addToSyncQueue('editVisit', updated);
        }
        
        // 3. Update UI immediately
        document.getElementById('modal-edit-visit').classList.add('hidden');
        showToast('Data kunjungan berhasil diperbarui', 'success');
        await loadDashboardData();
        hideLoading();
        
        if (window.SyncManager.isOnline) {
            window.SyncManager.syncNow();
        }
    });

    // --- GENERATE LAPORAN ---
    document.getElementById('btn-generate-report').addEventListener('click', async () => {
        showLoading();
        const visits = await window.AppDB.getAll(window.AppDB.STORES.VISITS);
        let myVisits = appState.session.role === 'Admin' 
            ? visits 
            : visits.filter(v => v.storeName === appState.session.storeName);
        myVisits = filterVisitsByDate(myVisits);

        const { start, end } = appState.dashboardFilter;
        const periodeLabel = start && end ? `${formatDate(start)} – ${formatDate(end)}` : 'Semua Periode';

        let tVisit = 0, tDeals = 0, tOmset = 0;
        myVisits.forEach(v => {
            tVisit += parseInt(v.visitBaru) || 0;
            tDeals += parseInt(v.totalDeals) || 0;
            tOmset += parseInt(v.omset) || 0;
            if (v.produkLainnya) v.produkLainnya.forEach(p => tOmset += parseInt(p.omset) || 0);
        });

        let myTarget = 0;
        if (appState.session.role === 'Admin') {
            appState.storeTargets.forEach(t => myTarget += parseInt(t.target) || 0);
        } else {
            const myTargetObj = appState.storeTargets.find(t => t.storeName === appState.session.storeName);
            myTarget = myTargetObj ? parseInt(myTargetObj.target) : 0;
        }
        const konversiDeals = tVisit > 0 ? ((tDeals / tVisit) * 100).toFixed(1) : 0;
        const konversiOmset = myTarget > 0 ? ((tOmset / myTarget) * 100).toFixed(1) : 0;

        const sorted = myVisits.sort((a, b) => new Date(b.visitDate || b.timestamp || b.id) - new Date(a.visitDate || a.timestamp || a.id));

        const rowsHTML = sorted.length === 0 
            ? '<tr><td colspan="7" style="text-align:center;padding:1rem;color:#94a3b8;">Tidak ada data pada periode ini</td></tr>'
            : sorted.map(v => {
                const displayDate = v.visitDate ? formatDate(v.visitDate) : new Date(v.timestamp || parseInt(v.id)).toLocaleDateString('id-ID');
                const visitOmset = (parseInt(v.omset) || 0) + ((v.produkLainnya || []).reduce((s, p) => s + (parseInt(p.omset) || 0), 0));
                return `<tr>
                    <td>${displayDate}</td>
                    <td>${v.storeName}</td>
                    <td>${v.visitBaru}</td>
                    <td>${v.totalDeals}</td>
                    <td>${v.visitRepair || 0}</td>
                    <td>${v.visitBuyback || 0}</td>
                    <td style="text-align:right;">${formatCurrency(visitOmset)}</td>
                </tr>`;
            }).join('');

        const reportHTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>Laporan Kunjungan Store — ${periodeLabel}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 2rem; }
  .report-header { text-align: center; margin-bottom: 2rem; border-bottom: 3px solid #3b82f6; padding-bottom: 1.5rem; }
  .report-header h1 { font-size: 1.8rem; color: #1e293b; margin-bottom: 0.5rem; }
  .report-header p { color: #64748b; font-size: 1rem; }
  .kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .kpi-card { background: white; border-radius: 12px; padding: 1.25rem; box-shadow: 0 2px 8px rgba(0,0,0,0.07); border-left: 4px solid #3b82f6; }
  .kpi-card.green { border-left-color: #10b981; }
  .kpi-card.purple { border-left-color: #8b5cf6; }
  .kpi-card.orange { border-left-color: #f59e0b; }
  .kpi-card.red { border-left-color: #ef4444; }
  .kpi-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .kpi-value { font-size: 1.5rem; font-weight: 700; color: #1e293b; }
  .section-title { font-size: 1.1rem; font-weight: 700; color: #1e293b; margin: 1.5rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.07); }
  thead { background: #1e293b; color: white; }
  th { padding: 0.875rem 1rem; text-align: left; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 0.875rem 1rem; border-bottom: 1px solid #f1f5f9; font-size: 0.9rem; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #f8fafc; }
  .report-footer { margin-top: 2rem; text-align: center; color: #94a3b8; font-size: 0.8rem; border-top: 1px solid #e2e8f0; padding-top: 1rem; }
  @media print {
    body { background: white; padding: 1rem; }
    .kpi-card, table { box-shadow: none; border: 1px solid #e2e8f0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="report-header">
  <h1>📊 Laporan Rekapitulasi Kunjungan Store</h1>
  <p>Periode: <strong>${periodeLabel}</strong> | Dibuat: ${new Date().toLocaleString('id-ID')} | User: ${appState.session.username}</p>
</div>

<div class="kpi-grid">
  <div class="kpi-card blue">
    <div class="kpi-label">Total Visit Baru</div>
    <div class="kpi-value">${tVisit}</div>
  </div>
  <div class="kpi-card green">
    <div class="kpi-label">Total Deals</div>
    <div class="kpi-value">${tDeals}</div>
  </div>
  <div class="kpi-card purple">
    <div class="kpi-label">Konversi Deals</div>
    <div class="kpi-value">${konversiDeals}%</div>
  </div>
  <div class="kpi-card orange">
    <div class="kpi-label">Total Omset</div>
    <div class="kpi-value">${formatCurrency(tOmset)}</div>
  </div>
  <div class="kpi-card red">
    <div class="kpi-label">Konversi Omset</div>
    <div class="kpi-value">${konversiOmset}%</div>
  </div>
</div>

<div class="section-title">Rekapitulasi Data Kunjungan</div>
<table>
  <thead>
    <tr>
      <th>Tanggal</th>
      <th>Store</th>
      <th>Visit Baru</th>
      <th>Total Deals</th>
      <th>Visit Repair</th>
      <th>Visit Buyback</th>
      <th style="text-align:right;">Omset</th>
    </tr>
  </thead>
  <tbody>${rowsHTML}</tbody>
  <tfoot>
    <tr style="background:#f8fafc;font-weight:700;">
      <td colspan="2">TOTAL</td>
      <td>${tVisit}</td>
      <td>${tDeals}</td>
      <td colspan="2"></td>
      <td style="text-align:right;">${formatCurrency(tOmset)}</td>
    </tr>
  </tfoot>
</table>

<div class="report-footer">
  <p>Laporan ini dibuat secara otomatis oleh Sistem Rekapitulasi Kunjungan &copy; ${new Date().getFullYear()}</p>
  <button class="no-print" onclick="window.print()" style="margin-top:1rem;padding:0.75rem 2rem;background:#3b82f6;color:white;border:none;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:600;">🖨️ Cetak / Simpan PDF</button>
</div>
</body>
</html>`;

        hideLoading();
        const reportWindow = window.open('', '_blank');
        reportWindow.document.write(reportHTML);
        reportWindow.document.close();
    });

    // --- CHARTS LOGIC ---
    let chartVisits, chartOmset;
    function renderCharts(visits) {
        if (!window.Chart) return;
        
        const isStore = appState.session.role === 'Store';
        const labels = [], visitData = [], dealData = [], omsetData = [];
        
        if (isStore) {
            const grouped = {};
            visits.forEach(v => {
                const date = new Date(v.visitDate ? v.visitDate + 'T00:00:00' : v.timestamp || parseInt(v.id)).toLocaleDateString('id-ID', {day: 'numeric', month: 'short'});
                if(!grouped[date]) grouped[date] = { visit: 0, deals: 0, omset: 0 };
                grouped[date].visit += parseInt(v.visitBaru) || 0;
                grouped[date].deals += parseInt(v.totalDeals) || 0;
                grouped[date].omset += parseInt(v.omset) || 0;
                if (v.produkLainnya) v.produkLainnya.forEach(p => grouped[date].omset += parseInt(p.omset) || 0);
            });
            Object.keys(grouped).slice(-7).forEach(date => {
                labels.push(date);
                visitData.push(grouped[date].visit);
                dealData.push(grouped[date].deals);
                omsetData.push(grouped[date].omset);
            });
        } else {
            const grouped = {};
            visits.forEach(v => {
                const store = v.storeName;
                if(!grouped[store]) grouped[store] = { visit: 0, deals: 0, omset: 0 };
                grouped[store].visit += parseInt(v.visitBaru) || 0;
                grouped[store].deals += parseInt(v.totalDeals) || 0;
                grouped[store].omset += parseInt(v.omset) || 0;
                if (v.produkLainnya) v.produkLainnya.forEach(p => grouped[store].omset += parseInt(p.omset) || 0);
            });
            Object.keys(grouped).forEach(store => {
                labels.push(store);
                visitData.push(grouped[store].visit);
                dealData.push(grouped[store].deals);
                omsetData.push(grouped[store].omset);
            });
        }

        const ctxVisits = document.getElementById('chart-visits');
        if (ctxVisits) {
            if (chartVisits) chartVisits.destroy();
            chartVisits = new Chart(ctxVisits, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        { label: 'Visit Baru', data: visitData, backgroundColor: 'rgba(59, 130, 246, 0.8)' },
                        { label: 'Total Deals', data: dealData, backgroundColor: 'rgba(16, 185, 129, 0.8)' }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#f8fafc' } } },
                    scales: {
                        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                        x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
                    }
                }
            });
        }

        const ctxOmset = document.getElementById('chart-omset');
        if (ctxOmset) {
            if (chartOmset) chartOmset.destroy();
            chartOmset = new Chart(ctxOmset, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: 'Omset Penjualan (Rp)',
                        data: omsetData,
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.2)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#f8fafc' } } },
                    scales: {
                        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                        x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
                    }
                }
            });
        }
    }
    
    document.getElementById('btn-refresh-charts').addEventListener('click', () => {
        loadDashboardData();
        showToast('Grafik diperbarui', 'info');
    });

    document.getElementById('btn-refresh-dashboard').addEventListener('click', () => {
        loadDashboardData();
        showToast('Dashboard diperbarui', 'info');
    });

    // --- FORM CALCULATIONS ---
    const calcInputs = ['visit-baru', 'deals-offline', 'deals-referal', 'deals-box', 'omset'];
    calcInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', calculateFormValues);
    });

    function calculateFormValues() {
        const visitBaru = parseInt(document.getElementById('visit-baru').value) || 0;
        const dOffline = parseInt(document.getElementById('deals-offline').value) || 0;
        const dReferal = parseInt(document.getElementById('deals-referal').value) || 0;
        const dBox = parseInt(document.getElementById('deals-box').value) || 0;
        const omset = parseInt(document.getElementById('omset').value) || 0;
        
        const targetOmset = parseInt(document.getElementById('calc-target-omset').dataset.value) || 0;

        const totalDeals = dOffline + dReferal + dBox;
        const konversiDeals = visitBaru > 0 ? ((totalDeals / visitBaru) * 100).toFixed(1) : 0;
        const konversiOmset = targetOmset > 0 ? ((omset / targetOmset) * 100).toFixed(1) : 0;

        document.getElementById('calc-total-deals').textContent = totalDeals;
        document.getElementById('calc-konversi-deals').textContent = `${konversiDeals}%`;
        document.getElementById('calc-konversi-omset').textContent = `${konversiOmset}%`;
    }

    // --- PRODUK LAINNYA ROWS ---
    let produkRowCount = 0;

    function renderProdukRows() {
        // Just ensure the button is wired up
        const btn = document.getElementById('btn-add-produk-row');
        if (btn && !btn._wired) {
            btn.addEventListener('click', addProdukRow);
            btn._wired = true;
        }
    }

    function addProdukRow(prefillData = null) {
        const container = document.getElementById('produk-rows-container');
        const rowId = ++produkRowCount;

        const row = document.createElement('div');
        row.className = 'produk-row';
        row.setAttribute('data-row-id', rowId);

        const productOptions = appState.products.map(p => 
            `<option value="${p.productName}" data-price="${p.pricePerUnit}">${p.productName} (${formatCurrency(p.pricePerUnit)})</option>`
        ).join('');

        row.innerHTML = `
            <div class="produk-row-inner">
                <div class="produk-select-wrap">
                    <label>Nama Produk</label>
                    <select class="produk-select" id="produk-select-${rowId}">
                        <option value="">-- Pilih Produk --</option>
                        ${productOptions}
                    </select>
                </div>
                <div class="produk-qty-wrap">
                    <label>Qty</label>
                    <input type="number" class="produk-qty" id="produk-qty-${rowId}" min="0" value="${prefillData ? prefillData.qty : 1}" placeholder="0">
                </div>
                <div class="produk-omset-wrap">
                    <label>Omset (Rp)</label>
                    <input type="text" class="produk-omset-display" id="produk-omset-${rowId}" readonly placeholder="Auto" value="${prefillData ? formatCurrency(prefillData.omset) : ''}">
                    <input type="hidden" class="produk-omset-value" id="produk-omset-val-${rowId}" value="${prefillData ? prefillData.omset : 0}">
                </div>
                <button type="button" class="btn-remove-row" data-row-id="${rowId}" title="Hapus baris">
                    <i data-lucide="x-circle"></i>
                </button>
            </div>
        `;

        container.appendChild(row);
        if (window.lucide) lucide.createIcons();

        // Pre-select if editing
        if (prefillData) {
            const sel = document.getElementById(`produk-select-${rowId}`);
            sel.value = prefillData.productName;
        }

        // Wire events
        const sel = document.getElementById(`produk-select-${rowId}`);
        const qtyInput = document.getElementById(`produk-qty-${rowId}`);

        function calcRowOmset() {
            const selectedOpt = sel.options[sel.selectedIndex];
            const price = selectedOpt ? (parseFloat(selectedOpt.getAttribute('data-price')) || 0) : 0;
            const qty = parseInt(qtyInput.value) || 0;
            const omset = price * qty;
            document.getElementById(`produk-omset-${rowId}`).value = omset > 0 ? formatCurrency(omset) : '';
            document.getElementById(`produk-omset-val-${rowId}`).value = omset;
            updateTotalOmsetProduk();
        }

        sel.addEventListener('change', calcRowOmset);
        qtyInput.addEventListener('input', calcRowOmset);

        // Remove row
        row.querySelector('.btn-remove-row').addEventListener('click', () => {
            row.remove();
            updateTotalOmsetProduk();
            toggleProdukTotalGroup();
        });

        toggleProdukTotalGroup();
        if (prefillData) updateTotalOmsetProduk();
    }

    function toggleProdukTotalGroup() {
        const container = document.getElementById('produk-rows-container');
        const group = document.getElementById('produk-lainnya-total-group');
        if (group) group.style.display = container.children.length > 0 ? '' : 'none';
    }

    function updateTotalOmsetProduk() {
        let total = 0;
        document.querySelectorAll('.produk-omset-value').forEach(el => {
            total += parseInt(el.value) || 0;
        });
        const el = document.getElementById('calc-total-omset-produk');
        if (el) el.textContent = formatCurrency(total);
        toggleProdukTotalGroup();
    }

    function getProdukLainnayaData() {
        const rows = document.querySelectorAll('.produk-row');
        const result = [];
        rows.forEach(row => {
            const rowId = row.getAttribute('data-row-id');
            const sel = document.getElementById(`produk-select-${rowId}`);
            const qty = parseInt(document.getElementById(`produk-qty-${rowId}`).value) || 0;
            const omset = parseInt(document.getElementById(`produk-omset-val-${rowId}`).value) || 0;
            const productName = sel ? sel.value : '';
            if (productName) {
                result.push({ productName, qty, omset });
            }
        });
        return result;
    }

    document.getElementById('btn-add-produk-row').addEventListener('click', () => addProdukRow());

    // --- FORM SUBMISSION ---
    elements.forms.visit.addEventListener('submit', async (e) => {
        e.preventDefault();
        showLoading();

        const produkLainnya = getProdukLainnayaData();
        const visitDate = document.getElementById('visit-date').value || getTodayDate();

        const localId = 'L-' + Date.now();

        const data = {
            id: localId,
            timestamp: new Date().toISOString(),
            visitDate,
            user: appState.session.username,
            storeName: appState.session.storeName,
            visitBaru: document.getElementById('visit-baru').value,
            dealsOffline: document.getElementById('deals-offline').value,
            dealsReferal: document.getElementById('deals-referal').value,
            dealsBox: document.getElementById('deals-box').value,
            totalDeals: document.getElementById('calc-total-deals').textContent,
            konversiDeals: document.getElementById('calc-konversi-deals').textContent,
            visitRepair: document.getElementById('visit-repair').value,
            visitBuyback: document.getElementById('visit-buyback').value,
            pengambilanBaru: document.getElementById('pengambilan-baru').value,
            pengambilanRepair: document.getElementById('pengambilan-repair').value,
            qtyCincin: document.getElementById('qty-cincin').value,
            omset: document.getElementById('omset').value,
            konversiOmset: document.getElementById('calc-konversi-omset').textContent,
            produkLainnya
        };

        try {
            // Update cache immediately
            await window.AppDB.put(window.AppDB.STORES.VISITS, data);
            
            // Add to sync queue
            await window.AppDB.addToSyncQueue('addVisit', data);
            
            // Update view immediately
            await loadDashboardData();
            
            // Reset form
            elements.forms.visit.reset();
            document.getElementById('visit-date').value = getTodayDate();
            document.getElementById('produk-rows-container').innerHTML = '';
            produkRowCount = 0;
            toggleProdukTotalGroup();
            calculateFormValues();
            updateFormTargetLabel();

            if (window.SyncManager.isOnline) {
                window.SyncManager.syncNow().then(() => {
                    showToast('Data kunjungan berhasil disimpan & disinkronisasi', 'success');
                }).catch(err => {
                    console.error('Background sync failed:', err);
                });
            } else {
                showToast('Offline: Data disimpan lokal. Akan dikirim otomatis saat online.', 'info');
            }
            
        } catch (err) {
            showToast('Gagal menyimpan data kunjungan', 'error');
            console.error(err);
        } finally {
            hideLoading();
        }
    });

    // --- SYNC QUEUE UI ---
    async function refreshSyncQueueUI() {
        const queue = await window.AppDB.getSyncQueue();
        const tbody = document.getElementById('sync-queue-body');
        tbody.innerHTML = '';
        
        if (queue.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Antrean sinkronisasi kosong</td></tr>';
            return;
        }

        queue.forEach(item => {
            const tr = document.createElement('tr');
            const date = new Date(item.timestamp).toLocaleString('id-ID');
            const store = item.payload.storeName || 'Sistem';
            tr.innerHTML = `
                <td>${date}</td>
                <td><span class="badge">${item.action}</span></td>
                <td>${store}</td>
                <td><span class="status-text ${item.status === 'pending' ? 'text-orange' : ''}">${item.status}</span></td>
                <td>
                    <button class="btn-action-delete btn-delete-queue" data-id="${item.id}" title="Hapus dari antrean">
                        <i data-lucide="trash-2"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        if (window.lucide) lucide.createIcons();

        document.querySelectorAll('.btn-delete-queue').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                if (!confirm('Hapus item ini dari antrean sinkronisasi?')) return;
                await window.AppDB.removeFromSyncQueue(id);
                refreshSyncQueueUI();
                showToast('Item dihapus dari antrean', 'success');
            });
        });
    }

    document.getElementById('btn-force-sync').addEventListener('click', () => {
        window.SyncManager.syncNow();
    });

    // --- ADMIN CONFIG FORMS (Store Target & User) ---
    elements.forms.storeTarget.addEventListener('submit', async (e) => {
        e.preventDefault();
        const storeName = document.getElementById('store-name-config').value.trim();
        const target = document.getElementById('store-target-config').value;
        const editKey = document.getElementById('store-target-edit-key').value;

        const payload = { storeName, target };
        
        // 1. Update cache immediately
        await window.AppDB.put(window.AppDB.STORES.STORE_TARGETS, payload);
        
        // 2. Queue management
        const updatedInQueue = await window.AppDB.updateSyncQueuePayload('saveStoreTarget', storeName, payload);
        if (!updatedInQueue) {
            await window.AppDB.addToSyncQueue('saveStoreTarget', payload);
        }
        
        // 3. Update UI immediately
        await loadStoreTargets();
        loadStoreTargetsUI();
        showToast(editKey ? 'Target diperbarui' : 'Target ditambahkan', 'success');
        
        elements.forms.storeTarget.reset();
        document.getElementById('store-target-edit-key').value = '';
        document.getElementById('btn-store-target-submit').textContent = 'Simpan Target';
        document.getElementById('btn-store-target-cancel').classList.add('hidden');

        if (window.SyncManager.isOnline) {
            window.SyncManager.syncNow();
        }
    });

    document.getElementById('btn-store-target-cancel').addEventListener('click', () => {
        elements.forms.storeTarget.reset();
        document.getElementById('store-target-edit-key').value = '';
        document.getElementById('btn-store-target-submit').textContent = 'Simpan Target';
        document.getElementById('btn-store-target-cancel').classList.add('hidden');
    });

    async function loadStoreTargetsUI() {
        await loadStoreTargets();
        const tbody = document.getElementById('stores-list-body');
        tbody.innerHTML = '';
        if (appState.storeTargets.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Belum ada target store</td></tr>';
        } else {
            appState.storeTargets.forEach(t => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${t.storeName}</td>
                    <td>${formatCurrency(t.target)}</td>
                    <td>
                        <div class="action-btns">
                            <button class="btn-action-edit btn-edit-store" data-store="${t.storeName}" data-target="${t.target}" title="Edit">
                                <i data-lucide="edit-3"></i>
                            </button>
                            <button class="btn-action-delete btn-delete-store" data-store="${t.storeName}" title="Hapus">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
        if (window.lucide) lucide.createIcons();
        
        // Edit Store Target
        document.querySelectorAll('.btn-edit-store').forEach(btn => {
            btn.addEventListener('click', () => {
                const sName = btn.getAttribute('data-store');
                const sTarget = btn.getAttribute('data-target');
                document.getElementById('store-name-config').value = sName;
                document.getElementById('store-target-config').value = sTarget;
                document.getElementById('store-target-edit-key').value = sName;
                document.getElementById('btn-store-target-submit').textContent = 'Update Target';
                document.getElementById('btn-store-target-cancel').classList.remove('hidden');
                document.getElementById('store-name-config').scrollIntoView({ behavior: 'smooth' });
            });
        });

        // Delete Store Target
        document.querySelectorAll('.btn-delete-store').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const sName = e.currentTarget.getAttribute('data-store');
                if(confirm(`Yakin ingin menghapus target untuk ${sName}?`)) {
                    // 1. Update cache immediately
                    await window.AppDB.delete(window.AppDB.STORES.STORE_TARGETS, sName);
                    
                    // 2. Queue management
                    const queue = await window.AppDB.getSyncQueue();
                    let removed = false;
                    for (const item of queue) {
                        if (item.action === 'saveStoreTarget' && item.payload && item.payload.storeName === sName) {
                            await window.AppDB.removeFromSyncQueue(item.id);
                            removed = true;
                            break;
                        }
                    }
                    if (!removed) {
                        await window.AppDB.addToSyncQueue('deleteStoreTarget', { storeName: sName });
                    }
                    
                    // 3. Update UI immediately
                    await loadStoreTargets();
                    loadStoreTargetsUI();
                    showToast(`Target ${sName} dihapus`, 'success');

                    if (window.SyncManager.isOnline) {
                        window.SyncManager.syncNow();
                    }
                }
            });
        });
        
        // Populate user management dropdown
        const select = document.getElementById('new-store-assign');
        select.innerHTML = '<option value="">-- Pilih Store --</option>';
        appState.storeTargets.forEach(t => {
            select.innerHTML += `<option value="${t.storeName}">${t.storeName}</option>`;
        });
    }
    document.getElementById('btn-refresh-stores').addEventListener('click', loadStoreTargetsUI);

    // --- PRODUCT MANAGEMENT ---
    elements.forms.product.addEventListener('submit', async (e) => {
        e.preventDefault();
        const productName = document.getElementById('product-name-input').value.trim();
        const pricePerUnit = parseInt(document.getElementById('product-price-input').value) || 0;
        const editKey = document.getElementById('product-edit-key').value;

        const payload = { productName, pricePerUnit };
        
        // 1. Update cache immediately
        await window.AppDB.put(window.AppDB.STORES.PRODUCTS, payload);
        
        // 2. Queue management
        const updatedInQueue = await window.AppDB.updateSyncQueuePayload('saveProduct', productName, payload);
        if (!updatedInQueue) {
            await window.AppDB.addToSyncQueue('saveProduct', payload);
        }
        
        // 3. Update UI immediately
        await loadProducts();
        loadProductsUI();
        showToast(editKey ? 'Produk diperbarui' : 'Produk berhasil disimpan', 'success');

        elements.forms.product.reset();
        document.getElementById('product-edit-key').value = '';
        const submitBtn = document.getElementById('btn-product-submit');
        submitBtn.innerHTML = '<i data-lucide="plus"></i> Simpan Produk';
        document.getElementById('btn-product-cancel').classList.add('hidden');
        if (window.lucide) lucide.createIcons();

        if (window.SyncManager.isOnline) {
            window.SyncManager.syncNow();
        }
    });

    document.getElementById('btn-product-cancel').addEventListener('click', () => {
        elements.forms.product.reset();
        document.getElementById('product-edit-key').value = '';
        const submitBtn = document.getElementById('btn-product-submit');
        submitBtn.innerHTML = '<i data-lucide="plus"></i> Simpan Produk';
        document.getElementById('btn-product-cancel').classList.add('hidden');
        if (window.lucide) lucide.createIcons();
    });

    async function loadProductsUI() {
        await loadProducts();
        const tbody = document.getElementById('products-list-body');
        tbody.innerHTML = '';
        
        if (appState.products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Belum ada produk</td></tr>';
        } else {
            appState.products.forEach(p => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${p.productName}</td>
                    <td>${formatCurrency(p.pricePerUnit)}</td>
                    <td>
                        <div class="action-btns">
                            <button class="btn-action-edit btn-edit-product" data-name="${p.productName}" data-price="${p.pricePerUnit}" title="Edit">
                                <i data-lucide="edit-3"></i>
                            </button>
                            <button class="btn-action-delete btn-delete-product" data-name="${p.productName}" title="Hapus">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
        if (window.lucide) lucide.createIcons();

        document.querySelectorAll('.btn-edit-product').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('product-name-input').value = btn.getAttribute('data-name');
                document.getElementById('product-price-input').value = btn.getAttribute('data-price');
                document.getElementById('product-edit-key').value = btn.getAttribute('data-name');
                const submitBtn = document.getElementById('btn-product-submit');
                submitBtn.innerHTML = '<i data-lucide="save"></i> Update Produk';
                document.getElementById('btn-product-cancel').classList.remove('hidden');
                document.getElementById('product-name-input').scrollIntoView({ behavior: 'smooth' });
                if (window.lucide) lucide.createIcons();
            });
        });

        document.querySelectorAll('.btn-delete-product').forEach(btn => {
            btn.addEventListener('click', async () => {
                const name = btn.getAttribute('data-name');
                if (!confirm(`Yakin ingin menghapus produk "${name}"?`)) return;
                
                // 1. Update cache immediately
                await window.AppDB.delete(window.AppDB.STORES.PRODUCTS, name);
                
                // 2. Queue management
                const queue = await window.AppDB.getSyncQueue();
                let removed = false;
                for (const item of queue) {
                    if (item.action === 'saveProduct' && item.payload && item.payload.productName === name) {
                        await window.AppDB.removeFromSyncQueue(item.id);
                        removed = true;
                        break;
                    }
                }
                if (!removed) {
                    await window.AppDB.addToSyncQueue('deleteProduct', { productName: name });
                }
                
                // 3. Update UI immediately
                await loadProducts();
                loadProductsUI();
                showToast(`Produk "${name}" dihapus`, 'success');

                if (window.SyncManager.isOnline) {
                    window.SyncManager.syncNow();
                }
            });
        });
    }
    document.getElementById('btn-refresh-products').addEventListener('click', loadProductsUI);

    // --- USER MANAGEMENT ---
    elements.forms.user.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('new-username').value.trim();
        const password = document.getElementById('new-password').value.trim();
        const role = document.getElementById('new-role').value;
        const storeName = document.getElementById('new-store-assign').value;
        const editKey = document.getElementById('user-edit-key').value;

        const payload = { id: editKey ? editKey : 'U-'+Date.now(), username, password, role, storeName };
        
        // 1. Update cache immediately
        await window.AppDB.put(window.AppDB.STORES.USERS, payload);
        
        // 2. Queue management
        const updatedInQueue = await window.AppDB.updateSyncQueuePayload('saveUser', username, payload);
        if (!updatedInQueue) {
            await window.AppDB.addToSyncQueue('saveUser', payload);
        }
        
        // 3. Update UI immediately
        loadUsersUI();
        showToast(editKey ? 'User diperbarui' : 'User ditambahkan', 'success');
        
        elements.forms.user.reset();
        document.getElementById('user-edit-key').value = '';
        document.getElementById('btn-user-submit').textContent = 'Simpan User';
        document.getElementById('btn-user-cancel').classList.add('hidden');

        if (window.SyncManager.isOnline) {
            window.SyncManager.syncNow();
        }
    });

    document.getElementById('btn-user-cancel').addEventListener('click', () => {
        elements.forms.user.reset();
        document.getElementById('user-edit-key').value = '';
        document.getElementById('btn-user-submit').textContent = 'Simpan User';
        document.getElementById('btn-user-cancel').classList.add('hidden');
    });

    async function loadUsersUI() {
        const users = await window.AppDB.getAll(window.AppDB.STORES.USERS);
        const tbody = document.getElementById('users-list-body');
        tbody.innerHTML = '';
        
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Belum ada data user</td></tr>';
            return;
        }

        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${u.username}</td>
                <td><span class="badge">${u.role}</span></td>
                <td>${u.storeName}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-action-edit btn-edit-user" data-user="${u.username}" data-role="${u.role}" data-store="${u.storeName}" title="Edit">
                            <i data-lucide="edit-3"></i>
                        </button>
                        <button class="btn-action-delete btn-delete-user" data-user="${u.username}" title="Hapus">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        if (window.lucide) lucide.createIcons();
        
        document.querySelectorAll('.btn-edit-user').forEach(btn => {
            btn.addEventListener('click', () => {
                const uName = btn.getAttribute('data-user');
                const uRole = btn.getAttribute('data-role');
                const uStore = btn.getAttribute('data-store');
                document.getElementById('new-username').value = uName;
                document.getElementById('new-role').value = uRole;
                document.getElementById('new-store-assign').value = uStore;
                document.getElementById('user-edit-key').value = uName;
                document.getElementById('btn-user-submit').textContent = 'Update User';
                document.getElementById('btn-user-cancel').classList.remove('hidden');
                document.getElementById('new-username').scrollIntoView({ behavior: 'smooth' });
            });
        });

        document.querySelectorAll('.btn-delete-user').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const uName = e.currentTarget.getAttribute('data-user');
                if(uName === 'admin') {
                    showToast('Admin default tidak bisa dihapus dari UI', 'error');
                    return;
                }
                if(confirm(`Yakin ingin menghapus user ${uName}?`)) {
                    // 1. Update cache immediately
                    await window.AppDB.delete(window.AppDB.STORES.USERS, uName);
                    
                    // 2. Queue management
                    const queue = await window.AppDB.getSyncQueue();
                    let removed = false;
                    for (const item of queue) {
                        if (item.action === 'saveUser' && item.payload && item.payload.username === uName) {
                            await window.AppDB.removeFromSyncQueue(item.id);
                            removed = true;
                            break;
                        }
                    }
                    if (!removed) {
                        await window.AppDB.addToSyncQueue('deleteUser', { username: uName });
                    }
                    
                    // 3. Update UI immediately
                    loadUsersUI();
                    showToast(`User ${uName} deleted`, 'success');

                    if (window.SyncManager.isOnline) {
                        window.SyncManager.syncNow();
                    }
                }
            });
        });
    }
    
    document.getElementById('btn-refresh-users').addEventListener('click', async () => {
        if (window.SyncManager.isOnline) {
            await window.SyncManager.fetchInitialData();
            loadUsersUI();
            showToast('Data user diperbarui', 'info');
        } else {
            showToast('Harus online untuk menyinkronkan user', 'error');
        }
    });

    // Make functions globally available for navigation triggers
    window.app.loadUsersUI = loadUsersUI;

    // Initial load
    checkAuth();
});
