/**
 * Main Application Logic (app.js)
 * Mengontrol logika UI, form inputs, render analitik, dan integrasi modul DB & Sync.
 */

// State Global Aplikasi
let currentLeads = [];
let validationOptions = { sales: [], channels: [], sources: [], messages: [], blocks: [], mql: [] };
let syncStatusGlobal = { isOnline: false, isSyncing: false, pendingCount: 0 };
let selectedSalesDashboard = 'Semua Sales';
let selectedSourceDashboard = null;
let selectedChannelDashboard = null;

// State Pagination Riwayat
let historyCurrentPage = 1;
const historyItemsPerPage = 50;
let historyFilteredLeads = [];
let historySelectedLeadIds = new Set();

/**
 * Helper: Sanitasi string untuk mencegah XSS & gangguan syntax HTML
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Helper: Ekstrak bagian tanggal YYYY-MM-DD secara konsisten dan aman dari berbagai format string
 */
function getLeadDateOnly(dateVal) {
  if (!dateVal) return '';
  const clean = String(dateVal).replace('T', ' ').trim();
  const firstPart = clean.split(' ')[0];
  
  // Format standar: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(firstPart)) {
    return firstPart;
  }
  
  // Format Indonesia / Eropa: DD/MM/YYYY atau DD-MM-YYYY
  const dmyMatch = firstPart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Format YYYY/MM/DD
  const ymdSlashMatch = firstPart.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (ymdSlashMatch) {
    const year = ymdSlashMatch[1];
    const month = ymdSlashMatch[2].padStart(2, '0');
    const day = ymdSlashMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return firstPart.substring(0, 10);
}

/**
 * Helper: Mengubah nilai tanggal leads ke unix timestamp secara aman cross-browser (termasuk Safari iOS/Mac)
 */
function parseLeadDateToTime(dateVal) {
  if (!dateVal) return 0;
  const clean = String(dateVal).trim();
  const isoLike = clean.replace(' ', 'T');
  let t = new Date(isoLike).getTime();
  if (!isNaN(t) && t > 0) return t;

  const ymd = getLeadDateOnly(clean);
  if (ymd) {
    const timePart = clean.includes(' ') ? clean.split(' ')[1] : '00:00:00';
    t = new Date(`${ymd}T${timePart}`).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return 0;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Inisialisasi Database
  try {
    await window.soviaDb.init();
    console.log('IndexedDB siap digunakan.');
  } catch (err) {
    showToast('Gagal memuat database lokal: ' + err.message, 'error');
    return;
  }

  // 2. Load URL GAS dari LocalStorage (dengan default URL Web App Anda)
  const defaultGasUrl = window.SOVIA_DEFAULT_GAS_URL || 'https://script.google.com/macros/s/AKfycbzZYlAh4oe5ZwRJAFNRZ-e31m_opHnxzBM8qDjAvHSj5XZkq-l8nJm5LjFhKLVFDqlkjw/exec';
  let savedUrl = localStorage.getItem('sovia_gas_url');
  if (!savedUrl) {
    savedUrl = defaultGasUrl;
    localStorage.setItem('sovia_gas_url', savedUrl);
  }
  const gasInput = document.getElementById('gas-url-input');
  if (gasInput) gasInput.value = savedUrl;

  // 3. Set Filter Tanggal secara default
  setDefaultDashboardDates();
  resetHistoryDateFilter(false); // Init without triggering render yet

  // 4. Inisialisasi Event Listener Sinkronisasi
  window.soviaSync.onStatusChange((status) => {
    syncStatusGlobal = status;
    updateSyncUIStatus(status);
  });

  // Listener untuk event pembaruan data
  window.addEventListener('sovia-data-updated', async () => {
    await loadLocalDataAndRefreshUI();
    showToast('Data diperbarui dan disinkronkan!', 'success');
  });

  // 5. Muat Data Lokal Pertama Kali (agar validationOptions terisi untuk dropdown)
  await loadLocalDataAndRefreshUI();

  // 6. Inisialisasi Form Input Leads
  resetLeadForm();

  // 7. Jika Online, jalankan sinkronisasi awal secara background
  if (navigator.onLine && savedUrl) {
    window.soviaSync.syncNow();
  }
});

/**
 * Memuat ulang data dari IndexedDB ke variabel global lalu merender ulang UI
 */
async function loadLocalDataAndRefreshUI() {
  try {
    currentLeads = await window.soviaDb.getLeads();
    validationOptions = await window.soviaDb.getValidationOptions();

    // Urutkan leads berdasarkan tanggal leads terbaru di paling atas secara aman
    currentLeads.sort((a, b) => {
      const timeA = parseLeadDateToTime(a['Tanggal Leads']);
      const timeB = parseLeadDateToTime(b['Tanggal Leads']);
      if (timeB !== timeA) return timeB - timeA;
      return String(b['ID Leads'] || '').localeCompare(String(a['ID Leads'] || ''));
    });

    // Bersihkan ID yang sudah tidak ada di database dari daftar seleksi massal
    if (historySelectedLeadIds.size > 0) {
      const activeIds = new Set(currentLeads.map(l => String(l['ID Leads'] || '').trim()));
      for (const selId of historySelectedLeadIds) {
        if (!activeIds.has(selId)) {
          historySelectedLeadIds.delete(selId);
        }
      }
    }

    // Rerender seluruh komponen UI
    renderDropdownSelectors();
    filterHistoryTable();
    renderDashboard();
    renderValidationLists();
  } catch (err) {
    console.error('Gagal memuat data lokal:', err);
    showToast('Gagal memuat data lokal: ' + (err.message || err), 'error');
  }
}

/**
 * Navigasi Panel (SPA Switcher)
 */
function switchPanel(panelId) {
  // Sembunyikan semua panel
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  // Nonaktifkan semua link menu
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

  // Tampilkan panel aktif
  document.getElementById(`panel-${panelId}`).classList.add('active');
  // Set aktif pada menu link sidebar
  document.getElementById(`nav-${panelId}`).classList.add('active');

  // Aksi spesifik saat ganti panel
  if (panelId === 'dashboard') {
    renderDashboard();
  }
}

/**
 * Konfigurasi UI Sinkronisasi di Sidebar
 */
function updateSyncUIStatus(status) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const count = document.getElementById('queue-count');
  const syncBtn = document.getElementById('btn-sync-now');

  // Update Status Online/Offline
  if (status.isOnline) {
    dot.className = 'status-dot online';
    label.innerText = 'Online - Terkoneksi';
  } else {
    dot.className = 'status-dot offline';
    label.innerText = 'Offline - Mode Lokal';
  }

  // Update Jumlah Antrean
  count.innerText = status.pendingCount;

  // Animasi Tombol Sync saat syncing
  if (status.isSyncing) {
    syncBtn.classList.add('syncing');
    syncBtn.disabled = true;
    syncBtn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>
      Syncing...
    `;
  } else {
    syncBtn.classList.remove('syncing');
    syncBtn.disabled = false;
    syncBtn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
      Sync Sekarang
    `;
  }
}

/**
 * Memicu sinkronisasi manual saat tombol diklik
 */
async function triggerManualSync() {
  if (!syncStatusGlobal.isOnline) {
    showToast('Tidak dapat mensinkronkan: Browser sedang offline.', 'error');
    return;
  }
  showToast('Memulai sinkronisasi data...', 'info');
  const success = await window.soviaSync.syncNow();
  if (success) {
    showToast('Sinkronisasi selesai dengan sukses!', 'success');
  } else {
    showToast('Sinkronisasi gagal. Periksa URL API Anda.', 'error');
  }
}

/**
 * Menyimpan URL Google Apps Script Web App
 */
function saveGasUrl() {
  const url = document.getElementById('gas-url-input').value.trim();
  if (url) {
    if (!url.startsWith('https://script.google.com/')) {
      showToast('Format URL Google Apps Script tidak valid.', 'error');
      return;
    }
    if (url.includes('/edit')) {
      showToast('Perhatian: Anda memasukkan URL editor skrip. Pastikan deploy dan gunakan Web App URL (/exec).', 'warning');
    }
  }
  
  window.soviaSync.setWebAppUrl(url);
  showToast('URL Google Apps Script disimpan.', 'success');
  
  if (url && navigator.onLine) {
    window.soviaSync.syncNow();
  }
}

/* ==========================================================================
   FORM LEADS OPERATIONS
   ========================================================================== */

/**
 * Menghasilkan ID Leads Otomatis yang unik dan tahan tabrakan (collision-proof): SVJ-YYMMDD-HHMMSSMS-RND4
 */
function generateLeadId() {
  const now = new Date();
  const yy = String(now.getFullYear()).substring(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  
  // Random string 4 karakter (36^4 = 1.679.616 kemungkinan)
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 4; i++) {
    randomStr += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  
  const generatedId = `SVJ-${yy}${mm}${dd}-${hh}${min}${ss}${ms}-${randomStr}`;
  const leadIdInput = document.getElementById('lead-id');
  if (leadIdInput) {
    leadIdInput.value = generatedId;
  }
  return generatedId;
}

/**
 * Inisialisasi Tanggal Leads ke Realtime lokal
 */
function initializeLeadDate() {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(now - tzOffset)).toISOString().slice(0, 16);
  document.getElementById('lead-date').value = localISOTime;
}

/**
 * Fungsi pembantu umum untuk menyembunyikan/menampilkan tombol hapus baris dinamis
 */
function updateRemoveButtonsVisibility(containerId, rowClass, btnClass) {
  const rows = document.querySelectorAll(`#${containerId} .${rowClass}`);
  rows.forEach(row => {
    const btn = row.querySelector(`.${btnClass}`);
    if (btn) {
      if (rows.length <= 1) {
        btn.style.display = 'none';
      } else {
        btn.style.display = 'flex';
      }
    }
  });
}

/**
 * Menambahkan satu baris item pada form rekapitulasi leads
 * @param {string} sourceVal - Sumber leads terpilih
 * @param {string} messageVal - Jenis pesan terpilih
 * @param {number} qtyVal - Jumlah leads
 * @param {Array|string} contactsVal - Daftar kontak / nomor HP (jika ada)
 */
function addLeadItemRow(sourceVal = '', messageVal = '', qtyVal = 1, contactsVal = []) {
  const container = document.getElementById('leads-items-container');
  if (!container) return;

  const rowId = `lead-item-row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Normalisasi data kontak ke array
  let contactsList = [];
  if (Array.isArray(contactsVal)) {
    contactsList = contactsVal.map(c => String(c).trim()).filter(Boolean);
  } else if (contactsVal && contactsVal !== '-') {
    contactsList = String(contactsVal).split(',').map(c => c.trim()).filter(Boolean);
  }

  const hasContacts = contactsList.length > 0;
  const initialQty = hasContacts ? contactsList.length : (qtyVal || 1);

  let sourceOptionsHtml = '<option value="">-- Pilih Sumber --</option>';
  (validationOptions.sources || []).forEach(opt => {
    sourceOptionsHtml += `<option value="${escapeHtml(opt)}" ${opt === sourceVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });

  let messageOptionsHtml = '<option value="">-- Pilih Jenis Pesan --</option>';
  (validationOptions.messages || []).forEach(opt => {
    messageOptionsHtml += `<option value="${escapeHtml(opt)}" ${opt === messageVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });

  const rowHtml = `
    <div class="lead-item-row" id="${rowId}">
      <div class="lead-item-main-grid">
        <div class="form-group">
          <label>Sumber Leads</label>
          <select class="form-control lead-item-source">
            ${sourceOptionsHtml}
          </select>
        </div>
        <div class="form-group">
          <label>Jenis Pesan</label>
          <select class="form-control lead-item-message">
            ${messageOptionsHtml}
          </select>
        </div>
        <div class="contact-toggle-wrapper">
          <label class="contact-toggle-label ${hasContacts ? 'active' : ''}" id="toggle-label-${rowId}">
            <input type="checkbox" class="lead-item-contact-toggle" ${hasContacts ? 'checked' : ''} onchange="toggleContactMode('${rowId}')">
            <span>Input Kontak / No HP</span>
          </label>
        </div>
        <div class="form-group">
          <label>Qty / Jumlah</label>
          <input type="number" class="form-control lead-item-qty ${hasContacts ? 'qty-auto-disabled' : ''}" min="1" value="${initialQty}" ${hasContacts ? 'disabled' : ''} title="${hasContacts ? 'Qty terisi otomatis berdasarkan jumlah kontak' : 'Isi jumlah leads'}">
        </div>
        <button type="button" class="btn-action delete btn-remove-item-row" onclick="removeLeadItemRow('${rowId}')" style="height: 42px; width: 42px; display: flex; align-items: center; justify-content: center; background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px;" title="Hapus Baris">
          <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>

      <!-- Container Multiple Baris Kontak / Nomor HP -->
      <div class="lead-item-contacts-container" id="contacts-container-${rowId}" style="display: ${hasContacts ? 'block' : 'none'};">
        <div class="contacts-header-bar">
          <div class="contacts-header-title">
            <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
            Daftar Kontak / No HP
            <span class="badge synced contact-count-badge" id="contact-badge-${rowId}">${hasContacts ? contactsList.length + ' Nomor Diisi' : '0 Nomor Diisi'}</span>
          </div>
          <button type="button" class="btn-add-contact-sub" onclick="addContactSubRow('${rowId}')">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M12 5v14M5 12h14"/></svg>
            Tambah Kontak
          </button>
        </div>
        
        <div class="contacts-list-grid" id="contacts-list-${rowId}">
          <!-- Sub-baris kontak diisi via JS -->
        </div>
        <p style="font-size: 0.75rem; color: var(--text-muted); margin: 0; font-style: italic;">
          * Tips: Anda dapat mem-paste beberapa nomor sekaligus (dipisahkan koma atau baris baru). Kolom Qty otomatis terkunci dan terisi sesuai jumlah kontak.
        </p>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);

  // Inisialisasi sub-baris kontak
  if (hasContacts) {
    contactsList.forEach(c => addContactSubRow(rowId, c, false));
    updateContactRowIndices(rowId);
  } else {
    // Siapkan 1 baris kosong awal jika nanti diaktifkan
    addContactSubRow(rowId, '', false);
    updateContactRowIndices(rowId);
  }

  updateRemoveButtonsVisibility('leads-items-container', 'lead-item-row', 'btn-remove-item-row');
}

