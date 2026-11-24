// ==========================================================================
// IndexedDB хранилище приложения: заметки, прогресс чтения, офлайн-книги, настройки
// ==========================================================================

const DB_NAME = 'gem_ref_db';
const DB_VERSION = 1;
const SETTINGS_KEY = 'reader_settings';
const FALLBACK_NOTES_KEY = 'gem_notes_fallback';
const FALLBACK_PROGRESS_KEY = 'gem_progress_fallback';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
        notesStore.createIndex('articleId', 'articleId', { unique: false });
        notesStore.createIndex('bookId', 'bookId', { unique: false });
        notesStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('offline_books')) {
        db.createObjectStore('offline_books', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
  });
  return dbPromise;
}

async function runTx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    if (req && typeof req.onsuccess !== 'undefined') {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    }
  });
}

// --- Notes ---
export async function getAllNotes() {
  try {
    const items = await runTx('notes', 'readonly', (s) => s.getAll());
    return (items || []).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  } catch (_) {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_NOTES_KEY) || '[]');
    } catch (__) {
      return [];
    }
  }
}

export async function getNotesForArticle(articleId) {
  const all = await getAllNotes();
  return all.filter((n) => n.articleId === articleId);
}

export async function saveNote(note) {
  const now = Date.now();
  const record = {
    id: note.id || `note_${now}_${Math.random().toString(36).slice(2, 7)}`,
    articleId: note.articleId,
    bookId: note.bookId || 'other',
    bookShort: note.bookShort || '',
    title: note.title || '',
    page: note.page != null ? Number(note.page) : null,
    anchor: note.anchor || '',
    color: note.color || 'blue',
    text: (note.text || '').trim(),
    createdAt: note.createdAt || now,
    updatedAt: now,
  };
  try {
    await runTx('notes', 'readwrite', (s) => s.put(record));
  } catch (_) {
    const list = await getAllNotes();
    const idx = list.findIndex((x) => x.id === record.id);
    if (idx >= 0) list[idx] = record;
    else list.unshift(record);
    localStorage.setItem(FALLBACK_NOTES_KEY, JSON.stringify(list));
  }
  return record;
}

export async function deleteNote(id) {
  try {
    await runTx('notes', 'readwrite', (s) => s.delete(id));
  } catch (_) {
    const list = (await getAllNotes()).filter((x) => x.id !== id);
    localStorage.setItem(FALLBACK_NOTES_KEY, JSON.stringify(list));
  }
}

export async function exportNotesJSON() {
  const notes = await getAllNotes();
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'Справочник врача-гематолога',
    count: notes.length,
    notes,
  };
  return JSON.stringify(payload, null, 2);
}

// --- Reading Progress ---
export async function getProgress(key) {
  if (!key) return null;
  try {
    return (await runTx('progress', 'readonly', (s) => s.get(key))) || null;
  } catch (_) {
    try {
      const map = JSON.parse(localStorage.getItem(FALLBACK_PROGRESS_KEY) || '{}');
      return map[key] || null;
    } catch (__) {
      return null;
    }
  }
}

export async function saveProgress(key, data) {
  if (!key) return;
  const record = {
    key,
    page: data.page != null ? Number(data.page) : null,
    scrollRatio: data.scrollRatio != null ? Number(data.scrollRatio) : 0,
    total: data.total != null ? Number(data.total) : null,
    updatedAt: Date.now(),
  };
  try {
    await runTx('progress', 'readwrite', (s) => s.put(record));
  } catch (_) {
    try {
      const map = JSON.parse(localStorage.getItem(FALLBACK_PROGRESS_KEY) || '{}');
      map[key] = record;
      localStorage.setItem(FALLBACK_PROGRESS_KEY, JSON.stringify(map));
    } catch (__) { /* ignore */ }
  }
}

// --- Offline Books Metadata ---
export async function getOfflineBook(bookId) {
  try {
    return (await runTx('offline_books', 'readonly', (s) => s.get(bookId))) || null;
  } catch (_) {
    return null;
  }
}

export async function getAllOfflineBooks() {
  try {
    return (await runTx('offline_books', 'readonly', (s) => s.getAll())) || [];
  } catch (_) {
    return [];
  }
}

export async function setOfflineBook(record) {
  try {
    await runTx('offline_books', 'readwrite', (s) => s.put(record));
  } catch (_) { /* ignore */ }
}

export async function deleteOfflineBookRecord(bookId) {
  try {
    await runTx('offline_books', 'readwrite', (s) => s.delete(bookId));
  } catch (_) { /* ignore */ }
}

// --- Reader Settings ---
const DEFAULT_SETTINGS = {
  fontSize: 16,
  theme: 'light',
  viewMode: 'swipe',
};

export async function getReaderSettings() {
  try {
    const res = await runTx('settings', 'readonly', (s) => s.get(SETTINGS_KEY));
    return { ...DEFAULT_SETTINGS, ...(res?.value || {}) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveReaderSettings(partial) {
  const current = await getReaderSettings();
  const next = { ...current, ...partial };
  try {
    await runTx('settings', 'readwrite', (s) => s.put({ key: SETTINGS_KEY, value: next }));
  } catch (_) { /* ignore */ }
  return next;
}
