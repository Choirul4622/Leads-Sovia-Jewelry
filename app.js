/**
 * Main Application Logic (app.js)
 * Mengontrol logika UI, form inputs, render analitik, dan integrasi modul DB & Sync.
 */

// State Global Aplikasi
let currentLeads = [];
let validationOptions = { sales: [], channels: [], sources: [], messages: [], blocks: [] };
let syncStatusGlobal = { isOnline: false, isSyncing: false, pendingCount: 0 };
let selectedSalesDashboard = 'Semua Sales';

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
  let savedUrl = localStorage.getItem('sovia_gas_url');
  if (!savedUrl) {
    savedUrl = 'https://script.google.com/macros/s/AKfycbzZYlAh4oe5ZwRJAFNRZ-e31m_opHnxzBM8qDjAvHSj5XZkq-l8nJm5LjFhKLVFDqlkjw/exec';
    localStorage.setItem('sovia_gas_url', savedUrl);
  }
  document.getElementById('gas-url-input').value = savedUrl;

  // 3. Set Filter Tanggal Dashboard ke Hari Ini secara default
  setDefaultDashboardDates();

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

  // 5. Inisialisasi Form Input Leads
  resetLeadForm();

  // 6. Muat Data Lokal Pertama Kali
  await loadLocalDataAndRefreshUI();

  // 7. Jika Online, jalankan sinkronisasi awal secara background
  if (navigator.onLine && savedUrl) {
    window.soviaSync.syncNow();
  }
});

/**
 * Memuat ulang data dari IndexedDB ke variabel global lalu merender ulang UI
 */
