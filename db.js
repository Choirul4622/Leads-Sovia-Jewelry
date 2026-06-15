/**
 * Database Module (db.js) - IndexedDB Wrapper
 * Menyimpan data leads, opsi validasi, dan antrean sinkronisasi secara offline first.
 */

const DB_NAME = 'sovia_leads_db';
const DB_VERSION = 1;

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
   * Mengambil semua data leads dari IndexedDB
   */
  getLeads() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['leads'], 'readonly');
      const store = transaction.objectStore('leads');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menyimpan / memperbarui satu data lead secara lokal
   */
  saveLead(lead) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['leads'], 'readwrite');
      const store = transaction.objectStore('leads');
      const request = store.put(lead, lead['ID Leads']);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menghapus satu data lead secara lokal
   */
  deleteLead(leadId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['leads'], 'readwrite');
      const store = transaction.objectStore('leads');
      const request = store.delete(leadId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Bulk save data leads dari server (digunakan saat sinkronisasi ulang penuh)
   */
  saveLeadsBulk(leads) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['leads'], 'readwrite');
      const store = transaction.objectStore('leads');
      
      // Hapus data lama agar sinkron sempurna dengan server
      const clearRequest = store.clear();
      
      clearRequest.onsuccess = () => {
        let count = 0;
        if (leads.length === 0) {
          resolve();
          return;
        }
        
        leads.forEach(lead => {
          const req = store.put(lead, lead['ID Leads']);
          req.onsuccess = () => {
            count++;
            if (count === leads.length) {
              resolve();
            }
          };
          req.onerror = () => reject(req.error);
        });
      };
      
      clearRequest.onerror = () => reject(clearRequest.error);
    });
  }

  /**
   * Mengambil semua opsi validasi
   */
  getValidationOptions() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['validation'], 'readonly');
      const store = transaction.objectStore('validation');
      const request = store.getAll();

      request.onsuccess = () => {
        // Konversi bentuk array object ke object format
        const result = { sales: [], sources: [], messages: [] };
        request.result.forEach(item => {
          if (item.type === 'Nama Sales') result.sales = item.values;
          else if (item.type === 'Sumber Leads') result.sources = item.values;
          else if (item.type === 'Jenis Pesan') result.messages = item.values;
        });

        // Jika data kosong, isi dengan default secara lokal
        if (result.sales.length === 0 && result.sources.length === 0 && result.messages.length === 0) {
          const defaultSales = ['Syifa', 'Devi', 'Risa', 'Intan'];
          const defaultSources = ['Instagram', 'Tiktok', 'WhatsApp', 'Website'];
          const defaultMessages = ['Tanya Harga', 'Custom Order', 'Ready Stock', 'Komplain'];

          // Simpan secara asinkron ke DB lokal agar permanen
          this.saveValidationOptions('Nama Sales', defaultSales);
          this.saveValidationOptions('Sumber Leads', defaultSources);
          this.saveValidationOptions('Jenis Pesan', defaultMessages);

          resolve({ sales: defaultSales, sources: defaultSources, messages: defaultMessages });
        } else {
          resolve(result);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menyimpan opsi validasi tertentu secara lokal
   */
  saveValidationOptions(type, values) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['validation'], 'readwrite');
      const store = transaction.objectStore('validation');
      const request = store.put({ type, values });

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menambahkan aksi ke dalam Sync Queue (Antrean Sinkronisasi)
   */
  addToQueue(action, id, type, data) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sync_queue'], 'readwrite');
      const store = transaction.objectStore('sync_queue');
      const queueItem = {
        action, // 'create_lead' | 'update_lead' | 'delete_lead' | 'update_options'
        id,     // ID Leads (jika relevan)
        type,   // Tipe opsi dropdown jika action update_options (sales, sources, messages)
        data,   // Payload data lead atau array opsi baru
        timestamp: Date.now()
      };
      
      const request = store.add(queueItem);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mengambil seluruh antrean sinkronisasi (diurutkan berdasarkan queueId)
   */
  getQueue() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sync_queue'], 'readonly');
      const store = transaction.objectStore('sync_queue');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menghapus item tertentu dari antrean (setelah sukses dikirim ke GAS)
   */
  removeFromQueue(queueId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sync_queue'], 'readwrite');
      const store = transaction.objectStore('sync_queue');
      const request = store.delete(queueId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Menghapus beberapa item dari antrean sekaligus (batch delete)
   */
  removeItemsFromQueue(queueIds) {
    return new Promise((resolve, reject) => {
      if (queueIds.length === 0) {
        resolve();
        return;
      }
      
      const transaction = this.db.transaction(['sync_queue'], 'readwrite');
      const store = transaction.objectStore('sync_queue');
      
      let count = 0;
      queueIds.forEach(id => {
        const request = store.delete(id);
        request.onsuccess = () => {
          count++;
          if (count === queueIds.length) {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
    });
  }
}

// Ekspor instance tunggal database
const db = new SoviaDB();
window.soviaDb = db;
