// ==========================================================================
// Единый полноэкранный мобильный ридер (WebP, PDF через ленивый PDF.js, Markdown, FB2)
// Поддержка iOS Safari & Android: 100dvh, safe-area, свайпы, pinch-zoom, заметки
// ==========================================================================

import {
  getNotesForArticle,
  saveNote,
  deleteNote,
  getProgress,
  saveProgress,
  getReaderSettings,
  saveReaderSettings,
  getCustomMaterial,
  saveCustomMaterial,
} from './storage.js';
import { readXmlTextWithEncoding } from './custom-materials.js';

const NOTE_COLORS = [
  { id: 'blue', label: 'Важно', hex: '#0071e3' },
  { id: 'amber', label: 'Схема', hex: '#d97706' },
  { id: 'rose', label: 'Дозировка', hex: '#e11d48' },
  { id: 'emerald', label: 'Заметка', hex: '#059669' },
];

let pdfJsPromise = null;
async function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    const mod = await import('./vendor/pdf.min.mjs');
    const pdfjsLib = mod.default || mod;
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).toString();
    return pdfjsLib;
  })();
  return pdfJsPromise;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ==========================================================================
// Лёгкий нативный FB2-парсер (0 внешних зависимостей, DOMParser)
// ==========================================================================
export function parseFb2Xml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error('Ошибка разбора FB2-файла');
  }

  // Извлекаем встроенные изображения <binary id="..." content-type="...">
  const binaries = new Map();
  doc.querySelectorAll('binary').forEach((bin) => {
    const id = bin.getAttribute('id');
    const type = bin.getAttribute('content-type') || 'image/jpeg';
    const b64 = (bin.textContent || '').replace(/\s+/g, '');
    if (id && b64) {
      binaries.set(id, `data:${type};base64,${b64}`);
    }
  });

  const toc = [];
  let secCounter = 0;

  function renderInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.localName;
    const inner = [...node.childNodes].map(renderInline).join('');
    if (tag === 'emphasis') return `<em>${inner}</em>`;
    if (tag === 'strong') return `<strong>${inner}</strong>`;
    if (tag === 'sup') return `<sup>${inner}</sup>`;
    if (tag === 'sub') return `<sub>${inner}</sub>`;
    if (tag === 'code') return `<code>${inner}</code>`;
    if (tag === 'a') {
      const href = node.getAttribute('l:href') || node.getAttribute('href') || '#';
      return `<a href="${escapeHtml(href)}" class="doc-link">${inner}</a>`;
    }
    if (tag === 'image') {
      const href = (node.getAttribute('l:href') || node.getAttribute('href') || '').replace(/^#/, '');
      const src = binaries.get(href);
      return src ? `<img src="${src}" alt="" loading="lazy" class="fb2-inline-img">` : '';
    }
    return inner;
  }

  function renderBlock(node, depth = 1) {
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.localName;

    if (tag === 'section') {
      const xmlId = node.getAttribute('id');
      const secId = xmlId || `fb2-sec-${++secCounter}`;
      const titleEl = [...node.children].find((c) => c.localName === 'title');
      const titleText = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
      if (titleText) {
        toc.push({ id: secId, title: titleText, level: Math.min(3, depth) });
      }
      const childrenHtml = [...node.children].map((c) => {
        if (c.localName === 'title') {
          const hTag = depth <= 1 ? 'h2' : 'h3';
          return `<${hTag} id="${secId}" class="reader-heading">${escapeHtml(titleText)}</${hTag}>`;
        }
        return renderBlock(c, depth + 1);
      }).join('');
      return `<section id="${secId}" class="fb2-section">${childrenHtml}</section>`;
    }

    const elemId = node.getAttribute('id');
    const idAttr = elemId ? ` id="${escapeHtml(elemId)}"` : '';

    if (tag === 'p') return `<p${idAttr}>${[...node.childNodes].map(renderInline).join('')}</p>`;
    if (tag === 'subtitle') return `<h4${idAttr} class="fb2-subtitle">${[...node.childNodes].map(renderInline).join('')}</h4>`;
    if (tag === 'empty-line') return '<div class="fb2-spacer"></div>';
    if (tag === 'epigraph' || tag === 'cite') {
      return `<blockquote${idAttr}>${[...node.children].map((c) => renderBlock(c, depth)).join('')}</blockquote>`;
    }
    if (tag === 'poem' || tag === 'stanza') {
      return `<div${idAttr} class="fb2-stanza">${[...node.children].map((c) => renderBlock(c, depth)).join('')}</div>`;
    }
    if (tag === 'v') return `<p${idAttr} class="fb2-verse">${[...node.childNodes].map(renderInline).join('')}</p>`;
    if (tag === 'image') {
      const href = (node.getAttribute('l:href') || node.getAttribute('href') || '').replace(/^#/, '');
      const src = binaries.get(href);
      return src ? `<figure${idAttr} class="article-figure"><img src="${src}" alt="" loading="lazy"></figure>` : '';
    }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map((tr) => {
        const cells = [...tr.children].map((td) => {
          const cellTag = td.localName === 'th' ? 'th' : 'td';
          return `<${cellTag}>${[...td.childNodes].map(renderInline).join('')}</${cellTag}>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<div${idAttr} class="table-scroll-container"><table>${rows}</table></div>`;
    }
    return [...node.children].map((c) => renderBlock(c, depth)).join('');
  }

  const bodies = [...(doc.documentElement?.children || [])].filter((el) => el.localName === 'body');
  const mainBodies = bodies.filter((b) => b.getAttribute('name') !== 'notes');
  const notesBodies = bodies.filter((b) => b.getAttribute('name') === 'notes');

  let html = mainBodies
    .map((b) => [...b.children].map((c) => renderBlock(c, 1)).join(''))
    .join('');

  if (notesBodies.length > 0) {
    html += '<section class="fb2-notes-container" style="margin-top: 36px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 20px;">';
    html += '<h2 class="reader-heading">Примечания и сноски</h2>';
    notesBodies.forEach((nb) => {
      html += [...nb.children].map((c) => renderBlock(c, 2)).join('');
    });
    html += '</section>';
  }

  return { html, toc };
}

// ==========================================================================
// Единый Reader Controller
// ==========================================================================
export function createReader({ parseMarkdown, getCatalog, isBookmarked, onToggleBookmark, onNotesChanged, onClose }) {
  const overlay = document.getElementById('readerOverlay');
  if (!overlay) return null;

  const titleEl = document.getElementById('readerTitle');
  const subtitleEl = document.getElementById('readerSubtitle');
  const stageEl = document.getElementById('readerStage');
  const closeBtn = document.getElementById('readerCloseBtn');
  const bookmarkBtn = document.getElementById('readerBookmarkBtn');
  const tocBtn = document.getElementById('readerTocBtn');
  const prevBtn = document.getElementById('readerPrevBtn');
  const nextBtn = document.getElementById('readerNextBtn');
  const scrubber = document.getElementById('readerScrubber');
  const pageLabel = document.getElementById('readerPageLabel');
  const modeToggleBtn = document.getElementById('readerModeToggleBtn');
  const noteBtn = document.getElementById('readerNoteBtn');
  const noteBadge = document.getElementById('readerNoteBadge');
  const typoBar = document.getElementById('readerTypoBar');
  const bottomControlsPage = document.getElementById('readerPageControls');
  const bottomControlsText = document.getElementById('readerTextControls');
  const textProgressLabel = document.getElementById('readerTextProgress');

  const notesSheet = document.getElementById('readerNotesSheet');
  const notesListEl = document.getElementById('readerNotesList');
  const notesForm = document.getElementById('readerNotesForm');
  const noteInput = document.getElementById('readerNoteInput');
  const noteColorRow = document.getElementById('readerNoteColorRow');
  const notesCloseBtn = document.getElementById('readerNotesCloseBtn');
  const notesSheetTitle = document.getElementById('readerNotesSheetTitle');

  const tocSheet = document.getElementById('readerTocSheet');
  const tocListEl = document.getElementById('readerTocList');
  const tocCloseBtn = document.getElementById('readerTocCloseBtn');

  let currentArticle = null;
  let format = 'markdown'; // 'images' | 'pdf' | 'markdown' | 'fb2'
  let pages = []; // [{ index, pageNum, src, caption }]
  let currentIndex = 0;
  let settings = { fontSize: 16, theme: 'light', viewMode: 'swipe' };
  let articleNotes = [];
  let selectedNoteColor = 'blue';
  let editingNoteId = null;
  let tocItems = [];

  // Text swipe state
  let textCurrentPage = 0;
  let totalTextPages = 1;
  let cachedTextBodyHtml = '';
  let textResizeObserver = null;
  let textTouchStart = null;
  let textTouchPointerId = null;

  // PDF state
  let pdfDoc = null;
  const pdfRenderCache = new Map(); // pageNum -> { dataUrl, width, height }
  const MAX_PDF_CACHE = 5;

  // Zoom & swipe state
  let zoomScale = 1;
  let zoomX = 0;
  let zoomY = 0;
  const pointers = new Map();
  let pinchStart = null;
  let panStart = null;
  let swipeStart = null;
  let tapCandidate = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let activeZoomTarget = null;
  let scrollObserver = null;

  let scrollProgressTimer = null;
  let wheelFlipAt = 0;
  let activeCustomBlobUrl = null;

  function detectFormat(article) {
    if (article?.format === 'fb2' || article?.fb2?.file || article?.type === 'fb2') return 'fb2';
    if (article?.format === 'markdown' || article?.format === 'txt' || article?.type === 'markdown' || article?.type === 'txt') return 'markdown';
    if (article?.pdf?.file || article?.pdf?.isCustom || (article?.isCustom && (article?.format === 'pdf' || article?.type === 'pdf')) || (article?.isCustom && !article?.format && !article?.type)) return 'pdf';
    if (article?.type === 'visual' && extractWebpPages(article).length > 0) return 'images';
    return 'markdown';
  }

  function extractWebpPages(article) {
    const out = [];
    const rx = /!\[(.*?)\]\((.*?)\)/g;
    const md = article.content_markdown || '';
    let m;
    let idx = 0;
    while ((m = rx.exec(md)) !== null) {
      const caption = m[1] || '';
      const src = m[2] || '';
      const pMatch = src.match(/p(\d+)\.webp/i);
      const pageNum = pMatch ? parseInt(pMatch[1], 10) : (idx + 1);
      out.push({ index: idx++, pageNum, src, caption });
    }
    return out;
  }

  function resetZoom() {
    zoomScale = 1;
    zoomX = 0;
    zoomY = 0;
    if (activeZoomTarget) {
      activeZoomTarget.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
    }
  }

  function applyZoom() {
    if (!activeZoomTarget) return;
    activeZoomTarget.style.transform = `translate3d(${zoomX}px, ${zoomY}px, 0) scale(${zoomScale})`;
    overlay.classList.toggle('reader-zoomed', zoomScale > 1.02);
  }

  function clampPan() {
    if (!activeZoomTarget || zoomScale <= 1) {
      zoomX = 0;
      zoomY = 0;
      return;
    }
    const rect = activeZoomTarget.getBoundingClientRect();
    const baseW = rect.width / zoomScale;
    const baseH = rect.height / zoomScale;
    const maxX = Math.max(0, (baseW * (zoomScale - 1)) / 2 + 24);
    const maxY = Math.max(0, (baseH * (zoomScale - 1)) / 2 + 24);
    zoomX = Math.min(maxX, Math.max(-maxX, zoomX));
    zoomY = Math.min(maxY, Math.max(-maxY, zoomY));
  }

  function zoomTo(targetScale, clientX, clientY, from) {
    if (!activeZoomTarget) return;
    const scale = Math.min(5, Math.max(1, targetScale));
    const rect = activeZoomTarget.getBoundingClientRect();
    const start = from || { scale: zoomScale, x: zoomX, y: zoomY };
    if (!rect.width || !rect.height) {
      zoomScale = scale;
      applyZoom();
      return;
    }
    const centerX = rect.left + rect.width / 2 - zoomX;
    const centerY = rect.top + rect.height / 2 - zoomY;
    const cx = clientX - centerX;
    const cy = clientY - centerY;
    const ux = (cx - start.x) / start.scale;
    const uy = (cy - start.y) / start.scale;
    zoomScale = scale;
    zoomX = cx - ux * scale;
    zoomY = cy - uy * scale;
    clampPan();
    applyZoom();
  }

  function currentPageNum() {
    if (format === 'images' || format === 'pdf') {
      return pages[currentIndex]?.pageNum ?? (currentIndex + 1);
    }
    if (settings.viewMode === 'swipe') {
      return textCurrentPage + 1;
    }
    return null;
  }

  function updateBookmarkUi() {
    if (!currentArticle || !bookmarkBtn) return;
    const active = isBookmarked(currentArticle.id);
    bookmarkBtn.classList.toggle('active', active);
    bookmarkBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    bookmarkBtn.title = active ? 'Удалить из избранного' : 'Добавить в избранное';
  }

  function updateNoteBadge() {
    if (!noteBadge) return;
    const pageNum = currentPageNum();
    const count = pageNum != null
      ? articleNotes.filter((n) => n.page === pageNum || n.page == null).length
      : articleNotes.length;
    noteBadge.textContent = count > 0 ? String(count) : '';
    noteBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  function updatePageChrome() {
    const total = pages.length;
    const pNum = currentPageNum();
    if (scrubber) {
      scrubber.min = 0;
      scrubber.max = Math.max(0, total - 1);
      scrubber.value = currentIndex;
    }
    if (pageLabel) {
      pageLabel.textContent = total > 0 ? `стр. ${pNum} · ${currentIndex + 1} / ${total}` : '';
    }
    if (subtitleEl) {
      const bookShort = currentArticle?.source?.book_short || currentArticle?.source?.book || '';
      subtitleEl.textContent = total > 0 ? `${bookShort} · стр. ${pNum}` : bookShort;
    }
    if (prevBtn) prevBtn.disabled = currentIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentIndex >= total - 1;
    if (modeToggleBtn) {
      modeToggleBtn.textContent = settings.viewMode === 'swipe' ? 'Свайп' : 'Лента';
    }
    updateNoteBadge();
  }

  function preloadNeighbors(idx) {
    if (format !== 'images') return;
    [idx - 1, idx + 1, idx + 2].forEach((i) => {
      if (i >= 0 && i < pages.length) {
        const img = new Image();
        img.src = pages[i].src;
      }
    });
  }

  async function renderPdfPageToDataUrl(localPageNum) {
    if (pdfRenderCache.has(localPageNum)) {
      const cached = pdfRenderCache.get(localPageNum);
      // Refresh LRU order
      pdfRenderCache.delete(localPageNum);
      pdfRenderCache.set(localPageNum, cached);
      return cached;
    }
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(localPageNum);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.2);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = Math.min(window.innerWidth * dpr, 1400);
    const scale = Math.max(1.2, targetWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL('image/webp', 0.88);
    // Освобождаем память canvas сразу (критично для iPhone Safari)
    canvas.width = 1;
    canvas.height = 1;

    const entry = { dataUrl, width: viewport.width, height: viewport.height };
    pdfRenderCache.set(localPageNum, entry);
    if (pdfRenderCache.size > MAX_PDF_CACHE) {
      const oldestKey = pdfRenderCache.keys().next().value;
      pdfRenderCache.delete(oldestKey);
    }
    return entry;
  }

  function attachGestureHandlers(targetEl) {
    activeZoomTarget = targetEl;
    targetEl.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        tapCandidate = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
        if (zoomScale > 1.02) {
          panStart = { x: e.clientX, y: e.clientY, tx: zoomX, ty: zoomY };
          swipeStart = null;
        } else if (settings.viewMode === 'swipe') {
          swipeStart = { x: e.clientX, y: e.clientY, t: performance.now() };
          panStart = null;
        }
      } else {
        const [p1, p2] = [...pointers.values()];
        pinchStart = {
          distance: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
          scale: zoomScale,
          x: zoomX,
          y: zoomY,
        };
        panStart = null;
        swipeStart = null;
        tapCandidate = null;
      }
    });

    targetEl.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tapCandidate && Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y) > 10) {
        tapCandidate.moved = true;
      }
      if (pointers.size >= 2 && pinchStart) {
        const [p1, p2] = [...pointers.values()];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        zoomTo(pinchStart.scale * (dist / pinchStart.distance), (p1.x + p2.x) / 2, (p1.y + p2.y) / 2, pinchStart);
      } else if (panStart) {
        zoomX = panStart.tx + (e.clientX - panStart.x);
        zoomY = panStart.ty + (e.clientY - panStart.y);
        clampPan();
        applyZoom();
      }
    });

    function onPointerEnd(e) {
      const wasSingle = pointers.size === 1;
      const tap = tapCandidate;
      const sw = swipeStart;
      pointers.delete(e.pointerId);

      if (pointers.size === 0) {
        panStart = null;
        pinchStart = null;
        swipeStart = null;

        // Горизонтальный свайп страниц (когда нет зума)
        if (wasSingle && sw && zoomScale <= 1.02 && settings.viewMode === 'swipe') {
          const dx = e.clientX - sw.x;
          const dy = e.clientY - sw.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
            if (dx < 0) goToIndex(currentIndex + 1);
            else goToIndex(currentIndex - 1);
            return;
          }
        }

        // Двойной тап / одиночный тап
        if (wasSingle && tap && !tap.moved) {
          const now = performance.now();
          if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 42) {
            targetEl.classList.add('smooth');
            zoomTo(zoomScale > 1.3 ? 1 : 2.4, e.clientX, e.clientY);
            setTimeout(() => targetEl.classList.remove('smooth'), 240);
            lastTap = { t: 0, x: 0, y: 0 };
          } else {
            lastTap = { t: now, x: e.clientX, y: e.clientY };
            // Короткая задержка: если не double-tap, обрабатываем тап по зонам
            const clientX = e.clientX;
            setTimeout(() => {
              if (lastTap.t !== now) return;
              if (zoomScale > 1.02) {
                overlay.classList.toggle('reader-chrome-hidden');
                return;
              }
              const w = window.innerWidth;
              if (settings.viewMode === 'swipe' && clientX < w * 0.18) {
                goToIndex(currentIndex - 1);
              } else if (settings.viewMode === 'swipe' && clientX > w * 0.82) {
                goToIndex(currentIndex + 1);
              } else {
                overlay.classList.toggle('reader-chrome-hidden');
              }
            }, 220);
          }
        }
      }
    }

    targetEl.addEventListener('pointerup', onPointerEnd);
    targetEl.addEventListener('pointercancel', onPointerEnd);
    targetEl.addEventListener('wheel', (e) => {
      if (settings.viewMode !== 'swipe' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || zoomScale > 1.02) {
        zoomTo(zoomScale * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
        return;
      }
      const now = performance.now();
      if (now - wheelFlipAt < 240 || Math.abs(e.deltaY) < 8) return;
      wheelFlipAt = now;
      if (e.deltaY > 0) goToIndex(currentIndex + 1);
      else goToIndex(currentIndex - 1);
    }, { passive: false });
  }

  async function renderSwipeStage() {
    resetZoom();
    const p = pages[currentIndex];
    if (!p) return;

    stageEl.className = 'reader-stage reader-stage--swipe';
    stageEl.innerHTML = `
      <div class="reader-swipe-wrap">
        <div class="reader-loader" id="readerPageLoader">Загрузка стр. ${p.pageNum}…</div>
        <img id="readerSwipeImg" class="reader-page-img" alt="Страница ${p.pageNum}" draggable="false" style="display:none;">
      </div>
    `;
    const imgEl = document.getElementById('readerSwipeImg');
    const loaderEl = document.getElementById('readerPageLoader');

    attachGestureHandlers(imgEl);

    if (format === 'images') {
      imgEl.onload = () => {
        if (loaderEl) loaderEl.style.display = 'none';
        imgEl.style.display = 'block';
      };
      imgEl.src = p.src;
      preloadNeighbors(currentIndex);
    } else if (format === 'pdf') {
      try {
        const rendered = await renderPdfPageToDataUrl(p.localPage);
        if (rendered && currentIndex === p.index) {
          imgEl.onload = () => {
            if (loaderEl) loaderEl.style.display = 'none';
            imgEl.style.display = 'block';
          };
          imgEl.src = rendered.dataUrl;
          // Фоновая предзагрузка следующей PDF-страницы
          if (currentIndex + 1 < pages.length) {
            renderPdfPageToDataUrl(pages[currentIndex + 1].localPage).catch(() => {});
          }
        }
      } catch (err) {
        if (loaderEl) loaderEl.textContent = `Не удалось загрузить PDF: ${err.message}`;
      }
    }

    updatePageChrome();
    persistCurrentProgress();
  }

  function renderScrollStage() {
    resetZoom();
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }

    stageEl.className = 'reader-stage reader-stage--scroll';
    stageEl.innerHTML = pages.map((p) => `
      <figure class="reader-scroll-item" data-index="${p.index}" data-page="${p.pageNum}">
        <div class="reader-scroll-page-badge">стр. ${p.pageNum}</div>
        ${format === 'images'
          ? `<img src="${p.src}" loading="lazy" alt="Страница ${p.pageNum}" class="reader-scroll-img">`
          : `<div class="reader-pdf-slot" data-local-page="${p.localPage}">Загрузка стр. ${p.pageNum}…</div>`
        }
      </figure>
    `).join('');

    scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(async (entry) => {
        const idx = Number(entry.target.getAttribute('data-index'));
        if (entry.isIntersecting) {
          if (entry.intersectionRatio >= 0.45) {
            currentIndex = idx;
            updatePageChrome();
            persistCurrentProgress();
          }
          if (format === 'pdf') {
            const slot = entry.target.querySelector('.reader-pdf-slot');
            if (slot && !slot.dataset.rendered) {
              slot.dataset.rendered = 'loading';
              const localPage = Number(slot.getAttribute('data-local-page'));
              try {
                const rendered = await renderPdfPageToDataUrl(localPage);
                if (rendered) {
                  slot.innerHTML = `<img src="${rendered.dataUrl}" class="reader-scroll-img" alt="стр. ${pages[idx].pageNum}">`;
                  slot.dataset.rendered = 'done';
                }
              } catch (_) {
                slot.textContent = 'Ошибка рендера страницы';
              }
            }
          }
        }
      });
    }, { root: stageEl, threshold: [0.1, 0.5] });

    stageEl.querySelectorAll('.reader-scroll-item').forEach((el) => scrollObserver.observe(el));

    // Прокрутка к текущей странице
    const targetEl = stageEl.querySelector(`.reader-scroll-item[data-index="${currentIndex}"]`);
    if (targetEl) {
      requestAnimationFrame(() => targetEl.scrollIntoView({ block: 'start' }));
    }

    // Тап по центру в режиме ленты скрывает панели
    stageEl.onclick = (e) => {
      if (e.target.closest('button, input, a')) return;
      overlay.classList.toggle('reader-chrome-hidden');
    };

    updatePageChrome();
  }

  function updateTextSwipeChrome() {
    if (bottomControlsPage) bottomControlsPage.style.display = 'flex';
    if (bottomControlsText) bottomControlsText.style.display = 'none';
    if (typoBar) typoBar.style.display = 'flex';
    if (pageLabel) {
      pageLabel.style.display = 'inline';
      pageLabel.textContent = totalTextPages > 0
        ? `стр. ${textCurrentPage + 1} · ${textCurrentPage + 1} / ${totalTextPages}`
        : '';
    }
    if (subtitleEl) {
      const bookShort = currentArticle?.source?.book_short || currentArticle?.source?.book || '';
      subtitleEl.textContent = totalTextPages > 0 ? `${bookShort} · стр. ${textCurrentPage + 1}` : bookShort;
    }
    if (prevBtn) prevBtn.disabled = textCurrentPage <= 0;
    if (nextBtn) nextBtn.disabled = textCurrentPage >= totalTextPages - 1;
    if (scrubber) {
      scrubber.min = '0';
      scrubber.max = String(Math.max(0, totalTextPages - 1));
      scrubber.value = String(textCurrentPage);
    }
    if (modeToggleBtn) {
      modeToggleBtn.style.display = 'inline-flex';
      modeToggleBtn.textContent = 'Свайп';
    }
    updateNoteBadge();
  }

  function updateTextScrollChrome() {
    if (bottomControlsPage) bottomControlsPage.style.display = 'none';
    if (bottomControlsText) bottomControlsText.style.display = 'flex';
    if (typoBar) typoBar.style.display = 'flex';
    if (pageLabel) pageLabel.style.display = 'none';
    if (subtitleEl) {
      subtitleEl.textContent = currentArticle?.source?.book_short || currentArticle?.source?.book || '';
    }
    if (modeToggleBtn) {
      modeToggleBtn.style.display = 'inline-flex';
      modeToggleBtn.textContent = 'Лента';
    }
    updateNoteBadge();
  }

  function persistTextProgress() {
    if (!currentArticle) return;
    const ratio = totalTextPages > 1 ? (textCurrentPage / (totalTextPages - 1)) : 0;
    saveProgress(currentArticle.id, {
      textPage: textCurrentPage,
      totalTextPages,
      scrollRatio: ratio,
    });
  }

  function goToTextPage(pageIndex, animate = true) {
    const clamped = Math.max(0, Math.min(totalTextPages - 1, pageIndex));
    textCurrentPage = clamped;
    const viewportEl = document.getElementById('readerTextViewport');
    const trackEl = document.getElementById('readerTextTrack');
    if (viewportEl && trackEl) {
      const colWidth = Math.max(260, viewportEl.clientWidth - 48);
      const colGap = 48;
      const step = colWidth + colGap;
      if (!animate) trackEl.style.transition = 'none';
      trackEl.style.transform = `translate3d(${-clamped * step}px, 0, 0)`;
      if (!animate) {
        trackEl.offsetHeight; // force reflow
        trackEl.style.transition = 'transform 0.28s cubic-bezier(0.2, 0, 0, 1)';
      }
    }
    updateTextSwipeChrome();
    persistTextProgress();
  }

  function recalculateTextSwipePages(keepRelative = true) {
    const viewportEl = document.getElementById('readerTextViewport');
    const trackEl = document.getElementById('readerTextTrack');
    if (!viewportEl || !trackEl) return;

    const prevTotal = totalTextPages;
    const prevRatio = prevTotal > 1 ? (textCurrentPage / (prevTotal - 1)) : 0;

    const colWidth = Math.max(260, viewportEl.clientWidth - 48);
    const colHeight = Math.max(200, viewportEl.clientHeight - 44);
    const colGap = 48;

    trackEl.style.columnWidth = `${colWidth}px`;
    trackEl.style.columnGap = `${colGap}px`;
    trackEl.style.height = `${colHeight}px`;

    const step = colWidth + colGap;
    totalTextPages = Math.max(1, Math.round((trackEl.scrollWidth + colGap) / step));

    if (keepRelative && prevTotal > 1) {
      textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, Math.round(prevRatio * (totalTextPages - 1))));
    } else {
      textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, textCurrentPage));
    }

    goToTextPage(textCurrentPage, false);
  }

  function jumpTextToElement(target) {
    if (!target) return;
    if (settings.viewMode === 'swipe') {
      const viewportEl = document.getElementById('readerTextViewport');
      if (viewportEl) {
        const colWidth = Math.max(260, viewportEl.clientWidth - 48);
        const colGap = 48;
        const step = colWidth + colGap;
        const targetPage = Math.max(0, Math.min(totalTextPages - 1, Math.floor(target.offsetLeft / step)));
        goToTextPage(targetPage, true);
      }
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function attachTextGestureHandlers(viewportEl) {
    viewportEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      textTouchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      textTouchPointerId = e.pointerId;
    });

    viewportEl.addEventListener('pointerup', (e) => {
      if (!textTouchStart || (textTouchPointerId !== null && e.pointerId !== textTouchPointerId)) return;
      const dx = e.clientX - textTouchStart.x;
      const dy = e.clientY - textTouchStart.y;
      const dt = performance.now() - textTouchStart.t;
      textTouchStart = null;
      textTouchPointerId = null;

      if (Math.abs(dx) > 40 && Math.abs(dx) > 1.2 * Math.abs(dy)) {
        if (dx < 0) goToTextPage(textCurrentPage + 1);
        else goToTextPage(textCurrentPage - 1);
        return;
      }

      if (Math.hypot(dx, dy) < 16 && dt < 400) {
        const w = window.innerWidth;
        if (e.clientX < w * 0.22) {
          goToTextPage(textCurrentPage - 1);
        } else if (e.clientX > w * 0.78) {
          goToTextPage(textCurrentPage + 1);
        } else {
          overlay.classList.toggle('reader-chrome-hidden');
        }
      }
    });

    viewportEl.addEventListener('click', (e) => {
      const link = e.target.closest('a[href], a[l\\:href], .doc-link');
      if (link) {
        const href = link.getAttribute('data-internal-id') || link.getAttribute('href') || link.getAttribute('l:href') || '';
        if (href.startsWith('#')) {
          e.preventDefault();
          const targetId = href.replace(/^#/, '');
          const targetEl = document.getElementById(targetId);
          if (targetEl) {
            jumpTextToElement(targetEl);
          }
        }
      }
    });

    viewportEl.addEventListener('pointercancel', () => {
      textTouchStart = null;
      textTouchPointerId = null;
    });

    viewportEl.addEventListener('wheel', (e) => {
      const now = performance.now();
      if (now - wheelFlipAt < 240) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
      if (Math.abs(delta) > 15) {
        wheelFlipAt = now;
        if (delta > 0) goToTextPage(textCurrentPage + 1);
        else goToTextPage(textCurrentPage - 1);
      }
    }, { passive: true });
  }

  async function renderTextStage(targetPageOrAnchor) {
    let bodyHtml = '';
    tocItems = [];

    if (format === 'fb2') {
      stageEl.innerHTML = `<div class="reader-text-wrap"><div class="reader-loader">Загрузка книги FB2…</div></div>`;
      try {
        let xmlText = '';
        if (currentArticle.isCustom && currentArticle.customId) {
          const rec = await getCustomMaterial(currentArticle.customId);
          if (!rec || !rec.blob) throw new Error('Файл не найден в локальном хранилище');
          xmlText = await readXmlTextWithEncoding(rec.blob);
        } else {
          const resp = await fetch(currentArticle.fb2.file);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          xmlText = await readXmlTextWithEncoding(blob);
        }
        const parsed = parseFb2Xml(xmlText);
        bodyHtml = parsed.html;
        tocItems = parsed.toc;
      } catch (err) {
        bodyHtml = `<p class="reader-error">Не удалось загрузить FB2: ${escapeHtml(err.message)}</p>`;
      }
    } else {
      if (currentArticle.isCustom && currentArticle.customId) {
        try {
          const rec = await getCustomMaterial(currentArticle.customId);
          if (rec && rec.blob) {
            currentArticle.content_markdown = await rec.blob.text();
          }
        } catch (err) {
          console.warn('Could not read custom markdown blob:', err);
        }
      }
      bodyHtml = parseMarkdown(currentArticle.content_markdown || '');
    }

    cachedTextBodyHtml = bodyHtml;

    if (settings.viewMode === 'swipe') {
      await renderTextSwipeStage(targetPageOrAnchor);
    } else {
      await renderTextScrollStage(targetPageOrAnchor);
    }
  }

  async function renderTextSwipeStage(targetPageOrAnchor) {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    stageEl.onclick = null;
    stageEl.onscroll = null;
    stageEl.className = `reader-stage reader-stage--text-swipe reader-theme-${settings.theme}`;
    stageEl.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
    stageEl.scrollTop = 0;

    const bookShort = currentArticle?.source?.book_short || currentArticle?.source?.book || '';
    stageEl.innerHTML = `
      <div class="reader-text-viewport" id="readerTextViewport">
        <div class="reader-text-track" id="readerTextTrack">
          <h1 class="reader-article-title">${escapeHtml(currentArticle.title)}</h1>
          <div class="reader-article-meta">${escapeHtml(bookShort)}</div>
          <div class="reader-text-body">${cachedTextBodyHtml}</div>
        </div>
      </div>
    `;

    // Собираем оглавление для Markdown из заголовков
    if (format === 'markdown') {
      tocItems = [];
      stageEl.querySelectorAll('.reader-text-body h2, .reader-text-body h3').forEach((h, i) => {
        const id = h.id || `md-sec-${i + 1}`;
        h.id = id;
        tocItems.push({ id, title: h.textContent.trim(), level: h.tagName === 'H2' ? 1 : 2 });
      });
    }

    const viewportEl = document.getElementById('readerTextViewport');
    const trackEl = document.getElementById('readerTextTrack');
    if (!viewportEl || !trackEl) return;

    recalculateTextSwipePages(false);
    attachTextGestureHandlers(viewportEl);

    if (textResizeObserver) {
      textResizeObserver.disconnect();
    }
    textResizeObserver = new ResizeObserver(() => {
      if (settings.viewMode === 'swipe' && (format === 'fb2' || format === 'markdown' || format === 'txt')) {
        recalculateTextSwipePages(false);
      }
    });
    textResizeObserver.observe(viewportEl);

    trackEl.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', () => recalculateTextSwipePages(false), { once: true });
      }
    });

    if (targetPageOrAnchor) {
      if (typeof targetPageOrAnchor === 'number') {
        textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, targetPageOrAnchor - 1));
      } else if (typeof targetPageOrAnchor === 'string') {
        const el = document.getElementById(targetPageOrAnchor.replace(/^#/, ''));
        if (el) {
          const colWidth = Math.max(260, viewportEl.clientWidth - 48);
          const colGap = 48;
          const step = colWidth + colGap;
          textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, Math.floor(el.offsetLeft / step)));
        }
      }
      goToTextPage(textCurrentPage, false);
    } else {
      const saved = await getProgress(currentArticle.id);
      if (saved?.textPage != null) {
        textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, Number(saved.textPage)));
      } else if (saved?.scrollRatio != null && totalTextPages > 1) {
        textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, Math.round(saved.scrollRatio * (totalTextPages - 1))));
      }
      goToTextPage(textCurrentPage, false);
    }
  }

  async function renderTextScrollStage(targetPageOrAnchor) {
    if (textResizeObserver) {
      textResizeObserver.disconnect();
      textResizeObserver = null;
    }
    stageEl.className = `reader-stage reader-stage--text reader-theme-${settings.theme}`;
    stageEl.style.setProperty('--reader-font-size', `${settings.fontSize}px`);

    const bookShort = currentArticle?.source?.book_short || currentArticle?.source?.book || '';
    stageEl.innerHTML = `
      <article class="reader-text-wrap" id="readerTextArticle">
        <h1 class="reader-article-title">${escapeHtml(currentArticle.title)}</h1>
        <div class="reader-article-meta">${escapeHtml(bookShort)}</div>
        <div class="reader-text-body">${cachedTextBodyHtml}</div>
      </article>
    `;

    if (format === 'markdown') {
      tocItems = [];
      stageEl.querySelectorAll('.reader-text-body h2, .reader-text-body h3').forEach((h, i) => {
        const id = h.id || `md-sec-${i + 1}`;
        h.id = id;
        tocItems.push({ id, title: h.textContent.trim(), level: h.tagName === 'H2' ? 1 : 2 });
      });
    }

    updateTextScrollChrome();

    const saved = await getProgress(currentArticle.id);
    if (saved?.scrollRatio && !targetPageOrAnchor) {
      requestAnimationFrame(() => {
        const maxScroll = stageEl.scrollHeight - stageEl.clientHeight;
        if (maxScroll > 0) stageEl.scrollTop = saved.scrollRatio * maxScroll;
      });
    }

    const updateTextProgress = (immediate = false) => {
      const maxScroll = Math.max(1, stageEl.scrollHeight - stageEl.clientHeight);
      const ratio = Math.min(1, Math.max(0, stageEl.scrollTop / maxScroll));
      const pct = Math.round(ratio * 100);
      if (textProgressLabel) textProgressLabel.textContent = `Прочитано ${pct}%`;
      clearTimeout(scrollProgressTimer);
      if (immediate) {
        saveProgress(currentArticle.id, { scrollRatio: ratio });
      } else {
        scrollProgressTimer = setTimeout(() => {
          if (currentArticle) saveProgress(currentArticle.id, { scrollRatio: ratio });
        }, 400);
      }
    };

    stageEl.onscroll = () => updateTextProgress(false);
    stageEl.onclick = (e) => {
      const link = e.target.closest('.doc-link, a[href^="#"]');
      if (link) {
        const targetId = link.getAttribute('data-internal-id') || link.getAttribute('href') || '';
        if (targetId.startsWith('#')) {
          e.preventDefault();
          const [cleanId, query = ''] = targetId.slice(1).split('?');
          const targetEl = document.getElementById(cleanId);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            const nextPage = parseInt(new URLSearchParams(query).get('p'), 10) || null;
            const targetArticle = getCatalog().find((a) => a.id === cleanId);
            if (targetArticle) open(targetArticle, nextPage);
          }
        }
        return;
      }
      if (e.target.closest('a, button, table')) return;
      overlay.classList.toggle('reader-chrome-hidden');
    };
    updateTextProgress(true);
    updateNoteBadge();
  }

  async function switchTextViewMode(nextMode) {
    if (nextMode === 'swipe') {
      const maxScroll = Math.max(1, stageEl.scrollHeight - stageEl.clientHeight);
      const ratio = Math.min(1, Math.max(0, stageEl.scrollTop / maxScroll));
      await renderTextSwipeStage();
      textCurrentPage = Math.min(totalTextPages - 1, Math.max(0, Math.round(ratio * (totalTextPages - 1))));
      goToTextPage(textCurrentPage, false);
    } else {
      const ratio = totalTextPages > 1 ? (textCurrentPage / (totalTextPages - 1)) : 0;
      await renderTextScrollStage();
      const maxScroll = Math.max(1, stageEl.scrollHeight - stageEl.clientHeight);
      stageEl.scrollTop = ratio * maxScroll;
    }
  }

  function goToIndex(idx) {
    const clamped = Math.max(0, Math.min(pages.length - 1, idx));
    if (clamped === currentIndex && stageEl.children.length > 0) return;
    currentIndex = clamped;
    if (settings.viewMode === 'swipe') {
      renderSwipeStage();
    } else {
      const targetEl = stageEl.querySelector(`.reader-scroll-item[data-index="${currentIndex}"]`);
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updatePageChrome();
      persistCurrentProgress();
    }
  }

  function persistCurrentProgress() {
    if (!currentArticle) return;
    const pNum = currentPageNum();
    saveProgress(currentArticle.id, { page: pNum, total: pages.length });
    if (currentArticle.source?.book_id) {
      saveProgress(`book:${currentArticle.source.book_id}`, {
        articleId: currentArticle.id,
        page: pNum,
      });
    }
  }

  async function openNotesSheet() {
    if (!notesSheet || !currentArticle) return;
    const pNum = currentPageNum();
    notesSheetTitle.textContent = pNum != null
      ? `Заметки · стр. ${pNum}`
      : 'Заметки к разделу';
    editingNoteId = null;
    noteInput.value = '';
    renderNotesListInSheet();
    notesSheet.classList.add('open');
  }

  function renderNotesListInSheet() {
    if (!notesListEl) return;
    const pNum = currentPageNum();
    const filtered = pNum != null
      ? articleNotes.filter((n) => n.page === pNum || n.page == null)
      : articleNotes;

    if (filtered.length === 0) {
      notesListEl.innerHTML = `<div class="reader-notes-empty">Заметок пока нет.</div>`;
    } else {
      notesListEl.innerHTML = filtered.map((n) => {
        const col = NOTE_COLORS.find((c) => c.id === n.color) || NOTE_COLORS[0];
        const pageBadge = n.page != null ? `стр. ${n.page}` : 'Общая заметка';
        return `
          <div class="reader-note-card" style="--note-color: ${col.hex}">
            <div class="reader-note-card-head">
              <span class="reader-note-tag">${col.label} · ${pageBadge}</span>
              <span class="reader-note-date">${new Date(n.updatedAt || n.createdAt).toLocaleDateString('ru-RU')}</span>
            </div>
            <div class="reader-note-text">${escapeHtml(n.text)}</div>
            <div class="reader-note-actions">
              <button type="button" data-edit-note="${n.id}">Изменить</button>
              <button type="button" class="danger" data-del-note="${n.id}">Удалить</button>
            </div>
          </div>
        `;
      }).join('');

      notesListEl.querySelectorAll('[data-edit-note]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-edit-note');
          const found = articleNotes.find((x) => x.id === id);
          if (!found) return;
          editingNoteId = found.id;
          noteInput.value = found.text;
          selectedNoteColor = found.color || 'blue';
          syncNoteColorButtons();
          noteInput.focus();
        });
      });

      notesListEl.querySelectorAll('[data-del-note]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-del-note');
          await deleteNote(id);
          articleNotes = articleNotes.filter((x) => x.id !== id);
          renderNotesListInSheet();
          updateNoteBadge();
          onNotesChanged?.();
        });
      });
    }
  }

  function syncNoteColorButtons() {
    if (!noteColorRow) return;
    noteColorRow.querySelectorAll('[data-color]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-color') === selectedNoteColor);
    });
  }

  function openTocSheet() {
    if (!tocSheet || !currentArticle) return;
    const bookId = currentArticle.source?.book_id;
    const catalog = getCatalog();

    if (format === 'markdown' || format === 'fb2') {
      if (tocItems.length === 0) {
        tocListEl.innerHTML = `<div class="reader-notes-empty">В этом разделе нет подзаголовков.</div>`;
      } else {
        tocListEl.innerHTML = tocItems.map((item) => `
          <button type="button" class="reader-toc-item level-${item.level}" data-sec-id="${item.id}">
            ${escapeHtml(item.title)}
          </button>
        `).join('');
        tocListEl.querySelectorAll('[data-sec-id]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const target = document.getElementById(btn.getAttribute('data-sec-id'));
            tocSheet.classList.remove('open');
            if (target) jumpTextToElement(target);
          });
        });
      }
    } else if (bookId) {
      const chapters = catalog.filter((a) => a.source?.book_id === bookId);
      tocListEl.innerHTML = chapters.map((ch) => `
        <button type="button" class="reader-toc-item ${ch.id === currentArticle.id ? 'active' : ''}" data-chapter-id="${ch.id}">
          <span>${escapeHtml(ch.title)}</span>
          <small>стр. ${escapeHtml(ch.source?.pages || '')}</small>
        </button>
      `).join('');
      tocListEl.querySelectorAll('[data-chapter-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const ch = chapters.find((c) => c.id === btn.getAttribute('data-chapter-id'));
          tocSheet.classList.remove('open');
          if (ch) open(ch);
        });
      });
    }
    tocSheet.classList.add('open');
  }

  async function open(article, targetPage = null) {
    currentArticle = article;
    format = detectFormat(article);
    settings = await getReaderSettings();
    articleNotes = await getNotesForArticle(article.id);
    pdfDoc = null;
    pdfRenderCache.clear();
    pages = [];
    currentIndex = 0;

    overlay.classList.remove('reader-chrome-hidden');
    overlay.classList.add('open');
    document.body.classList.add('reader-open');

    titleEl.textContent = article.title;
    subtitleEl.textContent = article.source?.book_short || article.source?.book || '';
    updateBookmarkUi();

    const isPageMode = format === 'images' || format === 'pdf';
    const isSwipe = settings.viewMode === 'swipe';
    if (modeToggleBtn) {
      modeToggleBtn.style.display = 'inline-flex';
      modeToggleBtn.textContent = isSwipe ? 'Свайп' : 'Лента';
    }
    if (isPageMode) {
      if (bottomControlsPage) bottomControlsPage.style.display = isSwipe ? 'flex' : 'none';
      if (bottomControlsText) bottomControlsText.style.display = 'none';
      if (typoBar) typoBar.style.display = 'none';
      if (pageLabel) pageLabel.style.display = 'inline';
    } else {
      if (typoBar) typoBar.style.display = 'flex';
      if (bottomControlsPage) bottomControlsPage.style.display = isSwipe ? 'flex' : 'none';
      if (bottomControlsText) bottomControlsText.style.display = isSwipe ? 'none' : 'flex';
      if (pageLabel) pageLabel.style.display = isSwipe ? 'inline' : 'none';
    }

    if (format === 'images') {
      pages = extractWebpPages(article);
      if (targetPage) {
        const foundIdx = pages.findIndex((p) => p.pageNum === Number(targetPage));
        if (foundIdx >= 0) currentIndex = foundIdx;
      } else {
        const saved = await getProgress(article.id);
        if (saved?.page) {
          const foundIdx = pages.findIndex((p) => p.pageNum === Number(saved.page));
          if (foundIdx >= 0) currentIndex = foundIdx;
        }
      }
      if (settings.viewMode === 'swipe') await renderSwipeStage();
      else renderScrollStage();
    } else if (format === 'pdf') {
      const pdf = article.pdf;
      const total = Number(pdf.pages) || 1;
      pages = Array.from({ length: total }, (_, i) => ({
        index: i,
        localPage: i + 1,
        pageNum: Number(pdf.start || 1) + i,
      }));
      if (targetPage) {
        const local = Math.max(1, Math.min(total, Number(targetPage) - Number(pdf.start || 1) + 1));
        currentIndex = local - 1;
      } else {
        const saved = await getProgress(article.id);
        if (saved?.page) {
          const foundIdx = pages.findIndex((p) => p.pageNum === Number(saved.page));
          if (foundIdx >= 0) currentIndex = foundIdx;
        }
      }
      stageEl.className = 'reader-stage reader-stage--swipe';
      stageEl.innerHTML = `<div class="reader-loader">Инициализация PDF-ридера…</div>`;
      try {
        const pdfjsLib = await loadPdfJs();
        let pdfSource = pdf.file;
        if (pdf.isCustom && pdf.customId) {
          const rec = await getCustomMaterial(pdf.customId);
          if (rec && rec.blob) {
            if (activeCustomBlobUrl) {
              URL.revokeObjectURL(activeCustomBlobUrl);
            }
            activeCustomBlobUrl = URL.createObjectURL(rec.blob);
            pdfSource = activeCustomBlobUrl;
          }
        }
        pdfDoc = await pdfjsLib.getDocument(pdfSource).promise;
        if (pdfDoc && pdfDoc.numPages && pdfDoc.numPages !== pages.length) {
          const actualTotal = pdfDoc.numPages;
          article.pages = actualTotal;
          if (article.pdf) {
            article.pdf.pages = actualTotal;
            article.pdf.end = actualTotal;
          }
          if (article.source) article.source.pages = actualTotal;
          pages = Array.from({ length: actualTotal }, (_, i) => ({
            index: i,
            localPage: i + 1,
            pageNum: Number(pdf.start || 1) + i,
          }));
          if (pdf.isCustom && pdf.customId) {
            getCustomMaterial(pdf.customId).then(rec => {
              if (rec && rec.pages !== actualTotal) {
                rec.pages = actualTotal;
                saveCustomMaterial(rec);
              }
            }).catch(() => {});
          }
        }
        if (settings.viewMode === 'swipe') await renderSwipeStage();
        else renderScrollStage();
      } catch (err) {
        stageEl.innerHTML = `<div class="reader-error">Не удалось открыть PDF: ${escapeHtml(err.message)}</div>`;
      }
    } else {
      await renderTextStage(targetPage);
    }
  }

  function close() {
    overlay.classList.remove('open', 'reader-chrome-hidden', 'reader-zoomed');
    document.body.classList.remove('reader-open');
    notesSheet?.classList.remove('open');
    tocSheet?.classList.remove('open');
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    if (textResizeObserver) {
      textResizeObserver.disconnect();
      textResizeObserver = null;
    }
    if (activeCustomBlobUrl) {
      URL.revokeObjectURL(activeCustomBlobUrl);
      activeCustomBlobUrl = null;
    }
    if (pdfDoc) {
      try { pdfDoc.destroy(); } catch (_) {}
      pdfDoc = null;
    }
    pdfRenderCache.clear();
    stageEl.innerHTML = '';
    stageEl.onclick = null;
    stageEl.onscroll = null;
    currentArticle = null;
    if (onClose) onClose();
  }

  // Bind UI controls
  closeBtn?.addEventListener('click', close);
  bookmarkBtn?.addEventListener('click', () => {
    if (!currentArticle) return;
    onToggleBookmark(currentArticle.id);
    updateBookmarkUi();
  });
  tocBtn?.addEventListener('click', openTocSheet);
  tocCloseBtn?.addEventListener('click', () => tocSheet?.classList.remove('open'));
  prevBtn?.addEventListener('click', () => {
    if (format === 'images' || format === 'pdf') {
      goToIndex(currentIndex - 1);
    } else if (settings.viewMode === 'swipe') {
      goToTextPage(textCurrentPage - 1);
    }
  });
  nextBtn?.addEventListener('click', () => {
    if (format === 'images' || format === 'pdf') {
      goToIndex(currentIndex + 1);
    } else if (settings.viewMode === 'swipe') {
      goToTextPage(textCurrentPage + 1);
    }
  });

  scrubber?.addEventListener('input', (e) => {
    const idx = Number(e.target.value);
    if (format === 'images' || format === 'pdf') {
      if (pageLabel) {
        const pNum = pages[idx]?.pageNum ?? (idx + 1);
        pageLabel.textContent = `стр. ${pNum} · ${idx + 1} / ${pages.length}`;
      }
    } else if (settings.viewMode === 'swipe') {
      if (pageLabel) {
        pageLabel.textContent = totalTextPages > 0
          ? `стр. ${idx + 1} · ${idx + 1} / ${totalTextPages}`
          : '';
      }
    }
  });
  scrubber?.addEventListener('change', (e) => {
    const val = Number(e.target.value);
    if (format === 'images' || format === 'pdf') {
      goToIndex(val);
    } else if (settings.viewMode === 'swipe') {
      goToTextPage(val);
    }
  });

  modeToggleBtn?.addEventListener('click', async () => {
    const nextMode = settings.viewMode === 'swipe' ? 'scroll' : 'swipe';
    settings = await saveReaderSettings({ viewMode: nextMode });
    if (format === 'images' || format === 'pdf') {
      if (nextMode === 'swipe') await renderSwipeStage();
      else renderScrollStage();
    } else {
      await switchTextViewMode(nextMode);
    }
  });

  // Typography controls
  typoBar?.addEventListener('click', async (e) => {
    const fontAction = e.target.closest('[data-font-delta]');
    if (fontAction) {
      const delta = Number(fontAction.getAttribute('data-font-delta'));
      const nextSize = Math.min(22, Math.max(13, settings.fontSize + delta));
      settings = await saveReaderSettings({ fontSize: nextSize });
      stageEl.style.setProperty('--reader-font-size', `${nextSize}px`);
      if (settings.viewMode === 'swipe' && (format === 'fb2' || format === 'markdown' || format === 'txt')) {
        recalculateTextSwipePages(true);
      }
    }
    const themeBtn = e.target.closest('[data-reader-theme]');
    if (themeBtn) {
      const theme = themeBtn.getAttribute('data-reader-theme');
      settings = await saveReaderSettings({ theme });
      const baseClass = settings.viewMode === 'swipe' ? 'reader-stage--text-swipe' : 'reader-stage--text';
      stageEl.className = `reader-stage ${baseClass} reader-theme-${theme}`;
    }
  });

  // Notes sheet
  noteBtn?.addEventListener('click', openNotesSheet);
  notesCloseBtn?.addEventListener('click', () => notesSheet?.classList.remove('open'));
  noteColorRow?.querySelectorAll('[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedNoteColor = btn.getAttribute('data-color');
      syncNoteColorButtons();
    });
  });

  notesForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = noteInput.value.trim();
    if (!text || !currentArticle) return;
    const saved = await saveNote({
      id: editingNoteId || undefined,
      articleId: currentArticle.id,
      bookId: currentArticle.source?.book_id || 'other',
      bookShort: currentArticle.source?.book_short || currentArticle.source?.book || '',
      title: currentArticle.title,
      page: currentPageNum(),
      color: selectedNoteColor,
      text,
    });
    if (editingNoteId) {
      articleNotes = articleNotes.map((n) => (n.id === saved.id ? saved : n));
    } else {
      articleNotes.unshift(saved);
    }
    editingNoteId = null;
    noteInput.value = '';
    renderNotesListInSheet();
    updateNoteBadge();
    onNotesChanged?.();
  });

  // Корректная подстройка Bottom Sheet под клавиатуру на iPhone / Android
  if (window.visualViewport && notesSheet) {
    window.visualViewport.addEventListener('resize', () => {
      if (!notesSheet.classList.contains('open')) return;
      const offset = Math.max(0, window.innerHeight - window.visualViewport.height);
      notesSheet.style.paddingBottom = `${offset}px`;
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('open')) return;
    const activeTag = document.activeElement?.tagName;
    const isTyping = activeTag === 'TEXTAREA' || activeTag === 'INPUT';
    if (e.key === 'Escape') {
      if (notesSheet?.classList.contains('open')) notesSheet.classList.remove('open');
      else if (tocSheet?.classList.contains('open')) tocSheet.classList.remove('open');
      else close();
    } else if (!isTyping && e.key === 'ArrowRight') {
      if (format === 'images' || format === 'pdf') goToIndex(currentIndex + 1);
      else if (settings.viewMode === 'swipe') goToTextPage(textCurrentPage + 1);
    } else if (!isTyping && e.key === 'ArrowLeft') {
      if (format === 'images' || format === 'pdf') goToIndex(currentIndex - 1);
      else if (settings.viewMode === 'swipe') goToTextPage(textCurrentPage - 1);
    }
  });

  return { open, close };
}
