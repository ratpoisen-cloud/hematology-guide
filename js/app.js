import { HematologySearchEngine } from './search-engine.js';
import { createReader } from './reader.js';
import { getAllNotes, deleteNote } from './storage.js';
import {
  downloadBook,
  removeBookCache,
  cancelBookDownload,
  getAllOfflineSummaryMap,
  getBookEstimatedLabel,
  formatBytes,
  onOfflineStateChange,
} from './offline-books.js';

const searchEngine = new HematologySearchEngine();
let currentTab = 'search';
let activeCategory = 'all';
let activeBookFilter = 'all';
let navLevel = 'sources'; // sources | books | articles
let activeBookmarkSubtab = 'articles'; // articles | notes
let catalogData = [];
let bookmarks = JSON.parse(localStorage.getItem('gem_bookmarks') || '[]');
let offlineSummaryMap = new Map();
let reader = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const segmentBtns = document.querySelectorAll('#segmentedControl .segment-btn');
const bookFilterScroll = document.getElementById('bookFilterScroll');
const articlesList = document.getElementById('articlesList');
const itemCount = document.getElementById('itemCount');
const dockButtons = document.querySelectorAll('.dock-btn');
const searchView = document.getElementById('searchView');
const calcView = document.getElementById('calcView');
const bookmarksView = document.getElementById('bookmarksView');
const searchContainer = document.querySelector('.search-container');
const segmentedControl = document.getElementById('segmentedControl');
const navTitle = document.querySelector('.nav-title');
const bookmarksList = document.getElementById('bookmarksList');

// Service Worker Registration + мгновенное обновление при смене версии
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) {
        hadController = false;
        window.location.reload();
      }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Порядок и человекочитаемые подписи источников для горизонтального фильтра
const BOOK_ORDER = [
  { id: 'all', short: 'Все разделы' },
  { id: 'cr-rf', short: 'Клинрекомендации РФ' },
  { id: 'emergency', short: 'Неотложные протоколы' },
  { id: 'tables-handbook', short: 'Справочник в таблицах' },
  { id: 'national-guide', short: 'Нац. руководство' },
  { id: 'algorithms', short: 'Алгоритмы НМИЦ' },
  { id: 'aster', short: 'Патофизиология Астер' },
  { id: 'basics', short: 'Основы гематологии' },
  { id: 'hematology-translation', short: 'Гематология (пер. с англ.)' },
  { id: 'devita', short: 'DeVita Cancer (EN)' },
];

function renderBookFilters() {
  if (!bookFilterScroll) return;

  const counts = { all: catalogData.length };
  catalogData.forEach(item => {
    const bid = item.source?.book_id;
    if (bid) {
      counts[bid] = (counts[bid] || 0) + 1;
    }
  });

  const availableBooks = BOOK_ORDER.filter(b => (counts[b.id] || 0) > 0);

  bookFilterScroll.innerHTML = availableBooks.map(b => {
    const count = counts[b.id] || 0;
    const isActive = activeBookFilter === b.id;
    return `
      <button class="book-chip ${isActive ? 'active' : ''}" data-book-id="${b.id}" role="tab" aria-selected="${isActive}">
        <span>${b.short}</span>
        <span class="book-chip-count">${count}</span>
      </button>
    `;
  }).join('');

  bookFilterScroll.querySelectorAll('.book-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const bid = btn.getAttribute('data-book-id');
      setActiveBookFilter(bid);
    });
  });
}

function updateBookChipStates() {
  if (!bookFilterScroll) return;
  bookFilterScroll.querySelectorAll('.book-chip').forEach(btn => {
    const matches = btn.getAttribute('data-book-id') === activeBookFilter;
    btn.classList.toggle('active', matches);
    btn.setAttribute('aria-selected', matches ? 'true' : 'false');
  });
}

function setActiveBookFilter(bid) {
  activeBookFilter = bid;
  navLevel = bid === 'all' ? 'sources' : 'articles';
  updateBookChipStates();
  performSearch();
}

function setNavLevel(level) {
  navLevel = level;
  activeBookFilter = 'all';
  updateBookChipStates();
  performSearch();
}

function performSearch() {
  const query = searchInput.value.trim();

  // Три уровня навигации без поиска: разделы → учебники → главы
  if (!query && activeCategory === 'all') {
    if (navLevel === 'sources') {
      renderSectionTiles();
      return;
    }
    if (navLevel === 'books') {
      renderBookTiles();
      return;
    }
  }

  const results = searchEngine.search(query, activeCategory, activeBookFilter);
  renderResults(results, activeBookFilter !== 'all' || navLevel !== 'sources');
}