/**
 * Toggle mode input kontak / no hp untuk baris rekap
 */
function toggleContactMode(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;

  const toggle = row.querySelector('.lead-item-contact-toggle');
  const toggleLabel = document.getElementById(`toggle-label-${rowId}`);
  const contactsContainer = document.getElementById(`contacts-container-${rowId}`);
  const qtyInput = row.querySelector('.lead-item-qty');

  if (!toggle || !contactsContainer || !qtyInput) return;

  if (toggle.checked) {
    contactsContainer.style.display = 'block';
    if (toggleLabel) toggleLabel.classList.add('active');
    qtyInput.disabled = true;
    qtyInput.classList.add('qty-auto-disabled');
    qtyInput.title = 'Qty terisi otomatis berdasarkan jumlah kontak yang diinput.';
    
    // Pastikan minimal ada 1 sub-row
    const subRows = row.querySelectorAll('.contact-sub-row');
    if (subRows.length === 0) {
      addContactSubRow(rowId, '', false);
      updateContactRowIndices(rowId);
    }
    updateContactQtyForRow(rowId);
  } else {
    contactsContainer.style.display = 'none';
    if (toggleLabel) toggleLabel.classList.remove('active');
    qtyInput.disabled = false;
    qtyInput.classList.remove('qty-auto-disabled');
    qtyInput.title = 'Isi jumlah leads secara manual.';
    if (!qtyInput.value || parseInt(qtyInput.value, 10) <= 0) {
      qtyInput.value = 1;
    }
  }
}

/**
 * Menambahkan 1 sub-baris kontak ke dalam lead item row
 */
function addContactSubRow(rowId, val = '', autoUpdate = true) {
  const listContainer = document.getElementById(`contacts-list-${rowId}`);
  if (!listContainer) return;

  const subRowHtml = `
    <div class="contact-sub-row">
      <span class="contact-index">#1</span>
      <input type="text" class="form-control contact-phone-input" placeholder="Contoh: 08123456789 atau nama customer" value="${escapeHtml(val)}" oninput="onContactInputChanged('${rowId}')" onpaste="handleContactPaste(event, '${rowId}')">
      <button type="button" class="btn-remove-contact-sub" onclick="removeContactSubRow(this, '${rowId}')" title="Hapus kontak ini">
        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
  `;
  listContainer.insertAdjacentHTML('beforeend', subRowHtml);
  updateContactRowIndices(rowId);

  if (autoUpdate) {
    updateContactQtyForRow(rowId);
  }
}

/**
 * Menghapus 1 sub-baris kontak
 */
function removeContactSubRow(btnEl, rowId) {
  const subRow = btnEl.closest('.contact-sub-row');
  if (subRow) {
    subRow.remove();
  }
  const listContainer = document.getElementById(`contacts-list-${rowId}`);
  if (listContainer && listContainer.querySelectorAll('.contact-sub-row').length === 0) {
    addContactSubRow(rowId, '', false);
  }
  updateContactRowIndices(rowId);
  updateContactQtyForRow(rowId);
}

/**
 * Update penomoran indeks sub-baris kontak (#1, #2, dst)
 */
function updateContactRowIndices(rowId) {
  const listContainer = document.getElementById(`contacts-list-${rowId}`);
  if (!listContainer) return;
  const subRows = listContainer.querySelectorAll('.contact-sub-row');
  subRows.forEach((row, idx) => {
    const idxEl = row.querySelector('.contact-index');
    if (idxEl) idxEl.innerText = `#${idx + 1}`;
  });
}

/**
 * Event handler saat input kontak berubah
 */
function onContactInputChanged(rowId) {
  updateContactQtyForRow(rowId);
}

/**
 * Update otomatis Qty dan Badge berdasarkan jumlah kontak yang diisi
 */
function updateContactQtyForRow(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;

  const toggle = row.querySelector('.lead-item-contact-toggle');
  const qtyInput = row.querySelector('.lead-item-qty');
  const badge = document.getElementById(`contact-badge-${rowId}`);
  if (!toggle || !qtyInput) return;

  if (toggle.checked) {
    qtyInput.disabled = true;
    qtyInput.classList.add('qty-auto-disabled');

    const inputs = row.querySelectorAll('.contact-phone-input');
    const filledValues = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
    const count = filledValues.length;

    qtyInput.value = count > 0 ? count : (inputs.length > 0 ? inputs.length : 1);

    if (badge) {
      badge.innerText = `${count} Nomor Diisi`;
    }
  } else {
    qtyInput.disabled = false;
    qtyInput.classList.remove('qty-auto-disabled');
  }
}

/**
 * Handler paste pintar: memisahkan nomor otomatis jika paste banyak nomor
 */
function handleContactPaste(event, rowId) {
  const pasteData = (event.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!pasteData) return;

  const numbers = pasteData.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
  if (numbers.length > 1) {
    event.preventDefault();
    const listContainer = document.getElementById(`contacts-list-${rowId}`);
    if (!listContainer) return;

    listContainer.innerHTML = '';
    numbers.forEach(num => {
      addContactSubRow(rowId, num, false);
    });
    updateContactRowIndices(rowId);
    updateContactQtyForRow(rowId);
    showToast(`Berhasil menambahkan ${numbers.length} nomor kontak dari teks yang di-paste.`, 'info');
  }
}

/**
 * Menghapus baris item tertentu dari form rekapitulasi leads
 */
function removeLeadItemRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    row.remove();
  }
  updateRemoveButtonsVisibility('leads-items-container', 'lead-item-row', 'btn-remove-item-row');
}

/**
 * Menambahkan satu baris item Chat Terhenti
 */
function addTerhentiRow(blockVal = '', qtyVal = 1) {
  const container = document.getElementById('terhenti-items-container');
  if (!container) return;

  const rowId = `terhenti-item-row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  let blockOptionsHtml = '<option value="">-- Pilih Block/Lose --</option>';
  (validationOptions.blocks || []).forEach(opt => {
    blockOptionsHtml += `<option value="${escapeHtml(opt)}" ${opt === blockVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });

  const rowHtml = `
    <div class="terhenti-item-row" id="${rowId}">
      <div class="form-group">
        <label>Block Lose</label>
        <select class="form-control terhenti-item-block">
          ${blockOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Qty / Jumlah</label>
        <input type="number" class="form-control terhenti-item-qty" min="1" value="${qtyVal}">
      </div>
      <button type="button" class="btn-action delete btn-remove-terhenti-row" onclick="removeTerhentiRow('${rowId}')" style="height: 42px; width: 42px; display: flex; align-items: center; justify-content: center; background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px;" title="Hapus Baris">
        <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
  updateRemoveButtonsVisibility('terhenti-items-container', 'terhenti-item-row', 'btn-remove-terhenti-row');
}

/**
 * Menghapus baris item Chat Terhenti
 */
function removeTerhentiRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    row.remove();
  }
  updateRemoveButtonsVisibility('terhenti-items-container', 'terhenti-item-row', 'btn-remove-terhenti-row');
}

/**
 * Menambahkan satu baris item Chat Lama
 */
function addLamaRow(mqlVal = '', qtyVal = 1) {
  const container = document.getElementById('lama-items-container');
  if (!container) return;

  const rowId = `lama-item-row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  let mqlOptionsHtml = '<option value="">-- Pilih MQL --</option>';
  (validationOptions.mql || []).forEach(opt => {
    mqlOptionsHtml += `<option value="${escapeHtml(opt)}" ${opt === mqlVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });

  const rowHtml = `
    <div class="lama-item-row" id="${rowId}">
      <div class="form-group">
        <label>MQL</label>
        <select class="form-control lama-item-mql">
          ${mqlOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Qty / Jumlah</label>
        <input type="number" class="form-control lama-item-qty" min="1" value="${qtyVal}">
      </div>
      <button type="button" class="btn-action delete btn-remove-lama-row" onclick="removeLamaRow('${rowId}')" style="height: 42px; width: 42px; display: flex; align-items: center; justify-content: center; background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px;" title="Hapus Baris">
        <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
  updateRemoveButtonsVisibility('lama-items-container', 'lama-item-row', 'btn-remove-lama-row');
}

/**
 * Menghapus baris item Chat Lama
 */
function removeLamaRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    row.remove();
  }
  updateRemoveButtonsVisibility('lama-items-container', 'lama-item-row', 'btn-remove-lama-row');
}

/**
 * Mengisi opsi pilihan dropdown pada form leads dari database lokal
 */
function renderDropdownSelectors() {
  const salesDropdown = document.getElementById('lead-sales');
  const channelDropdown = document.getElementById('lead-channel');
  if (!salesDropdown || !channelDropdown) return;

  const currentSales = salesDropdown.value;
  const currentChannel = channelDropdown.value;

  // Bersihkan opsi lama, bangun HTML string secara batch
  let salesHtml = '<option value="">-- Pilih Sales --</option>';
  (validationOptions.sales || []).forEach(opt => {
    salesHtml += `<option value="${escapeHtml(opt)}" ${opt === currentSales ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });
  salesDropdown.innerHTML = salesHtml;

  let channelHtml = '<option value="">-- Pilih Channel --</option>';
  (validationOptions.channels || []).forEach(opt => {
    channelHtml += `<option value="${escapeHtml(opt)}" ${opt === currentChannel ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });
  channelDropdown.innerHTML = channelHtml;

  // Isi dropdown di baris dynamic item yang ada (Rekap)
  const sourceDropdowns = document.querySelectorAll('.lead-item-source');
  sourceDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    let html = '<option value="">-- Pilih Sumber --</option>';
    (validationOptions.sources || []).forEach(opt => {
      html += `<option value="${escapeHtml(opt)}" ${opt === currentVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
    });
    dropdown.innerHTML = html;
  });

  const messageDropdowns = document.querySelectorAll('.lead-item-message');
  messageDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    let html = '<option value="">-- Pilih Jenis Pesan --</option>';
    (validationOptions.messages || []).forEach(opt => {
      html += `<option value="${escapeHtml(opt)}" ${opt === currentVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
    });
    dropdown.innerHTML = html;
  });

  // Isi dropdown Block Lose di Chat Terhenti
  const blockDropdowns = document.querySelectorAll('.terhenti-item-block');
  blockDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    let html = '<option value="">-- Pilih Block/Lose --</option>';
    (validationOptions.blocks || []).forEach(opt => {
      html += `<option value="${escapeHtml(opt)}" ${opt === currentVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
    });
    dropdown.innerHTML = html;
  });

  // Isi dropdown MQL di Chat Lama
  const mqlDropdowns = document.querySelectorAll('.lama-item-mql');
  mqlDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    let html = '<option value="">-- Pilih MQL --</option>';
    (validationOptions.mql || []).forEach(opt => {
      html += `<option value="${escapeHtml(opt)}" ${opt === currentVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
    });
    dropdown.innerHTML = html;
  });
}

/**
 * Handle submit dari form leads (Simpan / Edit)
 */
