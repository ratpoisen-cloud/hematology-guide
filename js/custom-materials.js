// ==========================================================================
// Модуль загрузки и управления собственными материалами (PDF, FB2, Markdown, TXT)
// Хранение в IndexedDB, привязка к разделам (Мои материалы, Учебники, Протоколы, Клинрекомендации)
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

// Декодирование XML с поддержкой кодировок (windows-1251, utf-8, koi8-r)
export async function readXmlTextWithEncoding(blobOrFile) {
  const buf = await blobOrFile.arrayBuffer();
  const headerBytes = new Uint8Array(buf.slice(0, 250));
  const headerAscii = String.fromCharCode(...headerBytes);
  const encMatch = headerAscii.match(/<\?xml[^>]+encoding=["']([^"']+)["']/i);
  let encoding = 'utf-8';
  if (encMatch && encMatch[1]) {
    const declared = encMatch[1].toLowerCase().trim();
    if (declared.includes('1251') || declared === 'windows-1251' || declared === 'cp1251') {
      encoding = 'windows-1251';
    } else if (declared.includes('koi8')) {
      encoding = 'koi8-r';
    } else if (declared.includes('iso-8859-5')) {
      encoding = 'iso-8859-5';
    }
  }
  try {
    const decoder = new TextDecoder(encoding);
    return decoder.decode(buf);
  } catch (e) {
    const fallback = new TextDecoder('utf-8');
    return fallback.decode(buf);
  }
}

// Определение формата файла по имени и MIME-типу
export function detectFileFormat(file) {
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file?.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.fb2') || file?.type.includes('fictionbook') || file?.type.includes('xml')) return 'fb2';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.txt') || file?.type === 'text/plain') return 'txt';
  return null;
}

export function getFormatBadgeLabel(format) {
  if (format === 'pdf') return 'PDF';
  if (format === 'fb2') return 'FB2';
  if (format === 'markdown') return 'Markdown';
  if (format === 'txt') return 'Текст';
  return 'Документ';
}

