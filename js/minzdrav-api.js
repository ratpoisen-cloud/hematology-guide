// ==========================================================================
// Модуль интеграции с Рубрикатором клинических рекомендаций Минздрава РФ
// Официальный реестр: https://cr.minzdrav.gov.ru/
// Официальный API: https://apicr.minzdrav.gov.ru/
// ==========================================================================

const DEFAULT_MINZDRAV_API = 'https://apicr.minzdrav.gov.ru';

export function getMinzdravProxyUrl() {
  try {
    return localStorage.getItem('gem_cr_proxy_url') || '';
  } catch (_) {
    return '';
  }
}

export function setMinzdravProxyUrl(url) {
  try {
    if (url) {
      localStorage.setItem('gem_cr_proxy_url', url.trim());
    } else {
      localStorage.removeItem('gem_cr_proxy_url');
    }
  } catch (_) {}
}

/**
 * Вспомогательный метод для выполнения запроса с каскадным fallback:
 * 1. Пользовательский прокси (если задан в gem_cr_proxy_url)
 * 2. Прямой запрос к https://apicr.minzdrav.gov.ru/
 * 3. Локальный dev-прокси /api/cr-proxy/ (если запущен на localhost/127.0.0.1)
 */
async function fetchWithFallback(pathAndQuery, options = {}) {
  const customProxy = getMinzdravProxyUrl();
  const urlsToTry = [];

  if (customProxy) {
    const base = customProxy.replace(/\/+$/, '');
    urlsToTry.push(`${base}/${pathAndQuery.replace(/^\/+/, '')}`);
  }

  // Если открыто локально, локальный dev-прокси имеет высший приоритет (обходит CORS и стримит PDF)
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    urlsToTry.push(`/api/cr-proxy/${pathAndQuery.replace(/^\/+/, '')}`);
  }

  // Прямой доступ к Минздраву (поддерживает CORS по умолчанию)
  urlsToTry.push(`${DEFAULT_MINZDRAV_API}/${pathAndQuery.replace(/^\/+/, '')}`);

  let lastError = null;
  for (const url of urlsToTry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const fetchOpts = { ...options, signal: controller.signal };
      const resp = await fetch(url, fetchOpts);
      clearTimeout(timer);
      if (resp.ok) return resp;
      if (resp.status === 404 || resp.status === 500) {
        lastError = new Error(`Сервер вернул статус ${resp.status}`);
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      // Пробуем следующий URL
    }
  }

  throw lastError || new Error('Не удалось связаться с сервером Минздрава');
}

/**
 * Выполнить поиск по официальному реестру клинических рекомендаций Минздрава РФ
 * @param {Object} options
 * @param {string} options.query - Текстовый поисковый запрос (диагноз, нозология)
 * @param {number} options.page - Номер страницы (1-based)
 * @param {number} options.pageSize - Количество записей на страницу
 * @returns {Promise<{total: number, page: number, items: Array}>}
 */
export async function searchMinzdravRegistry({ query = '', page = 1, pageSize = 20 } = {}) {
  const trimmed = (query || '').trim();
  const filters = [
    { fieldName: 'status', filterType: 1, filterValueType: 2, value1: 0, value2: '', values: [] },
  ];

  if (trimmed) {
    filters.push({
      fieldName: 'name',
      filterType: 2,
      filterValueType: 1,
      value1: trimmed,
      value2: '',
      values: [],
    });
  }

  const payload = {
    filters,
    sortOption: { fieldName: 'publishdate', sortType: 2 },
    pageSize,
    currentPage: page,
    useANDoperator: true,
    columns: [],
  };

  let response;
  try {
    response = await fetchWithFallback('api.ashx?op=GetJsonClinrecsFilterV2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Ошибка обращения к API Минздрава:', err);
    throw new Error('Не удалось подключиться к серверу Минздрава РФ. Проверьте интернет или повторите попытку.');
  }

  const data = await response.json();
  const rawList = Array.isArray(data.Data) ? data.Data : [];
  const total = Number(data.TotalRecords) || rawList.length;

  const items = rawList.map((item) => {
    const codeVer = item.CodeVersion || (item.Code ? `${item.Code}_${item.Version || 1}` : String(item.Id));
    let year = '2024';
    if (item.PublishDateStr) {
      const match = item.PublishDateStr.match(/^(\d{4})/);
      if (match) year = match[1];
    } else if (item.CreatedStr) {
      const match = item.CreatedStr.match(/^(\d{4})/);
      if (match) year = match[1];
    }

    const mkbs = Array.isArray(item.Mkbs)
      ? item.Mkbs.map((m) => m.MkbCode).filter(Boolean)
      : [];

    const developers = Array.isArray(item.Developers)
      ? item.Developers.map((d) => d.NkoShortName || d.NkoName).filter(Boolean)
      : [];

    const pdfUrl = `${DEFAULT_MINZDRAV_API}/api.ashx?op=GetClinrecPdf&id=${encodeURIComponent(codeVer)}`;
    const webUrl = `https://cr.minzdrav.gov.ru/recomend/${encodeURIComponent(codeVer)}`;

    return {
      id: item.Id,
      codeVersion: codeVer,
      code: item.Code,
      version: item.Version,
      title: item.Name || 'Клиническая рекомендация',
      year,
      publishDate: item.PublishDateStr || item.CreatedStr || null,
      ageCategory: item.AgeCategoryStr || 'Взрослые, дети',
      mkbCodes: mkbs,
      developers,
      pdfUrl,
      webUrl,
    };
  });

  return {
    total,
    page: Number(data.CurrentPage) || page,
    pageSize,
    items,
  };
}

/**
 * Скачать официальный PDF клинической рекомендации по её коду версии (например, '132_2')
 * @param {string} codeVersion
 * @returns {Promise<Blob>}
 */
export async function fetchMinzdravPdfBlob(codeVersion) {
  if (!codeVersion) throw new Error('Не указан идентификатор клинической рекомендации');

  const resp = await fetchWithFallback(`api.ashx?op=GetClinrecPdf&id=${encodeURIComponent(codeVersion)}`);
  const blob = await resp.blob();

  if (!blob || blob.size < 1000) {
    throw new Error('Файл PDF пуст или поврежден на сервере Минздрава');
  }

  // Проверяем сигнатуру PDF
  const slice = await blob.slice(0, 5).text();
  if (!slice.startsWith('%PDF')) {
    const errorText = await blob.slice(0, 300).text();
    console.error('Некорректный ответ PDF:', errorText);
    throw new Error('Сервер Минздрава вернул ошибку вместо файла PDF');
  }

  return blob;
}

/**
 * Проверить, скачана ли уже данная рекомендация в локальное хранилище
 * @param {string} codeVersion
 * @param {string} title
 * @param {Array} catalogData
 * @returns {Object|null}
 */
export function findDownloadedCr(codeVersion, title, catalogData = []) {
  if (!Array.isArray(catalogData)) return null;
  const cleanTitle = (title || '').trim().toLowerCase();
  const cleanCode = (codeVersion || '').trim().toLowerCase();

  return catalogData.find((m) => {
    if (m.targetSection !== 'cr-rf' && m.source?.book_id !== 'cr-rf') return false;
    const mTitle = (m.title || '').toLowerCase();
    if (cleanCode && (mTitle.includes(`кр_${cleanCode}`) || (m.codeVersion && m.codeVersion.toLowerCase() === cleanCode))) {
      return true;
    }
    if (cleanTitle && mTitle === cleanTitle) {
      return true;
    }
    return false;
  }) || null;
}
