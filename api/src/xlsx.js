import writeExcelFile from 'write-excel-file/node';

const header = (values) => values.map((value) => ({ value, fontWeight: 'bold', color: '#FFFFFF', backgroundColor: '#1D6043', alignVertical: 'center' }));
const cell = (value) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value;
const sheet = (name, headings, rows, widths) => ({
  sheet: name,
  data: [header(headings), ...rows.map((row) => row.map(cell))],
  columns: widths.map((width) => ({ width })),
  stickyRowsCount: 1,
  showGridLines: false,
});

export async function analyticsWorkbook(analytics, auditEvents = []) {
  const rows = [
    ['Всего вопросов', analytics.totals.questions], ['Доставлено', analytics.totals.delivered], ['Активно', analytics.totals.active],
    ['Просрочено', analytics.totals.overdue], ['Среднее время, мин', analytics.sla.averageMinutes], ['Медиана, мин', analytics.sla.medianMinutes],
    ['P90, мин', analytics.sla.p90Minutes], ['P95, мин', analytics.sla.p95Minutes], ['В SLA, %', analytics.sla.withinTargetPercent],
    ['Генерация ИИ, среднее мин', analytics.stages.generationAverageMinutes], ['Ожидание эксперта, среднее мин', analytics.stages.queueAverageMinutes],
    ['Проверка, среднее мин', analytics.stages.reviewAverageMinutes], ['LLM/RAG вызовов', analytics.llm.calls], ['Средняя задержка LLM/RAG, мс', analytics.llm.averageLatencyMs],
    ['Тайм-ауты', analytics.llm.timeouts], ['Пустые ответы', analytics.llm.emptyAnswers], ['Повторные генерации', analytics.llm.retries],
    ['Входные токены', analytics.llm.promptTokens], ['Выходные токены', analytics.llm.completionTokens], ['Оценочная стоимость, ₽', analytics.llm.costConfigured ? analytics.llm.estimatedCostRub : 'Не настроено'],
  ];
  const expertRows = analytics.experts.map((item) => [item.name, item.email, item.status, item.workload, item.completed, item.averageReviewMinutes, item.specialties.join(', '), item.products.join(', ')]);
  const delayRows = analytics.delayReasons.map((item) => [item.reason, item.count]);
  const auditRows = auditEvents.map((item) => [item.createdAt, item.actorName, item.actorEmail, item.action, item.entityType, item.entityId, item.details || {}]);
  return writeExcelFile([
    sheet('SLA и этапы', ['Показатель', 'Значение'], rows, [42, 22]),
    sheet('Эксперты', ['Эксперт', 'Почта', 'Статус', 'В работе', 'Завершено', 'Среднее время проверки, мин', 'Специализации', 'Темы'], expertRows, [24, 30, 16, 12, 12, 28, 32, 36]),
    sheet('Причины задержек', ['Причина', 'Количество'], delayRows, [52, 16]),
    sheet('Журнал действий', ['Время', 'Пользователь', 'Почта', 'Действие', 'Тип объекта', 'ID объекта', 'Подробности'], auditRows, [24, 28, 30, 30, 20, 28, 52]),
  ], { fontFamily: 'Arial', fontSize: 10 }).toBuffer();
}
