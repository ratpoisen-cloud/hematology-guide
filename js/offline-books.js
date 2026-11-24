// ==========================================================================
// Менеджер ленивой офлайн-загрузки учебников через Cache API
// Не раздувает базовый precache Service Worker: книги скачиваются по требованию.
// ==========================================================================

import {
  getAllOfflineBooks,
  getOfflineBook,
  setOfflineBook,
  deleteOfflineBookRecord,
} from './storage.js';

export const BOOK_CACHE_PREFIX = 'gem-book-';

// Примерный размер в МБ (для подсказки до загрузки)
const ESTIMATED_BOOK_MB = {
  'tables-handbook': 16,
  'aster': 41,
  'algorithms': 66,
  'devita': 120,
  'national-guide': 90,
  'basics': 35,
  'cr-rf': 18,
};

const activeDownloads = new Map(); // bookId -> { controller, progress }
const listeners = new Set();

export function onOfflineStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(bookId, state) {
  listeners.forEach((fn) => {
    try { fn(bookId, state); } catch (_) { /* ignore */ }
  });
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} МБ`;
  const kb = Math.max(1, Math.round(bytes / 1024));
  return `${kb} КБ`;
}

export function getBookEstimatedLabel(bookId, pagesCount = 0) {
  if (ESTIMATED_BOOK_MB[bookId]) return `~${ESTIMATED_BOOK_MB[bookId]} МБ`;
  if (pagesCount > 0) return `~${Math.max(1, Math.round(pagesCount * 0.09))} МБ`;
  return 'Офлайн';
}

/**
 * Собирает уникальный список всех ресурсов книги (обложка, WebP, PDF, FB2)
 */
export function collectBookAssets(bookId, catalogData) {
  const urls = new Set();
  const imgRegex = /!\[[^\]]*\]\(([^)]+)\)/g;

  catalogData.forEach((item) => {
    if (item.source?.book_id !== bookId) return;
    if (item.source?.book_cover) urls.add(item.source.book_cover);
    if (item.pdf?.file) urls.add(item.pdf.file);
    if (item.fb2?.file) urls.add(item.fb2.file);

    if (item.content_markdown) {
      let m;
      imgRegex.lastIndex = 0;
      while ((m = imgRegex.exec(item.content_markdown)) !== null) {
        if (m[1]) urls.add(m[1]);
      }
    }
  });

  // Если у книги есть PDF, гарантируем кэширование локального PDF.js движка при скачивании
  const hasPdf = catalogData.some((item) => item.source?.book_id === bookId && item.pdf?.file);
  if (hasPdf) {
    urls.add('./js/vendor/pdf.min.mjs');
    urls.add('./js/vendor/pdf.worker.min.mjs');
  }

  return [...urls];
}

export async function getBookOfflineSummary(bookId) {
  if (activeDownloads.has(bookId)) {
    return { status: 'downloading', ...activeDownloads.get(bookId).progress };
  }
  const record = await getOfflineBook(bookId);
  if (record && record.status === 'ready') {
    return record;
  }
  return { status: 'none', bookId };
}

export async function getAllOfflineSummaryMap() {
  const list = await getAllOfflineBooks();
  const map = new Map();
  list.forEach((rec) => {
    if (rec?.bookId) map.set(rec.bookId, rec);
  });
  activeDownloads.forEach((entry, bookId) => {
    map.set(bookId, { status: 'downloading', bookId, ...entry.progress });
  });
  return map;
}

export function cancelBookDownload(bookId) {
  const active = activeDownloads.get(bookId);
  if (active) {
    active.controller.abort();
    activeDownloads.delete(bookId);
    notify(bookId, { status: 'none', bookId });
  }
}

export async function downloadBook(bookId, catalogData) {
  if (activeDownloads.has(bookId)) return;
  if (!('caches' in window)) {
    throw new Error('Cache API не поддерживается в этом браузере');
  }

  const assets = collectBookAssets(bookId, catalogData);
  if (assets.length === 0) {
    throw new Error('Нет файлов для скачивания');
  }

  // Запрашиваем постоянное хранилище у браузера (защита от очистки на iOS/Android)
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch (_) { /* ignore */ }

  const controller = new AbortController();
  const progress = { loaded: 0, total: assets.length, bytes: 0, percent: 0 };
  activeDownloads.set(bookId, { controller, progress });
  notify(bookId, { status: 'downloading', bookId, ...progress });

  const cacheName = `${BOOK_CACHE_PREFIX}${bookId}`;
  const cache = await caches.open(cacheName);
  const CONCURRENCY = 4;
  let index = 0;

  async function worker() {
    while (index < assets.length) {
      if (controller.signal.aborted) return;
      const url = assets[index++];
      try {
        // Не качаем повторно, если файл уже есть в кэше книги
        const existing = await cache.match(url);
        if (existing) {
          const len = Number(existing.headers.get('content-length')) || 0;
          progress.bytes += len;
        } else {
          const resp = await fetch(url, { signal: controller.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
          const clone = resp.clone();
          const lenHeader = Number(resp.headers.get('content-length')) || 0;
          if (lenHeader > 0) {
            progress.bytes += lenHeader;
          } else {
            const buf = await resp.arrayBuffer();
            progress.bytes += buf.byteLength;
          }
          await cache.put(url, clone);
        }
      } catch (err) {
        if (controller.signal.aborted || err.name === 'AbortError') return;
        throw err;
      }

      progress.loaded += 1;
      progress.percent = Math.round((progress.loaded / progress.total) * 100);
      notify(bookId, { status: 'downloading', bookId, ...progress });
    }
  }

  try {
    const workers = Array.from({ length: Math.min(CONCURRENCY, assets.length) }, () => worker());
    await Promise.all(workers);

    if (controller.signal.aborted) {
      await caches.delete(cacheName);
      activeDownloads.delete(bookId);
      notify(bookId, { status: 'none', bookId });
      return null;
    }

    const record = {
      bookId,
      status: 'ready',
      downloadedAt: Date.now(),
      totalFiles: assets.length,
      bytes: progress.bytes,
    };
    await setOfflineBook(record);
    activeDownloads.delete(bookId);
    notify(bookId, record);
    return record;
  } catch (err) {
    activeDownloads.delete(bookId);
    notify(bookId, { status: 'error', bookId, error: err.message });
    throw err;
  }
}

export async function removeBookCache(bookId) {
  cancelBookDownload(bookId);
  if ('caches' in window) {
    await caches.delete(`${BOOK_CACHE_PREFIX}${bookId}`);
  }
  await deleteOfflineBookRecord(bookId);
  notify(bookId, { status: 'none', bookId });
}
