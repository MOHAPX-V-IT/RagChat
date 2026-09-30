import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BellRing, Check, CheckCircle2, Clock3, Download, RefreshCw, Search, Send, Smartphone, TimerReset, Trash2 } from 'lucide-react';
import { api, download, post, remove } from './api';
import type { ReviewTask } from './types';
import type { User } from './types';

const minuteText = (value?: number | null) => {
  if (value == null) return '—';
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 60) return `${rounded} мин`;
  return `${Math.floor(rounded / 60)} ч ${rounded % 60} мин`;
};

export function SlaBadge({ task, detailed = false }: { task: ReviewTask; detailed?: boolean }) {
  const timing = task.timing;
  if (!timing) return null;
  if (task.status === 'DISCUSSION') return <span className="sla-badge"><Clock3 size={14} /> Обсуждение · 24 ч</span>;
  const done = task.status === 'DELIVERED';
  const value = done ? timing.totalMinutes : timing.slaRemainingMinutes;
  return <span className={`sla-badge sla-${timing.slaState.toLowerCase()}`} title={`Регламент: ${timing.slaMinutes} мин`}>
    <Clock3 size={14} /> {done ? `Итого ${minuteText(value)}` : timing.slaState === 'BREACHED' ? `Просрочен на ${minuteText(Math.abs(value || 0))}` : `${minuteText(value)} до SLA`}
    {detailed && <small>{task.priority === 'CRITICAL' ? 'Критический' : task.priority === 'URGENT' ? 'Срочный' : 'Обычный'}</small>}
  </span>;
}

const stageOrder = [
  { id: 'GENERATING', label: 'ИИ формирует черновик', stages: ['AI_STARTED'] },
  { id: 'WAITING_REVIEW', label: 'Ожидает эксперта', stages: ['AI_READY', 'AI_DEGRADED'] },
  { id: 'IN_REVIEW', label: 'Эксперт проверяет', stages: ['REVIEW_STARTED'] },
  { id: 'DISCUSSION', label: 'Коллективное обсуждение', stages: ['DISCUSSION_STARTED'] },
  { id: 'DELIVERED', label: 'Ответ готов', stages: ['ANSWER_DELIVERED'] },
];

export function ProcessTimeline({ task }: { task: ReviewTask | null }) {
  if (!task) return null;
  const activeIndex = stageOrder.findIndex((stage) => stage.id === task.status);
  const history = task.stageHistory || [];
  return <section className="process-panel" aria-label="Этапы обработки вопроса">
    <div className="process-track">
      {stageOrder.map((stage, index) => {
        const event = [...history].reverse().find((item) => stage.stages.includes(item.stage));
        const complete = Boolean(event) || task.status === 'DELIVERED' || index < activeIndex;
        const active = stage.id === task.status;
        return <div className={`process-step ${complete ? 'complete' : ''} ${active ? 'active' : ''}`} key={stage.id}>
          <span>{complete ? <Check size={14} /> : index + 1}</span>
          <div><strong>{stage.label}</strong><small>{event ? new Date(event.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : active ? 'Сейчас' : complete ? 'Завершено' : 'Далее'}</small></div>
        </div>;
      })}
    </div>
    {task.status === 'DISCUSSION' ? <p>Идёт обсуждение. Срок голосования — 24 часа; отправка зависит от результата или решения автора ответа.</p> : task.status !== 'DELIVERED' && <p><TimerReset size={15} /> Примерное ожидание: {minuteText(task.estimatedWaitMinutes)}. Расчёт основан на завершённых вопросах.</p>}
  </section>;
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

export function PushNotificationControl() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [state, setState] = useState<'loading' | 'unsupported' | 'unconfigured' | 'disabled' | 'enabled'>('loading');
  const [error, setError] = useState('');

  const inspect = useCallback(async () => {
    if (!supported) return setState('unsupported');
    const config = await api<{ configured: boolean }>('/api/push/config');
    if (!config.configured) return setState('unconfigured');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return setState('disabled');
    await post('/api/push/subscribe', { subscription: subscription.toJSON() });
    setState('enabled');
  }, [supported]);
  useEffect(() => { inspect().catch((requestError) => { setError(requestError.message); setState('disabled'); }); }, [inspect]);

  const enable = async () => {
    setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешите уведомления в настройках браузера.');
      const config = await api<{ configured: boolean; publicKey?: string }>('/api/push/config');
      if (!config.publicKey) throw new Error('Администратор ещё не настроил Web Push.');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
      await post('/api/push/subscribe', { subscription: subscription.toJSON() });
      setState('enabled');
    } catch (requestError) { setError((requestError as Error).message); }
  };

  if (state === 'loading') return null;
  return <div className={`push-control ${state}`}>
    <BellRing size={17} />
    <div><strong>{state === 'enabled' ? 'Уведомления включены' : state === 'unconfigured' ? 'Web Push не настроен' : state === 'unsupported' ? 'Браузер не поддерживает Push' : 'Получать уведомления'}</strong>{error && <small>{error}</small>}</div>
    {state === 'disabled' && <button onClick={enable}>Включить</button>}
  </div>;
}

