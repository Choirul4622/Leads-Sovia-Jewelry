/**
 * Database Module (db.js) - IndexedDB Wrapper
 * Menyimpan data leads, opsi validasi, dan antrean sinkronisasi secara offline first.
 */

const DB_NAME = 'sovia_leads_db';
const DB_VERSION = 2; // v2: Added indexes

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

        // Store untuk data Leads (Out-of-line Key)
        if (!db.objectStoreNames.contains('leads')) {
          db.createObjectStore('leads');
        } else {
          // Migrasi v2: Tambah indexes jika belum ada
          const leadsStore = event.target.transaction.objectStore('leads');
          if (!leadsStore.indexNames.contains('idx_sales')) {
            leadsStore.createIndex('idx_sales', 'Nama Sales', { unique: false });
          }
          if (!leadsStore.indexNames.contains('idx_channel')) {
            leadsStore.createIndex('idx_channel', 'Sumber Channel', { unique: false });
          }
          if (!leadsStore.indexNames.contains('idx_date')) {
            leadsStore.createIndex('idx_date', 'Tanggal Leads', { unique: false });
          }
        }

        // Store untuk Opsi Validasi Dropdown (Key: type)
        if (!db.objectStoreNames.contains('validation')) {
          db.createObjectStore('validation', { keyPath: 'type' });
        }

        // Store untuk Antrean Sinkronisasi (Auto-increment key)
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
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        const request = store.put(lead, lead['ID Leads']);

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
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        const request = store.delete(leadId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
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
      try {
        const transaction = this.db.transaction(['leads'], 'readwrite');
        const store = transaction.objectStore('leads');
        
        // Hapus data lama agar sinkron sempurna dengan server
        const clearRequest = store.clear();
        
        clearRequest.onsuccess = () => {
          if (!leads || leads.length === 0) {
            resolve();
            return;
          }
          
          let count = 0;
          let hasError = false;
          
          leads.forEach(lead => {
            const req = store.put(lead, lead['ID Leads']);
            req.onsuccess = () => {
              count++;
              if (count === leads.length) {
                resolve();
              }
            };
            req.onerror = () => {
              if (!hasError) {
                hasError = true;
                reject(req.error);
              }
            };
          });
        };
        
        clearRequest.onerror = () => reject(clearRequest.error);
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
        const request = store.put({ type, values });

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
          id,
          type,
          data,
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
    this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['sync_queue'], 'readwrite');
        const store = transaction.objectStore('sync_queue');
        const request = store.delete(queueId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menghapus beberapa item dari antrean sekaligus (batch delete)
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
        
        let count = 0;
        let hasError = false;
        
        queueIds.forEach(id => {
          const request = store.delete(id);
          request.onsuccess = () => {
            count++;
            if (count === queueIds.length) {
              resolve();
            }
          };
          request.onerror = () => {
            if (!hasError) {
              hasError = true;
              reject(request.error);
            }
          };
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
