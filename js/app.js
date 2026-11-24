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
let currentTab = 'home';
let activeCategory = 'all';
let activeBookFilter = 'all';
let navLevel = 'sources'; // sources | books | articles
let activeBookmarkSubtab = 'articles'; // articles | notes
let calcReturnContext = null; // { calcId } при переходе из калькулятора в поиск
let catalogData = [];
let bookmarks = JSON.parse(localStorage.getItem('gem_bookmarks') || '[]');
let offlineSummaryMap = new Map();
let reader = null;

// DOM Elements
const homeView = document.getElementById('homeView');
const appHeader = document.getElementById('appHeader');
const dockBar = document.getElementById('dockBar');
const brandHomeBtn = document.getElementById('brandHomeBtn');
const homeDateEl = document.getElementById('homeDate');
const homeWidgetsRow = document.getElementById('homeWidgetsRow');
const homeEditWidgetsBtn = document.getElementById('homeEditWidgetsBtn');
const homeWidgetSheet = document.getElementById('homeWidgetSheet');
const homeWidgetSheetClose = document.getElementById('homeWidgetSheetClose');
const homeWidgetSearch = document.getElementById('homeWidgetSearch');
const homeWidgetPickerList = document.getElementById('homeWidgetPickerList');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const bookFilterScroll = document.getElementById('bookFilterScroll');
const articlesList = document.getElementById('articlesList');
const itemCount = document.getElementById('itemCount');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const homeThemeToggleBtn = document.getElementById('homeThemeToggleBtn');
const homeSearchBtn = document.getElementById('homeSearchBtn');
const dockButtons = document.querySelectorAll('.dock-btn');

// App Theme Switcher (Light / Dark)
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path stroke-linecap="round" d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;

function applyAppTheme(theme) {
  const isDark = theme === 'dark';
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', isDark ? '#0f1014' : '#f4f5f8');
  [themeToggleBtn, homeThemeToggleBtn].forEach((btn) => {
    if (!btn) return;
    btn.innerHTML = isDark ? ICON_SUN : ICON_MOON;
    btn.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
  });
}

applyAppTheme(localStorage.getItem('gem_app_theme') || 'light');
const toggleThemeHandler = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('gem_app_theme', next);
  applyAppTheme(next);
};
themeToggleBtn?.addEventListener('click', toggleThemeHandler);
homeThemeToggleBtn?.addEventListener('click', toggleThemeHandler);
const searchView = document.getElementById('searchView');
const calcView = document.getElementById('calcView');
const bookmarksView = document.getElementById('bookmarksView');
const searchContainer = document.querySelector('.search-container');
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
  { id: 'algorithms', short: 'Алгоритмы НМИЦ · Том 2' },
  { id: 'algorithms-v1', short: 'Алгоритмы НМИЦ · Том 1' },
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

  if (bookFilterScroll) {
    bookFilterScroll.style.display = (currentTab === 'search' && query.length > 0) ? 'flex' : 'none';
  }

  // Три уровня навигации без поиска: разделы → учебники → главы
  if (!query) {
    if (navLevel === 'sources') {
      renderSectionTiles();
      return;
    }
    if (navLevel === 'books') {
      renderBookTiles();
      return;
    }
  }

  const articleResults = searchEngine.search(query, 'all', activeBookFilter);
  const calcResults = (query && activeBookFilter === 'all') ? searchCalculators(query) : [];
  renderResults(articleResults, Boolean(calcReturnContext) || activeBookFilter !== 'all' || navLevel !== 'sources', calcResults);
}