// Data Fetch & Engine Init
async function init() {
  try {
    const res = await fetch('./data/catalog.json');
    catalogData = await res.json();
    searchEngine.loadData(catalogData);
    renderBookFilters();
    performSearch();
  } catch (err) {
    console.error('Data load error:', err);
    articlesList.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 48px;">
      Не удалось загрузить базу данных.
    </div>`;
  }
}

// Markdown formatting helper with link support
function formatInlineMarkdown(text) {
  if (!text) return '';
  let res = text;
  // Markdown links: [Title](#id) or [Title](url)
  res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="doc-link" data-internal-id="$2">$1</a>');
  // Bold & Italic & Code
  res = res.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  res = res.replace(/\*(.*?)\*/g, '<em>$1</em>');
  res = res.replace(/`([^`]+)`/g, '<code>$1</code>');
  return res;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Robust Line-by-Line Markdown Parser (tables, images, links, blockquotes)
function parseMarkdown(md) {
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  const output = [];
  let inTable = false;
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length > 0) {
      let tableHtml = '<div class="table-scroll-container"><table>';
      tableRows.forEach((row, idx) => {
        if (row.every(cell => /^[-: ]+$/.test(cell))) return;
        const tag = idx === 0 ? 'th' : 'td';
        tableHtml += '<tr>' + row.map(cell => `<${tag}>${formatInlineMarkdown(cell)}</${tag}>`).join('') + '</tr>';
      });
      tableHtml += '</table></div>';
      output.push(tableHtml);
      tableRows = [];
    }
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Табличная строка (начинается и заканчивается на |)
    if (line.startsWith('|') && line.endsWith('|') && line.length > 1) {
      inTable = true;
      const rawCells = line.slice(1, -1).split('|');
      tableRows.push(rawCells.map(c => c.trim()));
      continue;
    }

    if (inTable) {
      flushTable();
    }

    if (!line) {
      continue;
    }

    // Изображения: ![alt](url)
    const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imgMatch) {
      const alt = imgMatch[1];
      const src = imgMatch[2];
      const pageMatch = src.match(/p(\d{3})\.webp/);
      const pageAttr = pageMatch ? ` data-page="${parseInt(pageMatch[1], 10)}"` : '';
      output.push(`
        <figure class="article-figure">
          <img src="${src}" alt="${alt}" loading="lazy" class="zoomable-image" data-src="${src}" data-caption="${alt}"${pageAttr}>
          <figcaption class="figure-caption">${alt}</figcaption>
        </figure>
      `);
      continue;
    }

    // Заголовки
    if (line.startsWith('### ')) {
      output.push(`<h3>${formatInlineMarkdown(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      output.push(`<h3>${formatInlineMarkdown(line.slice(3))}</h3>`);
      continue;
    }

    // Цитаты и врезки
    if (line.startsWith('> ')) {
      output.push(`<blockquote>${formatInlineMarkdown(line.slice(2))}</blockquote>`);
      continue;
    }

    // Списки
    if (line.startsWith('* ') || line.startsWith('- ')) {
      output.push(`<li>${formatInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    // Обычные абзацы
    output.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  if (inTable) {
    flushTable();
  }

  return output.join('\n');
}

function getTypeLabel(type) {
  if (type === 'nosology') return 'Нозология';
  if (type === 'protocol') return 'Протокол';
  if (type === 'criteria') return 'Критерии';
  if (type === 'toc') return 'Оглавление';
  if (type === 'visual') return 'Таблицы';
  return 'Раздел';
}

// Навигация по трём уровням: разделы → учебники → главы
const SOURCE_ICON_BOOK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`;
const SOURCE_ICON_DOC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
const SOURCE_ICON_STACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`;

function pluralForm(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function getBackState() {
  if (navLevel === 'books') return { label: '← Учебники', target: 'books' };
  if (activeBookFilter === 'emergency') return { label: '← Все разделы', target: 'sources' };
  if (activeBookFilter && activeBookFilter !== 'all') return { label: '← Учебники', target: 'books' };
  return { label: '← Все разделы', target: 'sources' };
}

function renderSectionTiles() {
  const visualItems = catalogData.filter(a => a.type === 'visual');
  const bookIds = new Set(visualItems.map(a => a.source?.book_id));
  const emergencyItems = catalogData.filter(a => a.source?.book_id === 'emergency');

  const sections = [];
  if (bookIds.size) {
    sections.push({
      nav: 'books',
      kind: 'Раздел',
      title: 'Учебники',
      countText: `${bookIds.size} ${pluralForm(bookIds.size, ['учебник', 'учебника', 'учебников'])} · ${visualItems.length} ${pluralForm(visualItems.length, ['глава', 'главы', 'глав'])}`,
      icon: SOURCE_ICON_STACK,
    });
  }
  if (emergencyItems.length) {
    sections.push({
      nav: 'filter',
      bookId: 'emergency',
      kind: 'Неотложные протоколы',
      title: 'Неотложные протоколы',
      countText: `${emergencyItems.length} ${pluralForm(emergencyItems.length, ['протокол', 'протокола', 'протоколов'])}`,
      icon: SOURCE_ICON_DOC,
    });
  }

  itemCount.textContent = `${sections.length} ${pluralForm(sections.length, ['раздел', 'раздела', 'разделов'])}`;

  articlesList.innerHTML = sections.map((section, index) => `
    <button class="source-tile" data-nav="${section.nav}" data-book-id="${section.bookId || ''}" style="animation-delay: ${Math.min(index * 40, 200)}ms">
      <span class="source-tile-icon">${section.icon}</span>
      <span class="source-tile-body">
        <span class="source-tile-kind">${section.kind}</span>
        <span class="source-tile-title">${section.title}</span>
        <span class="source-tile-count">${section.countText}</span>
      </span>
      <span class="source-tile-arrow" aria-hidden="true">→</span>
    </button>
  `).join('');

  articlesList.querySelectorAll('.source-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      if (tile.getAttribute('data-nav') === 'books') {
        setNavLevel('books');
      } else {
        setActiveBookFilter(tile.getAttribute('data-book-id'));
      }
    });
  });
}

function renderDownloadButtonHtml(bookId, pagesCount = 0) {
  const state = offlineSummaryMap.get(bookId) || { status: 'none' };
  if (state.status === 'downloading') {
    const pct = state.percent || 0;
    const r = 8;
    const c = 2 * Math.PI * r;
    const offset = c - (pct / 100) * c;
    return `
      <button type="button" class="book-download-btn is-downloading" data-download-book="${bookId}" title="Отменить загрузку">
        <svg class="dl-ring" viewBox="0 0 20 20"><circle class="dl-ring-bg" cx="10" cy="10" r="${r}"/><circle class="dl-ring-fg" cx="10" cy="10" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/></svg>
        <span>${pct}% · ✕</span>
      </button>
    `;
  }
  if (state.status === 'ready') {
    const sizeText = state.bytes ? formatBytes(state.bytes) : 'Офлайн';
    return `
      <button type="button" class="book-download-btn is-ready" data-download-book="${bookId}" title="Удалить из офлайн-кэша">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
        <span>Офлайн · ${sizeText}</span>
      </button>
    `;
  }
  const est = getBookEstimatedLabel(bookId, pagesCount);
  return `
    <button type="button" class="book-download-btn" data-download-book="${bookId}" title="Скачать учебник для чтения без интернета">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg>
      <span>Скачать (${est})</span>
    </button>
  `;
}

function handleDownloadClick(bookId) {
  const state = offlineSummaryMap.get(bookId) || { status: 'none' };
  if (state.status === 'downloading') {
    cancelBookDownload(bookId);
    return;
  }
  if (state.status === 'ready') {
    if (confirm('Удалить скачанную книгу из офлайн-памяти устройства?')) {
      removeBookCache(bookId);
    }
    return;
  }
  downloadBook(bookId, catalogData).catch((err) => {
    alert(`Ошибка загрузки: ${err.message}`);
  });
}

onOfflineStateChange((bookId, state) => {
  offlineSummaryMap.set(bookId, state);
  document.querySelectorAll(`[data-download-book="${bookId}"]`).forEach((btn) => {
    const pages = Number(btn.getAttribute('data-book-pages')) || 0;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderDownloadButtonHtml(bookId, pages).trim();
    const newBtn = tmp.firstElementChild;
    newBtn.setAttribute('data-book-pages', String(pages));
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDownloadClick(bookId);
    });
    btn.replaceWith(newBtn);
  });
});

