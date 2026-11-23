/**
 * Оффлайн поисковый движок прототипа 2.
 * Индексирует не только статьи, но и отдельные страницы визуального учебника:
 * результат поиска содержит номер страницы и сниппет, а переход открывает
 * нужный фрагмент оригинала.
 */

const MEDICAL_SYNONYMS = {
  'омл': ['острый миелоидный лейкоз', 'aml'],
  'олл': ['острый лимфобластный лейкоз', 'all'],
  'хмл': ['хронический миелолейкоз', 'cml', 'филадельфийская', 'bcr-abl', 't(9;22)'],
  'опл': ['острый промиелоцитарный лейкоз', 't(15;17)', 'pml-rara', 'весаноид', 'атра'],
  'ттп': ['тромботическая тромбоцитопеническая пурпура', 'мошковиц', 'adamts13', 'шизоциты'],
  'итп': ['иммунная тромбоцитопения', 'верльгоф'],
  'двс': ['диссеминированное внутрисосудистое свертывание', 'двс-синдром'],
  'мдс': ['миелодиспластический синдром', 'mds'],
  'мм': ['множественная миелома', 'миеломная болезнь', 'бенс-джонс', 'парапротеин', 'crab', 'slim'],
  'лх': ['лимфома ходжкина', 'лимфогранулематоз', 'рид-березовский-штернберг'],
  'нхл': ['неходжкинские лимфомы', 'диффузная крупноклеточная'],
  'жда': ['железодефицитная анемия', 'ферритин', 'ожсс'],
  'в12': ['b12', 'мегалобластная анемия', 'пернициозная анемия'],
  'пнг': ['пароксизмальная ночная гемоглобинурия', 'экулизумаб'],
  'ачн': ['абсолютное число нейтрофилов', 'нейтропения', 'агранулоцитоз', 'anc'],
  'бса': ['bsa', 'площадь поверхности тела'],
  'сло': ['синдром лизиса опухоли', 'лизис опухоли', 'расбуриказа', 'аллопуринол', 'cairo-bishop'],
  'фн': ['фебрильная нейтропения', 'нейтропеническая лихорадка', 'mascc', 'цефепим'],
  'гит': ['гепарин-индуцированная тромбоцитопения', 'hit', '4t', 'шкала 4t', 'фондапаринукс'],
  'hit': ['гепарин-индуцированная тромбоцитопения', 'гит', '4t', 'шкала 4t'],
  '4t': ['шкала 4t', 'гепарин-индуцированная тромбоцитопения', 'гит', 'hit'],
  'экстравазация': ['экстравазация', 'везиканты', 'доксорубицин', 'винкристин', 'дмсо', 'гиалуронидаза']
};

export class HematologySearchEngine {
  constructor() {
    this.items = [];
    this.units = []; // { item, page, text } — статья или отдельная страница
    this.index = new Map();
  }