type PushDevice = {
  id: string;
  deviceName: string;
  browser: string;
  platform: string;
  endpointHint: string;
  createdAt?: string | null;
  lastSeenAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastError?: string | null;
};

type PushUser = User & { devices: PushDevice[] };

const pushDate = (value?: string | null) => value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';

export function PushDevicesPanel() {
  const [users, setUsers] = useState<PushUser[]>([]);
  const [configured, setConfigured] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const data = await api<{ configured: boolean; users: PushUser[] }>('/api/admin/push/devices');
    setConfigured(data.configured); setUsers(data.users);
  }, []);
  useEffect(() => { load().catch((requestError) => setError(requestError.message)); }, [load]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru');
    return query ? users.filter((user) => `${user.firstName} ${user.lastName} ${user.email} ${user.role}`.toLocaleLowerCase('ru').includes(query)) : users;
  }, [search, users]);
  const deviceCount = users.reduce((total, user) => total + user.devices.length, 0);
  const test = async (user: PushUser) => {
    setBusy(`test:${user.id}`); setError(''); setNotice('');
    try {
      const result = await post<{ delivery: { delivered: number; failed: number } }>('/api/admin/push/test', { userId: user.id });
      setNotice(result.delivery.delivered ? `Тестовый push отправлен: ${user.firstName} ${user.lastName}.` : `Push не доставлен. Ошибок: ${result.delivery.failed}.`);
      await load();
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(''); }
  };
  const removeDevice = async (user: PushUser, device: PushDevice) => {
    if (!window.confirm(`Удалить регистрацию «${device.deviceName}» у ${user.firstName} ${user.lastName}?`)) return;
    setBusy(`remove:${device.id}`); setError('');
    try { await remove(`/api/admin/push/devices/${encodeURIComponent(user.id)}/${encodeURIComponent(device.id)}`); await load(); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(''); }
  };
  return <section className="push-devices-panel">
    {error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <div className="inline-success" role="status">{notice}</div>}
    <div className="push-devices-heading"><div><h2>Push-устройства</h2><p>Регистрации PWA, состояние доставки и тест уведомлений по каждому сотруднику.</p></div><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button></div>
    <div className="push-devices-summary"><span className={configured ? 'configured' : 'unconfigured'}><i />{configured ? 'Web Push настроен' : 'VAPID-ключи не настроены'}</span><strong>{deviceCount}</strong><small>зарегистрированных устройств</small></div>
    <label className="search-field push-device-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти сотрудника по имени или почте" /></label>
    <div className="push-user-list">
      {filtered.map((user) => <section className="push-user-row" key={user.id}><div className="push-user-identity"><span>{user.firstName[0]}{user.lastName[0]}</span><div><strong>{user.firstName} {user.lastName}</strong><small>{user.email}</small></div></div><div className="push-user-devices">{user.devices.length ? user.devices.map((device) => <div className="push-device-row" key={device.id}><Smartphone size={18} /><div><strong>{device.deviceName}</strong><span>{device.platform} · {device.endpointHint}</span><small>Синхронизация: {pushDate(device.lastSeenAt)}{device.lastSuccessAt ? ` · доставка: ${pushDate(device.lastSuccessAt)}` : ''}</small>{device.lastError && <small className="push-device-error">Ошибка: {device.lastError}</small>}</div><button className="icon-button danger-icon" disabled={Boolean(busy)} onClick={() => removeDevice(user, device)} aria-label={`Удалить ${device.deviceName}`}><Trash2 size={16} /></button></div>) : <div className="push-device-empty"><BellRing size={17} /><span>PWA не зарегистрировано на сервере</span></div>}</div><button className="button secondary compact push-test-button" disabled={!configured || !user.devices.length || Boolean(busy)} onClick={() => test(user)}>{busy === `test:${user.id}` ? <RefreshCw className="spin" size={15} /> : <Send size={15} />} Тест push</button></section>)}
      {!filtered.length && <div className="table-empty"><Search size={22} /><strong>Сотрудники не найдены</strong><span>Измените поисковый запрос.</span></div>}
    </div>
  </section>;
}