async function renderBookTiles() {
  offlineSummaryMap = await getAllOfflineSummaryMap();
  const groups = new Map();
  catalogData.filter(a => a.type === 'visual' || a.type === 'fb2').forEach(item => {
    const id = item.source?.book_id || 'other';
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        title: item.source?.book_tile_title || item.source?.book || item.source?.book_short || id,
        cover: item.source?.book_cover || null,
        chapters: 0,
        pages: 0,
      });
    }
    const book = groups.get(id);
    book.chapters += 1;
    book.pages += Array.isArray(item.search_pages) ? item.search_pages.length : (item.pdf?.pages || 0);
  });

  const books = [...groups.values()];
  itemCount.textContent = `${books.length} ${pluralForm(books.length, ['учебник', 'учебника', 'учебников'])}`;

  articlesList.innerHTML = `<button class="back-tile" id="backToSectionsBtn">← Все разделы</button>` + books.map((book, index) => {
    const cover = book.cover
      ? `<span class="source-tile-cover"><img src="${book.cover}" alt="Обложка учебника" loading="lazy"></span>`
      : `<span class="source-tile-icon">${SOURCE_ICON_BOOK}</span>`;

    return `
    <div class="source-tile source-tile--book" data-book-id="${book.id}" role="button" tabindex="0" style="animation-delay: ${Math.min(index * 40, 200)}ms">
      ${cover}
      <span class="source-tile-body">
        <span class="source-tile-kind">Учебник · визуальный</span>
        <span class="source-tile-title source-tile-title--book">${escapeHtml(book.title)}</span>
        <span class="source-tile-count">${book.chapters} ${pluralForm(book.chapters, ['глава', 'главы', 'глав'])}${book.pages ? ` · ${book.pages} стр.` : ''}</span>
        <span class="source-tile-actions-row">${renderDownloadButtonHtml(book.id, book.pages)}</span>
      </span>
      <span class="source-tile-arrow" aria-hidden="true">→</span>
    </div>
  `;
  }).join('');

  document.getElementById('backToSectionsBtn').addEventListener('click', () => setNavLevel('sources'));

  articlesList.querySelectorAll('.source-tile').forEach(tile => {
    tile.addEventListener('click', () => setActiveBookFilter(tile.getAttribute('data-book-id')));
  });
  articlesList.querySelectorAll('[data-download-book]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDownloadClick(btn.getAttribute('data-download-book'));
    });
  });
}

// Render Results Grid
function renderResults(results, showBack = false) {
  const back = getBackState();
  const showBookDl = showBack && activeBookFilter && activeBookFilter !== 'all' && activeBookFilter !== 'emergency';
  const backTile = showBack
    ? `<div class="book-chapter-toolbar">
        <button class="back-tile" id="backToSourcesBtn" style="flex:1;">${back.label}</button>
        ${showBookDl ? renderDownloadButtonHtml(activeBookFilter) : ''}
      </div>`
    : '';

  const bindBack = () => {
    const backBtn = document.getElementById('backToSourcesBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (back.target === 'books') {
          setNavLevel('books');
        } else {
          setActiveBookFilter('all');
        }
      });
    }
    articlesList.querySelectorAll('[data-download-book]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDownloadClick(btn.getAttribute('data-download-book'));
      });
    });
  };

  if (!results || results.length === 0) {
    itemCount.textContent = '0 записей';
    articlesList.innerHTML = backTile + `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <p style="font-size: 0.95rem; font-weight: 500;">Ничего не найдено</p>
        <p style="font-size: 0.8rem; margin-top: 4px;">Попробуйте выбрать другой источник или поисковый запрос</p>
      </div>`;
    bindBack();
    return;
  }

  itemCount.textContent = `${results.length} ${results.length === 1 ? 'запись' : results.length < 5 ? 'записи' : 'записей'}`;

  articlesList.innerHTML = backTile + results.map(({ item, page, snippet }, index) => {
    const typeLabel = getTypeLabel(item.type);
    const bookTitle = item.source.book_short || item.source.book;
    const pageLabel = page ? `стр. ${page}` : `стр. ${item.source.pages}`;

    return `
      <article class="card-tile" data-id="${item.id}" data-page="${page || ''}" style="animation-delay: ${Math.min(index * 25, 200)}ms">
        <div>
          <div class="card-meta-bar">
            <span class="card-source-tag">${bookTitle}${page ? ` · стр. ${page}` : ''}</span>
            <span class="badge-outline">${typeLabel}</span>
          </div>
          
          <h2 class="card-title">${item.title}</h2>

          ${snippet ? `<p class="card-snippet">${escapeHtml(snippet)}</p>` : ''}

          ${item.quick_facts ? `
            <ul class="card-summary-list">
              ${item.quick_facts.slice(0, 2).map(f => `<li>${f}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        <div class="card-footer-tags">
          ${item.icd10 ? item.icd10.slice(0, 3).map(c => `<span class="tag-pill">${c}</span>`).join('') : ''}
          <span class="tag-pill">${pageLabel}</span>
        </div>
      </article>
    `;
  }).join('');

  bindBack();

  // Click card to open modal (and jump to the found page)
  articlesList.querySelectorAll('.card-tile').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const page = parseInt(card.getAttribute('data-page'), 10) || null;
      const article = catalogData.find(a => a.id === id);
      if (article) openArticleModal(article, page);
    });
  });
}