  normalize(str) {
    if (!str) return '';
    return str
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s\(\)\:\;\-\+\/\.\,]/gi, ' ')
      .trim();
  }

  tokenize(text) {
    const norm = this.normalize(text);
    return norm.split(/[\s,.;:()\/+-]+/).filter(t => t.length > 1);
  }

  loadData(items) {
    this.items = items;
    this.index.clear();
    this.units = [];

    const addTokens = (text, weight, unitIdx) => {
      if (!text) return;
      this.tokenize(text).forEach(t => {
        if (!this.index.has(t)) this.index.set(t, []);
        this.index.get(t).push({ unitIdx, weight });
      });
    };

    items.forEach((item) => {
      const pages = Array.isArray(item.search_pages) ? item.search_pages : [];

      if (pages.length) {
        // Визуальная книга: индексируем каждую страницу отдельно
        pages.forEach(p => {
          const idx = this.units.push({ item, page: p.page, text: p.text || '' }) - 1;
          addTokens(p.text, 4, idx);
          addTokens(item.title, 3, idx);
          if (item.tags) addTokens(item.tags.join(' '), 1, idx);
        });
        return;
      }

      // Обычная статья (например, протокол неотложки) или старый формат catalog
      const idx = this.units.push({ item, page: null, text: item.search_text || '' }) - 1;
      addTokens(item.title, 20, idx);
      if (item.icd10) addTokens(item.icd10.join(' '), 15, idx);
      if (item.tags) addTokens(item.tags.join(' '), 12, idx);
      if (item.quick_facts) addTokens(item.quick_facts.join(' '), 4, idx);
      if (item.category) addTokens(item.category, 3, idx);
      if (item.content_markdown) addTokens(item.content_markdown, 1, idx);
      if (item.search_text) addTokens(item.search_text, 4, idx);
    });
  }

  makeSnippet(text, tokens, length = 150) {
    if (!text) return '';
    const norm = this.normalize(text);
    let pos = -1;
    for (const t of tokens) {
      const i = norm.indexOf(t);
      if (i >= 0) { pos = i; break; }
    }
    if (pos < 0) pos = 0;
    const start = Math.max(0, pos - 40);
    const slice = text.slice(start, start + length).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + slice + (start + length < text.length ? '…' : '');
  }

  search(query, categoryFilter = 'all', bookFilter = 'all') {
    const matchesFilters = (item) => {
      if (categoryFilter !== 'all') {
        if (categoryFilter === 'toc' && item.type !== 'toc') return false;
        if (categoryFilter !== 'toc' && item.type !== categoryFilter) return false;
      }
      if (bookFilter !== 'all') {
        const itemBookId = item.source?.book_id || '';
        if (itemBookId !== bookFilter) return false;
      }
      return true;
    };

    if (!query || !query.trim()) {
      return this.items.filter(matchesFilters).map(item => ({
        item, score: 1, page: null, snippet: ''
      }));
    }

    const rawTokens = this.tokenize(query);
    if (rawTokens.length === 0) return [];

    const unitScores = new Map();

    rawTokens.forEach(token => {
      for (const [indexWord, postings] of this.index.entries()) {
        let matchWeight = 0;
        if (indexWord === token) matchWeight = 3.0;
        else if (indexWord.startsWith(token) && token.length >= 3) matchWeight = 1.2;
        if (!matchWeight) continue;
        postings.forEach(({ unitIdx, weight }) => {
          unitScores.set(unitIdx, (unitScores.get(unitIdx) || 0) + weight * matchWeight);
        });
      }
    });

    rawTokens.forEach(token => {
      const synonyms = MEDICAL_SYNONYMS[token.toLowerCase()] || [];
      synonyms.forEach(syn => {
        this.tokenize(syn).forEach(st => {
          (this.index.get(st) || []).forEach(({ unitIdx, weight }) => {
            unitScores.set(unitIdx, (unitScores.get(unitIdx) || 0) + weight * 0.4);
          });
        });
      });
    });

    let results = [];
    for (const [unitIdx, score] of unitScores.entries()) {
      const unit = this.units[unitIdx];
      if (!matchesFilters(unit.item)) continue;
      results.push({ item: unit.item, page: unit.page, score, text: unit.text });
    }
    results.sort((a, b) => b.score - a.score);

    // Не засорять выдачу десятками страниц одной главы
    const perArticle = new Map();
    results = results.filter(r => {
      if (r.page == null) return true;
      const key = r.item.id;
      const used = perArticle.get(key) || 0;
      if (used >= 2) return false;
      perArticle.set(key, used + 1);
      return true;
    });

    if (results.length) {
      const topScore = results[0].score;
      results = results.filter(r => r.score >= topScore * 0.12);
    }

    return results.slice(0, 30).map(r => ({
      item: r.item,
      page: r.page,
      score: r.score,
      snippet: this.makeSnippet(r.text, rawTokens)
    }));
  }
}