type Analytics = {
  totals: { questions: number; delivered: number; active: number; overdue: number };
  sla: { averageMinutes: number; medianMinutes: number; p90Minutes: number; p95Minutes: number; withinTargetPercent: number };
  stages: { generationAverageMinutes: number; queueAverageMinutes: number; reviewAverageMinutes: number };
  llm: { calls: number; averageLatencyMs: number; timeouts: number; emptyAnswers: number; retries: number; promptTokens: number; completionTokens: number; estimatedCostRub: number; costConfigured: boolean };
  experts: Array<{ id: string; name: string; email: string; status: string; workload: number; completed: number; averageReviewMinutes: number; specialties: string[]; products: string[] }>;
  products: string[];
  delayReasons: Array<{ reason: string; count: number }>;
};

export function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [product, setProduct] = useState('');
  const [expertId, setExpertId] = useState('');
  const [representativeId, setRepresentativeId] = useState('');
  const [experts, setExperts] = useState<User[]>([]);
  const [representatives, setRepresentatives] = useState<User[]>([]);
  const [error, setError] = useState('');
  const params = useMemo(() => { const value = new URLSearchParams(); if (dateFrom) value.set('dateFrom', dateFrom); if (dateTo) value.set('dateTo', dateTo); if (product) value.set('productName', product); if (expertId) value.set('expertId', expertId); if (representativeId) value.set('representativeId', representativeId); return value; }, [dateFrom, dateTo, product, expertId, representativeId]);
  const load = useCallback(() => api<{ analytics: Analytics; experts: User[]; representatives: User[] }>(`/api/admin/analytics?${params}`).then((data) => { setAnalytics(data.analytics); setExperts(data.experts); setRepresentatives(data.representatives); }), [params]);
  useEffect(() => { load().catch((requestError) => setError(requestError.message)); }, [load]);
  const exportFile = () => download(`/api/admin/analytics/export.xlsx?${params}`, `ragchat-analytics-${new Date().toISOString().slice(0, 10)}.xlsx`).catch((requestError) => setError(requestError.message));
  if (!analytics) return <div className="page-loader">{error || 'Собираем аналитику…'}</div>;
  const stageTotal = Math.max(1, analytics.stages.generationAverageMinutes + analytics.stages.queueAverageMinutes + analytics.stages.reviewAverageMinutes);
  return <section className="content-page analytics-page">
    {error && <div className="inline-error">{error}</div>}
    <header className="page-heading"><div><h1>Аналитика обработки</h1><p>Время, SLA, нагрузка экспертов и фактическая работа RAG и модели ИИ.</p></div><button className="button primary" onClick={exportFile}><Download size={16} /> Экспорт XLSX</button></header>
    <div className="analytics-filters"><label>С<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>По<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label><select value={product} onChange={(event) => setProduct(event.target.value)}><option value="">Все темы</option>{analytics.products.map((item) => <option key={item}>{item}</option>)}</select><select value={representativeId} onChange={(event) => setRepresentativeId(event.target.value)}><option value="">Все сотрудники</option>{representatives.map((user) => <option key={user.id} value={user.id}>{user.firstName} {user.lastName}</option>)}</select><select value={expertId} onChange={(event) => setExpertId(event.target.value)}><option value="">Все эксперты</option>{experts.map((user) => <option key={user.id} value={user.id}>{user.firstName} {user.lastName}</option>)}</select><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button></div>
    <div className="analytics-ledger"><div><span>Всего вопросов</span><strong>{analytics.totals.questions}</strong></div><div><span>В работе сейчас</span><strong>{analytics.totals.active}</strong></div><div className={analytics.totals.overdue ? 'danger' : ''}><span>Просрочено</span><strong>{analytics.totals.overdue}</strong></div><div><span>В SLA</span><strong>{analytics.sla.withinTargetPercent}%</strong></div></div>
    <div className="analytics-split">
      <section className="analytics-section"><div className="section-heading"><h2>Распределение времени</h2><span>среднее</span></div><div className="stage-bar"><span style={{ width: `${analytics.stages.generationAverageMinutes / stageTotal * 100}%` }} /><span style={{ width: `${analytics.stages.queueAverageMinutes / stageTotal * 100}%` }} /><span style={{ width: `${analytics.stages.reviewAverageMinutes / stageTotal * 100}%` }} /></div><dl className="stage-legend"><div><dt>Генерация ИИ</dt><dd>{minuteText(analytics.stages.generationAverageMinutes)}</dd></div><div><dt>Ожидание эксперта</dt><dd>{minuteText(analytics.stages.queueAverageMinutes)}</dd></div><div><dt>Проверка</dt><dd>{minuteText(analytics.stages.reviewAverageMinutes)}</dd></div></dl></section>
      <section className="analytics-section"><div className="section-heading"><h2>SLA</h2><span>по доставленным</span></div><dl className="percentile-grid"><div><dt>Среднее</dt><dd>{minuteText(analytics.sla.averageMinutes)}</dd></div><div><dt>Медиана</dt><dd>{minuteText(analytics.sla.medianMinutes)}</dd></div><div><dt>P90</dt><dd>{minuteText(analytics.sla.p90Minutes)}</dd></div><div><dt>P95</dt><dd>{minuteText(analytics.sla.p95Minutes)}</dd></div></dl></section>
    </div>
    <section className="analytics-section"><div className="section-heading"><h2>Работа модели</h2><span>{analytics.llm.calls} обращений</span></div><div className="llm-ledger"><div><span>Средняя длительность</span><strong>{Math.round(analytics.llm.averageLatencyMs / 100) / 10} c</strong></div><div><span>Токены</span><strong>{(analytics.llm.promptTokens + analytics.llm.completionTokens).toLocaleString('ru-RU')}</strong></div><div><span>Повторные генерации</span><strong>{analytics.llm.retries}</strong></div><div><span>Тайм-ауты / пустые</span><strong>{analytics.llm.timeouts} / {analytics.llm.emptyAnswers}</strong></div><div><span>Расчётная стоимость</span><strong>{analytics.llm.costConfigured ? `${analytics.llm.estimatedCostRub} ₽` : 'тариф не задан'}</strong></div></div></section>
    <section className="analytics-section"><div className="section-heading"><h2>Нагрузка экспертов</h2><span>{analytics.experts.length}</span></div><div className="table-wrap"><table className="queue-table"><thead><tr><th>Эксперт</th><th>Статус</th><th>Сейчас</th><th>Завершено</th><th>Средняя проверка</th><th>Профиль</th></tr></thead><tbody>{analytics.experts.map((expert) => <tr key={expert.id}><td><strong>{expert.name}</strong><small className="table-subline">{expert.email}</small></td><td>{expert.status === 'AVAILABLE' ? 'Доступен' : expert.status === 'BUSY' ? 'В работе' : 'Не беспокоить'}</td><td>{expert.workload}</td><td>{expert.completed}</td><td>{minuteText(expert.averageReviewMinutes)}</td><td>{[...expert.products, ...expert.specialties].join(', ') || 'Общий профиль'}</td></tr>)}</tbody></table></div></section>
    <section className="analytics-section"><div className="section-heading"><h2>Причины задержек</h2><span>{analytics.delayReasons.reduce((sum, item) => sum + item.count, 0)}</span></div>{analytics.delayReasons.length ? <div className="delay-list">{analytics.delayReasons.map((item) => <div key={item.reason}><AlertTriangle size={16} /><span>{item.reason}</span><strong>{item.count}</strong></div>)}</div> : <div className="analytics-empty"><CheckCircle2 size={20} /> Просроченных вопросов в выборке нет.</div>}</section>
  </section>;
}