async function handleLeadSubmit(event) {
  event.preventDefault();

  try {
    const mode = document.getElementById('form-mode').value;
    let idLeads = document.getElementById('lead-id').value;
    
    // Format Tanggal untuk disimpan di DB Sheets (YYYY-MM-DD HH:mm:ss)
    const inputDateTime = document.getElementById('lead-date').value;
    let formattedDate = '';
    if (inputDateTime) {
      let clean = inputDateTime.replace('T', ' ');
      if (clean.length === 16) clean += ':00';
      formattedDate = clean;
    } else {
      formattedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    const salesName = document.getElementById('lead-sales').value;
    const channelName = document.getElementById('lead-channel').value;

    if (!salesName || !channelName) {
      showToast('Harap pilih Nama Sales dan Sumber Channel terlebih dahulu!', 'warning');
      return;
    }

    if (mode === 'create') {
      // Pastikan ID tidak kosong atau tidak sengaja bentrok dengan data lokal yang sudah ada
      if (!idLeads || currentLeads.some(l => l['ID Leads'] === idLeads)) {
        idLeads = generateLeadId();
      }

      const rowsToSave = [];

      // 1. Rekapitulasi Leads
      const rekapRows = document.querySelectorAll('.lead-item-row');
      rekapRows.forEach((row, i) => {
        const source = row.querySelector('.lead-item-source')?.value || '';
        const message = row.querySelector('.lead-item-message')?.value || '';
        
        const toggle = row.querySelector('.lead-item-contact-toggle');
        const isContactActive = toggle && toggle.checked;

        let contacts = [];
        if (isContactActive) {
          const contactInputs = row.querySelectorAll('.contact-phone-input');
          contacts = Array.from(contactInputs).map(inp => inp.value.trim()).filter(Boolean);
        }

        let qty = 1;
        if (isContactActive) {
          qty = contacts.length > 0 ? contacts.length : 1;
        } else {
          qty = parseInt(row.querySelector('.lead-item-qty')?.value, 10) || 1;
        }

        const contactStr = (isContactActive && contacts.length > 0) ? contacts.join(', ') : '-';

        if (source || message || contacts.length > 0) {
          rowsToSave.push({
            type: 'rekap',
            tempId: `${idLeads}-R${i + 1}`,
            data: {
              'Sumber Leads': source || '-',
              'Jenis Pesan': message || '-',
              'Block Lose': '-',
              'MQL': '-',
              'Kontak / No HP': contactStr,
              'Kontak': contactStr,
              'Kontak List': contacts,
              'Qty': qty
            }
          });
        }
      });

      // 2. Chat Terhenti
      const terhentiRows = document.querySelectorAll('.terhenti-item-row');
      terhentiRows.forEach((row, i) => {
        const block = row.querySelector('.terhenti-item-block')?.value || '';
        const qty = parseInt(row.querySelector('.terhenti-item-qty')?.value, 10) || 1;
        if (block) {
          rowsToSave.push({
            type: 'terhenti',
            tempId: `${idLeads}-T${i + 1}`,
            data: {
              'Sumber Leads': '-',
              'Jenis Pesan': '-',
              'Block Lose': block,
              'MQL': '-',
              'Kontak / No HP': '-',
              'Kontak': '-',
              'Kontak List': [],
              'Qty': qty
            }
          });
        }
      });

      // 3. Chat Lama
      const lamaRows = document.querySelectorAll('.lama-item-row');
      lamaRows.forEach((row, i) => {
        const mql = row.querySelector('.lama-item-mql')?.value || '';
        const qty = parseInt(row.querySelector('.lama-item-qty')?.value, 10) || 1;
        if (mql) {
          rowsToSave.push({
            type: 'lama',
            tempId: `${idLeads}-L${i + 1}`,
            data: {
              'Sumber Leads': '-',
              'Jenis Pesan': '-',
              'Block Lose': '-',
              'MQL': mql,
              'Kontak / No HP': '-',
              'Kontak': '-',
              'Kontak List': [],
              'Qty': qty
            }
          });
        }
      });

      if (rowsToSave.length === 0) {
        showToast('Harap isi minimal 1 baris item Leads, Chat Terhenti, atau Chat Lama!', 'warning');
        return;
      }

      // Jika hanya ada 1 item dari seluruh kategori, pertahankan base ID asli
      if (rowsToSave.length === 1) {
        rowsToSave[0].tempId = idLeads;
      }

      // Simpan masing-masing baris item rekapitulasi ke DB lokal & server queue
      for (let i = 0; i < rowsToSave.length; i++) {
        const item = rowsToSave[i];
        const leadData = {
          'ID Leads': item.tempId,
          'Tanggal Leads': formattedDate,
          'Nama Sales': salesName,
          'Sumber Channel': channelName,
          'Sumber Leads': item.data['Sumber Leads'],
          'Jenis Pesan': item.data['Jenis Pesan'],
          'Block Lose': item.data['Block Lose'],
          'MQL': item.data['MQL'],
          'Kontak / No HP': item.data['Kontak / No HP'] || '-',
          'Kontak': item.data['Kontak'] || '-',
          'Kontak List': item.data['Kontak List'] || [],
          'Qty': item.data['Qty'],
          'Timestamp Created': new Date().toISOString(),
          'Timestamp Updated': new Date().toISOString(),
          'Status': 'Active'
        };

        // 1. Simpan Lokal ke IndexedDB
        await window.soviaDb.saveLead(leadData);

        // 2. Antrekan ke Sync Queue
        await window.soviaDb.addToQueue('create_lead', item.tempId, null, leadData);
      }

      showToast(`Berhasil menyimpan ${rowsToSave.length} rekap leads secara lokal.`, 'success');

    } else {
      // Edit mode (hanya 1 baris item terpilih yang di-update)
      let source = '-';
      let message = '-';
      let block = '-';
      let mql = '-';
      let qty = 1;
      let contactStr = '-';
      let contacts = [];

      const rekapSection = document.getElementById('leads-items-container')?.parentElement;
      const terhentiSection = document.getElementById('terhenti-items-container')?.parentElement;
      const lamaSection = document.getElementById('lama-items-container')?.parentElement;

      const rekapRow = document.querySelector('.lead-item-row');
      const terhentiRow = document.querySelector('.terhenti-item-row');
      const lamaRow = document.querySelector('.lama-item-row');

      if (rekapSection && rekapSection.style.display !== 'none' && rekapRow) {
        source = rekapRow.querySelector('.lead-item-source')?.value || '-';
        message = rekapRow.querySelector('.lead-item-message')?.value || '-';
        const toggle = rekapRow.querySelector('.lead-item-contact-toggle');
        const isContactActive = toggle && toggle.checked;
        if (isContactActive) {
          const contactInputs = rekapRow.querySelectorAll('.contact-phone-input');
          contacts = Array.from(contactInputs).map(inp => inp.value.trim()).filter(Boolean);
          qty = contacts.length > 0 ? contacts.length : 1;
          contactStr = contacts.length > 0 ? contacts.join(', ') : '-';
        } else {
          qty = parseInt(rekapRow.querySelector('.lead-item-qty')?.value, 10) || 1;
          contactStr = '-';
        }
      } else if (terhentiSection && terhentiSection.style.display !== 'none' && terhentiRow) {
        block = terhentiRow.querySelector('.terhenti-item-block')?.value || '-';
        qty = parseInt(terhentiRow.querySelector('.terhenti-item-qty')?.value, 10) || 1;
      } else if (lamaSection && lamaSection.style.display !== 'none' && lamaRow) {
        mql = lamaRow.querySelector('.lama-item-mql')?.value || '-';
        qty = parseInt(lamaRow.querySelector('.lama-item-qty')?.value, 10) || 1;
      }

      const existingLead = currentLeads.find(l => l['ID Leads'] === idLeads);
      const originalCreated = (existingLead && existingLead['Timestamp Created']) ? existingLead['Timestamp Created'] : new Date().toISOString();

      const leadData = {
        'ID Leads': idLeads,
        'Tanggal Leads': formattedDate,
        'Nama Sales': salesName,
        'Sumber Channel': channelName,
        'Sumber Leads': source,
        'Jenis Pesan': message,
        'Block Lose': block,
        'MQL': mql,
        'Kontak / No HP': contactStr,
        'Kontak': contactStr,
        'Kontak List': contacts,
        'Qty': qty,
        'Timestamp Created': originalCreated,
        'Timestamp Updated': new Date().toISOString(),
        'Status': 'Active'
      };

      // 1. Simpan Lokal ke IndexedDB
      await window.soviaDb.saveLead(leadData);

      // 2. Antrekan ke Sync Queue
      await window.soviaDb.addToQueue('update_lead', idLeads, null, leadData);

      showToast(`Lead ${idLeads} diperbarui secara lokal.`, 'success');
    }

    // 4. Bersihkan Form
    resetLeadForm();

    // 5. Muat ulang data & trigger sinkronisasi
    await loadLocalDataAndRefreshUI();
    
    if (navigator.onLine && window.soviaSync) {
      window.soviaSync.syncNow().catch(e => {
        console.warn('Sync background error setelah submit:', e);
      });
    }
  } catch (error) {
    console.error('Gagal memproses submit lead:', error);
    showToast(`Gagal menyimpan data: ${error.message || error}`, 'error');
  }
}

/**
 * Mengatur UI Form untuk mengedit lead
 */
async function editLead(leadId) {
  const lead = currentLeads.find(l => l['ID Leads'] === leadId);
  if (!lead) return;

  // Pindahkan view ke form leads
  switchPanel('leads');

  // Isi data ke form
  document.getElementById('form-mode').value = 'edit';
  document.getElementById('lead-id').value = lead['ID Leads'];
  
  // Convert format tanggal dari 'YYYY-MM-DD HH:mm:ss' ke 'YYYY-MM-DDTHH:mm' untuk input datetime-local
  const rawDate = lead['Tanggal Leads'] || '';
  const cleanDate = rawDate.replace(' ', 'T').substring(0, 16);
  document.getElementById('lead-date').value = cleanDate;
  
  document.getElementById('lead-sales').value = lead['Nama Sales'] || '';
  document.getElementById('lead-channel').value = lead['Sumber Channel'] || '';

  // Dapatkan element section dan container
  const rekapSection = document.getElementById('leads-items-container').parentElement;
  const terhentiSection = document.getElementById('terhenti-items-container').parentElement;
  const lamaSection = document.getElementById('lama-items-container').parentElement;

  // Bersihkan input container terlebih dahulu
  document.getElementById('leads-items-container').innerHTML = '';
  document.getElementById('terhenti-items-container').innerHTML = '';
  document.getElementById('lama-items-container').innerHTML = '';

  // Deteksi jenis data lead berdasarkan propertinya
  const hasBlock = lead['Block Lose'] && lead['Block Lose'] !== '-';
  const hasMQL = lead['MQL'] && lead['MQL'] !== '-';

  if (hasBlock) {
    // Tampilkan hanya bagian input Chat Terhenti
    rekapSection.style.display = 'none';
    terhentiSection.style.display = 'block';
    lamaSection.style.display = 'none';
    addTerhentiRow(lead['Block Lose'], lead['Qty']);
  } else if (hasMQL) {
    // Tampilkan hanya bagian input Chat Lama
    rekapSection.style.display = 'none';
    terhentiSection.style.display = 'none';
    lamaSection.style.display = 'block';
    addLamaRow(lead['MQL'], lead['Qty']);
  } else {
    // Tampilkan hanya bagian input Rekapitulasi Leads
    rekapSection.style.display = 'block';
    terhentiSection.style.display = 'none';
    lamaSection.style.display = 'none';
    
    const rawContact = lead['Kontak / No HP'] || lead['Kontak'] || '';
    let contactsList = [];
    if (Array.isArray(lead['Kontak List']) && lead['Kontak List'].length > 0) {
      contactsList = lead['Kontak List'];
    } else if (rawContact && rawContact !== '-') {
      contactsList = String(rawContact).split(',').map(s => s.trim()).filter(Boolean);
    }
    addLeadItemRow(lead['Sumber Leads'], lead['Jenis Pesan'], lead['Qty'], contactsList);
  }

  // Sembunyikan semua tombol "Tambah Baris" saat mode edit
  document.getElementById('btn-add-item-row').style.display = 'none';
  document.getElementById('btn-add-terhenti-row').style.display = 'none';
  document.getElementById('btn-add-lama-row').style.display = 'none';

  // Ganti Tulisan Tombol
  const submitBtn = document.getElementById('btn-submit-lead');
  if (submitBtn) {
    submitBtn.innerText = 'Perbarui Rekap';
    submitBtn.classList.add('editing');
  }
  
  showToast(`Mengedit lead ${leadId}`, 'info');
}

/**
 * Menghapus lead secara aman (lokal IndexedDB + antrean sinkronisasi server)
 */
async function deleteLead(leadId) {
  if (!confirm(`Apakah Anda yakin ingin menghapus data leads ${leadId}?`)) {
    return;
  }
  try {
    // 1. Hapus secara lokal dari IndexedDB
    await window.soviaDb.deleteLead(leadId);

    // 2. Tambahkan aksi delete_lead ke antrean sinkronisasi
    await window.soviaDb.addToQueue('delete_lead', leadId, null, null);

    // Bersihkan dari seleksi massal jika ada
    historySelectedLeadIds.delete(leadId);
    updateBulkDeleteUI();

    showToast(`Lead ${leadId} berhasil dihapus secara lokal.`, 'success');

    // 3. Refresh UI & Sinkronisasi
    await loadLocalDataAndRefreshUI();
    
    if (navigator.onLine && window.soviaSync) {
      window.soviaSync.syncNow().catch(e => {
        console.warn('Sync background error setelah delete lead:', e);
      });
    }
  } catch (error) {
    console.error(`Gagal menghapus lead ${leadId}:`, error);
    showToast(`Gagal menghapus lead: ${error.message || error}`, 'error');
  }
}

/**
 * Mengatur pilihan "Select All" pada halaman riwayat yang sedang aktif
 */
function toggleSelectAllLeads(isChecked) {
  const startIndex = (historyCurrentPage - 1) * historyItemsPerPage;
  const endIndex = startIndex + historyItemsPerPage;
  const displayLeads = historyFilteredLeads.slice(startIndex, endIndex);

  displayLeads.forEach(lead => {
    const id = String(lead['ID Leads'] || '').trim();
    if (!id) return;
    if (isChecked) {
      historySelectedLeadIds.add(id);
    } else {
      historySelectedLeadIds.delete(id);
    }
  });

  // Perbarui status checked pada checkbox baris di DOM secara langsung
  const checkboxes = document.querySelectorAll('.lead-row-check');
  checkboxes.forEach(cb => {
    cb.checked = isChecked;
  });

  updateBulkDeleteUI();
}

/**
 * Mengubah pilihan seleksi pada satu baris lead
 */
function toggleSelectLead(leadId, isChecked) {
  const safeId = String(leadId || '').trim();
  if (!safeId) return;

  if (isChecked) {
    historySelectedLeadIds.add(safeId);
  } else {
    historySelectedLeadIds.delete(safeId);
  }

  updateBulkDeleteUI();
}

/**
 * Sinkronisasi status tampilan tombol Hapus Massal dan Checkbox Header
 */
function updateBulkDeleteUI() {
  const btn = document.getElementById('btn-bulk-delete');
  const countSpan = document.getElementById('bulk-delete-count');
  const checkAll = document.getElementById('check-all-leads');

  const count = historySelectedLeadIds.size;

  if (countSpan) {
    countSpan.textContent = count;
  }

  if (btn) {
    btn.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  if (checkAll) {
    const startIndex = (historyCurrentPage - 1) * historyItemsPerPage;
    const endIndex = startIndex + historyItemsPerPage;
    const displayLeads = historyFilteredLeads.slice(startIndex, endIndex);

    if (displayLeads.length === 0) {
      checkAll.checked = false;
      checkAll.indeterminate = false;
    } else {
      const selectedOnPage = displayLeads.filter(l => historySelectedLeadIds.has(String(l['ID Leads'] || '').trim())).length;
      if (selectedOnPage === displayLeads.length) {
        checkAll.checked = true;
        checkAll.indeterminate = false;
      } else if (selectedOnPage > 0) {
        checkAll.checked = false;
        checkAll.indeterminate = true;
      } else {
        checkAll.checked = false;
        checkAll.indeterminate = false;
      }
    }
  }
}

/**
 * Menghapus banyak lead terpilih secara massal (lokal IndexedDB + antrean sinkronisasi)
 */
async function bulkDeleteSelectedLeads() {
  const selectedIds = Array.from(historySelectedLeadIds);
  if (selectedIds.length === 0) {
    showToast('Tidak ada data leads yang dipilih.', 'warning');
    return;
  }

  const count = selectedIds.length;
  if (!confirm(`Apakah Anda yakin ingin menghapus ${count} data leads yang dipilih? Data akan dihapus secara permanen.`)) {
    return;
  }

  try {
    // 1. Hapus secara massal dari IndexedDB lokal dalam satu transaksi atomik
    await window.soviaDb.deleteLeadsBulk(selectedIds);

    // 2. Tambahkan aksi delete_lead ke antrean sinkronisasi secara batch
    const queueItems = selectedIds.map(id => ({
      action: 'delete_lead',
      id: id,
      type: null,
      data: null
    }));
    await window.soviaDb.addBulkToQueue(queueItems);

    // 3. Bersihkan seleksi
    historySelectedLeadIds.clear();
    updateBulkDeleteUI();

    showToast(`Berhasil menghapus ${count} leads secara lokal.`, 'success');

    // 4. Refresh UI
    await loadLocalDataAndRefreshUI();

    // 5. Trigger sinkronisasi server jika online
    if (navigator.onLine && window.soviaSync) {
      window.soviaSync.syncNow().catch(e => {
        console.warn('Sync background error setelah bulk delete leads:', e);
      });
    }
  } catch (error) {
    console.error('Gagal menghapus massal leads:', error);
    showToast(`Gagal menghapus leads massal: ${error.message || error}`, 'error');
  }
}

/**
 * Mereset form lead kembali ke keadaan kosong (Mode: Create)
 */
function resetLeadForm() {
  document.getElementById('form-mode').value = 'create';
  generateLeadId();
  initializeLeadDate();
  
  document.getElementById('lead-sales').value = '';
  document.getElementById('lead-channel').value = '';

  // Dapatkan section input
  const rekapSection = document.getElementById('leads-items-container').parentElement;
  const terhentiSection = document.getElementById('terhenti-items-container').parentElement;
  const lamaSection = document.getElementById('lama-items-container').parentElement;

  // Tampilkan kembali semua kontainer item dinamis
  rekapSection.style.display = 'block';
  terhentiSection.style.display = 'block';
  lamaSection.style.display = 'block';

  // Bersihkan kontainer dan pasang masing-masing 1 baris kosong awal
  document.getElementById('leads-items-container').innerHTML = '';
  document.getElementById('terhenti-items-container').innerHTML = '';
  document.getElementById('lama-items-container').innerHTML = '';

  addLeadItemRow();
  addTerhentiRow();
  addLamaRow();

  // Tampilkan kembali semua tombol "Tambah Baris"
  document.getElementById('btn-add-item-row').style.display = 'flex';
  document.getElementById('btn-add-terhenti-row').style.display = 'flex';
  document.getElementById('btn-add-lama-row').style.display = 'flex';

  const btn = document.getElementById('btn-submit-lead');
  if (btn) {
    btn.innerText = 'Simpan Rekap';
    btn.classList.remove('editing');
  }
}

/**
 * Mengisi tabel riwayat leads
 */
async function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;

  if (historyFilteredLeads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="no-data-msg">Tidak ada data rekapitulasi leads ditemukan.</td></tr>`;
    updatePaginationUI();
    updateBulkDeleteUI();
    return;
  }

  // Hitung indeks data berdasarkan halaman aktif
  const startIndex = (historyCurrentPage - 1) * historyItemsPerPage;
  const endIndex = startIndex + historyItemsPerPage;
  const displayLeads = historyFilteredLeads.slice(startIndex, endIndex);

  // Muat data antrean untuk mencocokkan status sinkronisasi
  const queue = await window.soviaDb.getQueue();
  const pendingIds = new Set(queue.filter(q => q.action !== 'update_options').map(q => q.id));

  const rowsHtml = [];

  displayLeads.forEach(lead => {
    const isPending = pendingIds.has(lead['ID Leads']);
    const safeLeadId = encodeURIComponent(lead['ID Leads'] || '');
    const leadId = String(lead['ID Leads'] || '').trim();
    const isChecked = historySelectedLeadIds.has(leadId);
    
    // Badge status sync
    const badgeHtml = isPending 
      ? `<span class="badge pending">
          <svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
          Pending
         </span>`
      : `<span class="badge synced">
          <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          Synced
         </span>`;

    // Format kontak / nomor HP murni tanpa tombol WhatsApp
    const rawContact = lead['Kontak / No HP'] || lead['Kontak'] || '-';
    let contactCell = '<span style="color: var(--text-muted);">-</span>';
    if (rawContact && rawContact !== '-') {
      const parts = String(rawContact).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        contactCell = `<span class="contact-number">${escapeHtml(parts[0])}</span> <span class="badge synced" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;" title="${escapeHtml(parts.join(', '))}">+${parts.length - 1}</span>`;
      } else if (parts.length === 1) {
        contactCell = `<span class="contact-number">${escapeHtml(parts[0])}</span>`;
      }
    }

    // Render baris secara batch dengan HTML escaping
    rowsHtml.push(`
      <tr>
        <td style="text-align: center; padding: 0.5rem 0.6rem;">
          <input type="checkbox" class="lead-row-check" value="${safeLeadId}" onchange="toggleSelectLead(decodeURIComponent('${safeLeadId}'), this.checked)" ${isChecked ? 'checked' : ''} title="Pilih lead ini">
        </td>
        <td><strong>${escapeHtml(lead['ID Leads'])}</strong></td>
        <td>${escapeHtml(lead['Tanggal Leads'])}</td>
        <td>${escapeHtml(lead['Nama Sales'])}</td>
        <td>${escapeHtml(lead['Sumber Channel'] || '-')}</td>
        <td>${escapeHtml(lead['Sumber Leads'] || '-')}</td>
        <td>${escapeHtml(lead['Jenis Pesan'] || '-')}</td>
        <td>${escapeHtml(lead['Block Lose'] || '-')}</td>
        <td>${escapeHtml(lead['MQL'] || '-')}</td>
        <td>${contactCell}</td>
        <td>${escapeHtml(lead['Qty'])}</td>
        <td>${badgeHtml}</td>
        <td class="col-sticky-action" style="text-align: center;">
          <div class="btn-action-group" style="justify-content: center;">
            <button class="btn-action edit" onclick="editLead(decodeURIComponent('${safeLeadId}'))" title="Edit Data">
              <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button class="btn-action delete" onclick="deleteLead(decodeURIComponent('${safeLeadId}'))" title="Hapus Data">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rowsHtml.join('');
  updatePaginationUI();
  updateBulkDeleteUI();
}

/**
 * Update kontrol pagination UI
 */
function updatePaginationUI() {
  const totalItems = historyFilteredLeads.length;
  const totalPages = Math.ceil(totalItems / historyItemsPerPage) || 1;
  const startIndex = totalItems === 0 ? 0 : ((historyCurrentPage - 1) * historyItemsPerPage) + 1;
  const endIndex = Math.min((historyCurrentPage - 1) * historyItemsPerPage + historyItemsPerPage, totalItems);

  const infoEl = document.getElementById('pagination-info');
  if (infoEl) {
    infoEl.innerText = `Menampilkan ${startIndex}-${endIndex} dari total ${totalItems} data`;
  }
  
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');

  if (btnPrev) btnPrev.disabled = historyCurrentPage <= 1;
  if (btnNext) btnNext.disabled = historyCurrentPage >= totalPages;
}

/**
 * Ganti halaman pagination tabel riwayat
 */
function changeHistoryPage(direction) {
  const totalPages = Math.ceil(historyFilteredLeads.length / historyItemsPerPage) || 1;
  historyCurrentPage += direction;
  
  if (historyCurrentPage < 1) historyCurrentPage = 1;
  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
  
  renderHistoryTable();
}

/**
 * Mereset filter tanggal riwayat kembali ke hari ini
 */
function resetHistoryDateFilter(triggerRender = true) {
  const today = new Date();
  const tzOffset = today.getTimezoneOffset() * 60000;
  const localDateStr = (new Date(today - tzOffset)).toISOString().split('T')[0];
  
  const startInput = document.getElementById('history-filter-start');
  const endInput = document.getElementById('history-filter-end');
  
  if (startInput) startInput.value = localDateStr;
  if (endInput) endInput.value = localDateStr;
  
  if (triggerRender) {
    filterHistoryTable();
    showToast('Filter riwayat diatur ke Hari Ini.', 'info');
  }
}

/**
 * Filter riwayat ke bulan berjalan (Bulan Ini)
 */
function showMonthHistoryDates() {
  const today = new Date();
  const tzOffset = today.getTimezoneOffset() * 60000;
  const localToday = new Date(today - tzOffset);
  const localDateStr = localToday.toISOString().split('T')[0];
  const firstDayOfMonth = `${localDateStr.substring(0, 7)}-01`;

  const startInput = document.getElementById('history-filter-start');
  const endInput = document.getElementById('history-filter-end');
  
  if (startInput) startInput.value = firstDayOfMonth;
  if (endInput) endInput.value = localDateStr;
  
  filterHistoryTable();
  showToast('Filter riwayat diatur ke Bulan Ini.', 'info');
}

/**
 * Menampilkan semua riwayat data leads (tanpa batas tanggal)
 */
function showAllHistoryDates() {
  const startInput = document.getElementById('history-filter-start');
  const endInput = document.getElementById('history-filter-end');
  
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';
  
  filterHistoryTable();
  showToast('Menampilkan seluruh data riwayat leads.', 'info');
}

/**
 * Melakukan filter pencarian (teks & tanggal) pada tabel riwayat
 */
function filterHistoryTable() {
  const query = document.getElementById('search-history')?.value.toLowerCase().trim() || '';
  const startDateStr = document.getElementById('history-filter-start')?.value || ''; // format: YYYY-MM-DD
  const endDateStr = document.getElementById('history-filter-end')?.value || ''; // format: YYYY-MM-DD
  
  historyFilteredLeads = currentLeads.filter(lead => {
    // Filter by date range (compare YYYY-MM-DD secara konsisten)
    let matchDate = true;
    const leadDateStr = getLeadDateOnly(lead['Tanggal Leads']);
    
    if (startDateStr) {
      if (!leadDateStr || leadDateStr < startDateStr) matchDate = false;
    }
    if (endDateStr) {
      if (!leadDateStr || leadDateStr > endDateStr) matchDate = false;
    }
    
    // Filter by search text
    let matchText = true;
    if (query) {
      matchText = (
        (lead['ID Leads'] || '').toLowerCase().includes(query) ||
        (lead['Nama Sales'] || '').toLowerCase().includes(query) ||
        (lead['Sumber Channel'] || '').toLowerCase().includes(query) ||
        (lead['Sumber Leads'] || '').toLowerCase().includes(query) ||
        (lead['Jenis Pesan'] || '').toLowerCase().includes(query) ||
        (lead['Block Lose'] || '').toLowerCase().includes(query) ||
        (lead['MQL'] || '').toLowerCase().includes(query) ||
        (lead['Kontak / No HP'] || '').toLowerCase().includes(query) ||
        (lead['Kontak'] || '').toLowerCase().includes(query)
      );
    }
    
    return matchDate && matchText;
  });

  // Reset page to 1 on new filter
  historyCurrentPage = 1;
  renderHistoryTable();
}

/* ==========================================================================
   VALIDATION PANEL OPERATIONS (MANAGE DROPDOWN OPTIONS)
   ========================================================================== */

/**
 * Menampilkan daftar opsi validasi saat ini di Validation Panel
 */
function renderValidationLists() {
  renderOptionList('sales', validationOptions.sales);
  renderOptionList('channels', validationOptions.channels);
  renderOptionList('sources', validationOptions.sources);
  renderOptionList('messages', validationOptions.messages);
  renderOptionList('blocks', validationOptions.blocks);
  renderOptionList('mql', validationOptions.mql);
}

/**
 * Render satu list opsi
 */
function renderOptionList(type, list) {
  const container = document.getElementById(`list-${type}`);
  if (!container) return;
  container.innerHTML = '';

  if (!list || list.length === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.85rem; font-style: italic;">Belum ada pilihan.</span>`;
    return;
  }

  list.forEach(val => {
    const itemEl = document.createElement('div');
    itemEl.className = 'option-item';

    const spanEl = document.createElement('span');
    spanEl.textContent = val;
    itemEl.appendChild(spanEl);

    const btnEl = document.createElement('button');
    btnEl.className = 'btn-delete-option';
    btnEl.title = 'Hapus';
    btnEl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    btnEl.onclick = () => deleteOption(type, val);
    itemEl.appendChild(btnEl);

    container.appendChild(itemEl);
  });
}