// Определение метаданных в зависимости от формата
export async function inspectCustomFile(file) {
  const format = detectFileFormat(file);
  if (!format) {
    throw new Error('Неподдерживаемый формат файла. Поддерживаются PDF, FB2, Markdown (.md) и TXT.');
  }

  if (format === 'pdf') {
    let pdf = null;
    try {
      const pdfjsLib = await getPdfJs();
      const arrayBuffer = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
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

      return { format, numPages, thumbnail, title: file.name.replace(/\.[^/.]+$/, '') };
    } catch (err) {
      console.error('PDF inspection failed:', err);
      return { format: 'pdf', numPages: 1, thumbnail: null, title: file.name.replace(/\.[^/.]+$/, '') };
    } finally {
      if (pdf) {
        try { pdf.destroy(); } catch (_) {}
      }
    }
  }

  if (format === 'fb2') {
    try {
      const text = await readXmlTextWithEncoding(file);
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');

      // Название книги
      const titleEl = doc.querySelector('title-info > book-title');
      const bookTitle = titleEl ? titleEl.textContent.trim() : file.name.replace(/\.[^/.]+$/, '');

      // Обложка FB2
      let thumbnail = null;
      const coverImage = doc.querySelector('title-info > coverpage > image');
      if (coverImage) {
        const href = (coverImage.getAttribute('l:href') || coverImage.getAttribute('href') || '').replace(/^#/, '');
        if (href) {
          const binaryEl = doc.getElementById(href) || doc.querySelector(`binary[id="${href}"]`);
          if (binaryEl) {
            const type = binaryEl.getAttribute('content-type') || 'image/jpeg';
            const b64 = (binaryEl.textContent || '').replace(/\s+/g, '');
            if (b64) thumbnail = `data:${type};base64,${b64}`;
          }
        }
      }

      // Примерная длина в "страницах" (~2000 знаков на страницу)
      const numPages = Math.max(1, Math.round(text.length / 2000));
      return { format: 'fb2', numPages, thumbnail, title: bookTitle };
    } catch (err) {
      console.error('FB2 inspection failed:', err);
      return { format: 'fb2', numPages: 1, thumbnail: null, title: file.name.replace(/\.[^/.]+$/, '') };
    }
  }

  // Markdown или обычный текст
  try {
    const text = await file.text();
    let detectedTitle = '';
    const match = text.match(/^#\s+(.+)$/m);
    if (match) detectedTitle = match[1].trim();
    if (!detectedTitle) detectedTitle = file.name.replace(/\.[^/.]+$/, '');

    const numPages = Math.max(1, Math.round(text.length / 2500));
    return {
      format: format === 'markdown' ? 'markdown' : 'txt',
      numPages,
      thumbnail: null,
      title: detectedTitle,
      snippet: text.slice(0, 300),
    };
  } catch (err) {
    return { format: 'markdown', numPages: 1, thumbnail: null, title: file.name.replace(/\.[^/.]+$/, '') };
  }
}

// Добавление пользовательского документа в IndexedDB
export async function importCustomDocument({ file, title, category, section }) {
  if (!file) throw new Error('Файл не выбран');
  const info = await inspectCustomFile(file);
  const cleanTitle = (title || info.title || file.name.replace(/\.[^/.]+$/, '')).trim();

  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    title: cleanTitle,
    category: (category || 'Клинический протокол').trim(),
    section: section || 'my-materials', // 'my-materials' | 'books' | 'emergency' | 'cr-rf'
    format: info.format,
    size: file.size,
    pages: info.numPages,
    blob: file,
    thumbnail: info.thumbnail,
    snippet: info.snippet || '',
    addedAt: Date.now(),
  };

  await saveCustomMaterial(record);
  return record;
}

function getSectionMeta(sectionId) {
  if (sectionId === 'emergency') {
    return { book_id: 'emergency', book_title: 'Неотложные протоколы', book_short: 'Неотложные' };
  }
  if (sectionId === 'books') {
    return { book_id: 'custom-books', book_title: 'Учебники', book_short: 'Учебники' };
  }
  if (sectionId === 'cr-rf') {
    return { book_id: 'cr-rf', book_title: 'Клинические рекомендации РФ', book_short: 'Клинрекомендации' };
  }
  return { book_id: 'my-materials', book_title: 'Мои материалы', book_short: 'Мои материалы' };
}

// Преобразование записи из IndexedDB в элемент каталога статей для приложения
export function customMaterialToCatalogItem(record) {
  const meta = getSectionMeta(record.section || 'my-materials');
  const fmt = record.format || 'pdf';

  const pages = Number(record.pages) || Number(record.pdf?.pages) || 1;

  const item = {
    id: record.id,
    title: record.title,
    category: record.category || meta.book_short,
    format: fmt,
    type: fmt === 'pdf' ? 'pdf' : (fmt === 'fb2' ? 'fb2' : 'markdown'),
    targetSection: record.section || 'my-materials',
    pages: pages,
    source: {
      book_id: meta.book_id,
      book_title: meta.book_title,
      book_short: meta.book_short,
      book_tile_title: record.title,
      book_cover: record.thumbnail || null,
      pages: pages,
      year: new Date(record.addedAt || Date.now()).getFullYear(),
    },
    customThumbnail: record.thumbnail || null,
    fileSize: record.size || 0,
    addedAt: record.addedAt || Date.now(),
    isCustom: true,
    customId: record.id,
  };

  if (fmt === 'pdf') {
    item.pdf = {
      isCustom: true,
      customId: record.id,
      pages: pages,
      start: 1,
      end: pages,
    };
  } else if (fmt === 'fb2') {
    item.fb2 = {
      isCustom: true,
      customId: record.id,
      file: '',
    };
  } else {
    item.snippet = record.snippet || '';
    item.content_markdown = ''; // Загружается целиком из blob при открытии в ридере
  }

  return item;
}

// Загрузка всех пользовательских материалов в виде элементов каталога
export async function loadCustomCatalogItems() {
  const records = await getAllCustomMaterials();
  return records.map(customMaterialToCatalogItem);
}

export { getCustomMaterial, deleteCustomMaterial, getAllCustomMaterials };