export function EvidencePanel({ task }: { task: ReviewTask }) {
  const evidence = task.ragMeta?.evidenceMap || [];
  const rawContradictions = task.ragMeta?.contradictions;
  const contradictions = Array.isArray(rawContradictions) ? rawContradictions : rawContradictions ? [rawContradictions] : [];
  if (!evidence.length && !contradictions.length) return null;
  return <section className="review-block evidence-panel mobile-hidden-review-context"><h3>Проверка утверждений по источникам</h3>{contradictions.length > 0 && <div className="contradiction-note"><AlertTriangle size={18} /><div><strong>Нужно проверить противоречия</strong>{contradictions.map((item, index) => <p key={`${item.claim || item.message}-${index}`}>{item.claim ? `${item.claim}: ` : ''}{item.reason || item.message}</p>)}</div></div>}<div className="evidence-list">{evidence.map((item, index) => { const sourceIds = item.sourceIds || item.sources?.map((source) => source.sourceId).filter(Boolean) as string[] | undefined || []; return <div className={item.supported ? 'supported' : 'unsupported'} key={`${item.id || item.claim || item.text}-${index}`}><span>{item.supported ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}</span><p>{item.claim || item.text}</p><small>{item.supported ? `Источники: ${sourceIds.join(', ') || 'найдены'}` : 'Источник для утверждения не найден'}</small></div>; })}</div></section>;
}