function toggleBookmarkById(articleId) {
  if (bookmarks.includes(articleId)) {
    bookmarks = bookmarks.filter(b => b !== articleId);
  } else {
    bookmarks.push(articleId);
  }
  localStorage.setItem('gem_bookmarks', JSON.stringify(bookmarks));
  if (currentTab === 'bookmarks') renderBookmarks();
}

reader = createReader({
  parseMarkdown,
  getCatalog: () => catalogData,
  isBookmarked: (id) => bookmarks.includes(id),
  onToggleBookmark: toggleBookmarkById,
  onNotesChanged: () => {
    if (currentTab === 'bookmarks') renderBookmarks();
  },
});

// Fullscreen Reader View Logic
function openArticleModal(article, targetPage = null) {
  if (reader) reader.open(article, targetPage);
}

// Search input handling
searchInput.addEventListener('input', (e) => {
  const query = e.target.value;
  clearSearchBtn.style.display = query ? 'flex' : 'none';
  performSearch();
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.style.display = 'none';
  performSearch();
  searchInput.focus();
});

// Segmented Navigation
segmentBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    segmentBtns.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    activeCategory = btn.getAttribute('data-type');
    performSearch();
  });
});

// Калькуляторы: плитки групп по аналогии с навигацией по источникам
const CALC_ICON_BODY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 9h16v6H4zM8 9v3m4-3v4m4-4v3"/></svg>`;
const CALC_ICON_LAB = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3h6M10 3v6l-5 9a2 2 0 001.7 3h10.6a2 2 0 001.7-3l-5-9V3M7.5 15h9"/></svg>`;
const CALC_ICON_RISK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3zM9 12l2 2 4-4"/></svg>`;

const CALC_GROUPS = [
  { id: 'body', kind: 'Антропометрия и дозирование', title: 'Дозирование и антропометрия', names: 'BSA, ИМТ', icon: CALC_ICON_BODY },
  { id: 'labs', kind: 'Лаборатория и функция почек', title: 'Показатели крови и почки', names: 'АЧН, Cockcroft-Gault', icon: CALC_ICON_LAB },
  { id: 'risk', kind: 'Диагностические шкалы', title: 'Шкалы риска тромбоза', names: '4T, Хорана, Женева, IMPEDE VTE', icon: CALC_ICON_RISK },
];

let activeCalcGroup = 'all';
let activeCalcId = null;
let calcQuery = '';
const calcGroupsEl = document.getElementById('calcGroups');
const calcGridEl = document.getElementById('calcGrid');
const calcSearchContainer = document.getElementById('calcSearchContainer');
const calcSearchInput = document.getElementById('calcSearchInput');
const clearCalcSearchBtn = document.getElementById('clearCalcSearchBtn');
const calcCards = () => [...document.querySelectorAll('#calcView .panel-card[data-calc-group]')];

function calcMeta(card, index) {
  const groupId = card.getAttribute('data-calc-group');
  const group = CALC_GROUPS.find(g => g.id === groupId);
  return {
    id: `calc-${index}`,
    groupId,
    group,
    label: card.querySelector('.panel-label')?.textContent.trim() || '',
    title: card.querySelector('.panel-title')?.textContent.trim() || 'Калькулятор',
  };
}

function calcTile(meta, index, showGroup = false) {
  return `
    <button class="source-tile calc-tile" data-calc-target="${meta.id}" style="animation-delay: ${Math.min(index * 35, 200)}ms">
      <span class="source-tile-icon">${meta.group?.icon || ''}</span>
      <span class="source-tile-body">
        <span class="source-tile-kind">${showGroup ? (meta.group?.title || '') : (meta.group?.kind || '')}</span>
        <span class="source-tile-title">${meta.title}</span>
        <span class="source-tile-count">${meta.label}</span>
      </span>
      <span class="source-tile-arrow" aria-hidden="true">→</span>
    </button>`;
}

