import { useState } from 'react';
import { Check, X, Send, RotateCcw } from 'lucide-react';
import { post } from './api';
import type { ReviewTask, User } from './types';

// Existing review surface extension: votes, deadline, then an explicit delivery decision.
export function DiscussionPanel({ task, user, onChange, onReturn }: {
  task: ReviewTask; user: User; onChange: () => Promise<void>; onReturn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = task.discussion;
  if (!d || task.status !== 'DISCUSSION') return null;
  const expired = Date.now() >= Date.parse(d.deadlineAt);
  const canConfirm = Boolean(user.permissions?.includes('reviews.manage')) && (d.proposedBy === user.id || user.role === 'ADMIN');
  const canVote = !expired && Boolean(user.permissions?.includes('reviews.manage')) && ['EXPERT', 'SPECIALIST', 'ADMIN'].includes(user.role)
    && d.proposedBy !== user.id && task.representativeId !== user.id;
  const ownVote = d.votes.find((v) => v.userId === user.id)?.value;
  const send = async (action: string, value?: string) => {
    if (action === 'confirm-early' && !window.confirm(`Отправить текущую версию сотруднику сейчас? За: ${d.yes}, против: ${d.no}. Ответ уйдёт независимо от голосов против.`)) return;
    setBusy(true); setError('');
    try { await post(`/api/reviews/${task.id}/${action}`, { version: d.version, value }); await onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="review-block discussion-panel" aria-label="Коллективное обсуждение">
    <h3>Коллективное обсуждение · версия {d.version}</h3>
    <p>Ответ предложил: <strong>{d.proposedName}</strong>. Сотрудник пока не получил ответ.</p>
    <p>{expired ? `Голосование завершилось ${new Date(d.deadlineAt).toLocaleString('ru-RU')}. При большинстве «за» ответ отправляется автоматически; иначе остаётся на обсуждении.`
      : `Голосование до ${new Date(d.deadlineAt).toLocaleString('ru-RU')}. Через 24 часа ответ отправится, только если «за» больше, чем «против».`}</p>
    <div className="discussion-votes" aria-label="Результаты голосования">
      <span><Check size={18} /> За: {d.yes}</span><span><X size={18} /> Против: {d.no}</span>
    </div>
    {canVote && <div className="discussion-buttons">
      <button className="button secondary" aria-pressed={ownVote === 'YES'} disabled={busy} onClick={() => send('vote', 'YES')}><Check size={18} /> За{ownVote === 'YES' ? ' · ваш голос' : ''}</button>
      <button className="button secondary" aria-pressed={ownVote === 'NO'} disabled={busy} onClick={() => send('vote', 'NO')}><X size={18} /> Против{ownVote === 'NO' ? ' · ваш голос' : ''}</button>
    </div>}
    <p className="muted">Замечания оставляйте во внутренних комментариях. После правки и повторной отправки на обсуждение начинается новая версия и новый срок голосования.</p>
    {!!d.votes.length && <details><summary>Кто проголосовал</summary><ul>{d.votes.map((v) => <li key={v.userId}>{v.name}: {v.value === 'YES' ? 'за' : 'против'}</li>)}</ul></details>}
    {canConfirm && <div className="discussion-buttons">
      <button className="button secondary" disabled={busy} onClick={onReturn}><RotateCcw size={17} /> Вернуть на доработку</button>
      <button className="button primary" disabled={busy} onClick={() => send('confirm-early')}><Send size={17} /> Согласовать преждевременно</button>
    </div>}
    {error && <p className="error-notice" role="alert">{error}</p>}
  </section>;
}