/**
 * Menambahkan opsi baru secara aman
 */
async function addOption(type) {
  try {
    const inputEl = document.getElementById(`input-${type}`);
    if (!inputEl) return;
    const newVal = inputEl.value.trim();
    
    if (!newVal) return;

    const dbType = getDbType(type);
    if (!dbType) return;
    let currentList = getOptionArray(type);

    // Validasi duplikat secara case-insensitive & aman
    const lowerNewVal = newVal.toLowerCase();
    if (currentList.some(item => String(item).toLowerCase() === lowerNewVal)) {
      showToast('Opsi sudah ada di daftar!', 'warning');
      return;
    }

    currentList.push(newVal);

    // 1. Simpan Lokal ke IndexedDB
    await window.soviaDb.saveValidationOptions(dbType, currentList);

    // 2. Masukkan ke Sync Queue
    await window.soviaDb.addToQueue('update_options', null, dbType, currentList);

    // Reset input
    inputEl.value = '';
    showToast(`Opsi "${newVal}" berhasil ditambahkan secara lokal.`, 'success');

    // 3. Refresh UI & Sinkronisasi
    await loadLocalDataAndRefreshUI();
    
    if (navigator.onLine && window.soviaSync) {
      window.soviaSync.syncNow().catch(e => {
        console.warn('Sync background error setelah add option:', e);
      });
    }
  } catch (error) {
    console.error(`Gagal menambah opsi ${type}:`, error);
    showToast(`Gagal menambah opsi: ${error.message || error}`, 'error');
  }
}

