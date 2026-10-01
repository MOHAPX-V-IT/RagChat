import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, RefreshCw, Save, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, patch, post } from './api';
import { DiscussionPanel } from './DiscussionPanel';
import type { Message, ReviewTask, User } from './types';
import './ReviewQuestionPage.css';

const date = (value: string) => new Date(value).toLocaleString('ru-RU');
const statuses = { GENERATING: 'ИИ формирует черновик', WAITING_REVIEW: 'Ожидает эксперта', IN_REVIEW: 'В работе', DISCUSSION: 'На обсуждении', DELIVERED: 'Ответ отправлен' };
const Text = ({ children }: { children: string }) => <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;

// Operate / established green system. A full question page, not a queue overlay:
// question + responsible expert, current round, private editor, named immutable revisions.
export function ReviewQuestionPage({ taskId, user, experts, onBack }: {
  taskId: string; user: User; experts: User[]; onBack: () => void;
}) {
  const [task, setTask] = useState<ReviewTask | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [answer, setAnswer] = useState('');
  const [savedText, setSavedText] = useState('');
  const [baseVersion, setBaseVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [returnMode, setReturnMode] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Array<{id: string; title: string; content: string}>>([]);
  const initialized = useRef(false);
  const requestSeq = useRef(0);
  const pending = useRef(false);
  const key = `ragchat:review-draft:${user.id}:${taskId}`;
  const dirty = answer !== savedText;

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    const data = await api<{task: ReviewTask; history: Message[]}>(`/api/reviews/${taskId}`);
    if (seq !== requestSeq.current) return;
    setTask(data.task); setHistory(data.history);
    if (!initialized.current && data.task.status !== 'GENERATING') {
      const latest = data.task.revisions?.filter((r) => r.authorId === user.id).at(-1);
      const initial = latest?.content || data.task.discussion?.answer || data.task.aiDraft || '';
      let local: {answer?: string; baseVersion?: number} | null = null;
      try { local = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* unavailable browser storage */ }
      setAnswer(local?.answer ?? initial); setSavedText(initial);
      setBaseVersion(local?.baseVersion ?? latest?.baseVersion ?? data.task.discussion?.version ?? 0);
      if (local?.answer != null) setNotice('Восстановлена ваша незавершённая редакция с этого устройства.');
      initialized.current = true;
    }
  }, [taskId, user.id, key]);
  useEffect(() => {
    let mounted = true;
    const reload = () => refresh().catch((e) => { if (mounted) setError(`Не удалось обновить вопрос: ${e.message}`); });
    void reload();
    const timer = window.setInterval(() => { if (!pending.current) void reload(); }, 5000);
    return () => { mounted = false; requestSeq.current++; window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { api<{templates: typeof templates}>('/api/review-templates').then((d) => setTemplates(d.templates)).catch(() => undefined); }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: Event) => { if (dirty && !window.confirm('Редакция ещё не сохранена для коллег. Покинуть страницу? Текст останется на этом устройстве.')) event.preventDefault(); };
    window.addEventListener('beforeunload', unload); window.addEventListener('ragchat:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('ragchat:before-navigate', navigate); };
  }, [dirty]);
  const write = (text: string, version = baseVersion) => {
    setAnswer(text); setBaseVersion(version); setNotice('');
    try { localStorage.setItem(key, JSON.stringify({answer: text, baseVersion: version, updatedAt: new Date().toISOString()})); }
    catch { setError('Браузер не сохранил черновик на устройстве. Сохраните редакцию кнопкой ниже.'); }
  };
  const run = async (action: string, body = {}, method: 'post' | 'patch' = 'post') => {
    if (pending.current) return false;
    pending.current = true; requestSeq.current++; setBusy(true); setError(''); setNotice('');
    try {
      const result = await (method === 'patch' ? patch : post)<{task: ReviewTask}>(`/api/reviews/${taskId}/${action}`, body);
      if (result.task) setTask(result.task);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async () => {
    if (await run('revisions', {content: answer, baseVersion})) {
      setSavedText(answer); try { localStorage.removeItem(key); } catch { /* optional local cache */ }
      setNotice('Редакция сохранена для коллег. Обсуждаемый ответ и голоса не изменились.');
    }
  };
  const select = async (revisionId: string) => {
    if (!task?.discussion || !window.confirm('Заменить обсуждаемый ответ этой редакцией? Голоса будут архивированы, начнётся новое обсуждение на 24 часа.')) return;
    if (await run('select-revision', {revisionId, version: task.discussion.version})) setNotice('Редакция выбрана. Началось новое 24-часовое голосование. Ваша рабочая редакция не изменена.');
  };
  if (!task) return <main className="question-page"><button className="button secondary" onClick={onBack}><ArrowLeft size={18}/>К очереди</button><h1>Вопрос</h1>{error ? <div role="alert"><p>{error}</p><button className="button secondary" onClick={() => refresh().catch((e) => setError(e.message))}>Повторить загрузку</button></div> : <p role="status">Загружаем вопрос…</p>}</main>;
  const manage = Boolean(user.permissions?.includes('reviews.manage'));
  const own = task.representativeId === user.id && user.role !== 'ADMIN';
  const responsible = task.assignedTo || task.discussion?.proposedBy;
  const owner = manage && !own && (responsible === user.id || user.role === 'ADMIN');
  const editable = manage && !own && (['EXPERT', 'SPECIALIST', 'ADMIN'].includes(user.role) || (user.role === 'MANAGER' && owner)) && ['WAITING_REVIEW', 'IN_REVIEW', 'DISCUSSION'].includes(task.status);
  const canClaim = manage && !own && task.status === 'WAITING_REVIEW';
  const eligible = experts.filter((e) => e.isActive && e.id !== task.representativeId && ['EXPERT', 'SPECIALIST'].includes(e.role));
  const current = task.finalAnswer || task.discussion?.answer || task.aiDraft;
  return <main className="question-page" aria-labelledby="question-heading">
    <div className="question-navigation"><button className="button secondary" onClick={onBack}><ArrowLeft size={18}/>К очереди</button><span>{statuses[task.status]}</span><button className="button secondary" disabled={busy} onClick={() => refresh().then(() => setError('')).catch((e) => setError(e.message))}><RefreshCw size={16}/>Обновить</button></div>
    <header className="question-intro"><h1 id="question-heading">{task.question}</h1><dl className="question-facts"><div><dt>Автор вопроса</dt><dd>{task.representative?.name || 'Не указан'}</dd></div><div><dt>Ответственный эксперт</dt><dd>{task.assignedExpert?.name || task.returnExpert && `${task.returnExpert.firstName} ${task.returnExpert.lastName}` || 'Не назначен'}</dd></div><div><dt>Поступил</dt><dd>{date(task.createdAt)}</dd></div></dl><p className="muted">Обсуждение и редакции доступны только команде. Сотрудник получает итоговый ответ.</p></header>
    {error && <div className="error-notice" role="alert">{error}<button className="button secondary" onClick={() => setError('')}>Закрыть сообщение</button></div>}
    {notice && <p className="inline-success" role="status">{notice}</p>}
    {task.returnComment && <p className="question-return"><strong>Комментарий возврата:</strong> {task.returnComment}</p>}
    <div className="question-decision-grid">
      <section className="question-current"><h2>{task.status === 'DELIVERED' ? 'Отправленный ответ' : task.discussion ? `Ответ на обсуждении · версия ${task.discussion.version}` : 'Черновик ИИ'}</h2>{task.discussion?.answerAuthorName && <p className="muted">Выбрана редакция: {task.discussion.answerAuthorName}</p>}<Text>{current || 'Черновик ещё формируется.'}</Text>
        {canClaim && <button className="button primary" disabled={busy} onClick={() => run('claim')}><Check size={18}/>Взять в работу</button>}
        {owner && task.status === 'IN_REVIEW' && <div className="question-actions"><button className="button primary" disabled={busy || !current?.trim()} onClick={() => run('approve')}><Send size={18}/>Черновик на обсуждение</button><button className="button secondary" disabled={busy} onClick={() => setReturnMode(true)}>Вернуть адресату</button></div>}
        {!current && task.status !== 'DELIVERED' && manage && !own && (!task.assignedTo || owner) && <button className="button secondary" disabled={busy} onClick={() => run('regenerate')}>Повторить формирование черновика</button>}
      </section>
      <DiscussionPanel task={task} user={user} onChange={refresh} onReturn={() => setReturnMode(true)}/>
    </div>
    {returnMode && owner && <section className="question-section"><h2>Вернуть вопрос на доработку</h2><label>Эксперт<select value={recipient} onChange={(e) => setRecipient(e.target.value)}><option value="">Выберите эксперта</option>{eligible.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></label><label>Причина возврата<textarea value={reason} onChange={(e) => setReason(e.target.value)}/></label><div className="question-actions"><button className="button danger" disabled={busy || !recipient || reason.trim().length < 3} onClick={async () => { if (await run('return', {expertId: recipient, comment: reason, version: task.discussion?.version})) { setReturnMode(false); setReason(''); } }}>Вернуть адресату</button><button className="button secondary" onClick={() => setReturnMode(false)}>Отмена</button></div></section>}
    {editable && <section className="question-section question-editor"><h2>Моя редакция · {user.firstName} {user.lastName}</h2><p>Каждый эксперт работает со своим текстом. Сохранение добавляет редакцию в список ниже, но не заменяет ответ и не сбрасывает голоса.</p>
      {!!task.discussion && baseVersion !== task.discussion.version && <p className="question-return">Обсуждаемый ответ обновился. Ваша редакция сохранена в редакторе без изменений; сравните её с текущей версией выше.</p>}
      <div className="question-actions"><button className="button secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm('Заменить текст в вашем редакторе текущим обсуждаемым ответом?')) write(current || '', task.discussion?.version || 0); }}>Взять текущий текст за основу</button>{templates.length > 0 && <select aria-label="Вставить шаблон" defaultValue="" disabled={busy} onChange={(e) => { const t = templates.find((t) => t.id === e.target.value); if (t) write(`${answer}\n\n${t.content}`); e.target.value = ''; }}><option value="">Вставить шаблон…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>}</div>
      <label htmlFor="expert-revision">Текст вашей редакции</label><textarea id="expert-revision" className="expert-revision-editor" value={answer} maxLength={50000} disabled={busy} onChange={(e) => write(e.target.value)}/>
      <div className="question-actions"><button className="button primary" disabled={busy || answer.trim().length < 3} onClick={save}><Save size={18}/>{busy ? 'Сохраняем…' : 'Сохранить редакцию'}</button><span className="muted">{dirty ? 'Изменения ещё не сохранены для коллег' : 'Нет несохранённых изменений'}</span></div>
    </section>}
    <section className="question-section"><h2>Редакции <span className="muted">· {task.revisions?.length || 0}</span></h2><p className="muted">Выбирает текущий ответственный эксперт после начала обсуждения. Выбор редакции заменяет ответ и запускает голосование на 24 часа заново.</p>
      {!task.revisions?.length && <p>Пока нет сохранённых редакций.</p>}
      {[...(task.revisions || [])].reverse().map((r) => <article className="question-revision" key={r.id}><details><summary><strong>Редакция {r.authorName}</strong><time>{date(r.createdAt)}</time>{task.discussion?.selectedRevisionId === r.id && <span className="revision-selected"><Check size={16}/>На обсуждении</span>}</summary><Text>{r.content}</Text></details>{owner && task.status === 'DISCUSSION' && <button className="button secondary" disabled={busy || task.discussion?.selectedRevisionId === r.id} onClick={() => select(r.id)}>{task.discussion?.selectedRevisionId === r.id ? 'Текущая редакция' : 'Выбрать для обсуждения'}</button>}</article>)}
    </section>
    <section className="question-section"><h2>Обсуждение команды</h2><div className="question-comments">{task.internalComments?.map((c) => <article key={c.id}><strong>{c.authorName || 'Эксперт'}</strong><time>{date(c.createdAt)}</time><p>{c.text}</p></article>)}{!task.internalComments?.length && <p className="muted">Комментариев пока нет.</p>}</div><label>Комментарий<textarea value={comment} maxLength={3000} disabled={busy} onChange={(e) => setComment(e.target.value)}/></label><details><summary>Упомянуть коллег</summary><div className="question-mentions">{eligible.filter((e) => e.id !== user.id).map((e) => <label key={e.id}><input type="checkbox" checked={mentionIds.includes(e.id)} onChange={(event) => setMentionIds((ids) => event.target.checked ? [...ids, e.id] : ids.filter((id) => id !== e.id))}/>{e.firstName} {e.lastName}</label>)}</div></details><button className="button secondary" disabled={busy || comment.trim().length < 2} onClick={async () => { if (await run('comments', {text: comment, mentionIds})) { setComment(''); setMentionIds([]); } }}>Добавить комментарий</button></section>
    {owner && task.status === 'IN_REVIEW' && <details className="question-section"><summary>Передать вопрос коллеге</summary><label>Новый исполнитель<select value={recipient} onChange={(e) => setRecipient(e.target.value)}><option value="">Выберите коллегу</option>{eligible.filter((e) => e.id !== user.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></label><label>Причина передачи<textarea value={reason} onChange={(e) => setReason(e.target.value)}/></label><button className="button secondary" disabled={busy || !recipient || reason.trim().length < 3} onClick={async () => { if (await run('transfer', {expertId: recipient, comment: reason})) setReason(''); }}>Передать вопрос</button></details>}
    {user.permissions?.includes('reviews.route') && !['DELIVERED', 'DISCUSSION'].includes(task.status) && <details className="question-section"><summary>Маршрутизация и приоритет</summary>{['ADMIN','MANAGER'].includes(user.role) && <label>Направление<select value={task.reviewPool || 'GENERAL'} disabled={busy} onChange={(e) => run('routing', {reviewPool: e.target.value}, 'patch')}><option value="GENERAL">Общая очередь</option><option value="SPECIALIST">Очередь профильных экспертов</option></select></label>}<label>Приоритет<select value={task.priority || 'NORMAL'} disabled={busy} onChange={(e) => run('routing', {priority: e.target.value}, 'patch')}><option value="NORMAL">Обычный</option><option value="URGENT">Срочный</option><option value="CRITICAL">Критический</option></select></label><label>Назначить<select value={task.routedTo || ''} disabled={busy} onChange={(e) => run('routing', {routedTo: e.target.value}, 'patch')}><option value="">Без назначения</option>{eligible.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></label></details>}
    {!!task.responseVersions?.length && <details className="question-section"><summary>История подготовки ответа</summary>{[...task.responseVersions].reverse().map((v) => <details className="question-revision" key={v.id}><summary>{v.type.startsWith('AI_') ? 'Черновик ИИ' : 'Версия эксперта'} · {date(v.createdAt)}</summary><Text>{v.content}</Text></details>)}</details>}
    {history.length > 1 && <details className="question-section"><summary>Контекст диалога</summary>{history.slice(0, -1).map((m) => <p key={m.id}><strong>{m.authorType === 'USER' ? 'Вопрос' : 'Официальный ответ'}:</strong> {m.content}</p>)}</details>}
  </main>;
}