function bindCalcBack(handler, label = '← Назад') {
  calcGroupsEl.innerHTML = `<button class="back-tile" id="backToCalcGroupsBtn">${label}</button>`;
  document.getElementById('backToCalcGroupsBtn').addEventListener('click', () => {
    handler();
    renderCalcGroups();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function resetCalcQuery() {
  calcQuery = '';
  activeCalcGroup = 'all';
  activeCalcId = null;
  if (calcSearchInput) calcSearchInput.value = '';
  if (clearCalcSearchBtn) clearCalcSearchBtn.style.display = 'none';
}

function selectCalc(id) {
  calcQuery = '';
  activeCalcGroup = 'all';
  activeCalcId = id;
  if (calcSearchInput) calcSearchInput.value = '';
  if (clearCalcSearchBtn) clearCalcSearchBtn.style.display = 'none';
}

function renderCalcGroups() {
  const cards = calcCards();
  if (!calcGroupsEl) return;

  cards.forEach((card, index) => {
    if (!card.dataset.calcId) card.dataset.calcId = `calc-${index}`;
  });
  const metas = cards.map((card, index) => calcMeta(card, index));
  if (calcSearchContainer) {
    calcSearchContainer.style.display = activeCalcId === null ? 'flex' : 'none';
  }
  if (clearCalcSearchBtn) clearCalcSearchBtn.style.display = calcQuery ? 'flex' : 'none';
  calcGridEl?.classList.toggle('calc-single', activeCalcId !== null);

  // Поиск по калькуляторам — плоский список совпадений из всех групп.
  if (calcQuery) {
    const found = metas.filter(m =>
      `${m.title} ${m.label} ${m.group?.title || ''} ${m.group?.kind || ''}`
        .toLowerCase().includes(calcQuery)
    );
    navTitle.textContent = 'Результаты поиска';
    itemCount.textContent = `${found.length} ${pluralForm(found.length, ['инструмент', 'инструмента', 'инструментов'])}`;
    if (!found.length) {
      bindCalcBack(resetCalcQuery, '← Сбросить поиск');
      calcGroupsEl.insertAdjacentHTML('beforeend', `<div class="calc-empty">Ничего не найдено. Попробуйте «BSA», «тромбоз» или «Cockcroft».</div>`);
      return;
    }
    bindCalcBack(resetCalcQuery, '← Сбросить поиск');
    calcGroupsEl.insertAdjacentHTML('beforeend', found.map((m, i) => calcTile(m, i, true)).join(''));
    calcGroupsEl.querySelectorAll('[data-calc-target]').forEach(tile => {
      tile.addEventListener('click', () => {
        selectCalc(tile.getAttribute('data-calc-target'));
        renderCalcGroups();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  } else if (activeCalcId !== null) {
    const meta = metas.find(m => m.id === activeCalcId) || metas[0];
    navTitle.textContent = meta.title;
    itemCount.textContent = meta.group?.kind || 'Калькулятор';
    bindCalcBack(() => { activeCalcId = null; }, `← К списку: ${meta.group?.title || 'калькуляторы'}`);
  } else if (activeCalcGroup === 'all') {
    navTitle.textContent = 'Калькуляторы';
    itemCount.textContent = `${CALC_GROUPS.length} ${pluralForm(CALC_GROUPS.length, ['группа', 'группы', 'групп'])}`;
    calcGroupsEl.innerHTML = CALC_GROUPS.map((group, index) => {
      const count = metas.filter(m => m.groupId === group.id).length;
      return `
        <button class="source-tile" data-calc-group-target="${group.id}" style="animation-delay: ${Math.min(index * 40, 200)}ms">
          <span class="source-tile-icon">${group.icon}</span>
          <span class="source-tile-body">
            <span class="source-tile-kind">${group.kind}</span>
            <span class="source-tile-title">${group.title}</span>
            <span class="source-tile-count">${count} ${pluralForm(count, ['инструмент', 'инструмента', 'инструментов'])} · ${group.names}</span>
          </span>
          <span class="source-tile-arrow" aria-hidden="true">→</span>
        </button>`;
    }).join('');
    calcGroupsEl.querySelectorAll('[data-calc-group-target]').forEach(tile => {
      tile.addEventListener('click', () => {
        activeCalcGroup = tile.getAttribute('data-calc-group-target');
        renderCalcGroups();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  } else {
    const group = CALC_GROUPS.find(g => g.id === activeCalcGroup);
    const items = metas.filter(m => m.groupId === activeCalcGroup);
    navTitle.textContent = group?.title || 'Калькуляторы';
    itemCount.textContent = `${items.length} ${pluralForm(items.length, ['инструмент', 'инструмента', 'инструментов'])}`;
    bindCalcBack(() => { activeCalcGroup = 'all'; }, '← Все группы');
    calcGroupsEl.insertAdjacentHTML('beforeend', items.map((m, i) => calcTile(m, i)).join(''));
    calcGroupsEl.querySelectorAll('[data-calc-target]').forEach(tile => {
      tile.addEventListener('click', () => {
        selectCalc(tile.getAttribute('data-calc-target'));
        renderCalcGroups();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  cards.forEach(card => {
    card.style.display = card.dataset.calcId === activeCalcId ? '' : 'none';
  });
}

if (calcSearchInput) {
  calcSearchInput.addEventListener('input', (e) => {
    calcQuery = e.target.value.trim().toLowerCase();
    activeCalcGroup = 'all';
    activeCalcId = null;
    if (clearCalcSearchBtn) clearCalcSearchBtn.style.display = calcQuery ? 'flex' : 'none';
    renderCalcGroups();
  });
}
if (clearCalcSearchBtn) {
  clearCalcSearchBtn.addEventListener('click', () => {
    calcQuery = '';
    activeCalcGroup = 'all';
    activeCalcId = null;
    if (calcSearchInput) calcSearchInput.value = '';
    clearCalcSearchBtn.style.display = 'none';
    renderCalcGroups();
    calcSearchInput?.focus();
  });
}

// Bottom Dock Navigation with Dynamic Header Adaptation
dockButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    dockButtons.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    currentTab = btn.getAttribute('data-tab');

    if (currentTab === 'search') {
      searchView.style.display = 'block';
      calcView.style.display = 'none';
      bookmarksView.style.display = 'none';
      searchContainer.style.display = 'flex';
      segmentedControl.style.display = 'flex';
      if (bookFilterScroll) bookFilterScroll.style.display = 'flex';
      navTitle.textContent = 'Источники';
      itemCount.style.display = 'block';
      performSearch();
    } else if (currentTab === 'calc') {
      searchView.style.display = 'none';
      calcView.style.display = 'block';
      bookmarksView.style.display = 'none';
      searchContainer.style.display = 'none';
      segmentedControl.style.display = 'none';
      if (bookFilterScroll) bookFilterScroll.style.display = 'none';
      navTitle.textContent = 'Калькуляторы';
      resetCalcQuery();
      renderCalcGroups();
      itemCount.style.display = 'block';
    } else if (currentTab === 'bookmarks') {
      searchView.style.display = 'none';
      calcView.style.display = 'none';
      bookmarksView.style.display = 'block';
      searchContainer.style.display = 'none';
      segmentedControl.style.display = 'none';
      if (bookFilterScroll) bookFilterScroll.style.display = 'none';
      navTitle.textContent = 'Избранное';
      itemCount.textContent = `${bookmarks.length} ${bookmarks.length === 1 ? 'статья' : 'статей'}`;
      itemCount.style.display = 'block';
      renderBookmarks();
    }
  });
});

const bookmarksSubtabs = document.getElementById('bookmarksSubtabs');

if (bookmarksSubtabs) {
  bookmarksSubtabs.querySelectorAll('[data-bm-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeBookmarkSubtab = btn.getAttribute('data-bm-tab');
      bookmarksSubtabs.querySelectorAll('[data-bm-tab]').forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      renderBookmarks();
    });
  });
}

async function renderBookmarks() {

  if (activeBookmarkSubtab === 'notes') {
    const notes = await getAllNotes();
    itemCount.textContent = `${notes.length} ${pluralForm(notes.length, ['заметка', 'заметки', 'заметок'])}`;
    if (notes.length === 0) {
      bookmarksList.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 60px 20px;">Заметок пока нет. Откройте любую страницу или протокол и нажмите «Заметка».</div>`;
      return;
    }

    const COLOR_MAP = {
      blue: { label: 'Важно', hex: '#0071e3' },
      amber: { label: 'Схема', hex: '#d97706' },
      rose: { label: 'Дозировка', hex: '#e11d48' },
      emerald: { label: 'Заметка', hex: '#059669' },
    };

    bookmarksList.innerHTML = notes.map(n => {
      const col = COLOR_MAP[n.color] || COLOR_MAP.blue;
      const dateStr = new Date(n.updatedAt || n.createdAt).toLocaleDateString('ru-RU');
      return `
        <article class="card-tile note-bookmark-card" data-note-id="${n.id}" data-article-id="${n.articleId}" data-page="${n.page || ''}">
          <div>
            <div class="card-meta-bar">
              <span class="card-source-tag">${escapeHtml(n.bookShort || 'Источник')}${n.page ? ` · стр. ${n.page}` : ''}</span>
              <span class="note-badge-pill" style="--note-color: ${col.hex}">${col.label}</span>
            </div>
            <h2 class="card-title" style="font-size: 0.92rem; margin-bottom: 6px;">${escapeHtml(n.title)}</h2>
            <p class="note-bookmark-body">${escapeHtml(n.text)}</p>
          </div>
          <div class="card-footer-tags" style="justify-content: space-between; align-items: center;">
            <span class="tag-pill">${dateStr}</span>
            <button type="button" class="btn-minimal note-del-btn" data-delete-bm-note="${n.id}">Удалить</button>
          </div>
        </article>
      `;
    }).join('');

    bookmarksList.querySelectorAll('.note-bookmark-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-bm-note]')) return;
        const artId = card.getAttribute('data-article-id');
        const page = parseInt(card.getAttribute('data-page'), 10) || null;
        const article = catalogData.find(a => a.id === artId);
        if (article) openArticleModal(article, page);
      });
    });

    bookmarksList.querySelectorAll('[data-delete-bm-note]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteNote(btn.getAttribute('data-delete-bm-note'));
        renderBookmarks();
      });
    });
    return;
  }

  const items = catalogData.filter(item => bookmarks.includes(item.id));
  itemCount.textContent = `${items.length} ${pluralForm(items.length, ['статья', 'статьи', 'статей'])}`;
  if (items.length === 0) {
    bookmarksList.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 60px 20px;">В избранном пока нет сохраненных статей.</div>`;
    return;
  }
  bookmarksList.innerHTML = items.map(item => `
    <article class="card-tile" data-id="${item.id}">
      <div class="card-meta-bar">
        <span class="card-source-tag">${item.source.book_short || item.source.book}</span>
        <span class="tag-pill">стр. ${item.source.pages}</span>
      </div>
      <h2 class="card-title">${item.title}</h2>
    </article>
  `).join('');

  bookmarksList.querySelectorAll('.card-tile').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const article = catalogData.find(a => a.id === id);
      if (article) openArticleModal(article);
    });
  });
}