/**
 * Menghapus opsi secara aman
 */
async function deleteOption(type, value) {
  if (!confirm(`Apakah Anda yakin ingin menghapus opsi "${value}"?`)) {
    return;
  }
  try {
    const dbType = getDbType(type);
    let currentList = getOptionArray(type);

    currentList = currentList.filter(val => val !== value);

    // 1. Simpan Lokal ke IndexedDB
    await window.soviaDb.saveValidationOptions(dbType, currentList);

    // 2. Masukkan ke Sync Queue
    await window.soviaDb.addToQueue('update_options', null, dbType, currentList);

    showToast(`Opsi "${value}" dihapus secara lokal.`, 'success');

    // 3. Refresh UI & Sinkronisasi
    await loadLocalDataAndRefreshUI();
    
    if (navigator.onLine && window.soviaSync) {
      window.soviaSync.syncNow().catch(e => {
        console.warn('Sync background error setelah delete option:', e);
      });
    }
  } catch (error) {
    console.error(`Gagal menghapus opsi ${value}:`, error);
    showToast(`Gagal menghapus opsi: ${error.message || error}`, 'error');
  }
}

// Helper: Menerjemahkan type input ke nama Type di database
function getDbType(type) {
  if (type === 'sales') return 'Nama Sales';
  if (type === 'channels') return 'Sumber Channel';
  if (type === 'sources') return 'Sumber Leads';
  if (type === 'messages') return 'Jenis Pesan';
  if (type === 'blocks') return 'Block Lose';
  if (type === 'mql') return 'MQL';
  return '';
}

// Helper: Mengambil array opsi saat ini
function getOptionArray(type) {
  if (type === 'sales') return [...validationOptions.sales];
  if (type === 'channels') return [...validationOptions.channels];
  if (type === 'sources') return [...validationOptions.sources];
  if (type === 'messages') return [...validationOptions.messages];
  if (type === 'blocks') return [...validationOptions.blocks];
  if (type === 'mql') return [...validationOptions.mql];
  return [];
}


/* ==========================================================================
   DASHBOARD CALCULATIONS AND FILTERING
   ========================================================================== */

/**
 * Mengeset default input tanggal filter ke hari ini (Daily default)
 */
function setDefaultDashboardDates() {
  const today = new Date();
  const tzOffset = today.getTimezoneOffset() * 60000;
  const localDateStr = (new Date(today - tzOffset)).toISOString().split('T')[0];
  
  document.getElementById('filter-start-date').value = localDateStr;
  document.getElementById('filter-end-date').value = localDateStr;
}

/**
 * Menerapkan filter tanggal pada dashboard
 */
function applyDashboardFilters() {
  renderDashboard();
  showToast('Filter tanggal dashboard diterapkan.', 'info');
}

/**
 * Mereset filter tanggal dashboard kembali ke hari ini
 */
function resetDashboardFilters() {
  setDefaultDashboardDates();
  renderDashboard();
  showToast('Filter dashboard direset ke Hari Ini.', 'info');
}

/**
 * Filter dashboard ke bulan berjalan (Bulan Ini)
 */
function showMonthDashboardDates() {
  const today = new Date();
  const tzOffset = today.getTimezoneOffset() * 60000;
  const localToday = new Date(today - tzOffset);
  const localDateStr = localToday.toISOString().split('T')[0];
  const firstDayOfMonth = `${localDateStr.substring(0, 7)}-01`;

  document.getElementById('filter-start-date').value = firstDayOfMonth;
  document.getElementById('filter-end-date').value = localDateStr;
  renderDashboard();
  showToast('Dashboard diatur ke Bulan Ini.', 'info');
}

/**
 * Menampilkan seluruh data tanggal pada dashboard (tanpa batas)
 */
function showAllDashboardDates() {
  document.getElementById('filter-start-date').value = '';
  document.getElementById('filter-end-date').value = '';
  renderDashboard();
  showToast('Menampilkan seluruh data analitik leads.', 'info');
}

/**
 * Mengubah sales terpilih di dashboard dan merender ulang
 */
function selectSalesDashboard(salesName) {
  selectedSalesDashboard = salesName;
  renderDashboard();
  showToast(`Menampilkan detail analitik untuk ${salesName}`, 'info');
}

/**
 * Mengubah filter Sumber Leads terpilih di dashboard dan merender ulang on-demand table
 */
