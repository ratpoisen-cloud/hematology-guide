# Прокси-воркер Рубрикатора КР Минздрава РФ (Cloudflare Worker)

Этот Cloudflare Worker предназначен для проксирования запросов к официальному API Рубрикатора клинических рекомендаций Минздрава РФ (`https://apicr.minzdrav.gov.ru/`).

## Возможности
1. **Обход CORS и смешанного контента**: Добавляет заголовки `Access-Control-Allow-Origin: *`.
2. **Кэширование на границе сети (Edge Cache)**:
   - PDF-файлы кэшируются на 24 часа.
   - Поисковые запросы кэшируются на 1 час.
3. **Маршруты**:
   - `POST /api/search` или `?op=GetJsonClinrecsFilterV2` — поиск по реестру КР.
   - `GET /api/pdf?id={code_version}` — загрузка официального PDF документа.
   - `GET /api/rec?id={code_version}` — получение структурированного JSON документа.

## Быстрый деплой (бесплатно на Cloudflare)
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

После деплоя вы получите URL вида: `https://minzdrav-cr-proxy.<ваша-учетка>.workers.dev`.

## Подключение в приложении
В веб-приложении адрес прокси настраивается автоматически (прямой доступ к `apicr.minzdrav.gov.ru` работает нативно с поддержкой CORS), либо через ключ в консоли:
```javascript
localStorage.setItem('gem_cr_proxy_url', 'https://minzdrav-cr-proxy.<ваша-учетка>.workers.dev');
```
