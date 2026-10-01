const defaultTitlePattern = /^нов(?:ый|ая)\s+(?:чат|диалог)(?:\s+\d+)?$/iu;

const cleanTitle = (value) => String(value || '')
  .replace(/[*_`~>#]/g, '')
  .replace(/[«»“”"']/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?,;:—-]+$/u, '')
  .trim();

const shorten = (value, maxLength = 64) => {
  if (value.length <= maxLength) return value;
  const fragment = value.slice(0, maxLength - 1);
  const lastSpace = fragment.lastIndexOf(' ');
  return `${fragment.slice(0, lastSpace >= 32 ? lastSpace : fragment.length).trim()}…`;
};

export function isAutomaticConversationTitle(conversation) {
  if (conversation.titleSource) return conversation.titleSource === 'AUTO';
  return defaultTitlePattern.test(String(conversation.title || '').trim());
}

export function fallbackConversationTitle(question) {
  let cleaned = cleanTitle(question) || 'Общий вопрос';
  cleaned = cleaned.replace(/^(?:привет|добрый\s+(?:день|вечер|утро))[,!\s]*/iu, '').trim();
  cleaned = cleaned.replace(/^(?:подскажи(?:те)?|скажите)(?:\s*,?\s*пожалуйста)?[,!:]?\s*/iu, '').trim();

  const overview = cleaned.match(/^(?:расскажи(?:те)?(?:\s+мне)?(?:\s+подробнее)?\s+(?:про|о|об)|что\s+(?:такое|за\s+(?:тема|продукт)))\s+(.+)$/iu);
  if (overview) cleaned = `${overview[1]}: общая информация`;

  const usage = cleaned.match(/^(?:можно\s+ли\s+)?(?:применять|использовать)\s+(.+?)\s+при\s+(.+)$/iu);
  if (usage) cleaned = `${usage[1]} при ${usage[2]}`;

  const administration = cleaned.match(/^(?:как|когда)\s+(?:применять|использовать)\s+(.+)$/iu);
  if (administration) cleaned = `Использование ${administration[1]}`;

  const limitations = cleaned.match(/^(?:какие\s+)?ограничения\s+(?:у|для)\s+(.+)$/iu);
  if (limitations) cleaned = `${limitations[1]}: ограничения`;

  cleaned = cleaned ? `${cleaned[0].toLocaleUpperCase('ru-RU')}${cleaned.slice(1)}` : 'Общий вопрос';
  return shorten(cleaned);
}

export function normalizeGeneratedTitle(value, fallback) {
  const firstLine = String(value || '').split(/\r?\n/u).find((line) => line.trim()) || '';
  const cleaned = cleanTitle(firstLine.replace(/^заголовок\s*:\s*/iu, ''));
  return shorten(cleaned || fallbackConversationTitle(fallback));
}
