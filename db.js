/**
 * Database Module (db.js) - IndexedDB Wrapper
 * Menyimpan data leads, opsi validasi, dan antrean sinkronisasi secara offline first.
 */

const DB_NAME = 'sovia_leads_db';
const DB_VERSION = 3; // v3: Clean object stores without invalid keyPath indexes

class SoviaDB {
  constructor() {
    this.db = null;
  }

  /**
   * Inisialisasi Database IndexedDB
   */
  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store untuk data Leads (Out-of-line Key: ID Leads)
        if (!db.objectStoreNames.contains('leads')) {
          db.createObjectStore('leads');
        }

        // Store untuk Opsi Validasi Dropdown (Key: type)
        if (!db.objectStoreNames.contains('validation')) {
          db.createObjectStore('validation', { keyPath: 'type' });
        }

        // Store untuk Antrean Sinkronisasi (Auto-increment key: queueId)
        if (!db.objectStoreNames.contains('sync_queue')) {
          db.createObjectStore('sync_queue', { keyPath: 'queueId', autoIncrement: true });
        }
      };
    });
  }

  /**
   * Helper: Pastikan database sudah diinisialisasi
   */
  _ensureDb() {
    if (!this.db) {
      throw new Error('Database belum diinisialisasi. Panggil init() terlebih dahulu.');
    }
  }

  /**
   * Mengambil semua data leads dari IndexedDB
   */
  getLeads() {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['leads'], 'readonly');
        const store = transaction.objectStore('leads');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menyimpan / memperbarui satu data lead secara lokal
   */
  saveLead(lead) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const leadId = lead && lead['ID Leads'] !== undefined && lead['ID Leads'] !== null ? String(lead['ID Leads']).trim() : '';
        if (!leadId) {
          return reject(new Error('ID Leads wajib diisi dan tidak boleh kosong.'));
        }
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        const request = store.put(lead, leadId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menghapus satu data lead secara lokal
   */
  deleteLead(leadId) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const safeId = leadId !== undefined && leadId !== null ? String(leadId).trim() : '';
        if (!safeId) {
          return resolve(); // ID kosong, tidak ada yang perlu dihapus
        }
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        const request = store.delete(safeId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menghapus banyak data lead secara lokal dalam satu transaksi IndexedDB atomik
   */
  deleteLeadsBulk(leadIds) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return resolve();
      }
      try {
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
        transaction.onabort = () => reject(new Error('Transaction aborted'));

        leadIds.forEach(id => {
          const safeId = id !== undefined && id !== null ? String(id).trim() : '';
          if (safeId) {
            store.delete(safeId);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Bulk save data leads dari server (digunakan saat sinkronisasi ulang penuh)
   */
  saveLeadsBulk(leads) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      if (!Array.isArray(leads)) {
        resolve();
        return;
      }

      try {
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
        transaction.onabort = () => reject(new Error('Transaction aborted'));

        // Hapus data lama agar sinkron sempurna dengan server
        store.clear();
        
        if (leads.length > 0) {
          leads.forEach(lead => {
            if (lead && lead['ID Leads']) {
              store.put(lead, String(lead['ID Leads']).trim());
            }
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Mengambil semua opsi validasi
   */
  getValidationOptions() {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['validation'], 'readonly');
        const store = transaction.objectStore('validation');
        const request = store.getAll();

        request.onsuccess = () => {
          const result = { sales: [], channels: [], sources: [], messages: [], blocks: [], mql: [] };
          (request.result || []).forEach(item => {
            if (item.type === 'Nama Sales') result.sales = item.values || [];
            else if (item.type === 'Sumber Channel') result.channels = item.values || [];
            else if (item.type === 'Sumber Leads') result.sources = item.values || [];
            else if (item.type === 'Jenis Pesan') result.messages = item.values || [];
            else if (item.type === 'Block Lose') result.blocks = item.values || [];
            else if (item.type === 'MQL') result.mql = item.values || [];
          });

          // Lengkapi data default jika belum ada opsi tersimpan
          if (result.sales.length === 0 && result.channels.length === 0) {
            result.sales = ['Admin Sales 1', 'Admin Sales 2', 'CS Online'];
            result.channels = ['WhatsApp', 'Instagram', 'TikTok', 'Website', 'QONTAK', 'SHOPEE', 'TOKOPEDIA'];
            result.sources = ['Instagram Ads', 'TikTok Ads', 'Meta Ads', 'Organik', 'Website'];
            result.messages = ['Greeting / Halo', 'Regular', 'Tanya Model Cincin', 'Tanya Harga', 'Konsultasi Custom'];
            result.blocks = ['Harga Terlalu Mahal', 'Tidak Ada Respon', 'Belum Butuh Sekarang', 'Sapaan', 'Tanya Harga'];
            result.mql = ['MQL - Prospek Hangat', 'MQL - Follow Up', 'Bukan lead baru'];

            // Simpan ke IndexedDB
            this.saveValidationOptions('Nama Sales', result.sales);
            this.saveValidationOptions('Sumber Channel', result.channels);
            this.saveValidationOptions('Sumber Leads', result.sources);
            this.saveValidationOptions('Jenis Pesan', result.messages);
            this.saveValidationOptions('Block Lose', result.blocks);
            this.saveValidationOptions('MQL', result.mql);
          }

          resolve(result);
        };
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menyimpan opsi validasi tertentu secara lokal
   */
  saveValidationOptions(type, values) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['validation'], 'readwrite');
        const store = transaction.objectStore('validation');
        const request = store.put({ type, values: Array.isArray(values) ? values : [] });

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menambahkan aksi ke dalam Sync Queue (Antrean Sinkronisasi)
   */
  addToQueue(action, id, type, data) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['sync_queue'], 'readwrite');
        const store = transaction.objectStore('sync_queue');
        const queueItem = {
          action,
          id: id !== undefined && id !== null ? String(id).trim() : null,
          type: type || null,
          data: data || null,
          timestamp: Date.now()
        };
        
        const request = store.add(queueItem);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menambahkan banyak aksi ke dalam Sync Queue sekaligus dalam satu transaksi IndexedDB
   */
  addBulkToQueue(items) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      if (!Array.isArray(items) || items.length === 0) {
        return resolve();
      }
      try {
        const transaction = this.db.transaction(['sync_queue'], 'readwrite');
        const store = transaction.objectStore('sync_queue');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
        transaction.onabort = () => reject(new Error('Transaction aborted'));

        const now = Date.now();
        items.forEach((item, index) => {
          store.add({
            action: item.action,
            id: item.id !== undefined && item.id !== null ? String(item.id).trim() : null,
            type: item.type || null,
            data: item.data || null,
            timestamp: now + index
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Mengambil seluruh antrean sinkronisasi (diurutkan berdasarkan queueId)
   */
  getQueue() {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['sync_queue'], 'readonly');
        const store = transaction.objectStore('sync_queue');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menghapus item tertentu dari antrean (setelah sukses dikirim ke GAS)
   */
  removeFromQueue(queueId) {
    return this.removeItemsFromQueue([queueId]);
  }

  /**
   * Menghapus beberapa item dari antrean sekaligus (batch delete)
   * Mendukung baik number maupun string key secara aman
   */
  removeItemsFromQueue(queueIds) {
    this._ensureDb();
    return new Promise((resolve, reject) => {
      if (!queueIds || queueIds.length === 0) {
        resolve();
        return;
      }
      
      try {
        const transaction = this.db.transaction(['sync_queue'], 'readwrite');
        const store = transaction.objectStore('sync_queue');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
        transaction.onabort = () => reject(new Error('Transaction aborted'));

        queueIds.forEach(id => {
          if (id === undefined || id === null) return;
          const numId = Number(id);
          if (!isNaN(numId) && Number.isInteger(numId)) {
            store.delete(numId);
          }
          store.delete(id);
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}

// Ekspor instance tunggal database
const db = new SoviaDB();
window.soviaDb = db;
