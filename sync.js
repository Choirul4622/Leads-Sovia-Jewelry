/**
 * Sync Engine Module (sync.js)
 * Mengelola deteksi koneksi, antrean sinkronisasi (sync queue), dan komunikasi dengan Google Apps Script Web App.
 */

const DEFAULT_SOVIA_GAS_URL = 'https://script.google.com/macros/s/AKfycbzZYlAh4oe5ZwRJAFNRZ-e31m_opHnxzBM8qDjAvHSj5XZkq-l8nJm5LjFhKLVFDqlkjw/exec';
window.SOVIA_DEFAULT_GAS_URL = DEFAULT_SOVIA_GAS_URL;

class SoviaSync {
  constructor() {
    this.isOnline = navigator.onLine;
    this.isSyncing = false;
    this.listeners = [];
    this.syncIntervalId = null;
    
    // Inisialisasi event listener koneksi online/offline
    window.addEventListener('online', () => this.handleNetworkChange(true));
    window.addEventListener('offline', () => this.handleNetworkChange(false));
    
    // Sinkronisasi otomatis saat user kembali membuka tab / aplikasi di perangkat apa pun
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isOnline && !this.isSyncing) {
        this.syncNow();
      }
    });

    window.addEventListener('focus', () => {
      if (this.isOnline && !this.isSyncing) {
        this.syncNow();
      }
    });

    // Loop sinkronisasi background setiap 60 detik (1 menit) agar multi-device selalu konsisten
    this.syncIntervalId = setInterval(() => {
      if (this.isOnline && !this.isSyncing) {
        this.syncNow();
      }
    }, 60000);
  }

  /**
   * Daftarkan callback untuk mendengarkan perubahan status koneksi/sinkronisasi
   */
  onStatusChange(callback) {
    this.listeners.push(callback);
    // Jalankan callback langsung dengan status saat ini
    callback({
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: 0
    });
    // Segera perbarui dengan data antrean aktual
    this.notifyListeners();
  }

  /**
   * Hapus callback listener
   */
  offStatusChange(callback) {
    this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  /**
   * Memicu callback status ke seluruh UI
   */
  async notifyListeners() {
    try {
      const queue = await window.soviaDb.getQueue();
      const status = {
        isOnline: this.isOnline,
        isSyncing: this.isSyncing,
        pendingCount: queue.length
      };
      this.listeners.forEach(cb => {
        try {
          cb(status);
        } catch (listenerErr) {
          console.error('Error pada listener status:', listenerErr);
        }
      });
    } catch (err) {
      console.error('Gagal memuat status antrean:', err);
    }
  }

  /**
   * Handler ketika status jaringan browser berubah
   */
  handleNetworkChange(status) {
    this.isOnline = status;
    console.log(`Koneksi terdeteksi: ${status ? 'ONLINE' : 'OFFLINE'}`);
    this.notifyListeners();
    
    if (status) {
      // Jika jaringan pulih, langsung lakukan sinkronisasi
      this.syncNow();
    }
  }

  /**
   * Mendapatkan Web App URL dari LocalStorage atau default URL terpasang
   */
  getWebAppUrl() {
    return localStorage.getItem('sovia_gas_url') || DEFAULT_SOVIA_GAS_URL;
  }

  /**
   * Menyimpan Web App URL ke LocalStorage
   */
  setWebAppUrl(url) {
    localStorage.setItem('sovia_gas_url', url || DEFAULT_SOVIA_GAS_URL);
    this.notifyListeners();
  }

  /**
   * Helper: Fetch dengan timeout menggunakan AbortController
   * Timeout default 60 detik untuk memberikan ruang kerja cukup bagi Google Apps Script.
   */
  _fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    const mergedOptions = {
      ...options,
      signal: controller.signal
    };
    
    return fetch(url, mergedOptions)
      .then(response => {
        clearTimeout(timeoutId);
        return response;
      })
      .catch(error => {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout: Server tidak merespon dalam ${Math.round(timeoutMs / 1000)} detik.`);
        }
        throw error;
      });
  }

  /**
   * Fungsi Utama Sinkronisasi (Pencocokan offline dan online)
   */
  async syncNow() {
    if (!this.isOnline) {
      console.warn('Sinkronisasi ditunda: browser offline.');
      this.notifyListeners();
      return false;
    }

    if (this.isSyncing) {
      console.log('Sinkronisasi sedang berjalan, mengabaikan request baru.');
      return false;
    }

    const url = this.getWebAppUrl();
    if (!url) {
      console.warn('Google Apps Script URL belum dikonfigurasi.');
      this.notifyListeners();
      return false;
    }

    let queue;
    try {
      queue = await window.soviaDb.getQueue();
    } catch (err) {
      console.error('Gagal membaca antrean sinkronisasi:', err);
      return false;
    }

    if (queue.length === 0) {
      // Jika tidak ada antrean lokal yang perlu dikirim, tarik data terbaru dari server
      return this.pullDataFromServer();
    }

    this.isSyncing = true;
    this.notifyListeners();
    console.log(`Memulai sinkronisasi ${queue.length} item antrean ke server...`);

    try {
      const response = await this._fetchWithTimeout(url, {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8'
        },
        body: JSON.stringify({
          action: 'sync',
          queue: queue
        })
      }, 60000);

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      let result;
      try {
        result = await response.json();
      } catch (parseErr) {
        throw new Error('Server mengembalikan respons non-JSON.');
      }
      
      if (result && result.status === 'success') {
        console.log(`Sync berhasil. Server memproses ${result.processedCount || 0} operasi.`);
        
        // Tentukan ID item yang berhasil diproses
        let processedIds = [];
        if (result.processedQueueIds && Array.isArray(result.processedQueueIds) && result.processedQueueIds.length > 0) {
          processedIds = result.processedQueueIds;
        } else {
          const processedCount = result.processedCount || 0;
          if (processedCount > 0) {
            processedIds = queue.slice(0, processedCount).map(item => item.queueId);
          }
        }

        // Gabungkan data terbaru dari server ke database lokal
        // Catatan: Lakukan merge terlebih dahulu agar item antrean yang baru saja disinkronkan tidak terhapus dari memori
        if (result.data) {
          await this.mergeServerData(result.data, processedIds);
        }

        // Hapus item yang berhasil diproses dari antrean lokal
        if (processedIds.length > 0) {
          await window.soviaDb.removeItemsFromQueue(processedIds);
        }

        // Log error parsial jika ada
        if (result.errors && result.errors.length > 0) {
          console.warn('Beberapa item gagal disinkronkan:', result.errors);
        }
        
        this.isSyncing = false;
        this.notifyListeners();
        this.triggerDataUpdateEvent();
        return true;
      } else {
        throw new Error((result && result.message) || 'Gagal sinkronisasi data.');
      }

    } catch (error) {
      console.error('Error saat sinkronisasi background:', error);
      this.isSyncing = false;
      this.notifyListeners();
      return false;
    }
  }

  /**
   * Menarik (pull) data terbaru dari server ketika online tanpa memproses antrean.
   * Menggunakan POST dengan action 'sync' (queue kosong) yang terbukti cepat dan stabil di GAS,
   * dengan fallback ke GET jika endpoint lama.
   */
  async pullDataFromServer() {
    const url = this.getWebAppUrl();
    if (!url || !this.isOnline || this.isSyncing) return false;

    this.isSyncing = true;
    this.notifyListeners();
    console.log('Menarik data terbaru dari Google Sheets...');

    try {
      let response;
      let usedPost = true;

      try {
        // Coba POST { action: 'sync', queue: [] } terlebih dahulu
        response = await this._fetchWithTimeout(url, {
          method: 'POST',
          mode: 'cors',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8'
          },
          body: JSON.stringify({
            action: 'sync',
            queue: []
          })
        }, 60000);
      } catch (postErr) {
        console.warn('POST pull gagal atau timeout, mencoba GET fallback...', postErr);
        usedPost = false;
        response = await this._fetchWithTimeout(url, {
          method: 'GET',
          mode: 'cors'
        }, 60000);
      }

      if (!response || !response.ok) {
        throw new Error(`HTTP ${response ? response.status : 'No Response'}`);
      }

      let result;
      try {
        result = await response.json();
      } catch (parseErr) {
        throw new Error('Server mengembalikan respons non-JSON.');
      }

      if (result && result.status === 'success' && result.data) {
        await this.mergeServerData(result.data);
        this.isSyncing = false;
        this.notifyListeners();
        this.triggerDataUpdateEvent();
        console.log('Data dari Google Sheets berhasil ditarik dan diperbarui secara lokal.');
        return true;
      } else {
        throw new Error((result && result.message) || 'Format respons salah.');
      }
    } catch (error) {
      console.error('Gagal menarik data dari server:', error);
      this.isSyncing = false;
      this.notifyListeners();
      return false;
    }
  }

  /**
   * Menggabungkan data server ke database lokal (IndexedDB)
   * Menyelesaikan masalah perbedaan data antar perangkat dan mencegah data terhapus.
   */
  async mergeServerData(serverData, justProcessedQueueIds = []) {
    if (!serverData) return;

    const queue = await window.soviaDb.getQueue();
    
    // Ambil daftar ID Leads yang masih memiliki antrean edit/delete lokal
    const pendingLeadIds = new Set();
    const deletedPendingIds = new Set();
    const pendingValidationTypes = new Set();
    
    queue.forEach(item => {
      const safeId = String(item.id || '').trim();
      if (item.action === 'delete_lead' && safeId) {
        deletedPendingIds.add(safeId);
      } else if (safeId) {
        pendingLeadIds.add(safeId);
      }
      if (item.action === 'update_options') pendingValidationTypes.add(item.type);
    });

    // 1. Merge Leads
    const currentLocalLeads = await window.soviaDb.getLeads();
    const localLeadsMap = new Map(currentLocalLeads.map(l => [String(l['ID Leads'] || '').trim(), l]));
    
    const leadsToSave = [];
    const serverLeadIds = new Set();
    
    if (serverData.leads && Array.isArray(serverData.leads)) {
      serverData.leads.forEach(serverLead => {
        const leadId = String(serverLead['ID Leads'] || '').trim();
        if (!leadId) return;
        serverLeadIds.add(leadId);
        
        // Jika lead sedang diantrekan untuk dihapus lokal, jangan masukkan ke lokal
        if (deletedPendingIds.has(leadId)) {
          return;
        }

        // Jika lead memiliki antrean edit lokal yang belum terkirim, pertahankan versi lokal
        if (pendingLeadIds.has(leadId)) {
          const localVersion = localLeadsMap.get(leadId);
          if (localVersion) {
            leadsToSave.push(localVersion);
            return;
          }
        }

        // Normalisasi properti kontak pada data dari server
        const rawContact = serverLead['Kontak / No HP'] || serverLead['Kontak'] || '';
        if (!serverLead['Kontak List'] || !Array.isArray(serverLead['Kontak List'])) {
          serverLead['Kontak List'] = (rawContact && rawContact !== '-')
            ? String(rawContact).split(',').map(s => s.trim()).filter(Boolean)
            : [];
        }

        leadsToSave.push(serverLead);
      });
    }

    // Pertahankan leads lokal yang baru dibuat dan belum ada di server (Offline-First)
    currentLocalLeads.forEach(localLead => {
      const leadId = String(localLead['ID Leads'] || '').trim();
      if (!leadId || deletedPendingIds.has(leadId)) return;
      
      // Jika belum ada di data server, pertahankan data lokal tersebut
      if (!serverLeadIds.has(leadId)) {
        leadsToSave.push(localLead);
        
        // Jika belum ada di antrean sync, masukkan kembali ke antrean agar disinkronkan ke server
        if (!pendingLeadIds.has(leadId)) {
          window.soviaDb.addToQueue('create_lead', leadId, null, localLead).catch(e => {
            console.warn('Gagal menjadwalkan ulang antrean lead:', e);
          });
        }
      }
    });

    // Simpan semua leads hasil merge ke lokal
    await window.soviaDb.saveLeadsBulk(leadsToSave);

    // 2. Merge Opsi Validasi
    const validation = serverData.validation;
    if (validation) {
      const validationMergeMap = {
        'Nama Sales': validation.sales,
        'Sumber Channel': validation.channels,
        'Sumber Leads': validation.sources,
        'Jenis Pesan': validation.messages,
        'Block Lose': validation.blocks,
        'MQL': validation.mql
      };

      for (const [type, values] of Object.entries(validationMergeMap)) {
        if (!pendingValidationTypes.has(type) && values && Array.isArray(values) && values.length > 0) {
          await window.soviaDb.saveValidationOptions(type, values);
        }
      }
    }
  }

  /**
   * Memicu Custom Event untuk memberitahu UI agar merender ulang datanya
   */
  triggerDataUpdateEvent() {
    const event = new CustomEvent('sovia-data-updated');
    window.dispatchEvent(event);
  }
}

// Ekspor instance tunggal sync
const sync = new SoviaSync();
window.soviaSync = sync;
