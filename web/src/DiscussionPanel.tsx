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
  const responsible = task.assignedTo || d.proposedBy;
  const canConfirm = Boolean(user.permissions?.includes('reviews.manage')) && (responsible === user.id || user.role === 'ADMIN') && (task.representativeId !== user.id || user.role === 'ADMIN');
  const canVote = !expired && Boolean(user.permissions?.includes('reviews.manage')) && ['EXPERT', 'SPECIALIST', 'ADMIN'].includes(user.role)
    && responsible !== user.id && d.answerAuthorId !== user.id && task.representativeId !== user.id;
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
    <p>{expired ? 'Голосование завершилось' : 'Голосование до'} {new Date(d.deadlineAt).toLocaleString('ru-RU')}.</p>
    <p>Через 24 часа текущий ответ отправляется, если «за» больше, чем «против»{d.autoReleaseWithoutVotes ? ', или если голосов нет' : ''}. При равенстве ненулевых голосов или большинстве «против» ответ остаётся на обсуждении.</p>
    <div className="discussion-votes" aria-label="Результаты голосования">
      <span><Check size={18} /> За: {d.yes}</span><span><X size={18} /> Против: {d.no}</span>
    </div>
    {canVote && <div className="discussion-buttons">
      <button className="button secondary" aria-pressed={ownVote === 'YES'} disabled={busy} onClick={() => send('vote', 'YES')}><Check size={18} /> За{ownVote === 'YES' ? ' · ваш голос' : ''}</button>
      <button className="button secondary" aria-pressed={ownVote === 'NO'} disabled={busy} onClick={() => send('vote', 'NO')}><X size={18} /> Против{ownVote === 'NO' ? ' · ваш голос' : ''}</button>
    </div>}
    <p className="muted">Выбор другой редакции ответственным экспертом сбрасывает голоса и запускает новые 24 часа.</p>
    {!!d.votes.length && <details><summary>Кто проголосовал</summary><ul>{d.votes.map((v) => <li key={v.userId}>{v.name}: {v.value === 'YES' ? 'за' : 'против'}</li>)}</ul></details>}
    {canConfirm && <div className="discussion-buttons">
      <button className="button secondary" disabled={busy} onClick={onReturn}><RotateCcw size={17} /> Вернуть на доработку</button>
      <button className="button primary" disabled={busy} onClick={() => send('confirm-early')}><Send size={17} /> Согласовать преждевременно</button>
    </div>}
    {error && <p className="error-notice" role="alert">{error}</p>}
  </section>;
}
