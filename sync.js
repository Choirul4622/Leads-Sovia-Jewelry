/**
 * Sync Engine Module (sync.js)
 * Mengelola deteksi koneksi, antrean sinkronisasi (sync queue), dan komunikasi dengan Google Apps Script Web App.
 */

class SoviaSync {
  constructor() {
    this.isOnline = navigator.onLine;
    this.isSyncing = false;
    this.listeners = [];
    
    // Inisialisasi event listener koneksi
    window.addEventListener('online', () => this.handleNetworkChange(true));
    window.addEventListener('offline', () => this.handleNetworkChange(false));
    
    // Loop sinkronisasi background setiap 5 menit (300.000 ms)
    setInterval(() => {
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
   * Memicu callback status ke seluruh UI
   */
  async notifyListeners() {
    const queue = await window.soviaDb.getQueue();
    const status = {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: queue.length
    };
    this.listeners.forEach(cb => cb(status));
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

    const queue = await window.soviaDb.getQueue();
    if (queue.length === 0) {
      // Jika tidak ada antrean, kita lakukan pull data terbaru saja dari server
      return this.pullDataFromServer();
    }

    this.isSyncing = true;
    this.notifyListeners();
    console.log(`Memulai sinkronisasi ${queue.length} item antrean...`);

    try {
      // Mengirim POST request dengan Content-Type text/plain untuk menghindari CORS Preflight
      const response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8'
        },
        body: JSON.stringify({
          action: 'sync',
          queue: queue
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const result = await response.json();
      
      if (result.status === 'success') {
        console.log(`Sync berhasil. Server memproses ${result.processedCount} operasi.`);
        
        // Hapus item yang berhasil diproses dari antrean lokal
        const processedIds = queue.slice(0, result.processedCount).map(item => item.queueId);
        await window.soviaDb.removeItemsFromQueue(processedIds);
        
        // Gabungkan data terbaru dari server ke database lokal
        if (result.data) {
          await this.mergeServerData(result.data);
        }

        // Tampilkan pesan sukses di UI jika ada error parsial
        if (result.errors && result.errors.length > 0) {
          console.warn('Beberapa item gagal disinkronkan:', result.errors);
        }
        
        this.isSyncing = false;
        this.notifyListeners();
        this.triggerDataUpdateEvent();
        return true;
      } else {
        throw new Error(result.message || 'Gagal sinkronisasi data.');
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
      // Cukup lakukan GET request ke Web App
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      if (result.status === 'success' && result.data) {
        await this.mergeServerData(result.data);
        this.isSyncing = false;
        this.notifyListeners();
        this.triggerDataUpdateEvent();
        console.log('Data dari Google Sheets berhasil ditarik dan diperbarui secara lokal.');
        return true;
      } else {
        throw new Error(result.message || 'Format respons salah.');
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
    
    // Proses leads dari server
    serverData.leads.forEach(serverLead => {
      const leadId = serverLead['ID Leads'];
      
      // Jika lead tidak memiliki antrean perubahan lokal, kita ikuti server
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

    // Pertahankan juga leads lokal yang baru dibuat offline dan belum ada di server
    currentLocalLeads.forEach(localLead => {
      const leadId = localLead['ID Leads'];
      // Jika data lokal tersebut tidak ada di server tetapi ada di antrean, simpan
      const existsOnServer = serverData.leads.some(l => l['ID Leads'] === leadId);
      if (!existsOnServer && pendingLeadIds.has(leadId)) {
        leadsToSave.push(localLead);
      }
    });

    // Simpan semua leads hasil merge ke lokal
    await window.soviaDb.saveLeadsBulk(leadsToSave);

    // 2. Merge Opsi Validasi
    const validation = serverData.validation;
    if (validation) {
      if (!pendingValidationTypes.has('Nama Sales')) {
        await window.soviaDb.saveValidationOptions('Nama Sales', validation.sales || []);
      }
      if (!pendingValidationTypes.has('Sumber Leads')) {
        await window.soviaDb.saveValidationOptions('Sumber Leads', validation.sources || []);
      }
      if (!pendingValidationTypes.has('Jenis Pesan')) {
        await window.soviaDb.saveValidationOptions('Jenis Pesan', validation.messages || []);
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