function selectSourceDashboard(sourceName) {
  if (!sourceName || selectedSourceDashboard === sourceName) {
    selectedSourceDashboard = null;
  } else {
    selectedSourceDashboard = sourceName;
  }
  renderDashboard();
  if (selectedSourceDashboard) {
    showToast(`Menampilkan detail leads untuk sumber: ${selectedSourceDashboard}`, 'info');
    setTimeout(() => {
      const el = document.getElementById('source-analytics-table-card');
      if (el && el.style.display !== 'none') {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }
}

/**
 * Mengubah filter Sumber Channel terpilih di dashboard dan merender ulang on-demand table
 */
function selectChannelDashboard(channelName) {
  if (!channelName || selectedChannelDashboard === channelName) {
    selectedChannelDashboard = null;
  } else {
    selectedChannelDashboard = channelName;
  }
  renderDashboard();
  if (selectedChannelDashboard) {
    showToast(`Menampilkan detail leads untuk channel: ${selectedChannelDashboard}`, 'info');
    setTimeout(() => {
      const el = document.getElementById('channel-analytics-table-card');
      if (el && el.style.display !== 'none') {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }
}

/**
 * Helper: Membuat URL langsung WhatsApp (whatsapp://) tanpa template pesan agar langsung membuka chat tanpa tab baru
 */
function createWhatsAppFollowupUrl(phoneStr) {
  if (!phoneStr) return '';
  let digits = String(phoneStr).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0')) {
    digits = '62' + digits.substring(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  } else if (!digits.startsWith('62') && digits.length >= 9) {
    digits = '62' + digits;
  }

  return `whatsapp://send?phone=${digits}`;
}

/**
 * Helper: Merender daftar nomor kontak dengan tombol Followup WhatsApp yang rapi (proper button) langsung membuka obrolan
 */
function renderContactListWithWhatsApp(contactsList, salesName = '', sourceName = '') {
  if (!contactsList || contactsList.length === 0) {
    return '<span style="color: var(--text-muted);">-</span>';
  }

  const itemsHtml = contactsList.map(contact => {
    const cleanContact = String(contact).trim();
    if (!cleanContact || cleanContact === '-') {
      return '';
    }

    const waUrl = createWhatsAppFollowupUrl(cleanContact);
    const hasDigits = Boolean(cleanContact.replace(/\D/g, ''));

    if (hasDigits && waUrl) {
      return `
        <div class="contact-followup-item">
          <span class="contact-number">${escapeHtml(cleanContact)}</span>
          <a href="${waUrl}" class="btn-wa-proper" title="Buka obrolan WhatsApp (${escapeHtml(cleanContact)})">
            <svg viewBox="0 0 24 24"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2m.01 1.67c4.56 0 8.25 3.69 8.25 8.24 0 2.2-.86 4.28-2.42 5.84l-.01.01c-1.55 1.55-3.62 2.4-5.83 2.4-1.47 0-2.9-.39-4.16-1.13l-.3-.18-3.11.82.83-3.03-.2-.31c-.81-1.3-1.24-2.81-1.24-4.36 0-4.55 3.69-8.24 8.25-8.24m4.54 11.66c-.25.7-.72 1.32-1.39 1.66-.54.28-1.23.42-1.99.31-.69-.1-1.44-.39-2.22-.85-1.37-.8-2.6-1.96-3.48-3.32-.47-.73-.83-1.52-1.02-2.32-.19-.79-.08-1.56.24-2.14.34-.63.95-1.03 1.61-1.03.18 0 .36.04.53.13.38.19.82 1.24.96 1.54.14.3.15.53.03.77-.12.24-.26.43-.44.64l-.27.31c-.13.15-.22.28-.1.49.25.43.6 1 1.05 1.57.57.73 1.26 1.32 1.95 1.67.22.11.38.1.51-.05.15-.17.34-.44.52-.69.17-.23.36-.31.57-.23.21.08 1.32.62 1.55.73.23.11.38.17.44.27.06.1.06.58-.19 1.28z"/></svg>
            <span>Chat WA</span>
          </a>
        </div>
      `;
    } else {
      return `<div class="contact-followup-item"><span class="contact-number">${escapeHtml(cleanContact)}</span></div>`;
    }
  }).filter(Boolean);

  if (itemsHtml.length === 0) {
    return '<span style="color: var(--text-muted);">-</span>';
  }

  if (itemsHtml.length <= 3) {
    return `<div class="contacts-followup-container">${itemsHtml.join('')}</div>`;
  }

  return `
    <div class="contacts-followup-container">
      ${itemsHtml.slice(0, 2).join('')}
      <details class="contacts-details-dropdown" style="cursor: pointer; margin-top: 0.25rem;">
        <summary style="font-size: 0.75rem; color: var(--gold-primary); outline: none;">+${itemsHtml.length - 2} nomor lainnya</summary>
        <div style="display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.4rem;">
          ${itemsHtml.slice(2).join('')}
        </div>
      </details>
    </div>
  `;
}

/**
 * Helper: Merender baris detail leads sales per channel (Sales -> Sumber Leads -> Jenis Pesan -> Total Leads)
 * Mengembalikan string HTML baris tabel dengan rowspan bertingkat.
 */
function renderChannelDetailRows(channelLeads) {
  if (!channelLeads || channelLeads.length === 0) {
    return `<tr><td colspan="5" class="no-data-msg">Tidak ada data leads sales pada channel ini.</td></tr>`;
  }

  // Group data by Sales -> Source -> Message Type
  const groups = {};
  channelLeads.forEach(lead => {
    const sales = (lead['Nama Sales'] || 'Tidak Diketahui').trim();
    const source = (lead['Sumber Leads'] || 'Tidak Diketahui').trim();
    const msg = (lead['Jenis Pesan'] || 'Tidak Diketahui').trim();
    const qty = parseInt(lead['Qty'], 10) || 0;

    // Ambil nomor kontak
    const rawContact = lead['Kontak / No HP'] || lead['Kontak'] || '';
    let contactsList = [];
    if (Array.isArray(lead['Kontak List']) && lead['Kontak List'].length > 0) {
      contactsList = lead['Kontak List'];
    } else if (rawContact && rawContact !== '-') {
      contactsList = String(rawContact).split(',').map(s => s.trim()).filter(Boolean);
    }

    if (!groups[sales]) groups[sales] = {};
    if (!groups[sales][source]) groups[sales][source] = {};
    if (!groups[sales][source][msg]) {
      groups[sales][source][msg] = { qty: 0, contacts: [] };
    }
    groups[sales][source][msg].qty += qty;
    if (contactsList.length > 0) {
      contactsList.forEach(c => {
        if (!groups[sales][source][msg].contacts.includes(c)) {
          groups[sales][source][msg].contacts.push(c);
        }
      });
    }
  });

  // Flatten ke list baris
  const rows = [];
  const sortedSalesKeys = Object.keys(groups).sort();
  sortedSalesKeys.forEach(sales => {
    const sortedSourceKeys = Object.keys(groups[sales]).sort();
    sortedSourceKeys.forEach(source => {
      const sortedMsgKeys = Object.keys(groups[sales][source]).sort();
      sortedMsgKeys.forEach(msg => {
        const item = groups[sales][source][msg];
        rows.push({
          sales,
          source,
          msg,
          contacts: item.contacts,
          qty: item.qty
        });
      });
    });
  });

  // Pre-calculate rowspan counts
  const salesSpan = [];
  const sourceSpan = [];

  let idx = 0;
  while (idx < rows.length) {
    let nextSalesIdx = idx;
    while (nextSalesIdx < rows.length && rows[nextSalesIdx].sales === rows[idx].sales) {
      nextSalesIdx++;
    }
    const salesCount = nextSalesIdx - idx;
    salesSpan[idx] = salesCount;
    for (let k = idx + 1; k < nextSalesIdx; k++) salesSpan[k] = 0;

    let sourceStart = idx;
    while (sourceStart < nextSalesIdx) {
      let sourceEnd = sourceStart;
      while (sourceEnd < nextSalesIdx && rows[sourceEnd].source === rows[sourceStart].source) {
        sourceEnd++;
      }
      const sourceCount = sourceEnd - sourceStart;
      sourceSpan[sourceStart] = sourceCount;
      for (let k = sourceStart + 1; k < sourceEnd; k++) sourceSpan[k] = 0;
      sourceStart = sourceEnd;
    }
    idx = nextSalesIdx;
  }

  let html = '';
  rows.forEach((row, rIdx) => {
    html += '<tr>';
    if (salesSpan[rIdx] > 0) {
      html += `<td rowspan="${salesSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${escapeHtml(row.sales)}</strong></td>`;
    }
    if (sourceSpan[rIdx] > 0) {
      html += `<td rowspan="${sourceSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.source)}</td>`;
    }
    html += `<td style="border-right: 1px solid var(--border-color);">${escapeHtml(row.msg)}</td>`;
    
    // Format Kontak / Nomor HP dengan tombol Followup WhatsApp
    const contactCell = renderContactListWithWhatsApp(row.contacts, row.sales, row.source);
    html += `<td style="border-right: 1px solid var(--border-color);">${contactCell}</td>`;
    html += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
    html += '</tr>';
  });

  return html;
}

/**
 * Mengkalkulasi metrik & merender dashboard secara realtime dengan drilldown kartu per sales
 */
function renderDashboard() {
  const startDateStr = document.getElementById('filter-start-date')?.value || '';
  const endDateStr = document.getElementById('filter-end-date')?.value || '';

  // Filter leads yang berada di dalam range tanggal terpilih secara aman dan konsisten
  const filteredLeads = currentLeads.filter(lead => {
    const leadDateStr = getLeadDateOnly(lead['Tanggal Leads']);
    if (startDateStr && (!leadDateStr || leadDateStr < startDateStr)) return false;
    if (endDateStr && (!leadDateStr || leadDateStr > endDateStr)) return false;
    return true;
  });

  // 1. Hitung total transaksi dan qty keseluruhan (hanya leads sales / rekap, tanpa Block Lose & MQL)
  const rekapOnlyLeads = filteredLeads.filter(l =>
    (!l['Block Lose'] || l['Block Lose'] === '-') &&
    (!l['MQL'] || l['MQL'] === '-')
  );

  const totalLeadsCount = rekapOnlyLeads.length;
  let totalQty = 0;

  // Map untuk memetakan performa sales di range terpilih (hanya leads sales)
  const salesMap = {};

  rekapOnlyLeads.forEach(lead => {
    const qty = parseInt(lead['Qty'], 10) || 0;
    totalQty += qty;

    const sales = (lead['Nama Sales'] || 'Unknown').trim();
    if (!salesMap[sales]) {
      salesMap[sales] = { count: 0, qty: 0 };
    }
    salesMap[sales].count += 1;
    salesMap[sales].qty += qty;
  });

  // 2. Render Kartu Per Sales
  const cardsContainer = document.getElementById('sales-cards-container');
  if (cardsContainer) {
    cardsContainer.innerHTML = '';

    // Buat set nama sales unik dari data dan validation dropdown
    const allSalesNames = new Set((validationOptions.sales || []).map(s => String(s).trim()).filter(Boolean));
    filteredLeads.forEach(lead => {
      if (lead['Nama Sales'] && lead['Nama Sales'].trim()) {
        allSalesNames.add(lead['Nama Sales'].trim());
      }
    });

    // Urutkan nama sales secara alfabetis
    const sortedSalesNames = Array.from(allSalesNames).sort();

    // Kartu pertama: "Semua Sales" (Total)
    const isSemuaActive = selectedSalesDashboard === 'Semua Sales';
    cardsContainer.innerHTML += `
      <div class="card ${isSemuaActive ? 'active' : ''}" onclick="selectSalesDashboard('Semua Sales')">
        <span class="card-title">Semua Sales (Total)</span>
        <span class="card-value" style="font-size: 1.85rem;">${totalQty} Leads</span>
        <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${totalLeadsCount} Recap</span>
      </div>
    `;

    // Kartu untuk masing-masing sales
    sortedSalesNames.forEach(salesName => {
      const stats = salesMap[salesName] || { count: 0, qty: 0 };
      const isActive = selectedSalesDashboard === salesName;
      const safeSales = encodeURIComponent(salesName);
      cardsContainer.innerHTML += `
        <div class="card ${isActive ? 'active' : ''}" onclick="selectSalesDashboard(decodeURIComponent('${safeSales}'))">
          <span class="card-title">Sales: ${escapeHtml(salesName)}</span>
          <span class="card-value" style="font-size: 1.85rem;">${stats.qty} Leads</span>
          <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${stats.count} Recap</span>
        </div>
      `;
    });
  }

  // 3. Render Analitik Per Sumber Channel (Channel -> Sales -> Sumber Leads -> Jenis Pesan -> Total Leads)
  const channelContainer = document.getElementById('channel-analytics-container');
  if (channelContainer) {
    channelContainer.innerHTML = '';

    const channelSourceLeads = selectedSalesDashboard === 'Semua Sales'
      ? rekapOnlyLeads
      : rekapOnlyLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard);

    // Group data rekap leads per Channel
    const channelGroups = {};
    channelSourceLeads.forEach(lead => {
      const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
      if (!channelGroups[channel]) channelGroups[channel] = [];
      channelGroups[channel].push(lead);
    });

    const channelSortedKeys = Object.keys(channelGroups).sort();
    const channelTotalQty = channelSourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
    const channelQtyEl = document.getElementById('channel-analytics-qty');
    if (channelQtyEl) {
      channelQtyEl.innerText = `Total: ${channelTotalQty} Leads (${channelSourceLeads.length} Recap)`;
    }

    if (channelSortedKeys.length === 0) {
      channelContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data leads sales untuk range ini.</p>`;
    } else {
      channelSortedKeys.forEach(channel => {
        const channelLeads = channelGroups[channel];
        const channelQty = channelLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
        const channelCount = channelLeads.length;
        const isSelected = selectedChannelDashboard === channel;

        // Hitung unique sales pada channel ini
        const salesOnChannel = new Set(channelLeads.map(l => l['Nama Sales'] || 'Tidak Diketahui'));

        // Hitung breakdown sumber leads pada channel ini
        const srcGroups = {};
        channelLeads.forEach(lead => {
          const src = lead['Sumber Leads'] || 'Tidak Diketahui';
          const qty = parseInt(lead['Qty'], 10) || 0;
          srcGroups[src] = (srcGroups[src] || 0) + qty;
        });

        let srcHtml = '';
        if (Object.keys(srcGroups).length > 0) {
          srcHtml = `<hr style="margin: 0.75rem 0 0.5rem 0; border: 0; border-top: 1px dashed var(--border-color);"><div style="font-size: 0.75rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.2rem; max-height: 90px; overflow-y: auto; padding-right: 0.25rem;">`;
          Object.keys(srcGroups).sort().forEach(src => {
            srcHtml += `<span>${escapeHtml(src)}: <strong style="color: var(--gold-primary);">${srcGroups[src]} Leads</strong></span>`;
          });
          srcHtml += `</div>`;
        }

        const safeChannel = escapeHtml(channel).replace(/'/g, "\\'");
        const cardHtml = `
          <div class="card ${isSelected ? 'active' : ''}" 
               onclick="selectChannelDashboard('${safeChannel}')"
               style="cursor: pointer; transition: all 0.25s ease; ${isSelected ? 'border-color: var(--gold-primary); box-shadow: 0 0 14px rgba(212, 175, 55, 0.35);' : ''}"
               title="${isSelected ? 'Klik untuk menutup detail' : 'Klik untuk melihat detail channel ini'}">
            <span class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
              <span>${escapeHtml(channel)}</span>
              ${isSelected ? '<span class="badge synced" style="font-size: 0.68rem; padding: 0.15rem 0.4rem;">Aktif</span>' : ''}
            </span>
            <span class="card-value" style="font-size: 1.85rem;">${channelQty} Leads</span>
            <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${salesOnChannel.size} Sales &middot; ${channelCount} Recap</span>
            ${srcHtml}
            <div style="margin-top: 0.6rem; font-size: 0.75rem; color: var(--gold-primary); font-weight: 500; text-align: right;">
              ${isSelected ? '✕ Tutup Detail' : '🔍 Lihat Detail →'}
            </div>
          </div>
        `;
        channelContainer.insertAdjacentHTML('beforeend', cardHtml);
      });
    }

    // Render Tabel Detail Analitik Per Sumber Channel (On-Demand saat kartu diklik)
    const channelTableCard = document.getElementById('channel-analytics-table-card');
    const channelTbody = document.getElementById('channel-analytics-tbody');
    const channelTableBadge = document.getElementById('channel-table-badge');
    const channelTableTitle = document.getElementById('channel-table-title');

    if (!selectedChannelDashboard) {
      if (channelTableCard) channelTableCard.style.display = 'none';
    } else {
      if (channelTableCard) channelTableCard.style.display = 'block';
      if (channelTableTitle) channelTableTitle.innerText = `Detail Analitik Channel: ${selectedChannelDashboard}`;

      const activeChannelLeads = channelSourceLeads.filter(
        l => (l['Sumber Channel'] || 'Tidak Diketahui').trim() === selectedChannelDashboard
      );
      const activeChannelQty = activeChannelLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

      if (channelTableBadge) {
        channelTableBadge.innerText = `${activeChannelQty} Leads (${activeChannelLeads.length} Recap)`;
      }

      if (channelTbody) {
        if (activeChannelLeads.length === 0) {
          channelTbody.innerHTML = `<tr><td colspan="5" class="no-data-msg">Tidak ada data untuk sumber channel "${escapeHtml(selectedChannelDashboard)}" pada filter ini.</td></tr>`;
        } else {
          channelTbody.innerHTML = renderChannelDetailRows(activeChannelLeads);
        }
      }
    }
  }

  // 3a. Render Analitik Per Sumber Leads Global
  const sourceContainer = document.getElementById('source-analytics-container');
  if (sourceContainer) {
    sourceContainer.innerHTML = '';

    const channelSourceLeads = selectedSalesDashboard === 'Semua Sales'
      ? rekapOnlyLeads
      : rekapOnlyLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard);

    const sourceGroups = {};
    channelSourceLeads.forEach(lead => {
      const source = lead['Sumber Leads'] || 'Tidak Diketahui';
      if (!sourceGroups[source]) sourceGroups[source] = [];
      sourceGroups[source].push(lead);
    });

    const sourceSortedKeys = Object.keys(sourceGroups).sort();
    const sourceTotalQty = channelSourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
    const sourceQtyEl = document.getElementById('source-analytics-qty');
    if (sourceQtyEl) {
      sourceQtyEl.innerText = `Total: ${sourceTotalQty} Leads (${channelSourceLeads.length} Recap)`;
    }

    if (sourceSortedKeys.length === 0) {
      sourceContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data sumber leads untuk range ini.</p>`;
    } else {
      sourceSortedKeys.forEach(source => {
        const sourceLeads = sourceGroups[source];
        const sourceQty = sourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
        const sourceCount = sourceLeads.length;
        const isSelected = selectedSourceDashboard === source;

        const msgGroups = {};
        sourceLeads.forEach(lead => {
          const msg = lead['Jenis Pesan'] || 'Tidak Diketahui';
          const qty = parseInt(lead['Qty'], 10) || 0;
          msgGroups[msg] = (msgGroups[msg] || 0) + qty;
        });

        let msgHtml = '';
        if (Object.keys(msgGroups).length > 0) {
          msgHtml = `<hr style="margin: 0.75rem 0 0.5rem 0; border: 0; border-top: 1px dashed var(--border-color);"><div style="font-size: 0.75rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.2rem; max-height: 90px; overflow-y: auto; padding-right: 0.25rem;">`;
          Object.keys(msgGroups).sort().forEach(msg => {
            msgHtml += `<span>${escapeHtml(msg)}: <strong style="color: var(--gold-primary);">${msgGroups[msg]} Leads</strong></span>`;
          });
          msgHtml += `</div>`;
        }

        const safeSource = escapeHtml(source).replace(/'/g, "\\'");
        const cardHtml = `
          <div class="card ${isSelected ? 'active' : ''}" 
               onclick="selectSourceDashboard('${safeSource}')"
               style="cursor: pointer; transition: all 0.25s ease; ${isSelected ? 'border-color: var(--gold-primary); box-shadow: 0 0 14px rgba(212, 175, 55, 0.35);' : ''}"
               title="${isSelected ? 'Klik untuk menutup detail' : 'Klik untuk melihat detail sumber ini'}">
            <span class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
              <span>${escapeHtml(source)}</span>
              ${isSelected ? '<span class="badge synced" style="font-size: 0.68rem; padding: 0.15rem 0.4rem;">Aktif</span>' : ''}
            </span>
            <span class="card-value" style="font-size: 1.85rem;">${sourceQty} Leads</span>
            <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${sourceCount} Recap</span>
            ${msgHtml}
            <div style="margin-top: 0.6rem; font-size: 0.75rem; color: var(--gold-primary); font-weight: 500; text-align: right;">
              ${isSelected ? '✕ Tutup Detail' : '🔍 Lihat Detail →'}
            </div>
          </div>
        `;
        sourceContainer.insertAdjacentHTML('beforeend', cardHtml);
      });
    }

    // Render Tabel Detail Analitik Per Sumber Leads (On-Demand saat kartu diklik)
    const sourceTableCard = document.getElementById('source-analytics-table-card');
    const sourceTbody = document.getElementById('source-analytics-tbody');
    const sourceTableBadge = document.getElementById('source-table-badge');
    const sourceTableTitle = document.getElementById('source-table-title');

    if (!selectedSourceDashboard) {
      if (sourceTableCard) sourceTableCard.style.display = 'none';
    } else {
      if (sourceTableCard) sourceTableCard.style.display = 'block';
      if (sourceTableTitle) sourceTableTitle.innerText = `Detail Analitik: ${selectedSourceDashboard}`;

      const activeSourceLeads = channelSourceLeads.filter(
        l => (l['Sumber Leads'] || 'Tidak Diketahui').trim() === selectedSourceDashboard
      );
      const activeSourceQty = activeSourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

      if (sourceTableBadge) {
        sourceTableBadge.innerText = `${activeSourceQty} Leads (${activeSourceLeads.length} Recap)`;
      }

      if (sourceTbody) {
        if (activeSourceLeads.length === 0) {
          sourceTbody.innerHTML = `<tr><td colspan="6" class="no-data-msg">Tidak ada data untuk sumber leads "${escapeHtml(selectedSourceDashboard)}" pada filter ini.</td></tr>`;
        } else {
          // Group data: Sumber Leads -> Sales -> Channel -> Jenis Pesan
          const groupsBySource = {};
          activeSourceLeads.forEach(lead => {
            const src = (lead['Sumber Leads'] || 'Tidak Diketahui').trim();
            const sls = (lead['Nama Sales'] || 'Tidak Diketahui').trim();
            const chn = (lead['Sumber Channel'] || 'Tidak Diketahui').trim();
            const msg = (lead['Jenis Pesan'] || 'Tidak Diketahui').trim();
            const qty = parseInt(lead['Qty'], 10) || 0;

            const rawContact = lead['Kontak / No HP'] || lead['Kontak'] || '';
            let contactsList = [];
            if (Array.isArray(lead['Kontak List']) && lead['Kontak List'].length > 0) {
              contactsList = lead['Kontak List'];
            } else if (rawContact && rawContact !== '-') {
              contactsList = String(rawContact).split(',').map(s => s.trim()).filter(Boolean);
            }

            if (!groupsBySource[src]) groupsBySource[src] = {};
            if (!groupsBySource[src][sls]) groupsBySource[src][sls] = {};
            if (!groupsBySource[src][sls][chn]) groupsBySource[src][sls][chn] = {};
            if (!groupsBySource[src][sls][chn][msg]) {
              groupsBySource[src][sls][chn][msg] = { qty: 0, contacts: [] };
            }
            groupsBySource[src][sls][chn][msg].qty += qty;
            if (contactsList.length > 0) {
              contactsList.forEach(c => {
                if (!groupsBySource[src][sls][chn][msg].contacts.includes(c)) {
                  groupsBySource[src][sls][chn][msg].contacts.push(c);
                }
              });
            }
          });

          // Flatten groups to list of rows
          const tableRows = [];
          const sortedSrcKeys = Object.keys(groupsBySource).sort();
          sortedSrcKeys.forEach(src => {
            const sortedSlsKeys = Object.keys(groupsBySource[src]).sort();
            sortedSlsKeys.forEach(sls => {
              const sortedChnKeys = Object.keys(groupsBySource[src][sls]).sort();
              sortedChnKeys.forEach(chn => {
                const sortedMsgKeys = Object.keys(groupsBySource[src][sls][chn]).sort();
                sortedMsgKeys.forEach(msg => {
                  const item = groupsBySource[src][sls][chn][msg];
                  tableRows.push({
                    source: src,
                    sales: sls,
                    channel: chn,
                    msg: msg,
                    contacts: item.contacts,
                    qty: item.qty
                  });
                });
              });
            });
          });

          // Pre-calculate rowspan counts
          const srcSpan = [];
          const slsSpan = [];
          const chnSpan = [];

          let sIdx = 0;
          while (sIdx < tableRows.length) {
            let nextSrcIdx = sIdx;
            while (nextSrcIdx < tableRows.length && tableRows[nextSrcIdx].source === tableRows[sIdx].source) {
              nextSrcIdx++;
            }
            const srcCount = nextSrcIdx - sIdx;
            srcSpan[sIdx] = srcCount;
            for (let k = sIdx + 1; k < nextSrcIdx; k++) srcSpan[k] = 0;

            let slsStart = sIdx;
            while (slsStart < nextSrcIdx) {
              let slsEnd = slsStart;
              while (slsEnd < nextSrcIdx && tableRows[slsEnd].sales === tableRows[slsStart].sales) {
                slsEnd++;
              }
              const slsCount = slsEnd - slsStart;
              slsSpan[slsStart] = slsCount;
              for (let k = slsStart + 1; k < slsEnd; k++) slsSpan[k] = 0;

              let chnStart = slsStart;
              while (chnStart < slsEnd) {
                let chnEnd = chnStart;
                while (chnEnd < slsEnd && tableRows[chnEnd].channel === tableRows[chnStart].channel) {
                  chnEnd++;
                }
                const chnCount = chnEnd - chnStart;
                chnSpan[chnStart] = chnCount;
                for (let k = chnStart + 1; k < chnEnd; k++) chnSpan[k] = 0;
                chnStart = chnEnd;
              }
              slsStart = slsEnd;
            }
            sIdx = nextSrcIdx;
          }

          let tableHtml = '';
          tableRows.forEach((row, rIdx) => {
            tableHtml += '<tr>';
            if (srcSpan[rIdx] > 0) {
              tableHtml += `<td rowspan="${srcSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${escapeHtml(row.source)}</strong></td>`;
            }
            if (slsSpan[rIdx] > 0) {
              tableHtml += `<td rowspan="${slsSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.sales)}</td>`;
            }
            if (chnSpan[rIdx] > 0) {
              tableHtml += `<td rowspan="${chnSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.channel)}</td>`;
            }
            tableHtml += `<td style="border-right: 1px solid var(--border-color);">${escapeHtml(row.msg)}</td>`;
            tableHtml += `<td style="border-right: 1px solid var(--border-color);">${renderContactListWithWhatsApp(row.contacts, row.sales, row.source)}</td>`;
            tableHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
            tableHtml += '</tr>';
          });

          sourceTbody.innerHTML = tableHtml;
        }
      }
    }
  }

  // Calculate terhentiLeads and lamaLeads earlier if needed, or just do it here
  const globalTerhentiLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['Block Lose'] && l['Block Lose'] !== '-')
    : filteredLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard && l['Block Lose'] && l['Block Lose'] !== '-');
  const globalTerhentiQty = globalTerhentiLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

  // 3b. Render Analitik Per Block Lose Global
  const blockContainer = document.getElementById('block-analytics-container');
  const blockQtyEl = document.getElementById('block-analytics-qty');
  if (blockQtyEl) {
    blockQtyEl.innerText = `Total: ${globalTerhentiQty} Leads (${globalTerhentiLeads.length} Recap)`;
  }

  if (blockContainer) {
    blockContainer.innerHTML = '';
    const blockGroups = {};
    globalTerhentiLeads.forEach(lead => {
      const block = lead['Block Lose'] || 'Tidak Diketahui';
      const qty = parseInt(lead['Qty'], 10) || 0;
      if (!blockGroups[block]) blockGroups[block] = { qty: 0, count: 0 };
      blockGroups[block].qty += qty;
      blockGroups[block].count += 1;
    });

    const blockSortedKeys = Object.keys(blockGroups).sort();
    if (blockSortedKeys.length === 0) {
      blockContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data Block Lose untuk range ini.</p>`;
    } else {
      blockSortedKeys.forEach(block => {
        const bData = blockGroups[block];
        const cardHtml = `
          <div class="card">
            <span class="card-title">${block}</span>
            <span class="card-value" style="font-size: 1.85rem;">${bData.qty} Leads</span>
            <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${bData.count} Recap</span>
          </div>
        `;
        blockContainer.insertAdjacentHTML('beforeend', cardHtml);
      });
    }
  }

  // 3c. Render Analitik Per MQL Global
  const globalLamaLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['MQL'] && l['MQL'] !== '-')
    : filteredLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard && l['MQL'] && l['MQL'] !== '-');
  const globalLamaQty = globalLamaLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

  const mqlContainer = document.getElementById('mql-analytics-container');
  const mqlQtyEl = document.getElementById('mql-analytics-qty');
  if (mqlQtyEl) {
    mqlQtyEl.innerText = `Total: ${globalLamaQty} Leads (${globalLamaLeads.length} Recap)`;
  }

  if (mqlContainer) {
    mqlContainer.innerHTML = '';
    const mqlGroups = {};
    globalLamaLeads.forEach(lead => {
      const mql = lead['MQL'] || 'Tidak Diketahui';
      const qty = parseInt(lead['Qty'], 10) || 0;
      if (!mqlGroups[mql]) mqlGroups[mql] = { qty: 0, count: 0 };
      mqlGroups[mql].qty += qty;
      mqlGroups[mql].count += 1;
    });

    const mqlSortedKeys = Object.keys(mqlGroups).sort();
    if (mqlSortedKeys.length === 0) {
      mqlContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data MQL untuk range ini.</p>`;
    } else {
      mqlSortedKeys.forEach(mql => {
        const mData = mqlGroups[mql];
        const cardHtml = `
          <div class="card">
            <span class="card-title">${mql}</span>
            <span class="card-value" style="font-size: 1.85rem;">${mData.qty} Leads</span>
            <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${mData.count} Recap</span>
          </div>
        `;
        mqlContainer.insertAdjacentHTML('beforeend', cardHtml);
      });
    }
  }

  // 4. Render Detail Drill-down Rekapitulasi Leads (Nama Sales -> Sumber Channel -> Sumber Leads -> Jenis Pesan -> Total Leads)
  document.getElementById('drilldown-sales-title').innerText = selectedSalesDashboard;
  
  // Filter leads rekap sesuai dengan sales terpilih (yang bukan chat terhenti / chat lama)
  const drilldownLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => (!l['Block Lose'] || l['Block Lose'] === '-') && (!l['MQL'] || l['MQL'] === '-'))
    : filteredLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard && (!l['Block Lose'] || l['Block Lose'] === '-') && (!l['MQL'] || l['MQL'] === '-'));

  const drilldownQty = drilldownLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
  document.getElementById('drilldown-sales-qty').innerText = `Total: ${drilldownQty} Leads (${drilldownLeads.length} Recap)`;

  // Group data by Sales -> Channel -> Source -> Message Type
  const groups = {};
  drilldownLeads.forEach(lead => {
    const sales = lead['Nama Sales'] || 'Tidak Diketahui';
    const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
    const source = lead['Sumber Leads'] || 'Tidak Diketahui';
    const msg = lead['Jenis Pesan'] || 'Tidak Diketahui';
    const qty = parseInt(lead['Qty'], 10) || 0;
    
    if (!groups[sales]) groups[sales] = {};
    if (!groups[sales][channel]) groups[sales][channel] = {};
    if (!groups[sales][channel][source]) groups[sales][channel][source] = {};
    groups[sales][channel][source][msg] = (groups[sales][channel][source][msg] || 0) + qty;
  });

  // Flatten the groups to a list of rows
  const rows = [];
  const sortedSalesKeys = Object.keys(groups).sort();
  sortedSalesKeys.forEach(sales => {
    const sortedChannelKeys = Object.keys(groups[sales]).sort();
    sortedChannelKeys.forEach(channel => {
      const sortedSourceKeys = Object.keys(groups[sales][channel]).sort();
      sortedSourceKeys.forEach(source => {
        const sortedMsgKeys = Object.keys(groups[sales][channel][source]).sort();
        sortedMsgKeys.forEach(msg => {
          rows.push({
            sales,
            channel,
            source,
            msg,
            qty: groups[sales][channel][source][msg]
          });
        });
      });
    });
  });

  // Pre-calculate rowspan counts untuk tabel rekap utama
  const salesSpan = [];
  const channelSpan = [];
  const sourceSpan = [];

  let idx = 0;
  while (idx < rows.length) {
    let nextSalesIdx = idx;
    while (nextSalesIdx < rows.length && rows[nextSalesIdx].sales === rows[idx].sales) {
      nextSalesIdx++;
    }
    const salesCount = nextSalesIdx - idx;
    salesSpan[idx] = salesCount;
    for (let k = idx + 1; k < nextSalesIdx; k++) {
      salesSpan[k] = 0;
    }
    
    let channelStart = idx;
    while (channelStart < nextSalesIdx) {
      let channelEnd = channelStart;
      while (channelEnd < nextSalesIdx && rows[channelEnd].channel === rows[channelStart].channel) {
        channelEnd++;
      }
      const channelCount = channelEnd - channelStart;
      channelSpan[channelStart] = channelCount;
      for (let k = channelStart + 1; k < channelEnd; k++) {
        channelSpan[k] = 0;
      }
      
      let sourceStart = channelStart;
      while (sourceStart < channelEnd) {
        let sourceEnd = sourceStart;
        while (sourceEnd < channelEnd && rows[sourceEnd].source === rows[sourceStart].source) {
          sourceEnd++;
        }
        const sourceCount = sourceEnd - sourceStart;
        sourceSpan[sourceStart] = sourceCount;
        for (let k = sourceStart + 1; k < sourceEnd; k++) {
          sourceSpan[k] = 0;
        }
        sourceStart = sourceEnd;
      }
      channelStart = channelEnd;
    }
    idx = nextSalesIdx;
  }

  // Render the unified table rekap
  const unifiedTbody = document.getElementById('drilldown-unified-tbody');

  if (rows.length === 0) {
    unifiedTbody.innerHTML = `<tr><td colspan="5" class="no-data-msg">Tidak ada data rekapitulasi leads untuk range ini.</td></tr>`;
  } else {
    const rowsHtml = rows.map((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${escapeHtml(row.sales)}</strong></td>`;
      }
      if (channelSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.channel)}</td>`;
      }
      if (sourceSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${sourceSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.source)}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${escapeHtml(row.msg)}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      return rowHtml;
    });
    unifiedTbody.innerHTML = rowsHtml.join('');
  }

  // 5. Render Filter Bertingkat Chat Terhenti (Nama Sales -> Sumber Channel -> Block Lose -> Total Leads)
  document.getElementById('drilldown-terhenti-title').innerText = selectedSalesDashboard;
  
  const terhentiLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['Block Lose'] && l['Block Lose'] !== '-')
    : filteredLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard && l['Block Lose'] && l['Block Lose'] !== '-');

  const terhentiQty = terhentiLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
  document.getElementById('drilldown-terhenti-qty').innerText = `Total: ${terhentiQty} Leads (${terhentiLeads.length} Recap)`;

  const groupsTerhenti = {};
  terhentiLeads.forEach(lead => {
    const sales = lead['Nama Sales'] || 'Tidak Diketahui';
    const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
    const block = lead['Block Lose'] || 'Tidak Diketahui';
    const qty = parseInt(lead['Qty'], 10) || 0;
    
    if (!groupsTerhenti[sales]) groupsTerhenti[sales] = {};
    if (!groupsTerhenti[sales][channel]) groupsTerhenti[sales][channel] = {};
    groupsTerhenti[sales][channel][block] = (groupsTerhenti[sales][channel][block] || 0) + qty;
  });

  const rowsTerhenti = [];
  const sortedSalesTerhenti = Object.keys(groupsTerhenti).sort();
  sortedSalesTerhenti.forEach(sales => {
    const sortedChannelTerhenti = Object.keys(groupsTerhenti[sales]).sort();
    sortedChannelTerhenti.forEach(channel => {
      const sortedBlockTerhenti = Object.keys(groupsTerhenti[sales][channel]).sort();
      sortedBlockTerhenti.forEach(block => {
        rowsTerhenti.push({
          sales,
          channel,
          block,
          qty: groupsTerhenti[sales][channel][block]
        });
      });
    });
  });

  // Hitung rowspan untuk tabel terhenti
  const salesSpanTerhenti = [];
  const channelSpanTerhenti = [];

  let idxT = 0;
  while (idxT < rowsTerhenti.length) {
    let nextSalesIdx = idxT;
    while (nextSalesIdx < rowsTerhenti.length && rowsTerhenti[nextSalesIdx].sales === rowsTerhenti[idxT].sales) {
      nextSalesIdx++;
    }
    salesSpanTerhenti[idxT] = nextSalesIdx - idxT;
    for (let k = idxT + 1; k < nextSalesIdx; k++) {
      salesSpanTerhenti[k] = 0;
    }
    
    let channelStart = idxT;
    while (channelStart < nextSalesIdx) {
      let channelEnd = channelStart;
      while (channelEnd < nextSalesIdx && rowsTerhenti[channelEnd].channel === rowsTerhenti[channelStart].channel) {
        channelEnd++;
      }
      channelSpanTerhenti[channelStart] = channelEnd - channelStart;
      for (let k = channelStart + 1; k < channelEnd; k++) {
        channelSpanTerhenti[k] = 0;
      }
      channelStart = channelEnd;
    }
    idxT = nextSalesIdx;
  }

  const terhentiTbody = document.getElementById('drilldown-terhenti-tbody');

  if (rowsTerhenti.length === 0) {
    terhentiTbody.innerHTML = `<tr><td colspan="4" class="no-data-msg">Tidak ada data chat terhenti untuk range ini.</td></tr>`;
  } else {
    const rowsTerhentiHtml = rowsTerhenti.map((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpanTerhenti[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpanTerhenti[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${escapeHtml(row.sales)}</strong></td>`;
      }
      if (channelSpanTerhenti[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpanTerhenti[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.channel)}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${escapeHtml(row.block)}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      return rowHtml;
    });
    terhentiTbody.innerHTML = rowsTerhentiHtml.join('');
  }

  // 6. Render Filter Bertingkat Chat Lama (Nama Sales -> Sumber Channel -> MQL -> Total Leads)
  document.getElementById('drilldown-lama-title').innerText = selectedSalesDashboard;
  
  const lamaLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['MQL'] && l['MQL'] !== '-')
    : filteredLeads.filter(l => (l['Nama Sales'] || '').trim() === selectedSalesDashboard && l['MQL'] && l['MQL'] !== '-');

  const lamaQty = lamaLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
  document.getElementById('drilldown-lama-qty').innerText = `Total: ${lamaQty} Leads (${lamaLeads.length} Recap)`;

  const groupsLama = {};
  lamaLeads.forEach(lead => {
    const sales = lead['Nama Sales'] || 'Tidak Diketahui';
    const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
    const mql = lead['MQL'] || 'Tidak Diketahui';
    const qty = parseInt(lead['Qty'], 10) || 0;
    
    if (!groupsLama[sales]) groupsLama[sales] = {};
    if (!groupsLama[sales][channel]) groupsLama[sales][channel] = {};
    groupsLama[sales][channel][mql] = (groupsLama[sales][channel][mql] || 0) + qty;
  });

  const rowsLama = [];
  const sortedSalesLama = Object.keys(groupsLama).sort();
  sortedSalesLama.forEach(sales => {
    const sortedChannelLama = Object.keys(groupsLama[sales]).sort();
    sortedChannelLama.forEach(channel => {
      const sortedMqlLama = Object.keys(groupsLama[sales][channel]).sort();
      sortedMqlLama.forEach(mql => {
        rowsLama.push({
          sales,
          channel,
          mql,
          qty: groupsLama[sales][channel][mql]
        });
      });
    });
  });

  // Hitung rowspan untuk tabel lama
  const salesSpanLama = [];
  const channelSpanLama = [];

  let idxL = 0;
  while (idxL < rowsLama.length) {
    let nextSalesIdx = idxL;
    while (nextSalesIdx < rowsLama.length && rowsLama[nextSalesIdx].sales === rowsLama[idxL].sales) {
      nextSalesIdx++;
    }
    salesSpanLama[idxL] = nextSalesIdx - idxL;
    for (let k = idxL + 1; k < nextSalesIdx; k++) {
      salesSpanLama[k] = 0;
    }
    
    let channelStart = idxL;
    while (channelStart < nextSalesIdx) {
      let channelEnd = channelStart;
      while (channelEnd < nextSalesIdx && rowsLama[channelEnd].channel === rowsLama[channelStart].channel) {
        channelEnd++;
      }
      channelSpanLama[channelStart] = channelEnd - channelStart;
      for (let k = channelStart + 1; k < channelEnd; k++) {
        channelSpanLama[k] = 0;
      }
      channelStart = channelEnd;
    }
    idxL = nextSalesIdx;
  }

  const lamaTbody = document.getElementById('drilldown-lama-tbody');

  if (rowsLama.length === 0) {
    lamaTbody.innerHTML = `<tr><td colspan="4" class="no-data-msg">Tidak ada data chat lama untuk range ini.</td></tr>`;
  } else {
    const rowsLamaHtml = rowsLama.map((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpanLama[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpanLama[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${escapeHtml(row.sales)}</strong></td>`;
      }
      if (channelSpanLama[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpanLama[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${escapeHtml(row.channel)}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${escapeHtml(row.mql)}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      return rowHtml;
    });
    lamaTbody.innerHTML = rowsLamaHtml.join('');
  }
}

/* ==========================================================================
   TOAST NOTIFICATION MODULE
   ========================================================================== */

/**
 * Menampilkan Toast Popup Notification
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  toast.innerHTML = `
    <div class="toast-message">${message}</div>
    <button class="toast-close" onclick="this.parentElement.remove()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  
  container.appendChild(toast);
  
  // Hapus otomatis dalam 4 detik
  setTimeout(() => {
    if (toast.parentElement) {
      toast.remove();
    }
  }, 4000);
}