async function loadLocalDataAndRefreshUI() {
  currentLeads = await window.soviaDb.getLeads();
  validationOptions = await window.soviaDb.getValidationOptions();

  // Urutkan leads berdasarkan tanggal leads terbaru di paling atas
  currentLeads.sort((a, b) => {
    const timeA = new Date(a['Tanggal Leads'].replace(' ', 'T')).getTime();
    const timeB = new Date(b['Tanggal Leads'].replace(' ', 'T')).getTime();
    return timeB - timeA;
  });

  // Rerender seluruh komponen UI
  renderDropdownSelectors();
  renderHistoryTable();
  renderDashboard();
  renderValidationLists();
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
  if (panelId === 'leads') {
    resetLeadForm();
  } else if (panelId === 'dashboard') {
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
  if (url && !url.startsWith('https://script.google.com/')) {
    showToast('Format URL Google Apps Script tidak valid.', 'error');
    return;
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
 * Menghasilkan ID Leads Otomatis: SVJ-YYMMDD-HHMMSS-RND
 */
function generateLeadId() {
  const now = new Date();
  const yy = String(now.getFullYear()).substring(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  
  // Random string 3 digit
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 3; i++) {
    randomStr += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  
  const generatedId = `SVJ-${yy}${mm}${dd}-${hh}${min}${ss}-${randomStr}`;
  document.getElementById('lead-id').value = generatedId;
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
 * Menambahkan satu baris item (Sumber Channel, Sumber Leads, Jenis Pesan, Block Loose, Qty) pada form rekapitulasi leads
 */
function addLeadItemRow(channelVal = '', sourceVal = '', messageVal = '', blockVal = '', qtyVal = 1) {
  const container = document.getElementById('leads-items-container');
  if (!container) return;

  const rowId = `lead-item-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  
  // Options for dropdowns
  let channelOptionsHtml = '<option value="">-- Pilih Channel --</option>';
  (validationOptions.channels || []).forEach(opt => {
    channelOptionsHtml += `<option value="${opt}" ${opt === channelVal ? 'selected' : ''}>${opt}</option>`;
  });

  let sourceOptionsHtml = '<option value="">-- Pilih Sumber --</option>';
  (validationOptions.sources || []).forEach(opt => {
    sourceOptionsHtml += `<option value="${opt}" ${opt === sourceVal ? 'selected' : ''}>${opt}</option>`;
  });

  let messageOptionsHtml = '<option value="">-- Pilih Jenis Pesan --</option>';
  (validationOptions.messages || []).forEach(opt => {
    messageOptionsHtml += `<option value="${opt}" ${opt === messageVal ? 'selected' : ''}>${opt}</option>`;
  });

  let blockOptionsHtml = '<option value="">-- Pilih Block/Loose --</option>';
  (validationOptions.blocks || []).forEach(opt => {
    blockOptionsHtml += `<option value="${opt}" ${opt === blockVal ? 'selected' : ''}>${opt}</option>`;
  });

  const rowHtml = `
    <div class="lead-item-row" id="${rowId}">
      <div class="form-group">
        <label>Sumber Channel</label>
        <select class="form-control lead-item-channel" required>
          ${channelOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Sumber Leads</label>
        <select class="form-control lead-item-source" required>
          ${sourceOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Jenis Pesan</label>
        <select class="form-control lead-item-message" required>
          ${messageOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Block Loose</label>
        <select class="form-control lead-item-block" required>
          ${blockOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Qty / Jumlah</label>
        <input type="number" class="form-control lead-item-qty" min="1" required value="${qtyVal}">
      </div>
      <button type="button" class="btn-action delete btn-remove-item-row" onclick="removeLeadItemRow('${rowId}')" style="height: 42px; width: 42px; display: flex; align-items: center; justify-content: center; background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px;" title="Hapus Baris">
        <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
  updateRemoveButtonsVisibility();
}

/**
 * Menghapus baris item tertentu dari form rekapitulasi leads
 */
function removeLeadItemRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    row.remove();
  }
  updateRemoveButtonsVisibility();
}

/**
 * Menampilkan/menyembunyikan tombol hapus baris tergantung jumlah baris yang ada
 */
function updateRemoveButtonsVisibility() {
  const rows = document.querySelectorAll('.lead-item-row');
  rows.forEach(row => {
    const btn = row.querySelector('.btn-remove-item-row');
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
 * Mengisi opsi pilihan dropdown pada form leads dari database lokal
 */
function renderDropdownSelectors() {
  const salesDropdown = document.getElementById('lead-sales');

  // Bersihkan opsi lama, sisakan placeholder
  salesDropdown.innerHTML = '<option value="">-- Pilih Sales --</option>';

  // Isi dengan data lokal
  (validationOptions.sales || []).forEach(opt => {
    salesDropdown.innerHTML += `<option value="${opt}">${opt}</option>`;
  });

  // Isi dropdown di baris dynamic item yang ada
  const channelDropdowns = document.querySelectorAll('.lead-item-channel');
  channelDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih Channel --</option>';
    (validationOptions.channels || []).forEach(opt => {
      dropdown.innerHTML += `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`;
    });
  });

  const sourceDropdowns = document.querySelectorAll('.lead-item-source');
  sourceDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih Sumber --</option>';
    (validationOptions.sources || []).forEach(opt => {
      dropdown.innerHTML += `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`;
    });
  });

  const messageDropdowns = document.querySelectorAll('.lead-item-message');
  messageDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih Jenis Pesan --</option>';
    (validationOptions.messages || []).forEach(opt => {
      dropdown.innerHTML += `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`;
    });
  });

  const blockDropdowns = document.querySelectorAll('.lead-item-block');
  blockDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih Block/Loose --</option>';
    (validationOptions.blocks || []).forEach(opt => {
      dropdown.innerHTML += `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`;
    });
  });
}

/**
 * Handle submit dari form leads (Simpan / Edit)
 */
async function handleLeadSubmit(event) {
  event.preventDefault();

  const mode = document.getElementById('form-mode').value;
  const idLeads = document.getElementById('lead-id').value;
  
  // Format Tanggal untuk disimpan di DB Sheets (YYYY-MM-DD HH:mm:ss)
  const inputDateTime = document.getElementById('lead-date').value; // format: 2026-06-15T11:26
  const formattedDate = inputDateTime.replace('T', ' ') + ':00';
  const salesName = document.getElementById('lead-sales').value;

  if (mode === 'create') {
    const itemRows = document.querySelectorAll('.lead-item-row');
    if (itemRows.length === 0) {
      showToast('Harap tambahkan setidaknya satu item rekap!', 'warning');
      return;
    }

    // Simpan masing-masing baris item rekapitulasi
    for (let i = 0; i < itemRows.length; i++) {
      const row = itemRows[i];
      const channel = row.querySelector('.lead-item-channel').value;
      const source = row.querySelector('.lead-item-source').value;
      const message = row.querySelector('.lead-item-message').value;
      const block = row.querySelector('.lead-item-block').value;
      const qty = parseInt(row.querySelector('.lead-item-qty').value, 10) || 1;

      // Suffix ID jika ada lebih dari 1 item, pertahankan base ID jika hanya ada 1 item
      const itemLeadId = itemRows.length > 1 ? `${idLeads}-${i + 1}` : idLeads;

      const leadData = {
        'ID Leads': itemLeadId,
        'Tanggal Leads': formattedDate,
        'Nama Sales': salesName,
        'Sumber Channel': channel,
        'Sumber Leads': source,
        'Jenis Pesan': message,
        'Block Loose': block,
        'Qty': qty,
        'Timestamp Created': new Date().toISOString(),
        'Timestamp Updated': new Date().toISOString(),
        'Status': 'Active'
      };

      // 1. Simpan Lokal ke IndexedDB
      await window.soviaDb.saveLead(leadData);

      // 2. Antrekan ke Sync Queue
      await window.soviaDb.addToQueue('create_lead', itemLeadId, null, leadData);
    }

    showToast(`Berhasil menyimpan ${itemRows.length} rekap leads secara lokal.`, 'success');

  } else {
    // Edit mode (hanya 1 baris item terpilih yang di-update)
    const itemRow = document.querySelector('.lead-item-row');
    const channel = itemRow.querySelector('.lead-item-channel').value;
    const source = itemRow.querySelector('.lead-item-source').value;
    const message = itemRow.querySelector('.lead-item-message').value;
    const block = itemRow.querySelector('.lead-item-block').value;
    const qty = parseInt(itemRow.querySelector('.lead-item-qty').value, 10) || 1;

    const leadData = {
      'ID Leads': idLeads,
      'Tanggal Leads': formattedDate,
      'Nama Sales': salesName,
      'Sumber Channel': channel,
      'Sumber Leads': source,
      'Jenis Pesan': message,
      'Block Loose': block,
      'Qty': qty,
      'Timestamp Created': '', // Biarkan server tetap mempertahankan waktu pembuatan asli
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
  
  if (navigator.onLine) {
    window.soviaSync.syncNow();
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
  const cleanDate = lead['Tanggal Leads'].replace(' ', 'T').substring(0, 16);
  document.getElementById('lead-date').value = cleanDate;
  
  document.getElementById('lead-sales').value = lead['Nama Sales'];

  // Kosongkan item list lama dan pasang 1 baris item dengan nilai lead
  const container = document.getElementById('leads-items-container');
  if (container) {
    container.innerHTML = '';
  }
  addLeadItemRow(lead['Sumber Channel'] || '', lead['Sumber Leads'], lead['Jenis Pesan'], lead['Block Loose'] || '', lead['Qty']);

  // Sembunyikan tombol "Tambah Baris" saat mode edit
  const addBtn = document.getElementById('btn-add-item-row');
  if (addBtn) {
    addBtn.style.display = 'none';
  }

  // Ganti Tulisan Tombol
  document.getElementById('btn-submit-lead').innerText = 'Perbarui Rekap';
  document.getElementById('btn-submit-lead').classList.add('editing');
  
  showToast(`Mengedit lead ${leadId}`, 'info');
}

/**
 * Menghapus lead
 */
async function deleteLead(leadId) {
  if (confirm(`Apakah Anda yakin ingin menghapus data leads ${leadId}?`)) {
    // 1. Hapus secara lokal dari IndexedDB
    await window.soviaDb.deleteLead(leadId);

    // 2. Tambahkan aksi delete_lead ke antrean sinkronisasi
    await window.soviaDb.addToQueue('delete_lead', leadId, null, null);

    showToast(`Lead ${leadId} dihapus secara lokal.`, 'success');

    // 3. Refresh UI & Sinkronisasi
    await loadLocalDataAndRefreshUI();
    
    if (navigator.onLine) {
      window.soviaSync.syncNow();
    }
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

  // Kosongkan item list lama dan pasang 1 baris kosong awal
  const container = document.getElementById('leads-items-container');
  if (container) {
    container.innerHTML = '';
  }
  addLeadItemRow();

  // Tampilkan kembali tombol "Tambah Baris"
  const addBtn = document.getElementById('btn-add-item-row');
  if (addBtn) {
    addBtn.style.display = 'flex';
  }

  const btn = document.getElementById('btn-submit-lead');
  if (btn) {
    btn.innerText = 'Simpan Rekap';
    btn.classList.remove('editing');
  }
}

/**
 * Mengisi tabel riwayat leads
 */
async function renderHistoryTable(leadsToRender = currentLeads) {
  const tbody = document.getElementById('history-table-body');
  tbody.innerHTML = '';

  if (leadsToRender.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="no-data-msg">Tidak ada data rekapitulasi leads ditemukan.</td></tr>`;
    return;
  }

  // Muat data antrean untuk mencocokkan status sinkronisasi
  const queue = await window.soviaDb.getQueue();
  const pendingIds = new Set(queue.filter(q => q.action !== 'update_options').map(q => q.id));

  leadsToRender.forEach(lead => {
    const isPending = pendingIds.has(lead['ID Leads']);
    
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

    // Render baris
    tbody.innerHTML += `
      <tr>
        <td><strong>${lead['ID Leads']}</strong></td>
        <td>${lead['Tanggal Leads']}</td>
        <td>${lead['Nama Sales']}</td>
        <td>${lead['Sumber Channel'] || '-'}</td>
        <td>${lead['Sumber Leads']}</td>
        <td>${lead['Jenis Pesan']}</td>
        <td>${lead['Block Loose'] || '-'}</td>
        <td>${lead['Qty']}</td>
        <td>${badgeHtml}</td>
        <td style="text-align: center;">
          <div class="btn-action-group">
            <button class="btn-action edit" onclick="editLead('${lead['ID Leads']}')" title="Edit Data">
              <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button class="btn-action delete" onclick="deleteLead('${lead['ID Leads']}')" title="Hapus Data">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  });
}

/**
 * Melakukan filter pencarian pada tabel riwayat
 */
function filterHistoryTable() {
  const query = document.getElementById('search-history').value.toLowerCase().trim();
  
  if (!query) {
    renderHistoryTable(currentLeads);
    return;
  }

  const filtered = currentLeads.filter(lead => {
    return (
      lead['ID Leads'].toLowerCase().includes(query) ||
      lead['Nama Sales'].toLowerCase().includes(query) ||
      (lead['Sumber Channel'] || '').toLowerCase().includes(query) ||
      lead['Sumber Leads'].toLowerCase().includes(query) ||
      lead['Jenis Pesan'].toLowerCase().includes(query) ||
      (lead['Block Loose'] || '').toLowerCase().includes(query) ||
      lead['Tanggal Leads'].toLowerCase().includes(query)
    );
  });

  renderHistoryTable(filtered);
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
}

/**
 * Render satu list opsi
 */
function renderOptionList(type, list) {
  const container = document.getElementById(`list-${type}`);
  container.innerHTML = '';

  if (!list || list.length === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.85rem; font-style: italic;">Belum ada pilihan.</span>`;
    return;
  }

  list.forEach(val => {
    container.innerHTML += `
      <div class="option-item">
        <span>${val}</span>
        <button class="btn-delete-option" onclick="deleteOption('${type}', '${val}')" title="Hapus">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    `;
  });
}

/**
 * Menambahkan opsi baru
 */
async function addOption(type) {
  const inputEl = document.getElementById(`input-${type}`);
  const newVal = inputEl.value.trim();
  
  if (!newVal) return;

  const dbType = getDbType(type);
  let currentList = getOptionArray(type);

  // Validasi duplikat
  if (currentList.some(item => item.toLowerCase() === newVal.toLowerCase())) {
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
  
  if (navigator.onLine) {
    window.soviaSync.syncNow();
  }
}

/**
 * Menghapus opsi
 */
async function deleteOption(type, value) {
  if (confirm(`Apakah Anda yakin ingin menghapus opsi "${value}"?`)) {
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
    
    if (navigator.onLine) {
      window.soviaSync.syncNow();
    }
  }
}

// Helper: Menerjemahkan type input ke nama Type di database
function getDbType(type) {
  if (type === 'sales') return 'Nama Sales';
  if (type === 'channels') return 'Sumber Channel';
  if (type === 'sources') return 'Sumber Leads';
  if (type === 'messages') return 'Jenis Pesan';
  if (type === 'blocks') return 'Block Loose';
  return '';
}

// Helper: Mengambil array opsi saat ini
function getOptionArray(type) {
  if (type === 'sales') return [...validationOptions.sales];
  if (type === 'channels') return [...validationOptions.channels];
  if (type === 'sources') return [...validationOptions.sources];
  if (type === 'messages') return [...validationOptions.messages];
  if (type === 'blocks') return [...validationOptions.blocks];
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
  showToast('Filter direset ke hari ini.', 'info');
}

/**
 * Mengkalkulasi metrik & merender dashboard secara realtime
 */
/**
 * Mengubah sales terpilih di dashboard dan merender ulang
 */
function selectSalesDashboard(salesName) {
  selectedSalesDashboard = salesName;
  renderDashboard();
  showToast(`Menampilkan detail analitik untuk ${salesName}`, 'info');
}

/**
 * Memilih tanggal harian dari tabel summary untuk memfilter dashboard
 */
function selectDashboardDate(day) {
  document.getElementById('filter-start-date').value = day;
  document.getElementById('filter-end-date').value = day;
  renderDashboard();
  showToast(`Menampilkan data untuk tanggal ${day}`, 'info');
}

/**
 * Mengkalkulasi metrik & merender dashboard secara realtime dengan drilldown kartu per sales
 */
function renderDashboard() {
  const startDateStr = document.getElementById('filter-start-date').value;
  const endDateStr = document.getElementById('filter-end-date').value;

  if (!startDateStr || !endDateStr) return;

  // Ubah filter ke objek Date (Start = 00:00:00, End = 23:59:59)
  const filterStart = new Date(startDateStr + 'T00:00:00');
  const filterEnd = new Date(endDateStr + 'T23:59:59');

  // Filter leads yang berada di dalam range tanggal terpilih
  const filteredLeads = currentLeads.filter(lead => {
    // Tanggal Leads tersimpan dalam format 'YYYY-MM-DD HH:mm:ss'
    const leadDate = new Date(lead['Tanggal Leads'].replace(' ', 'T'));
    return leadDate >= filterStart && leadDate <= filterEnd;
  });

  // 1. Hitung total transaksi dan qty keseluruhan
  const totalLeadsCount = filteredLeads.length;
  let totalQty = 0;

  // Map untuk memetakan performa sales di range terpilih
  const salesMap = {};
  const dailySummary = {};

  filteredLeads.forEach(lead => {
    const qty = parseInt(lead['Qty'], 10) || 0;
    totalQty += qty;

    const sales = lead['Nama Sales'] || 'Unknown';
    if (!salesMap[sales]) {
      salesMap[sales] = { count: 0, qty: 0 };
    }
    salesMap[sales].count += 1;
    salesMap[sales].qty += qty;

    // Daily summary grouping (berdasarkan Tanggal YYYY-MM-DD)
    const dateOnly = lead['Tanggal Leads'].substring(0, 10);
    if (!dailySummary[dateOnly]) {
      dailySummary[dateOnly] = { count: 0, qty: 0, salesMap: {} };
    }
    dailySummary[dateOnly].count += 1;
    dailySummary[dateOnly].qty += qty;
    dailySummary[dateOnly].salesMap[sales] = (dailySummary[dateOnly].salesMap[sales] || 0) + qty;
  });

  // 2. Render Kartu Per Sales
  const cardsContainer = document.getElementById('sales-cards-container');
  cardsContainer.innerHTML = '';

  // Buat set nama sales unik dari data dan validation dropdown
  const allSalesNames = new Set(validationOptions.sales);
  filteredLeads.forEach(lead => {
    if (lead['Nama Sales']) allSalesNames.add(lead['Nama Sales']);
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
    cardsContainer.innerHTML += `
      <div class="card ${isActive ? 'active' : ''}" onclick="selectSalesDashboard('${salesName}')">
        <span class="card-title">Sales: ${salesName}</span>
        <span class="card-value" style="font-size: 1.85rem;">${stats.qty} Leads</span>
        <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${stats.count} Recap</span>
      </div>
    `;
  });

  // 3. Render Daily Summary Table (Keseluruhan)
  const dailyTbody = document.getElementById('dashboard-daily-table-body');
  dailyTbody.innerHTML = '';
  
  const sortedDays = Object.keys(dailySummary).sort((a, b) => new Date(b) - new Date(a));
  if (sortedDays.length === 0) {
    dailyTbody.innerHTML = `<tr><td colspan="4" class="no-data-msg">Tidak ada data transaksi harian di range ini.</td></tr>`;
  } else {
    sortedDays.forEach(day => {
      const dayData = dailySummary[day];
      
      // Cari Top Sales di hari itu
      let dayTopSales = '-';
      let dayTopSalesQty = 0;
      for (const s in dayData.salesMap) {
        if (dayData.salesMap[s] > dayTopSalesQty) {
          dayTopSalesQty = dayData.salesMap[s];
          dayTopSales = s;
        }
      }
      
      dailyTbody.innerHTML += `
        <tr onclick="selectDashboardDate('${day}')" style="cursor: pointer;">
          <td><strong>${day}</strong></td>
          <td>${dayData.count} Recap</td>
          <td>${dayData.qty} Leads</td>
          <td>${dayTopSales} (${dayTopSalesQty} Leads)</td>
        </tr>
      `;
    });
  }

  // 4. Render Detail Drill-down (Unified Table: Nama Sales -> Sumber Channel -> Sumber Leads -> Jenis Pesan -> Block Loose -> Total Leads)
  document.getElementById('drilldown-sales-title').innerText = selectedSalesDashboard;
  
  // Filter leads sesuai dengan sales yang dipilih
  const drilldownLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard);

  const drilldownQty = drilldownLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
  document.getElementById('drilldown-sales-qty').innerText = `Total: ${drilldownQty} Leads (${drilldownLeads.length} Recap)`;

  // Group data by Sales -> Channel -> Source -> Message Type -> Block Loose
  const groups = {};
  drilldownLeads.forEach(lead => {
    const sales = lead['Nama Sales'] || 'Tidak Diketahui';
    const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
    const source = lead['Sumber Leads'] || 'Tidak Diketahui';
    const msg = lead['Jenis Pesan'] || 'Tidak Diketahui';
    const block = lead['Block Loose'] || 'Tidak Diketahui';
    const qty = parseInt(lead['Qty'], 10) || 0;
    
    if (!groups[sales]) groups[sales] = {};
    if (!groups[sales][channel]) groups[sales][channel] = {};
    if (!groups[sales][channel][source]) groups[sales][channel][source] = {};
    if (!groups[sales][channel][source][msg]) groups[sales][channel][source][msg] = {};
    groups[sales][channel][source][msg][block] = (groups[sales][channel][source][msg][block] || 0) + qty;
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
          const sortedBlockKeys = Object.keys(groups[sales][channel][source][msg]).sort();
          sortedBlockKeys.forEach(block => {
            rows.push({
              sales,
              channel,
              source,
              msg,
              block,
              qty: groups[sales][channel][source][msg][block]
            });
          });
        });
      });
    });
  });

  // Pre-calculate rowspan counts
  const salesSpan = [];
  const channelSpan = [];
  const sourceSpan = [];
  const msgSpan = [];

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
        
        let msgStart = sourceStart;
        while (msgStart < sourceEnd) {
          let msgEnd = msgStart;
          while (msgEnd < sourceEnd && rows[msgEnd].msg === rows[msgStart].msg) {
            msgEnd++;
          }
          const msgCount = msgEnd - msgStart;
          msgSpan[msgStart] = msgCount;
          for (let k = msgStart + 1; k < msgEnd; k++) {
            msgSpan[k] = 0;
          }
          msgStart = msgEnd;
        }
        
        sourceStart = sourceEnd;
      }
      
      channelStart = channelEnd;
    }
    
    idx = nextSalesIdx;
  }

  // Render the table
  const unifiedTbody = document.getElementById('drilldown-unified-tbody');
  unifiedTbody.innerHTML = '';

  if (rows.length === 0) {
    unifiedTbody.innerHTML = `<tr><td colspan="6" class="no-data-msg">Tidak ada data untuk kombinasi analitik ini.</td></tr>`;
  } else {
    rows.forEach((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${row.sales}</strong></td>`;
      }
      if (channelSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.channel}</td>`;
      }
      if (sourceSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${sourceSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.source}</td>`;
      }
      if (msgSpan[rIdx] > 0) {
        rowHtml += `<td rowspan="${msgSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.msg}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${row.block}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      unifiedTbody.innerHTML += rowHtml;
    });
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