// Calculators
window.calculateBSA = function() {
  const h = parseFloat(document.getElementById('bsaHeight').value);
  const w = parseFloat(document.getElementById('bsaWeight').value);
  const dose = parseFloat(document.getElementById('bsaDose').value) || 0;
  
  if (h > 0 && w > 0) {
    const bsa = Math.sqrt((h * w) / 3600);
    document.getElementById('bsaResult').innerHTML = `${bsa.toFixed(2)} <span class="metric-unit">м²</span>`;
    
    if (dose > 0) {
      document.getElementById('bsaTotalDose').innerHTML = `${Math.round(bsa * dose)} <span class="metric-unit">мг</span>`;
    } else {
      document.getElementById('bsaTotalDose').textContent = '—';
    }
  }
};

window.calculateANC = function() {
  const wbc = parseFloat(document.getElementById('ancWBC').value);
  const segs = parseFloat(document.getElementById('ancSegs').value) || 0;
  const bands = parseFloat(document.getElementById('ancBands').value) || 0;

  if (wbc >= 0) {
    const anc = wbc * (segs + bands) / 100;
    document.getElementById('ancResult').innerHTML = `${anc.toFixed(2)} <span class="metric-unit">×10⁹/л</span>`;

    const risk = document.getElementById('ancRisk');
    if (anc < 0.5) {
      risk.innerHTML = '<span style="color:#ffffff; font-weight:600;">Агранулоцитоз (CTCAE 4) — критический риск инфекций</span>';
    } else if (anc < 1.0) {
      risk.innerHTML = 'Нейтропения 3 степени';
    } else if (anc < 1.5) {
      risk.innerHTML = 'Нейтропения 2 степени';
    } else {
      risk.innerHTML = 'Показатели в пределах нормы';
    }
  }
};