function searchCalculators(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return calcCards().map((card, i) => calcMeta(card, i)).filter((m) => {
    const hay = `${m.title} ${m.label} ${m.group?.title || ''} ${m.group?.names || ''} ${m.group?.kind || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

// Data Fetch & Engine Init
async function init() {
  initHomeScreen();
  try {
    const res = await fetch('./data/catalog.json');
    catalogData = await res.json();
    searchEngine.loadData(catalogData);
    renderBookFilters();
    renderHomeWidgets();
    navigateToTab('home');
    if (homeView) homeView.classList.add('home-animate');
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

// Единое правило кнопки возврата: всегда на 1 уровень выше ("← В <родительский раздел>")
function getBackState() {
  if (calcReturnContext) return { label: '← В калькулятор', target: 'calc' };
  if (activeBookFilter === 'emergency') return { label: '← В источники', target: 'sources' };
  if (activeBookFilter && activeBookFilter !== 'all') return { label: '← В учебники', target: 'books' };
  return { label: '← В источники', target: 'sources' };
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

  articlesList.innerHTML = `<button class="back-tile" id="backToSectionsBtn">← В источники</button>` + books.map((book, index) => {
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
function renderResults(results, showBack = false, calcResults = []) {
  const back = getBackState();
  const showBookDl = showBack && activeBookFilter && activeBookFilter !== 'all' && activeBookFilter !== 'emergency';
  const backTile = showBack
    ? `<div class="book-chapter-toolbar">
        <button class="back-tile" id="backToSourcesBtn">${back.label}</button>
        ${showBookDl ? renderDownloadButtonHtml(activeBookFilter) : ''}
      </div>`
    : '';

  const bindBack = () => {
    const backBtn = document.getElementById('backToSourcesBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (back.target === 'calc' && calcReturnContext) {
          const returnCalcId = calcReturnContext.calcId;
          calcReturnContext = null;
          searchInput.value = '';
          clearSearchBtn.style.display = 'none';
          const calcDock = document.querySelector('.dock-btn[data-tab="calc"]');
          if (calcDock) calcDock.click();
          activeCalcId = returnCalcId;
          renderCalcGroups();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (back.target === 'books') {
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

  const totalCount = (results?.length || 0) + (calcResults?.length || 0);
  if (totalCount === 0) {
    itemCount.textContent = '0 записей';
    articlesList.innerHTML = backTile + `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <p style="font-size: 0.95rem; font-weight: 500;">Ничего не найдено</p>
        <p style="font-size: 0.8rem; margin-top: 4px;">Попробуйте выбрать другой источник или поисковый запрос</p>
      </div>`;
    bindBack();
    return;
  }

  itemCount.textContent = `${totalCount} ${pluralForm(totalCount, ['запись', 'записи', 'записей'])}`;

  const calcCardsHtml = (calcResults || []).map((m, index) => `
    <article class="card-tile card-tile--calc" data-search-calc="${m.id}" style="animation-delay: ${Math.min(index * 25, 160)}ms">
      <div>
        <div class="card-meta-bar">
          <span class="card-source-tag">Калькулятор · ${escapeHtml(m.group?.title || '')}</span>
          <span class="card-page-meta">${escapeHtml(m.label)}</span>
        </div>
        <h2 class="card-title">${escapeHtml(m.title)}</h2>
      </div>
    </article>
  `).join('');

  articlesList.innerHTML = backTile + calcCardsHtml + results.map(({ item, page, snippet }, index) => {
    const bookTitle = item.source.book_short || item.source.book;
    const pageLabel = page ? `стр. ${page}` : `стр. ${item.source.pages}`;
    const hasIcd = Array.isArray(item.icd10) && item.icd10.length > 0;

    return `
      <article class="card-tile" data-id="${item.id}" data-page="${page || ''}" style="animation-delay: ${Math.min(index * 25, 200)}ms">
        <div>
          <div class="card-meta-bar">
            <span class="card-source-tag">${bookTitle}</span>
            <span class="card-page-meta">${pageLabel}</span>
          </div>
          
          <h2 class="card-title">${item.title}</h2>

          ${snippet ? `<p class="card-snippet">${escapeHtml(snippet)}</p>` : ''}

          ${item.quick_facts ? `
            <ul class="card-summary-list">
              ${item.quick_facts.slice(0, 2).map(f => `<li>${f}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        ${hasIcd ? `
          <div class="card-footer-tags">
            ${item.icd10.slice(0, 3).map(c => `<span class="tag-pill">${c}</span>`).join('')}
          </div>
        ` : ''}
      </article>
    `;
  }).join('');

  bindBack();

  // Click card to open modal (and jump to the found page) or open calculator
  articlesList.querySelectorAll('.card-tile[data-id]').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const page = parseInt(card.getAttribute('data-page'), 10) || null;
      const article = catalogData.find(a => a.id === id);
      if (article) openArticleModal(article, page);
    });
  });
  articlesList.querySelectorAll('[data-search-calc]').forEach(card => {
    card.addEventListener('click', () => {
      const calcId = card.getAttribute('data-search-calc');
      navigateToTab('calc');
      selectCalc(calcId);
      renderCalcGroups();
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
  if (!query.trim()) calcReturnContext = null;
  clearSearchBtn.style.display = query ? 'flex' : 'none';
  performSearch();
});

clearSearchBtn.addEventListener('click', () => {
  calcReturnContext = null;
  searchInput.value = '';
  clearSearchBtn.style.display = 'none';
  performSearch();
  searchInput.focus();
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

function getCalcSourceQuery(card) {
  if (card.querySelector('#bsaHeight')) return 'доза';
  if (card.querySelector('#ancWBC')) {
    const val = parseFloat(document.getElementById('ancResult')?.dataset.numValue);
    return (!Number.isNaN(val) && val < 0.5) ? 'фебрильная нейтропения' : 'нейтропения';
  }
  if (card.querySelector('#crclAge')) {
    const val = parseFloat(document.getElementById('crclResult')?.dataset.numValue);
    return (!Number.isNaN(val) && val < 60) ? 'леналидомид' : 'креатинин';
  }
  if (card.querySelector('#fourT1')) {
    const val = parseFloat(document.getElementById('fourTScore')?.dataset.numValue);
    return (!Number.isNaN(val) && val >= 4) ? 'гепарин' : 'тромбоцитопения';
  }
  if (card.querySelector('#bmiHeight')) return 'индекс массы тела';
  if (card.querySelector('#khoranaCancer')) return 'тромбоз';
  if (card.querySelector('#genevaHR')) return 'ТЭЛА';
  if (card.querySelector('#impedeImid')) return 'множественная миелома';
  return card.querySelector('.panel-title')?.textContent.trim() || '';
}

function navigateToSourcesSearch(query, calcId) {
  const searchDock = document.querySelector('.dock-btn[data-tab="search"]');
  if (searchDock) searchDock.click();
  calcReturnContext = calcId ? { calcId } : null;
  activeBookFilter = 'all';
  navLevel = 'sources';
  updateBookChipStates();
  searchInput.value = query;
  clearSearchBtn.style.display = query ? 'flex' : 'none';
  performSearch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function ensureCalcSourceButtons() {
  calcCards().forEach((card) => {
    if (card.querySelector('.calc-source-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calc-source-btn';
    btn.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>
      <span>Найти в источниках</span>
      <span aria-hidden="true">→</span>
    `;
    btn.addEventListener('click', () => {
      navigateToSourcesSearch(getCalcSourceQuery(card), card.dataset.calcId || activeCalcId);
    });
    card.appendChild(btn);
  });
}

function renderCalcGroups() {
  const cards = calcCards();
  if (!calcGroupsEl) return;
  ensureCalcSourceButtons();

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
      bindCalcBack(resetCalcQuery, '← В калькуляторы');
      calcGroupsEl.insertAdjacentHTML('beforeend', `<div class="calc-empty">Ничего не найдено. Попробуйте «BSA», «тромбоз» или «Cockcroft».</div>`);
      return;
    }
    bindCalcBack(resetCalcQuery, '← В калькуляторы');
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
    itemCount.textContent = 'Калькулятор';
    const parentTitle = meta.group?.title || 'Калькуляторы';
    bindCalcBack(() => {
      activeCalcId = null;
      if (meta.groupId) activeCalcGroup = meta.groupId;
    }, `← В ${parentTitle}`);
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
    bindCalcBack(() => { activeCalcGroup = 'all'; }, '← В калькуляторы');
    calcGroupsEl.insertAdjacentHTML('beforeend', items.map((m, i) => calcTile(m, i)).join(''));
    calcGroupsEl.querySelectorAll('[data-calc-target]').forEach(tile => {
      tile.addEventListener('click', () => {
        selectCalc(tile.getAttribute('data-calc-target'));
        renderCalcGroups();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  if (calcGridEl) {
    calcGridEl.classList.toggle('calc-single', activeCalcId !== null);
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

// ==========================================================================
// Главный экран (Home View), 3 настраиваемых виджета и переключение разделов
// ==========================================================================
const DEFAULT_HOME_WIDGETS = [
  { kind: 'calc', id: 'calc-0', label: 'BSA (доза)', sub: 'Калькулятор' },
  { kind: 'book', id: 'algorithms', label: 'Алгоритмы', sub: 'Учебник' },
  { kind: 'article', id: 'emergency-tls', label: 'СЛО', sub: 'Протокол' },
];
let homeWidgetsEditing = false;
let editingWidgetSlot = 0;

function getHomeWidgets() {
  try {
    const raw = JSON.parse(localStorage.getItem('gem_home_widgets') || 'null');
    if (Array.isArray(raw) && raw.length === 3) return raw;
  } catch (_) { /* ignore */ }
  return [...DEFAULT_HOME_WIDGETS];
}

function saveHomeWidgets(list) {
  localStorage.setItem('gem_home_widgets', JSON.stringify(list));
}

function renderHomeWidgets() {
  if (!homeWidgetsRow) return;
  const list = getHomeWidgets();
  homeWidgetsRow.innerHTML = list.map((w, idx) => {
    const kind = w?.sub || 'Быстро';
    const title = w?.label || '+ Добавить';
    return `
      <button type="button" class="home-widget-btn ${homeWidgetsEditing ? 'is-editing' : ''}" data-widget-slot="${idx}">
        <span class="home-widget-kind">${escapeHtml(kind)}</span>
        <span class="home-widget-title">${escapeHtml(title)}</span>
        ${homeWidgetsEditing ? '<span class="home-widget-edit-badge" aria-hidden="true">✎</span>' : ''}
      </button>
    `;
  }).join('');

  homeWidgetsRow.querySelectorAll('[data-widget-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.getAttribute('data-widget-slot'));
      if (homeWidgetsEditing) {
        openHomeWidgetPicker(slot);
        return;
      }
      const w = getHomeWidgets()[slot];
      if (!w) {
        openHomeWidgetPicker(slot);
        return;
      }
      if (w.kind === 'calc') {
        navigateToTab('calc');
        activeCalcId = w.id;
        renderCalcGroups();
      } else if (w.kind === 'book') {
        navigateToTab('search');
        setActiveBookFilter(w.id);
      } else if (w.kind === 'article') {
        const art = catalogData.find((a) => a.id === w.id);
        navigateToTab('search');
        if (art) openArticleModal(art);
      }
    });
  });
}

function openHomeWidgetPicker(slot) {
  if (!homeWidgetSheet || !homeWidgetPickerList) return;
  editingWidgetSlot = slot;
  if (homeWidgetSearch) homeWidgetSearch.value = '';
  renderWidgetPickerOptions('');
  homeWidgetSheet.classList.add('open');
}

function renderWidgetPickerOptions(filterText) {
  if (!homeWidgetPickerList) return;
  const q = filterText.trim().toLowerCase();
  const options = [];

  // 1. Калькуляторы
  calcCards().forEach((card, idx) => {
    const title = card.querySelector('.panel-title')?.textContent.trim() || `Калькулятор ${idx + 1}`;
    const short = title.split('(')[0].trim();
    options.push({ kind: 'calc', id: `calc-${idx}`, label: short, sub: 'Калькулятор', full: title });
  });

  // 2. Учебники
  const seenBooks = new Set();
  catalogData.forEach((a) => {
    const bid = a.source?.book_id;
    if (bid && bid !== 'emergency' && !seenBooks.has(bid)) {
      seenBooks.add(bid);
      const short = a.source?.book_short || a.source?.book || bid;
      options.push({ kind: 'book', id: bid, label: short, sub: 'Учебник', full: short });
    }
  });

  // 3. Статьи / протоколы
  catalogData.forEach((a) => {
    const sub = a.source?.book_short || 'Статья';
    options.push({ kind: 'article', id: a.id, label: a.title, sub, full: `${a.title} ${sub}` });
  });

  const filtered = q
    ? options.filter((o) => o.full.toLowerCase().includes(q) || o.sub.toLowerCase().includes(q))
    : options.slice(0, 30);

  homeWidgetPickerList.innerHTML = filtered.map((o, i) => `
    <button type="button" class="reader-toc-item" data-pick-idx="${i}">
      <span>${escapeHtml(o.label)}</span>
      <small>${escapeHtml(o.sub)}</small>
    </button>
  `).join('');

  homeWidgetPickerList.querySelectorAll('[data-pick-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chosen = filtered[Number(btn.getAttribute('data-pick-idx'))];
      if (!chosen) return;
      const list = getHomeWidgets();
      list[editingWidgetSlot] = { kind: chosen.kind, id: chosen.id, label: chosen.label, sub: chosen.sub };
      saveHomeWidgets(list);
      homeWidgetsEditing = false;
      homeEditWidgetsBtn?.classList.remove('active');
      if (homeEditWidgetsBtn) homeEditWidgetsBtn.textContent = 'Настроить';
      homeWidgetSheet.classList.remove('open');
      renderHomeWidgets();
    });
  });
}

