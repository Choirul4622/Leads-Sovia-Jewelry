/**
 * Sync Engine Module (sync.js)
 * Mengelola deteksi koneksi, antrean sinkronisasi (sync queue), dan komunikasi dengan Google Apps Script Web App.
 */

class SoviaSync {
  constructor() {
    this.isOnline = navigator.onLine;
    this.isSyncing = false;
    this.listeners = [];
    this.syncIntervalId = null;
    
    // Inisialisasi event listener koneksi
    window.addEventListener('online', () => this.handleNetworkChange(true));
    window.addEventListener('offline', () => this.handleNetworkChange(false));
    
    // Loop sinkronisasi background setiap 5 menit (300.000 ms)
    this.syncIntervalId = setInterval(() => {
      if (this.isOnline && !this.isSyncing) {
        this.syncNow();
      }
    }, 300000);
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
      this.listeners.forEach(cb => cb(status));
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
   * Mendapatkan Web App URL dari LocalStorage
   */
  getWebAppUrl() {
    return localStorage.getItem('sovia_gas_url') || '';
  }

  /**
   * Menyimpan Web App URL ke LocalStorage
   */
  setWebAppUrl(url) {
    localStorage.setItem('sovia_gas_url', url);
    this.notifyListeners();
  }

  /**
   * Helper: Fetch dengan timeout menggunakan AbortController
   */
  _fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
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
          throw new Error('Request timeout: Server tidak merespon dalam 30 detik.');
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
      // Jika tidak ada antrean, lakukan pull data terbaru dari server
      return this.pullDataFromServer();
    }

    this.isSyncing = true;
    this.notifyListeners();
    console.log(`Memulai sinkronisasi ${queue.length} item antrean...`);

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
      }, 30000);

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
        
        // Hapus item yang berhasil diproses dari antrean lokal
        const processedCount = result.processedCount || 0;
        if (processedCount > 0) {
          const processedIds = queue.slice(0, processedCount).map(item => item.queueId);
          await window.soviaDb.removeItemsFromQueue(processedIds);
        }
        
        // Gabungkan data terbaru dari server ke database lokal
        if (result.data) {
          await this.mergeServerData(result.data);
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
   * Menarik (pull) data terbaru dari server ketika online tanpa memproses antrean
   */
  async pullDataFromServer() {
    const url = this.getWebAppUrl();
    if (!url || !this.isOnline || this.isSyncing) return false;

    this.isSyncing = true;
    this.notifyListeners();
    console.log('Menarik data terbaru dari Google Sheets...');

    try {
      const response = await this._fetchWithTimeout(url, {
        method: 'GET',
        mode: 'cors'
      }, 30000);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
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
   * Memastikan data lokal yang masih ada di antrean tidak tertimpa oleh data server yang lebih lama.
   */
  async mergeServerData(serverData) {
    const queue = await window.soviaDb.getQueue();
    
    // Ambil daftar ID Leads yang masih memiliki antrean edit/delete lokal
    const pendingLeadIds = new Set();
    const pendingValidationTypes = new Set();
    
    queue.forEach(item => {
      if (item.id) pendingLeadIds.add(item.id);
      if (item.action === 'update_options') pendingValidationTypes.add(item.type);
    });

    // 1. Merge Leads
    const currentLocalLeads = await window.soviaDb.getLeads();
    const localLeadsMap = new Map(currentLocalLeads.map(l => [l['ID Leads'], l]));
    
    const leadsToSave = [];
    
    // Build Set of server lead IDs untuk O(1) lookup
    const serverLeadIds = new Set();
    if (serverData.leads) {
      serverData.leads.forEach(serverLead => {
        const leadId = serverLead['ID Leads'];
        serverLeadIds.add(leadId);
        
        // Jika lead tidak memiliki antrean perubahan lokal, ikuti server
        if (!pendingLeadIds.has(leadId)) {
          leadsToSave.push(serverLead);
        } else {
          // Jika ada antrean lokal, pertahankan versi lokal
          const localVersion = localLeadsMap.get(leadId);
          if (localVersion) {
            leadsToSave.push(localVersion);
          }
        }
      });
    }

    // Pertahankan juga leads lokal yang baru dibuat offline dan belum ada di server
    currentLocalLeads.forEach(localLead => {
      const leadId = localLead['ID Leads'];
      if (!serverLeadIds.has(leadId) && pendingLeadIds.has(leadId)) {
        leadsToSave.push(localLead);
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
        if (!pendingValidationTypes.has(type) && values) {
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