// CrCl Gender state & calculation (Cockcroft-Gault)
let crclGender = 'male';

window.setCrClGender = function(gender) {
  crclGender = gender;
  const maleBtn = document.getElementById('genderMale');
  const femaleBtn = document.getElementById('genderFemale');
  if (gender === 'male') {
    maleBtn.classList.add('active');
    femaleBtn.classList.remove('active');
  } else {
    femaleBtn.classList.add('active');
    maleBtn.classList.remove('active');
  }
  calculateCrCl();
};

window.calculateCrCl = function() {
  const age = parseFloat(document.getElementById('crclAge').value);
  const weight = parseFloat(document.getElementById('crclWeight').value);
  const creat = parseFloat(document.getElementById('crclCreatinine').value);
  
  if (age > 0 && weight > 0 && creat > 0) {
    const k = crclGender === 'male' ? 1.23 : 1.05;
    const crcl = ((140 - age) * weight * k) / creat;

    document.getElementById('crclResult').innerHTML = `${crcl.toFixed(1)} <span class="metric-unit">мл/мин</span>`;

    const advice = document.getElementById('crclAdvice');
    if (crcl >= 60) {
      advice.innerHTML = '<span style="color:#ffffff; font-weight:500;">Нормальная функция или легкое снижение (ХБП 1–2).</span> Стандартные дозы цитостатиков.';
    } else if (crcl >= 30) {
      advice.innerHTML = '<span style="color:#fbbf24; font-weight:500;">Умеренное снижение (ХБП 3 ст.).</span> Леналидомид: редукция до 10 мг/сут. Контроль бисфосфонатов.';
    } else if (crcl >= 15) {
      advice.innerHTML = '<span style="color:#fb7185; font-weight:500;">Тяжелое снижение (ХБП 4 ст.).</span> Леналидомид: 15 мг через день или 5 мг/сут. НМГ строго по анти-Ха.';
    } else {
      advice.innerHTML = '<span style="color:#ffffff; font-weight:600; background:rgba(225,29,72,0.2); padding:2px 6px; border-radius:4px;">Терминальная ХБП / Диализ.</span> Требуется строгая редукция цитостатиков. Леналидомид 5 мг после диализа.';
    }
  }
};

window.calculate4T = function() {
  const t1 = parseInt(document.getElementById('fourT1').value, 10) || 0;
  const t2 = parseInt(document.getElementById('fourT2').value, 10) || 0;
  const t3 = parseInt(document.getElementById('fourT3').value, 10) || 0;
  const t4 = parseInt(document.getElementById('fourT4').value, 10) || 0;

  const total = t1 + t2 + t3 + t4;
  document.getElementById('fourTScore').innerHTML = `${total} <span class="metric-unit">из 8</span>`;

  const riskElem = document.getElementById('fourTRisk');
  if (total <= 3) {
    riskElem.innerHTML = '<span style="color:#059669; font-weight:600;">0–3 балла: Низкая вероятность ГИТ (<5%).</span> Гепарин можно продолжать, поиск альтернативных причин тромбоцитопении.';
  } else if (total <= 5) {
    riskElem.innerHTML = '<span style="color:#d97706; font-weight:600;">4–5 баллов: Промежуточная вероятность ГИТ (~14%).</span> Высокая настороженность: рассмотреть отмену гепарина и переход на фондапаринукс.';
  } else {
    riskElem.innerHTML = '<span style="color:#e11d48; font-weight:600;">6–8 баллов: Высокая вероятность ГИТ (>64%)!</span> Немедленно отменить ВСЕ гепарины! Начать фондапаринукс (7.5 мг) или аргатробан. Тромбоциты и варфарин запрещены!';
  }
};

// 5. Расчет индекса массы тела (ИМТ / BMI по ВОЗ)
window.calculateBMI = function() {
  const h = parseFloat(document.getElementById('bmiHeight').value);
  const w = parseFloat(document.getElementById('bmiWeight').value);

  if (h > 0 && w > 0) {
    const heightM = h / 100;
    const bmi = w / (heightM * heightM);
    document.getElementById('bmiResult').innerHTML = `${bmi.toFixed(1)} <span class="metric-unit">кг/м²</span>`;

    const statusElem = document.getElementById('bmiStatus');
    if (bmi <= 16.0) {
      statusElem.innerHTML = '<span style="color:#e11d48; font-weight:600;">Выраженный дефицит массы тела</span> (≤ 16.0 кг/м²)';
    } else if (bmi < 18.5) {
      statusElem.innerHTML = '<span style="color:#d97706; font-weight:600;">Недостаточная (дефицит) массы тела</span> (16.0–18.5 кг/м²)';
    } else if (bmi < 25.0) {
      statusElem.innerHTML = '<span style="color:#059669; font-weight:600;">Нормальная масса тела</span> (18.5–25.0 кг/м²)';
    } else if (bmi < 30.0) {
      statusElem.innerHTML = '<span style="color:#d97706; font-weight:600;">Избыточная масса тела (предожирение)</span> (25.0–30.0 кг/м²)';
    } else if (bmi < 35.0) {
      statusElem.innerHTML = '<span style="color:#ea580c; font-weight:600;">Ожирение I степени</span> (30.0–35.0 кг/м²)';
    } else if (bmi < 40.0) {
      statusElem.innerHTML = '<span style="color:#dc2626; font-weight:600;">Ожирение II степени</span> (35.0–40.0 кг/м²)';
    } else {
      statusElem.innerHTML = '<span style="color:#991b1b; font-weight:700;">Ожирение III степени</span> (≥ 40.0 кг/м²)';
    }
  } else {
    document.getElementById('bmiResult').innerHTML = `0.0 <span class="metric-unit">кг/м²</span>`;
    document.getElementById('bmiStatus').textContent = 'Введите рост и вес для расчета';
  }
};

