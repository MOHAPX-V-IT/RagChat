import { hasPermission } from './capabilities.js';

export const discussionRoles = ['EXPERT', 'SPECIALIST', 'ADMIN'];
export const discussionVisible = (user, task) => Boolean(task?.discussion) && hasPermission(user, 'reviews.view') && discussionRoles.includes(user.role);
export const tally = (discussion) => ({
  yes: (discussion?.votes || []).filter((v) => v.value === 'YES').length,
  no: (discussion?.votes || []).filter((v) => v.value === 'NO').length,
});
export const responsibleId = (task) => task?.assignedTo || task?.discussion?.proposedBy;

export function revisionBlock(user, task) {
  if (!task || !['WAITING_REVIEW', 'IN_REVIEW', 'DISCUSSION'].includes(task.status)) return 'Вопрос уже закрыт или черновик ещё формируется.';
  const eligible = discussionRoles.includes(user.role) || (user.role === 'MANAGER' && responsibleId(task) === user.id);
  if (!eligible || !hasPermission(user, 'reviews.manage')) return 'Нет права сохранять экспертные редакции.';
  if (task.representativeId === user.id && user.role !== 'ADMIN') return 'Нельзя редактировать ответ на собственный вопрос.';
  return null;
}

export function saveRevision(task, user, revisionId, content, baseVersion, now = Date.now()) {
  const blocked = revisionBlock(user, task);
  if (blocked) throw new Error(blocked);
  const text = String(content || '').trim();
  if (text.length < 3 || text.length > 50000) throw new Error('Редакция должна содержать от 3 до 50 000 символов.');
  const revision = { id: revisionId, authorId: user.id, authorName: `${user.firstName} ${user.lastName}`,
    content: text, baseVersion: Number(baseVersion) || 0, createdAt: new Date(now).toISOString() };
  task.revisions ||= [];
  task.revisions.push(revision);
  task.updatedAt = revision.createdAt;
  return revision;
}

export function selectRevision(task, user, revisionId, version, now = Date.now()) {
  const blocked = deliveryBlock(task, user, version);
  if (blocked) throw new Error('Выбрать редакцию может текущий ответственный эксперт. Обновите вопрос и проверьте версию обсуждения.');
  const revision = task.revisions?.find((r) => r.id === revisionId);
  if (!revision) throw new Error('Редакция не найдена.');
  if (task.discussion.selectedRevisionId === revisionId) throw new Error('Эта редакция уже выбрана.');
  const d = propose(task, user, revision.content, now);
  d.selectedRevisionId = revision.id;
  d.answerAuthorId = revision.authorId;
  d.answerAuthorName = revision.authorName;
  return d;
}

export function propose(task, user, answer, now = Date.now()) {
  if (!answer?.trim() || answer.trim().length < 3) throw new Error('Введите текст ответа.');
  if (task.discussion) archiveDiscussion(task, 'REPLACED', now);
  task.discussion = {
    version: (task.discussionHistory?.length || 0) + 1,
    proposedBy: user.id, proposedName: `${user.firstName} ${user.lastName}`,
    proposedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    // Opt-in per round: pre-upgrade discussions retain their strict-majority rule.
    autoReleaseWithoutVotes: true,
    answer: answer.trim(), edited: Boolean(task.discussionHistory?.some((d) => d.edited)) || answer.trim() !== task.aiDraft?.trim(), votes: [],
  };
  task.status = 'DISCUSSION';
  task.updatedAt = new Date(now).toISOString();
  task.finalAnswer = null;
  task.returnTo = null;
  return task.discussion;
}

export function archiveDiscussion(task, reason, now = Date.now()) {
  if (!task.discussion) return;
  task.discussionHistory ||= [];
  task.discussionHistory.push({ ...structuredClone(task.discussion), endedAt: new Date(now).toISOString(), reason });
  task.discussion = null;
}

export function voteBlock(user, task, version, now = Date.now()) {
  if (task?.status !== 'DISCUSSION' || !task.discussion) return 'Ответ уже отправлен или снят с обсуждения.';
  if (!discussionRoles.includes(user.role) || !hasPermission(user, 'reviews.manage')) return 'Нет права голосовать.';
  if (task.representativeId === user.id || responsibleId(task) === user.id || task.discussion.answerAuthorId === user.id) return 'Нельзя голосовать за собственный вопрос или предложенный вами ответ.';
  if (task.discussion.version !== version) return 'Версия ответа изменилась. Обновите вопрос.';
  if (now >= Date.parse(task.discussion.deadlineAt)) return '24 часа голосования истекли. Обсуждение продолжается в комментариях.';
  return null;
}

export function recordVote(task, user, value, now = Date.now()) {
  task.discussion.votes = task.discussion.votes.filter((v) => v.userId !== user.id);
  task.discussion.votes.push({ userId: user.id, name: `${user.firstName} ${user.lastName}`, value, at: new Date(now).toISOString() });
  task.updatedAt = new Date(now).toISOString();
}

export function deliveryBlock(task, user, version, automatic = false, now = Date.now()) {
  if (task?.status !== 'DISCUSSION' || !task.discussion || task.discussion.version !== version) return 'unavailable';
  if (automatic) {
    const { yes, no } = tally(task.discussion);
    const accepted = yes > no || (task.discussion.autoReleaseWithoutVotes === true && yes === 0 && no === 0);
    return now >= Date.parse(task.discussion.deadlineAt) && accepted ? null : 'unavailable';
  }
  if (!hasPermission(user, 'reviews.manage')) return 'scope';
  if (user.role !== 'ADMIN' && responsibleId(task) !== user.id) return 'owner';
  if (user.role !== 'ADMIN' && task.representativeId === user.id) return 'scope';
  return null;
}

export function pinnedOrder(userId, sort = 'desc') {
  return (a, b) => Number(b.status === 'WAITING_REVIEW' && b.returnTo === userId)
    - Number(a.status === 'WAITING_REVIEW' && a.returnTo === userId)
    || (sort === 'asc' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