function initHomeScreen() {
  if (homeDateEl) {
    const formatted = new Intl.DateTimeFormat('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());
    homeDateEl.textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  document.querySelectorAll('[data-home-nav]').forEach((tile) => {
    tile.addEventListener('click', () => {
      navigateToTab(tile.getAttribute('data-home-nav'));
    });
  });

  brandHomeBtn?.addEventListener('click', () => navigateToTab('home'));
  brandHomeBtn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigateToTab('home');
    }
  });

  homeEditWidgetsBtn?.addEventListener('click', () => {
    homeWidgetsEditing = !homeWidgetsEditing;
    homeEditWidgetsBtn.classList.toggle('active', homeWidgetsEditing);
    homeEditWidgetsBtn.textContent = homeWidgetsEditing ? 'Готово' : 'Настроить';
    renderHomeWidgets();
  });

  homeSearchBtn?.addEventListener('click', () => {
    navigateToTab('search');
    requestAnimationFrame(() => searchInput?.focus());
  });

  homeWidgetSheetClose?.addEventListener('click', () => homeWidgetSheet?.classList.remove('open'));
  homeWidgetSearch?.addEventListener('input', (e) => renderWidgetPickerOptions(e.target.value));
}

function navigateToTab(tab) {
  currentTab = tab;
  const isHome = tab === 'home';

  if (homeView) homeView.style.display = isHome ? 'flex' : 'none';
  if (appHeader) appHeader.style.display = isHome ? 'none' : 'block';
  if (dockBar) dockBar.style.display = isHome ? 'none' : 'block';
  document.body.classList.toggle('on-home', isHome);

  if (isHome) {
    searchView.style.display = 'none';
    calcView.style.display = 'none';
    bookmarksView.style.display = 'none';
    renderHomeWidgets();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  homeView?.classList.remove('home-animate');

  dockButtons.forEach((b) => {
    const active = b.getAttribute('data-tab') === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (tab === 'search') {
    searchView.style.display = 'block';
    calcView.style.display = 'none';
    bookmarksView.style.display = 'none';
    searchContainer.style.display = 'flex';
    navTitle.textContent = 'Источники';
    itemCount.style.display = 'block';
    performSearch();
  } else if (tab === 'calc') {
    searchView.style.display = 'none';
    calcView.style.display = 'block';
    bookmarksView.style.display = 'none';
    searchContainer.style.display = 'none';
    if (bookFilterScroll) bookFilterScroll.style.display = 'none';
    navTitle.textContent = 'Калькуляторы';
    resetCalcQuery();
    renderCalcGroups();
    itemCount.style.display = 'block';
  } else if (tab === 'bookmarks') {
    searchView.style.display = 'none';
    calcView.style.display = 'none';
    bookmarksView.style.display = 'block';
    searchContainer.style.display = 'none';
    if (bookFilterScroll) bookFilterScroll.style.display = 'none';
    navTitle.textContent = 'Избранное';
    itemCount.textContent = `${bookmarks.length} ${bookmarks.length === 1 ? 'статья' : 'статей'}`;
    itemCount.style.display = 'block';
    renderBookmarks();
  }
}

// Bottom Dock Navigation
dockButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    navigateToTab(btn.getAttribute('data-tab'));
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

// Плавная анимация финального значения калькуляторов (быстрый набор цифр)
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function animateMetricValue(elId, target, decimals = 0, unit = '') {
  const el = document.getElementById(elId);
  if (!el) return;
  const endVal = Number(target) || 0;
  const startVal = el.dataset.numValue !== undefined ? parseFloat(el.dataset.numValue) : 0;
  el.dataset.numValue = String(endVal);
  const unitHtml = unit ? ` <span class="metric-unit">${unit}</span>` : '';

  if (el._animFrame) cancelAnimationFrame(el._animFrame);

  if (REDUCED_MOTION || Math.abs(endVal - startVal) < 0.0001) {
    el.innerHTML = `${endVal.toFixed(decimals)}${unitHtml}`;
    return;
  }

  const duration = 280;
  const t0 = performance.now();
  el.classList.remove('metric-pop');

  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    const current = startVal + (endVal - startVal) * eased;
    el.innerHTML = `${current.toFixed(decimals)}${unitHtml}`;
    if (p < 1) {
      el._animFrame = requestAnimationFrame(step);
    } else {
      el.innerHTML = `${endVal.toFixed(decimals)}${unitHtml}`;
      el._animFrame = null;
      el.classList.add('metric-pop');
      setTimeout(() => el.classList.remove('metric-pop'), 220);
    }
  };
  el._animFrame = requestAnimationFrame(step);
}

// Calculators
window.calculateBSA = function() {
  const h = parseFloat(document.getElementById('bsaHeight').value);
  const w = parseFloat(document.getElementById('bsaWeight').value);
  const dose = parseFloat(document.getElementById('bsaDose').value) || 0;
  
  if (h > 0 && w > 0) {
    const bsa = Math.sqrt((h * w) / 3600);
    animateMetricValue('bsaResult', bsa, 2, 'м²');
    
    if (dose > 0) {
      animateMetricValue('bsaTotalDose', Math.round(bsa * dose), 0, 'мг');
    } else {
      const doseEl = document.getElementById('bsaTotalDose');
      if (doseEl) {
        doseEl.dataset.numValue = '0';
        doseEl.textContent = '—';
      }
    }
  }
};

window.calculateANC = function() {
  const wbc = parseFloat(document.getElementById('ancWBC').value);
  const segs = parseFloat(document.getElementById('ancSegs').value) || 0;
  const bands = parseFloat(document.getElementById('ancBands').value) || 0;

  if (wbc >= 0) {
    const anc = wbc * (segs + bands) / 100;
    animateMetricValue('ancResult', anc, 2, '×10⁹/л');

    const risk = document.getElementById('ancRisk');
    if (anc < 0.5) {
      risk.innerHTML = '<span style="color:#e11d48; font-weight:600;">Агранулоцитоз (CTCAE 4) — критический риск инфекций</span>';
    } else if (anc < 1.0) {
      risk.innerHTML = '<span style="color:#d97706; font-weight:600;">Нейтропения 3 степени</span>';
    } else if (anc < 1.5) {
      risk.innerHTML = '<span style="color:#d97706; font-weight:600;">Нейтропения 2 степени</span>';
    } else {
      risk.innerHTML = '<span style="color:#059669; font-weight:600;">Показатели в пределах нормы</span>';
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

    animateMetricValue('crclResult', crcl, 1, 'мл/мин');

    const advice = document.getElementById('crclAdvice');
    if (crcl >= 60) {
      advice.innerHTML = '<span style="color:#059669; font-weight:600;">Нормальная функция или лёгкое снижение (ХБП 1–2).</span> Стандартные дозы цитостатиков.';
    } else if (crcl >= 30) {
      advice.innerHTML = '<span style="color:#d97706; font-weight:600;">Умеренное снижение (ХБП 3 ст.).</span> Леналидомид: редукция до 10 мг/сут. Контроль бисфосфонатов.';
    } else if (crcl >= 15) {
      advice.innerHTML = '<span style="color:#e11d48; font-weight:600;">Тяжёлое снижение (ХБП 4 ст.).</span> Леналидомид: 15 мг через день или 5 мг/сут. НМГ строго по анти-Ха.';
    } else {
      advice.innerHTML = '<span style="color:#e11d48; font-weight:700;">Терминальная ХБП / Диализ.</span> Требуется строгая редукция цитостатиков. Леналидомид 5 мг после диализа.';
    }
  }
};

window.calculate4T = function() {
  const t1 = parseInt(document.getElementById('fourT1').value, 10) || 0;
  const t2 = parseInt(document.getElementById('fourT2').value, 10) || 0;
  const t3 = parseInt(document.getElementById('fourT3').value, 10) || 0;
  const t4 = parseInt(document.getElementById('fourT4').value, 10) || 0;

  const total = t1 + t2 + t3 + t4;
  animateMetricValue('fourTScore', total, 0, 'из 8');

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
    animateMetricValue('bmiResult', bmi, 1, 'кг/м²');

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
    animateMetricValue('bmiResult', 0, 1, 'кг/м²');
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
  animateMetricValue('khoranaScore', total, 0, 'из 6');

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
  animateMetricValue('genevaScore', total, 0, 'баллов');

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
  animateMetricValue('impedeScore', total, 0, 'баллов');

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
