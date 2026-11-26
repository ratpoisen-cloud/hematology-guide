// ==========================================================================
// Модуль загрузки и управления собственными материалами (PDF)
// Хранение в IndexedDB, генерация превью, интеграция в каталог и поиск
// ==========================================================================

import {
  saveCustomMaterial,
  getCustomMaterial,
  getAllCustomMaterials,
  deleteCustomMaterial,
} from './storage.js';

let pdfJsLibPromise = null;
async function getPdfJs() {
  if (pdfJsLibPromise) return pdfJsLibPromise;
  pdfJsLibPromise = (async () => {
    const mod = await import('./vendor/pdf.min.mjs');
    const lib = mod.default || mod;
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).toString();
    return lib;
  })();
  return pdfJsLibPromise;
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} МБ`;
  const kb = Math.max(1, Math.round(bytes / 1024));
  return `${kb} КБ`;
}

// Извлечение метаданных PDF: число страниц и превью 1-й страницы
export async function inspectPdfFile(file) {
  try {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages || 1;

    let thumbnail = null;
    try {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport }).promise;
      thumbnail = canvas.toDataURL('image/webp', 0.8);
      canvas.width = 1;
      canvas.height = 1;
    } catch (renderErr) {
      console.warn('Could not generate PDF thumbnail:', renderErr);
    }

    return { numPages, thumbnail };
  } catch (err) {
    console.error('PDF inspection failed:', err);
    return { numPages: 1, thumbnail: null };
  }
}

// Добавление пользовательского PDF-документа в IndexedDB
export async function importCustomPdf({ file, title, category }) {
  if (!file) throw new Error('Файл не выбран');
  const cleanTitle = (title || file.name.replace(/\.[^/.]+$/, '')).trim();
  const { numPages, thumbnail } = await inspectPdfFile(file);

  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    title: cleanTitle,
    category: (category || 'Клинический протокол').trim(),
    size: file.size,
    pages: numPages,
    blob: file,
    thumbnail,
    addedAt: Date.now(),
  };

  await saveCustomMaterial(record);
  return record;
}

// Преобразование записи из IndexedDB в элемент каталога статей для приложения
export function customMaterialToCatalogItem(record) {
  return {
    id: record.id,
    title: record.title,
    category: record.category || 'Мои материалы',
    source: {
      book_id: 'my-materials',
      book_title: 'Мои материалы',
      book_short: 'Мои материалы',
      year: new Date(record.addedAt || Date.now()).getFullYear(),
    },
    type: 'pdf',
    pdf: {
      isCustom: true,
      customId: record.id,
      pages: record.pages || 1,
      start: 1,
      end: record.pages || 1,
    },
    customThumbnail: record.thumbnail || null,
    fileSize: record.size || 0,
    addedAt: record.addedAt || Date.now(),
    isCustom: true,
  };
}

// Загрузка всех пользовательских материалов в виде элементов каталога
export async function loadCustomCatalogItems() {
  const records = await getAllCustomMaterials();
  return records.map(customMaterialToCatalogItem);
}

export { getCustomMaterial, deleteCustomMaterial, getAllCustomMaterials };
