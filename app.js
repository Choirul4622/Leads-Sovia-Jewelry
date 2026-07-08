/**
 * Main Application Logic (app.js)
 * Mengontrol logika UI, form inputs, render analitik, dan integrasi modul DB & Sync.
 */

// State Global Aplikasi
let currentLeads = [];
let validationOptions = { sales: [], channels: [], sources: [], messages: [], blocks: [], mql: [] };
let syncStatusGlobal = { isOnline: false, isSyncing: false, pendingCount: 0 };
let selectedSalesDashboard = 'Semua Sales';

// State Pagination Riwayat
let historyCurrentPage = 1;
const historyItemsPerPage = 50;
let historyFilteredLeads = [];

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
  filterHistoryTable();
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
 */
function addLeadItemRow(sourceVal = '', messageVal = '', qtyVal = 1) {
  const container = document.getElementById('leads-items-container');
  if (!container) return;

  const rowId = `lead-item-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

  let sourceOptionsHtml = '<option value="">-- Pilih Sumber --</option>';
  (validationOptions.sources || []).forEach(opt => {
    sourceOptionsHtml += `<option value="${opt}" ${opt === sourceVal ? 'selected' : ''}>${opt}</option>`;
  });

  let messageOptionsHtml = '<option value="">-- Pilih Jenis Pesan --</option>';
  (validationOptions.messages || []).forEach(opt => {
    messageOptionsHtml += `<option value="${opt}" ${opt === messageVal ? 'selected' : ''}>${opt}</option>`;
  });

  const rowHtml = `
    <div class="lead-item-row" id="${rowId}">
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
      <div class="form-group">
        <label>Qty / Jumlah</label>
        <input type="number" class="form-control lead-item-qty" min="1" value="${qtyVal}">
      </div>
      <button type="button" class="btn-action delete btn-remove-item-row" onclick="removeLeadItemRow('${rowId}')" style="height: 42px; width: 42px; display: flex; align-items: center; justify-content: center; background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px;" title="Hapus Baris">
        <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
  updateRemoveButtonsVisibility('leads-items-container', 'lead-item-row', 'btn-remove-item-row');
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

  const rowId = `terhenti-item-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

  let blockOptionsHtml = '<option value="">-- Pilih Block/Lose --</option>';
  (validationOptions.blocks || []).forEach(opt => {
    blockOptionsHtml += `<option value="${opt}" ${opt === blockVal ? 'selected' : ''}>${opt}</option>`;
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

  const rowId = `lama-item-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

  let mqlOptionsHtml = '<option value="">-- Pilih MQL --</option>';
  (validationOptions.mql || []).forEach(opt => {
    mqlOptionsHtml += `<option value="${opt}" ${opt === mqlVal ? 'selected' : ''}>${opt}</option>`;
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

  // Bersihkan opsi lama, sisakan placeholder
  salesDropdown.innerHTML = '<option value="">-- Pilih Sales --</option>';
  channelDropdown.innerHTML = '<option value="">-- Pilih Channel --</option>';

  // Isi dengan data lokal
  (validationOptions.sales || []).forEach(opt => {
    salesDropdown.innerHTML += `<option value="${opt}">${opt}</option>`;
  });

  (validationOptions.channels || []).forEach(opt => {
    channelDropdown.innerHTML += `<option value="${opt}">${opt}</option>`;
  });

  // Isi dropdown di baris dynamic item yang ada (Rekap)
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

  // Isi dropdown Block Lose di Chat Terhenti
  const blockDropdowns = document.querySelectorAll('.terhenti-item-block');
  blockDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih Block/Lose --</option>';
    (validationOptions.blocks || []).forEach(opt => {
      dropdown.innerHTML += `<option value="${opt}" ${opt === currentVal ? 'selected' : ''}>${opt}</option>`;
    });
  });

  // Isi dropdown MQL di Chat Lama
  const mqlDropdowns = document.querySelectorAll('.lama-item-mql');
  mqlDropdowns.forEach(dropdown => {
    const currentVal = dropdown.value;
    dropdown.innerHTML = '<option value="">-- Pilih MQL --</option>';
    (validationOptions.mql || []).forEach(opt => {
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
  const channelName = document.getElementById('lead-channel').value;

  if (mode === 'create') {
    const rowsToSave = [];

    // 1. Rekapitulasi Leads
    const rekapRows = document.querySelectorAll('.lead-item-row');
    rekapRows.forEach((row, i) => {
      const source = row.querySelector('.lead-item-source').value;
      const message = row.querySelector('.lead-item-message').value;
      const qty = parseInt(row.querySelector('.lead-item-qty').value, 10) || 1;
      if (source || message) {
        rowsToSave.push({
          type: 'rekap',
          tempId: `${idLeads}-R${i + 1}`,
          data: {
            'Sumber Leads': source || '-',
            'Jenis Pesan': message || '-',
            'Block Lose': '-',
            'MQL': '-',
            'Qty': qty
          }
        });
      }
    });

    // 2. Chat Terhenti
    const terhentiRows = document.querySelectorAll('.terhenti-item-row');
    terhentiRows.forEach((row, i) => {
      const block = row.querySelector('.terhenti-item-block').value;
      const qty = parseInt(row.querySelector('.terhenti-item-qty').value, 10) || 1;
      if (block) {
        rowsToSave.push({
          type: 'terhenti',
          tempId: `${idLeads}-T${i + 1}`,
          data: {
            'Sumber Leads': '-',
            'Jenis Pesan': '-',
            'Block Lose': block,
            'MQL': '-',
            'Qty': qty
          }
        });
      }
    });

    // 3. Chat Lama
    const lamaRows = document.querySelectorAll('.lama-item-row');
    lamaRows.forEach((row, i) => {
      const mql = row.querySelector('.lama-item-mql').value;
      const qty = parseInt(row.querySelector('.lama-item-qty').value, 10) || 1;
      if (mql) {
        rowsToSave.push({
          type: 'lama',
          tempId: `${idLeads}-L${i + 1}`,
          data: {
            'Sumber Leads': '-',
            'Jenis Pesan': '-',
            'Block Lose': '-',
            'MQL': mql,
            'Qty': qty
          }
        });
      }
    });

    if (rowsToSave.length === 0) {
      // Jika sama sekali tidak ada item yang diisi, simpan satu baris data kosong (hanya berisi header rekap)
      rowsToSave.push({
        type: 'rekap',
        tempId: idLeads,
        data: {
          'Sumber Leads': '-',
          'Jenis Pesan': '-',
          'Block Lose': '-',
          'MQL': '-',
          'Qty': 1
        }
      });
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

    const rekapRow = document.querySelector('.lead-item-row');
    const terhentiRow = document.querySelector('.terhenti-item-row');
    const lamaRow = document.querySelector('.lama-item-row');

    if (rekapRow && rekapRow.style.display !== 'none') {
      source = rekapRow.querySelector('.lead-item-source').value || '-';
      message = rekapRow.querySelector('.lead-item-message').value || '-';
      qty = parseInt(rekapRow.querySelector('.lead-item-qty').value, 10) || 1;
    } else if (terhentiRow && terhentiRow.style.display !== 'none') {
      block = terhentiRow.querySelector('.terhenti-item-block').value || '-';
      qty = parseInt(terhentiRow.querySelector('.terhenti-item-qty').value, 10) || 1;
    } else if (lamaRow && lamaRow.style.display !== 'none') {
      mql = lamaRow.querySelector('.lama-item-mql').value || '-';
      qty = parseInt(lamaRow.querySelector('.lama-item-qty').value, 10) || 1;
    }

    const leadData = {
      'ID Leads': idLeads,
      'Tanggal Leads': formattedDate,
      'Nama Sales': salesName,
      'Sumber Channel': channelName,
      'Sumber Leads': source,
      'Jenis Pesan': message,
      'Block Lose': block,
      'MQL': mql,
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
    addLeadItemRow(lead['Sumber Leads'], lead['Jenis Pesan'], lead['Qty']);
  }

  // Sembunyikan semua tombol "Tambah Baris" saat mode edit
  document.getElementById('btn-add-item-row').style.display = 'none';
  document.getElementById('btn-add-terhenti-row').style.display = 'none';
  document.getElementById('btn-add-lama-row').style.display = 'none';

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
  tbody.innerHTML = '';

  if (historyFilteredLeads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="no-data-msg">Tidak ada data rekapitulasi leads ditemukan.</td></tr>`;
    updatePaginationUI();
    return;
  }

  // Hitung indeks data berdasarkan halaman aktif
  const startIndex = (historyCurrentPage - 1) * historyItemsPerPage;
  const endIndex = startIndex + historyItemsPerPage;
  const displayLeads = historyFilteredLeads.slice(startIndex, endIndex);

  // Muat data antrean untuk mencocokkan status sinkronisasi
  const queue = await window.soviaDb.getQueue();
  const pendingIds = new Set(queue.filter(q => q.action !== 'update_options').map(q => q.id));

  displayLeads.forEach(lead => {
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
        <td>${lead['Sumber Leads'] || '-'}</td>
        <td>${lead['Jenis Pesan'] || '-'}</td>
        <td>${lead['Block Lose'] || '-'}</td>
        <td>${lead['MQL'] || '-'}</td>
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

  updatePaginationUI();
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
  }
}

/**
 * Melakukan filter pencarian (teks & tanggal) pada tabel riwayat
 */
function filterHistoryTable() {
  const query = document.getElementById('search-history').value.toLowerCase().trim();
  const startDateStr = document.getElementById('history-filter-start')?.value; // format: YYYY-MM-DD
  const endDateStr = document.getElementById('history-filter-end')?.value; // format: YYYY-MM-DD
  
  historyFilteredLeads = currentLeads.filter(lead => {
    // Filter by date range (compare YYYY-MM-DD)
    let matchDate = true;
    const leadDateStr = (lead['Tanggal Leads'] || '').split(' ')[0]; // Extract YYYY-MM-DD part
    
    if (startDateStr && leadDateStr < startDateStr) {
      matchDate = false;
    }
    if (endDateStr && leadDateStr > endDateStr) {
      matchDate = false;
    }
    
    // Filter by search text
    let matchText = true;
    if (query) {
      matchText = (
        lead['ID Leads'].toLowerCase().includes(query) ||
        lead['Nama Sales'].toLowerCase().includes(query) ||
        (lead['Sumber Channel'] || '').toLowerCase().includes(query) ||
        (lead['Sumber Leads'] || '').toLowerCase().includes(query) ||
        (lead['Jenis Pesan'] || '').toLowerCase().includes(query) ||
        (lead['Block Lose'] || '').toLowerCase().includes(query) ||
        (lead['MQL'] || '').toLowerCase().includes(query)
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
 * Helper: Merender baris detail leads sales per channel (Sales -> Sumber Leads -> Jenis Pesan -> Total Leads)
 * Mengembalikan string HTML baris tabel dengan rowspan bertingkat.
 */
function renderChannelDetailRows(channelLeads) {
  if (!channelLeads || channelLeads.length === 0) {
    return `<tr><td colspan="4" class="no-data-msg">Tidak ada data leads sales pada channel ini.</td></tr>`;
  }

  // Group data by Sales -> Source -> Message Type
  const groups = {};
  channelLeads.forEach(lead => {
    const sales = lead['Nama Sales'] || 'Tidak Diketahui';
    const source = lead['Sumber Leads'] || 'Tidak Diketahui';
    const msg = lead['Jenis Pesan'] || 'Tidak Diketahui';
    const qty = parseInt(lead['Qty'], 10) || 0;

    if (!groups[sales]) groups[sales] = {};
    if (!groups[sales][source]) groups[sales][source] = {};
    groups[sales][source][msg] = (groups[sales][source][msg] || 0) + qty;
  });

  // Flatten ke list baris
  const rows = [];
  const sortedSalesKeys = Object.keys(groups).sort();
  sortedSalesKeys.forEach(sales => {
    const sortedSourceKeys = Object.keys(groups[sales]).sort();
    sortedSourceKeys.forEach(source => {
      const sortedMsgKeys = Object.keys(groups[sales][source]).sort();
      sortedMsgKeys.forEach(msg => {
        rows.push({ sales, source, msg, qty: groups[sales][source][msg] });
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
      html += `<td rowspan="${salesSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${row.sales}</strong></td>`;
    }
    if (sourceSpan[rIdx] > 0) {
      html += `<td rowspan="${sourceSpan[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.source}</td>`;
    }
    html += `<td style="border-right: 1px solid var(--border-color);">${row.msg}</td>`;
    html += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
    html += '</tr>';
  });

  return html;
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

  // 1. Hitung total transaksi dan qty keseluruhan (hanya leads sales / rekap, tanpa Block Lose & MQL)
  // Filter hanya leads yang termasuk rekap leads sales (memiliki Sumber Leads & Jenis Pesan)
  const rekapOnlyLeads = filteredLeads.filter(l =>
    l['Sumber Leads'] && l['Sumber Leads'] !== '-' &&
    l['Jenis Pesan'] && l['Jenis Pesan'] !== '-'
  );

  const totalLeadsCount = rekapOnlyLeads.length;
  let totalQty = 0;

  // Map untuk memetakan performa sales di range terpilih (hanya leads sales)
  const salesMap = {};

  rekapOnlyLeads.forEach(lead => {
    const qty = parseInt(lead['Qty'], 10) || 0;
    totalQty += qty;

    const sales = lead['Nama Sales'] || 'Unknown';
    if (!salesMap[sales]) {
      salesMap[sales] = { count: 0, qty: 0 };
    }
    salesMap[sales].count += 1;
    salesMap[sales].qty += qty;
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

  // 3. Render Analitik Per Sumber Channel (Channel -> Sales -> Sumber Leads -> Jenis Pesan -> Total Leads)
  // Hanya menghitung leads sales (rekap), tanpa Block Lose & MQL
  // Hormati filter sales terpilih: jika sales tertentu dipilih, hanya tampilkan leads sales tersebut
  const channelContainer = document.getElementById('channel-analytics-container');
  channelContainer.innerHTML = '';

  const channelSourceLeads = selectedSalesDashboard === 'Semua Sales'
    ? rekapOnlyLeads
    : rekapOnlyLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard);

  // Group data rekap leads per Channel
  const channelGroups = {};
  channelSourceLeads.forEach(lead => {
    const channel = lead['Sumber Channel'] || 'Tidak Diketahui';
    if (!channelGroups[channel]) channelGroups[channel] = [];
    channelGroups[channel].push(lead);
  });

  const channelSortedKeys = Object.keys(channelGroups).sort();
  const channelTotalQty = channelSourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
  document.getElementById('channel-analytics-qty').innerText = `Total: ${channelTotalQty} Leads (${channelSourceLeads.length} Recap)`;

  if (channelSortedKeys.length === 0) {
    channelContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data leads sales untuk range ini.</p>`;
  } else {
    channelSortedKeys.forEach(channel => {
      const channelLeads = channelGroups[channel];
      const channelQty = channelLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
      const channelCount = channelLeads.length;

      // Hitung unique sales pada channel ini
      const salesOnChannel = new Set(channelLeads.map(l => l['Nama Sales'] || 'Tidak Diketahui'));

      const cardHtml = `
        <div class="channel-analytics-card" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-color);">
            <div>
              <span style="font-family: var(--font-title); font-size: 1.05rem; font-weight: 600; color: var(--gold-primary);">${channel}</span>
              <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 0.5rem;">${salesOnChannel.size} Sales &middot; ${channelCount} Recap</span>
            </div>
            <span class="badge synced" style="font-size: 0.85rem; font-family: var(--font-body); padding: 0.35rem 0.75rem;">${channelQty} Leads</span>
          </div>
          <div style="overflow-x: auto;">
            <table class="history-table" style="font-size: 0.85rem;">
              <thead>
                <tr>
                  <th>Nama Sales</th>
                  <th>Sumber Leads</th>
                  <th>Jenis Pesan</th>
                  <th>Total Leads</th>
                </tr>
              </thead>
              <tbody>
                ${renderChannelDetailRows(channelLeads)}
              </tbody>
            </table>
          </div>
        </div>
      `;
      channelContainer.insertAdjacentHTML('beforeend', cardHtml);
    });
  }

  // 3a. Render Analitik Per Sumber Leads Global
  const sourceContainer = document.getElementById('source-analytics-container');
  sourceContainer.innerHTML = '';

  const sourceGroups = {};
  channelSourceLeads.forEach(lead => {
    const source = lead['Sumber Leads'] || 'Tidak Diketahui';
    if (!sourceGroups[source]) sourceGroups[source] = [];
    sourceGroups[source].push(lead);
  });

  const sourceSortedKeys = Object.keys(sourceGroups).sort();
  document.getElementById('source-analytics-qty').innerText = `Total: ${channelTotalQty} Leads (${channelSourceLeads.length} Recap)`;

  if (sourceSortedKeys.length === 0) {
    sourceContainer.innerHTML = `<p class="no-data-msg" style="padding: 1rem 0;">Tidak ada data sumber leads untuk range ini.</p>`;
  } else {
    sourceSortedKeys.forEach(source => {
      const sourceLeads = sourceGroups[source];
      const sourceQty = sourceLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);
      const sourceCount = sourceLeads.length;

      const msgGroups = {};
      sourceLeads.forEach(lead => {
        const msg = lead['Jenis Pesan'] || 'Tidak Diketahui';
        const qty = parseInt(lead['Qty'], 10) || 0;
        msgGroups[msg] = (msgGroups[msg] || 0) + qty;
      });

      let msgHtml = '';
      if (Object.keys(msgGroups).length > 0) {
        msgHtml = `<hr style="margin: 0.75rem 0 0.5rem 0; border: 0; border-top: 1px dashed var(--border-color);"><div style="font-size: 0.75rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.2rem;">`;
        Object.keys(msgGroups).sort().forEach(msg => {
          msgHtml += `<span>${msg}: <strong style="color: var(--gold-primary);">${msgGroups[msg]} Leads</strong></span>`;
        });
        msgHtml += `</div>`;
      }

      const cardHtml = `
        <div class="card">
          <span class="card-title">${source}</span>
          <span class="card-value" style="font-size: 1.85rem;">${sourceQty} Leads</span>
          <span style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${sourceCount} Recap</span>
          ${msgHtml}
        </div>
      `;
      sourceContainer.insertAdjacentHTML('beforeend', cardHtml);
    });
  }

  // Calculate terhentiLeads and lamaLeads earlier if needed, or just do it here
  const globalTerhentiLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['Block Lose'] && l['Block Lose'] !== '-')
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard && l['Block Lose'] && l['Block Lose'] !== '-');
  const globalTerhentiQty = globalTerhentiLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

  // 3b. Render Analitik Per Block Lose Global
  const blockContainer = document.getElementById('block-analytics-container');
  blockContainer.innerHTML = '';
  document.getElementById('block-analytics-qty').innerText = `Total: ${globalTerhentiQty} Leads (${globalTerhentiLeads.length} Recap)`;

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

  // 3c. Render Analitik Per MQL Global
  const globalLamaLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['MQL'] && l['MQL'] !== '-')
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard && l['MQL'] && l['MQL'] !== '-');
  const globalLamaQty = globalLamaLeads.reduce((acc, curr) => acc + (parseInt(curr['Qty'], 10) || 0), 0);

  const mqlContainer = document.getElementById('mql-analytics-container');
  mqlContainer.innerHTML = '';
  document.getElementById('mql-analytics-qty').innerText = `Total: ${globalLamaQty} Leads (${globalLamaLeads.length} Recap)`;

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

  // 4. Render Detail Drill-down Rekapitulasi Leads (Nama Sales -> Sumber Channel -> Sumber Leads -> Jenis Pesan -> Total Leads)
  document.getElementById('drilldown-sales-title').innerText = selectedSalesDashboard;
  
  // Filter leads rekap sesuai dengan sales terpilih (yang bukan chat terhenti / chat lama)
  const drilldownLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['Sumber Leads'] && l['Sumber Leads'] !== '-' && l['Jenis Pesan'] && l['Jenis Pesan'] !== '-')
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard && l['Sumber Leads'] && l['Sumber Leads'] !== '-' && l['Jenis Pesan'] && l['Jenis Pesan'] !== '-');

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
  unifiedTbody.innerHTML = '';

  if (rows.length === 0) {
    unifiedTbody.innerHTML = `<tr><td colspan="5" class="no-data-msg">Tidak ada data rekapitulasi leads untuk range ini.</td></tr>`;
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
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${row.msg}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      unifiedTbody.innerHTML += rowHtml;
    });
  }

  // 5. Render Filter Bertingkat Chat Terhenti (Nama Sales -> Sumber Channel -> Block Lose -> Total Leads)
  document.getElementById('drilldown-terhenti-title').innerText = selectedSalesDashboard;
  
  const terhentiLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['Block Lose'] && l['Block Lose'] !== '-')
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard && l['Block Lose'] && l['Block Lose'] !== '-');

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
  terhentiTbody.innerHTML = '';

  if (rowsTerhenti.length === 0) {
    terhentiTbody.innerHTML = `<tr><td colspan="4" class="no-data-msg">Tidak ada data chat terhenti untuk range ini.</td></tr>`;
  } else {
    rowsTerhenti.forEach((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpanTerhenti[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpanTerhenti[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${row.sales}</strong></td>`;
      }
      if (channelSpanTerhenti[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpanTerhenti[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.channel}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${row.block}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      terhentiTbody.innerHTML += rowHtml;
    });
  }

  // 6. Render Filter Bertingkat Chat Lama (Nama Sales -> Sumber Channel -> MQL -> Total Leads)
  document.getElementById('drilldown-lama-title').innerText = selectedSalesDashboard;
  
  const lamaLeads = selectedSalesDashboard === 'Semua Sales'
    ? filteredLeads.filter(l => l['MQL'] && l['MQL'] !== '-')
    : filteredLeads.filter(l => l['Nama Sales'] === selectedSalesDashboard && l['MQL'] && l['MQL'] !== '-');

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
  lamaTbody.innerHTML = '';

  if (rowsLama.length === 0) {
    lamaTbody.innerHTML = `<tr><td colspan="4" class="no-data-msg">Tidak ada data chat lama untuk range ini.</td></tr>`;
  } else {
    rowsLama.forEach((row, rIdx) => {
      let rowHtml = '<tr>';
      if (salesSpanLama[rIdx] > 0) {
        rowHtml += `<td rowspan="${salesSpanLama[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);"><strong>${row.sales}</strong></td>`;
      }
      if (channelSpanLama[rIdx] > 0) {
        rowHtml += `<td rowspan="${channelSpanLama[rIdx]}" style="vertical-align: top; border-right: 1px solid var(--border-color);">${row.channel}</td>`;
      }
      rowHtml += `<td style="border-right: 1px solid var(--border-color);">${row.mql}</td>`;
      rowHtml += `<td><span style="color: var(--gold-primary); font-weight: 600;">${row.qty} Leads</span></td>`;
      rowHtml += '</tr>';
      lamaTbody.innerHTML += rowHtml;
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
