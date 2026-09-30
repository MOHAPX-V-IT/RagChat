import { id } from './ids.js';
import { sendReminderEmail } from './mailer.js';
import { applyPushDeliveries, sendPush } from './push.js';
import { store, audit } from './store.js';

const fullName = (user) => user ? `${user.firstName} ${user.lastName}` : 'Сотрудник';

export function reminderEventForTask(task, now = Date.now(), firstMinutes = 15, escalationMinutes = 30) {
  if (task.status !== 'IN_REVIEW' || !task.assignedAt) return null;
  const elapsedMinutes = Math.floor((now - new Date(task.assignedAt).getTime()) / 60_000);
  const sent = new Set((task.reminderHistory || []).map((item) => item.type));
  if (elapsedMinutes >= firstMinutes && !sent.has('FIRST_REMINDER')) {
    return { type: 'FIRST_REMINDER', elapsedMinutes, notifySales: false };
  }
  if (elapsedMinutes < escalationMinutes) return null;
  const salesAlreadyNotified = [...sent].some((type) => type === 'MANAGER_ESCALATION' || type.startsWith('MANAGER_ESCALATION_'));
  return salesAlreadyNotified ? null : { type: 'MANAGER_ESCALATION', elapsedMinutes, notifySales: true };
}

async function pushRecipients(users, payload) {
  const unique = [...new Map(users.filter(Boolean).map((user) => [user.id, user])).values()];
  const results = await Promise.all(unique.map(async (user) => ({
    user,
    result: await sendPush(user, payload).catch((error) => ({ failed: 1, error: error.message })),
  })));
  if (results.some(({ result }) => result.deliveries?.length)) await store.mutate((data) => {
    const now = new Date().toISOString();
    for (const { user, result } of results) {
      const current = data.users.find((item) => item.id === user.id);
      if (current) applyPushDeliveries(current, result, now);
    }
  });
  return results.map(({ user, result }) => ({ userId: user.id, ...result }));
}

export async function processReminders(now = Date.now()) {
  const snapshot = store.read();
  const firstMinutes = Number(process.env.REVIEW_REMINDER_MINUTES || snapshot.settings.reminderMinutes || 15);
  const escalationMinutes = Number(process.env.MANAGER_ESCALATION_MINUTES || snapshot.settings.salesEscalationMinutes || 30);
  const due = snapshot.reviewTasks.map((task) => ({ task, event: reminderEventForTask(task, now, firstMinutes, escalationMinutes) })).filter((item) => item.event);
  let processed = 0;

  for (const { task, event } of due) {
    const dispatch = await store.mutate((data) => {
      const current = data.reviewTasks.find((item) => item.id === task.id);
      if (!current) return null;
      const freshEvent = reminderEventForTask(current, now, firstMinutes, escalationMinutes);
      if (!freshEvent || freshEvent.type !== event.type) return null;
      const reviewer = data.users.find((user) => user.id === current.assignedTo && user.isActive);
      if (!reviewer) return null;
      const representative = data.users.find((user) => user.id === current.representativeId);
      const question = data.messages.find((message) => message.id === current.questionMessageId)?.content || '';
      const title = data.conversations.find((item) => item.id === current.conversationId)?.title || 'Вопрос без названия';
      const sales = freshEvent.notifySales ? data.users.filter((user) => user.isActive && user.role === 'MANAGER') : [];
      const recipients = [...new Map([reviewer, ...sales].map((user) => [user.id, user])).values()];
      const createdAt = new Date(now).toISOString();
      const body = freshEvent.notifySales
        ? `${fullName(reviewer)} не ответил за ${freshEvent.elapsedMinutes} мин. «${title}», автор — ${fullName(representative)}.`
        : `${fullName(reviewer)}, вопрос «${title}» в работе уже ${freshEvent.elapsedMinutes} мин.`;
      current.reminderHistory ||= [];
      current.reminderHistory.push({ type: freshEvent.type, at: createdAt, recipients: recipients.map((user) => user.id) });
      current.reminderSentAt = createdAt;
      for (const recipient of recipients) data.notifications.unshift({
        id: id('notice'), userId: recipient.id,
        type: freshEvent.notifySales ? 'MANAGER_OVERDUE_ALERT' : 'REVIEW_REMINDER',
        title: freshEvent.notifySales ? 'Просрочен ответ на вопрос' : 'Напоминание о вопросе в работе',
        body, taskId: current.id, conversationId: current.conversationId, isRead: false, createdAt,
      });
      audit(data, 'system', freshEvent.notifySales ? 'MANAGER_OVERDUE_ALERT' : 'REMINDER_SENT', 'review_task', current.id, {
        elapsedMinutes: freshEvent.elapsedMinutes, reviewerId: reviewer.id, recipients: recipients.map((user) => user.id),
      });
      return { current: { ...current }, reviewer, recipients, question, body, event: freshEvent };
    });
    if (!dispatch) continue;
    processed += 1;
    let emailDelivery = null;
    let emailError = null;
    try {
      emailDelivery = await sendReminderEmail({
        to: dispatch.reviewer.email,
        reviewerName: fullName(dispatch.reviewer),
        question: dispatch.question,
        elapsedMinutes: dispatch.event.elapsedMinutes,
      });
    } catch (error) {
      emailError = error.message;
    }
    const pushDelivery = await pushRecipients(dispatch.recipients, {
      title: dispatch.event.notifySales ? 'Просрочен ответ на вопрос' : 'Напоминание RagChat',
      body: dispatch.body,
      taskId: dispatch.current.id,
      url: `/?section=queue&task=${encodeURIComponent(dispatch.current.id)}`,
      icon: '/icons/icon-192.png',
    });
    await store.mutate((data) => audit(data, 'system', 'REMINDER_DELIVERY_RECORDED', 'review_task', dispatch.current.id, {
      type: dispatch.event.type, emailDelivery, emailError, pushDelivery,
    }));
  }
  return { processed };
}

export function startReminderScheduler() {
  const timer = setInterval(() => processReminders().catch(console.error), 60_000);
  timer.unref();
  processReminders().catch(console.error);
}