// 6. Шкала Хорана (Khorana Score)
window.calculateKhorana = function() {
  const cancer = parseInt(document.getElementById('khoranaCancer').value, 10) || 0;
  const plt = document.getElementById('khoranaPlt').checked ? 1 : 0;
  const wbc = document.getElementById('khoranaWbc').checked ? 1 : 0;
  const hb = document.getElementById('khoranaHb').checked ? 1 : 0;
  const bmi = document.getElementById('khoranaBmi').checked ? 1 : 0;

  const total = cancer + plt + wbc + hb + bmi;
  document.getElementById('khoranaScore').innerHTML = `${total} <span class="metric-unit">из 6</span>`;

  const riskElem = document.getElementById('khoranaRisk');
  if (total === 0) {
    riskElem.innerHTML = '<span style="color:#059669; font-weight:600;">0 баллов: Низкий риск ВТЭО (1.5%).</span> Медикаментозная тромбопрофилактика не показана.';
  } else if (total <= 2) {
    riskElem.innerHTML = '<span style="color:#d97706; font-weight:600;">1–2 балла: Промежуточный риск (3.8–4.8%).</span> Рутинная профилактика не требуется. Динамическое наблюдение.';
  } else {
    riskElem.innerHTML = '<span style="color:#e11d48; font-weight:600;">≥ 3 баллов: Высокий риск ВТЭО (6.7–7.1%)!</span> Рекомендована медикаментозная тромбопрофилактика (ПОАК: апиксабан 2.5 мг 2 р/сут, ривароксабан 10 мг/сут или НМГ) при отсутствии высокого риска кровотечений (RUSSCO / ASCO).';
  }
};

// 7. Пересмотренная Женевская шкала вероятности ТЭЛА (Revised Geneva Score)
window.calculateGeneva = function() {
  const age = document.getElementById('genevaAge').checked ? 1 : 0;
  const priorVTE = document.getElementById('genevaPriorVTE').checked ? 3 : 0;
  const surgery = document.getElementById('genevaSurgery').checked ? 2 : 0;
  const malignancy = document.getElementById('genevaMalignancy').checked ? 2 : 0;
  const limbPain = document.getElementById('genevaLimbPain').checked ? 3 : 0;
  const hemoptysis = document.getElementById('genevaHemoptysis').checked ? 2 : 0;
  const hr = parseInt(document.getElementById('genevaHR').value, 10) || 0;
  const dVTsign = document.getElementById('genevaDVTSign').checked ? 4 : 0;

  const total = age + priorVTE + surgery + malignancy + limbPain + hemoptysis + hr + dVTsign;
  document.getElementById('genevaScore').innerHTML = `${total} <span class="metric-unit">баллов</span>`;

  const riskElem = document.getElementById('genevaRisk');
  if (total <= 3) {
    riskElem.innerHTML = '<span style="color:#059669; font-weight:600;">0–3 балла: Низкая вероятность ТЭЛА (~8%).</span> Рекомендовано: определение уровня D-димера. При отрицательном результате ТЭЛА исключена без КТ.';
  } else if (total <= 10) {
    riskElem.innerHTML = '<span style="color:#d97706; font-weight:600;">4–10 баллов: Промежуточная вероятность (~28%).</span> Рекомендовано: высокочувствительный D-димер или прямая КТ-ангиопульмонография.';
  } else {
    riskElem.innerHTML = '<span style="color:#e11d48; font-weight:600;">≥ 11 баллов: Высокая вероятность ТЭЛА (>74%)!</span> Показана экстренная КТ-ангиопульмонография немедленно (минуя D-димер) и начало антикоагулянтной терапии.';
  }
};

// 8. Шкала IMPEDE VTE (Multiple Myeloma)
window.calculateIMPEDE = function() {
  const imid = document.getElementById('impedeImid').checked ? 4 : 0;
  const bmi = document.getElementById('impedeBmi').checked ? 1 : 0;
  const fracture = document.getElementById('impedeFracture').checked ? 4 : 0;
  const esa = document.getElementById('impedeEsa').checked ? 1 : 0;
  const steroidDox = parseInt(document.getElementById('impedeSteroidDox').value, 10) || 0;
  const asian = document.getElementById('impedeAsian').checked ? -3 : 0;
  const vte = document.getElementById('impedeVTE').checked ? 5 : 0;
  const cvc = document.getElementById('impedeCVC').checked ? 2 : 0;
  const proph = parseInt(document.getElementById('impedeProphylaxis').value, 10) || 0;

  const total = imid + bmi + fracture + esa + steroidDox + asian + vte + cvc + proph;
  document.getElementById('impedeScore').innerHTML = `${total} <span class="metric-unit">баллов</span>`;

  const riskElem = document.getElementById('impedeRisk');
  if (total <= 3) {
    riskElem.innerHTML = '<span style="color:#059669; font-weight:600;">≤ 3 баллов: Низкий риск ВТЭО (<5%).</span> Рекомендован Аспирин (81–325 мг/сут) при терапии IMiD (по NCCN / IMWG).';
  } else if (total <= 7) {
    riskElem.innerHTML = '<span style="color:#d97706; font-weight:600;">4–7 баллов: Промежуточный риск (8–10%).</span> Показана фармакологическая тромбопрофилактика: профилактический НМГ (эноксапарин 40 мг п/к) или ПОАК (апиксабан 2.5 мг 2 р/сут, ривароксабан 10 мг/сут).';
  } else {
    riskElem.innerHTML = '<span style="color:#e11d48; font-weight:600;">≥ 8 баллов: Высокий риск ВТЭО (>15%)!</span> Обязательна антикоагулянтная тромбопрофилактика (НМГ или ПОАК) на весь период активной терапии иммуномодуляторами/дексаметазоном.';
  }
};

init();
