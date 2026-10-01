import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { authRequired, signToken } from './auth.js';
import { fallbackConversationTitle, isAutomaticConversationTitle, normalizeGeneratedTitle } from './conversation-title.js';
import { id } from './ids.js';
import { rag } from './rag-client.js';
import { audit, publicUser, store } from './store.js';
import { processReminders, startReminderScheduler } from './reminders.js';
import { sendAnswerReadyEmail, sendTestEmail } from './mailer.js';
import { deleteUserAccount, findUserRecord } from './user-deletion.js';
import { allowPermission, canAccessReviewPool, canManageReviewTask, effectivePermissions, hasPermission, permissionCatalog, representativeRoles, reviewClaimBlock, reviewPoolsForRole, reviewRoles, userRoles } from './capabilities.js';
import { addStage, buildAnalytics, delayReason, ensureTaskShape, estimateWaitMinutes, EXPERT_STATUSES, PRIORITIES, taskTiming } from './workflow.js';
import { applyPushDeliveries, describePushClient, publicPushDevice, pushConfigured, pushDeviceId, pushPublicKey, registerPushSubscription, sendPush } from './push.js';
import { analyticsWorkbook } from './xlsx.js';
import { markAllNotificationsRead } from './notifications.js';
import { buildSalesDashboard, manualReminderBlock } from './sales-dashboard.js';
import { isAfterStatisticsReset } from './statistics.js';
import { discussionVisible, tally, propose, archiveDiscussion, voteBlock, recordVote, deliveryBlock, pinnedOrder, responsibleId, saveRevision, selectRevision } from './discussion.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const activeReviewStatuses = new Set(['GENERATING', 'WAITING_REVIEW', 'IN_REVIEW', 'DISCUSSION']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fullName = (user) => user ? `${user.firstName} ${user.lastName}` : '—';
const clientUser = (user) => user ? { ...publicUser(user), permissions: effectivePermissions(user) } : null;
const roleLabel = (role) => ({ REQUESTER: 'Сотрудник', EXPERT: 'Эксперт', SPECIALIST: 'Профильные эксперты', MANAGER: 'Руководители', ADMIN: 'Администратор' })[role] || 'Сотрудник';
const poolLabel = (pool) => pool === 'SPECIALIST' ? 'профильный вопрос' : 'общий вопрос';
const moscowTime = (value = new Date()) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const questionTitle = (data, task) => data.conversations.find((item) => item.id === task.conversationId)?.title || 'Вопрос без названия';

function addNotification(data, user, { type, title, body, taskId, conversationId, createdAt = new Date().toISOString() }) {
  if (!user?.isActive) return null;
  const notification = { id: id('notice'), userId: user.id, type, title, body, taskId, conversationId, isRead: false, createdAt };
  data.notifications.unshift(notification);
  return notification;
}

const activeUsersByRole = (data, roles) => data.users.filter((user) => user.isActive && roles.includes(user.role));
const respondersForPool = (data, pool) => activeUsersByRole(data, [pool === 'SPECIALIST' ? 'SPECIALIST' : 'EXPERT']);

async function pushToUsers(users, payload) {
  const unique = [...new Map((users || []).filter(Boolean).map((user) => [user.id, user])).values()];
  const results = await Promise.all(unique.map(async (user) => ({ user, result: await sendPush(user, payload).catch((error) => ({ channel: 'web-push', delivered: 0, failed: 1, error: error.message })) })));
  if (results.some(({ result }) => result.deliveries?.length)) await store.mutate((data) => {
    const now = new Date().toISOString();
    for (const { user, result } of results) {
      const current = data.users.find((item) => item.id === user.id);
      if (!current) continue;
      applyPushDeliveries(current, result, now);
    }
  });
  return results.map(({ user, result }) => ({ userId: user.id, ...result }));
}

function taskVisibleTo(user, task) {
  if (user.role === 'REQUESTER') return false;
  return user.role === 'ADMIN' || discussionVisible(user, task) || canAccessReviewPool(user, task.reviewPool || 'GENERAL');
}

function enrichTask(task, data) {
  task = ensureTaskShape({ ...task });
  const question = data.messages.find((message) => message.id === task.questionMessageId);
  const conversation = data.conversations.find((item) => item.id === task.conversationId);
  const representative = findUserRecord(data, task.representativeId);
  const assigned = findUserRecord(data, task.assignedTo);
  const internalComments = (task.internalComments || []).map((comment) => {
    const author = findUserRecord(data, comment.authorId);
    return { ...comment, authorName: author ? fullName(author) : 'Удалённый пользователь' };
  });
  return {
    ...task,
    question: question?.content || '',
    conversationTitle: conversation?.title || 'Чат',
    representative: representative ? { id: representative.id, name: fullName(representative), email: representative.email, role: representative.role } : null,
    assignedExpert: assigned ? { id: assigned.id, name: fullName(assigned), role: assigned.role } : null,
    hasComment: Boolean(task.returnComment?.trim()),
    waitMinutes: Math.max(0, Math.floor((Date.now() - new Date(task.assignedAt || task.createdAt).getTime()) / 60_000)),
    timing: taskTiming(task),
    estimatedWaitMinutes: estimateWaitMinutes(data.reviewTasks, task),
    delayReason: delayReason(task),
    internalComments,
    returnExpert: task.returnTo ? publicUser(findUserRecord(data, task.returnTo)) : null,
    discussion: task.discussion ? { ...task.discussion, ...tally(task.discussion) } : null,
  };
}

function taskForViewer(task, data, user) {
  if (!task) return null;
  const result = enrichTask(task, data);
  if (user.role !== 'REQUESTER' && hasPermission(user, 'reviews.view')) return result;
  const keys = ['id', 'conversationId', 'status', 'reviewPool', 'createdAt', 'updatedAt',
    'assignedExpert', 'estimatedWaitMinutes', 'timing'];
  return { ...Object.fromEntries(keys.map((k) => [k, result[k]])),
    stageHistory: result.stageHistory.map(({ id, stage, at }) => ({ id, stage, at })) };
}

async function generateDraft(taskId, payload) {
  let classification = { reviewPool: 'GENERAL', confidence: 0.5, reason: 'Резервное общее направление.', method: 'fallback' };
  try {
    classification = await rag.classify({ question: payload.question, history: payload.history });
    await store.mutate((data) => {
      const task = data.reviewTasks.find((item) => item.id === taskId);
      if (!task || task.status !== 'GENERATING') return null;
      task.reviewPool = classification.reviewPool === 'SPECIALIST' ? 'SPECIALIST' : 'GENERAL';
      task.routingConfidence = classification.confidence ?? null;
      task.routingReason = classification.reason || null;
      task.routingMethod = classification.method || 'llm';
      task.updatedAt = new Date().toISOString();
      addStage(task, 'ROUTING_CLASSIFIED', { at: task.updatedAt, meta: { reviewPool: task.reviewPool, confidence: task.routingConfidence, reason: task.routingReason, method: task.routingMethod } });
      audit(data, 'system', 'QUESTION_CLASSIFIED', 'review_task', taskId, { reviewPool: task.reviewPool, confidence: task.routingConfidence, reason: task.routingReason, method: task.routingMethod });
      return task;
    });
    const draft = await rag.draft({ ...payload, reviewPool: classification.reviewPool });
    if (!String(draft.text || '').trim()) throw new Error('RAG-сервис вернул пустой черновик.');
    const ready = await store.mutate((data) => {
      const task = data.reviewTasks.find((item) => item.id === taskId);
      if (!task || task.status !== 'GENERATING') return null;
      task.aiDraft = draft.text;
      task.sources = draft.sources || [];
      task.webSources = draft.webSources || [];
      task.confidence = draft.confidence ?? null;
      task.ragMeta = draft.meta || {};
      task.responseVersions ||= [];
      task.responseVersions.push({ id: id('answer-version'), type: 'AI_DRAFT', content: draft.text, authorId: 'system', createdAt: new Date().toISOString(), metrics: draft.meta?.metrics || {} });
      task.productName = draft.meta?.productName || task.productName || null;
      task.reviewPool = classification.reviewPool === 'SPECIALIST' ? 'SPECIALIST' : 'GENERAL';
      task.routingConfidence = classification.confidence ?? null;
      task.routingReason = classification.reason || null;
      task.routingMethod = classification.method || 'llm';
      task.status = 'WAITING_REVIEW';
      task.updatedAt = new Date().toISOString();
      addStage(task, 'AI_READY', { at: task.updatedAt, meta: { metrics: task.ragMeta.metrics || {} } });
      const representative = findUserRecord(data, task.representativeId);
      const title = questionTitle(data, task);
      const responders = respondersForPool(data, task.reviewPool);
      for (const responder of responders) {
        addNotification(data, responder, {
          type: 'DRAFT_READY',
          title: task.reviewPool === 'SPECIALIST' ? 'Новый вопрос для профильных экспертов' : 'Новый общий вопрос',
          body: `${fullName(representative)}: «${title}». Черновик ИИ готов к проверке.`,
          taskId: task.id,
          createdAt: task.updatedAt,
        });
      }
      audit(data, 'system', 'DRAFT_READY', 'review_task', taskId, { traceId: task.traceId, reviewPool: task.reviewPool, sourceCount: task.sources.length, webSourceCount: task.webSources.length, metrics: task.ragMeta.metrics || {} });
      return { task: { ...task }, responders, representative, title };
    });
    if (ready) await pushToUsers(ready.responders.filter((user) => user.expertStatus !== 'DND'), {
      title: ready.task.reviewPool === 'SPECIALIST' ? 'Новый вопрос для профильных экспертов' : 'Новый общий вопрос',
      body: `${fullName(ready.representative)}: «${ready.title}». Черновик ИИ готов.`,
      taskId,
      url: `/?section=queue&task=${encodeURIComponent(taskId)}`,
      icon: '/icons/icon-192.png',
    });
  } catch (error) {
    const degraded = await store.mutate((data) => {
      const task = data.reviewTasks.find((item) => item.id === taskId);
      if (!task || task.status !== 'GENERATING') return null;
      task.aiDraft = 'ИИ-ядро временно недоступно. Эксперту необходимо подготовить ответ вручную на основании доступных материалов.';
      task.sources = [];
      task.webSources = [];
      task.confidence = 0;
      task.ragMeta = { degraded: true, error: error.message };
      task.reviewPool = classification.reviewPool === 'SPECIALIST' ? 'SPECIALIST' : 'GENERAL';
      task.routingConfidence = classification.confidence ?? null;
      task.routingReason = classification.reason || null;
      task.routingMethod = classification.method || 'fallback';
      task.responseVersions ||= [];
      task.responseVersions.push({ id: id('answer-version'), type: 'AI_DEGRADED', content: task.aiDraft, authorId: 'system', createdAt: new Date().toISOString(), error: error.message });
      task.status = 'WAITING_REVIEW';
      task.updatedAt = new Date().toISOString();
      addStage(task, 'AI_DEGRADED', { at: task.updatedAt, meta: { error: error.message } });
      const representative = findUserRecord(data, task.representativeId);
      const title = questionTitle(data, task);
      const responders = respondersForPool(data, task.reviewPool);
      for (const responder of responders) addNotification(data, responder, { type: 'DRAFT_DEGRADED', title: 'Вопрос требует ручного ответа', body: `${fullName(representative)}: «${title}».`, taskId: task.id, createdAt: task.updatedAt });
      audit(data, 'system', 'DRAFT_DEGRADED', 'review_task', taskId, { traceId: task.traceId, reviewPool: task.reviewPool, error: error.message });
      return { task: { ...task }, responders, representative, title };
    });
    if (degraded) await pushToUsers(degraded.responders.filter((user) => user.expertStatus !== 'DND'), { title: 'Вопрос требует ручного ответа', body: `${fullName(degraded.representative)}: «${degraded.title}».`, taskId, url: `/?section=queue&task=${encodeURIComponent(taskId)}`, icon: '/icons/icon-192.png' });
  }
}

async function generateConversationTitle(conversationId, payload) {
  try {
    const result = await rag.title(payload);
    const title = normalizeGeneratedTitle(result.title, payload.question);
    await store.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === conversationId);
      if (!conversation || !isAutomaticConversationTitle(conversation)) return null;
      const changed = conversation.title !== title;
      conversation.title = title;
      conversation.titleSource = 'AUTO';
      conversation.titleGeneratedAt = new Date().toISOString();
      if (changed) audit(data, 'system', 'CONVERSATION_AUTO_TITLED', 'conversation', conversation.id, { title });
      return conversation;
    });
  } catch (error) {
    // Вопрос уже дал чату читаемый резервный заголовок; ошибка ИИ не мешает работе.
    console.warn(`Не удалось уточнить название диалога ${conversationId}: ${error.message}`);
    await store.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === conversationId);
      if (!conversation || !isAutomaticConversationTitle(conversation)) return null;
      conversation.titleGeneratedAt = new Date().toISOString();
      return conversation;
    });
  }
}

async function initializeConversationTitles() {
  return store.mutate((data) => {
    const candidates = [];
    for (const conversation of data.conversations) {
      if (!conversation.titleSource && !isAutomaticConversationTitle(conversation)) {
        conversation.titleSource = 'MANUAL';
        continue;
      }
      if (!conversation.titleSource) conversation.titleSource = 'AUTO';
      if (conversation.titleSource !== 'AUTO' || conversation.titleGeneratedAt) continue;
      const messages = data.messages.filter((message) => message.conversationId === conversation.id && message.isOfficial);
      const questionIndex = messages.findLastIndex((message) => message.authorType === 'USER');
      if (questionIndex < 0) continue;
      const question = messages[questionIndex].content;
      if (isAutomaticConversationTitle(conversation)) {
        conversation.title = fallbackConversationTitle(question);
        audit(data, 'system', 'CONVERSATION_AUTO_TITLED', 'conversation', conversation.id, { title: conversation.title, migrated: true });
      }
      candidates.push({
        conversationId: conversation.id,
        question,
        history: messages.slice(Math.max(0, questionIndex - 8), questionIndex)
          .map((message) => ({ role: message.authorType === 'USER' ? 'user' : 'assistant', content: message.content })),
      });
    }
    return candidates;
  });
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  let ragHealth;
  try { ragHealth = await rag.health(); } catch (error) { ragHealth = { status: 'down', error: error.message }; }
  let database;
  try { database = await store.health(); } catch (error) { database = { status: 'down', engine: 'PostgreSQL', error: error.message }; }
  res.json({ status: ragHealth.status === 'ok' && database.status === 'ok' ? 'ok' : 'degraded', api: 'ok', database, rag: ragHealth, now: new Date().toISOString() });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = store.read().users.find((item) => item.email.toLowerCase() === email);
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверная почта или пароль.' });
  }
  await store.mutate((data) => {
    const current = data.users.find((item) => item.id === user.id);
    current.lastLoginAt = new Date().toISOString();
    audit(data, user.id, 'LOGIN', 'user', user.id);
  });
  res.json({ token: signToken(user), user: clientUser(user) });
}));

app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: clientUser(store.read().users.find((item) => item.id === req.user.id)) }));

app.get('/api/capabilities', authRequired, (req, res) => res.json({ permissions: effectivePermissions(req.user), catalog: req.user.role === 'ADMIN' ? permissionCatalog : undefined }));

app.get('/api/faq', authRequired, (_req, res) => res.json({ items: store.read().settings.faq }));

app.get('/api/notifications', authRequired, (req, res) => {
  const notifications = store.read().notifications.filter((item) => item.userId === req.user.id).slice(0, 50);
  res.json({ notifications });
});

app.post('/api/notifications/read-all', authRequired, asyncRoute(async (req, res) => {
  const updated = await store.mutate((data) => markAllNotificationsRead(data.notifications, req.user.id));
  res.json({ updated });
}));

app.post('/api/notifications/:id/read', authRequired, asyncRoute(async (req, res) => {
  const result = await store.mutate((data) => {
    const item = data.notifications.find((notice) => notice.id === req.params.id && notice.userId === req.user.id);
    if (!item) return null;
    item.isRead = true;
    return item;
  });
  if (!result) return res.status(404).json({ error: 'Уведомление не найдено.' });
  res.json({ notification: result });
}));

app.get('/api/push/config', authRequired, (_req, res) => res.json({ configured: pushConfigured(), publicKey: pushPublicKey() || null }));

app.get('/api/push/subscriptions', authRequired, (req, res) => {
  const user = store.read().users.find((item) => item.id === req.user.id);
  res.json({ configured: pushConfigured(), devices: (user?.webPushSubscriptions || []).map(publicPushDevice) });
});

app.post('/api/push/subscribe', authRequired, asyncRoute(async (req, res) => {
  const subscription = req.body?.subscription || req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'Некорректная push-подписка.' });
  const now = new Date().toISOString();
  const client = describePushClient(req.get('user-agent'));
  const device = await store.mutate((data) => {
    const registered = registerPushSubscription(data.users, req.user.id, subscription, client, now);
    if (!registered) return null;
    if (registered.isNew) audit(data, req.user.id, 'PUSH_SUBSCRIBED', 'user', req.user.id, { deviceId: registered.saved.id, platform: registered.saved.platform, browser: registered.saved.browser });
    return publicPushDevice(registered.saved);
  });
  if (!device) return res.status(404).json({ error: 'Пользователь не найден.' });
  res.status(201).json({ subscribed: true, device });
}));

app.delete('/api/push/subscribe', authRequired, asyncRoute(async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  await store.mutate((data) => {
    const user = data.users.find((item) => item.id === req.user.id);
    user.webPushSubscriptions = (user.webPushSubscriptions || []).filter((item) => item.endpoint !== endpoint);
    audit(data, req.user.id, 'PUSH_UNSUBSCRIBED', 'user', req.user.id);
  });
  res.status(204).end();
}));

app.delete('/api/push/subscriptions/:id', authRequired, asyncRoute(async (req, res) => {
  const removed = await store.mutate((data) => {
    const user = data.users.find((item) => item.id === req.user.id);
    const before = user.webPushSubscriptions || [];
    user.webPushSubscriptions = before.filter((item) => (item.id || pushDeviceId(item.endpoint)) !== req.params.id);
    if (user.webPushSubscriptions.length === before.length) return false;
    audit(data, req.user.id, 'PUSH_UNSUBSCRIBED', 'user', req.user.id, { deviceId: req.params.id });
    return true;
  });
  if (!removed) return res.status(404).json({ error: 'Push-устройство не найдено.' });
  res.status(204).end();
}));

app.get('/api/conversations', authRequired, (req, res) => {
  const data = store.read();
  let conversations = data.conversations;
  const ownScope = req.user.role === 'REQUESTER' || req.query.scope === 'mine';
  if (ownScope && !hasPermission(req.user, 'chats.use')) return res.status(403).json({ error: 'Недостаточно прав для работы с диалогами.' });
  if (!ownScope && !hasPermission(req.user, 'reviews.view')) return res.status(403).json({ error: 'Недостаточно прав для просмотра всех диалогов.' });
  if (ownScope) {
    conversations = conversations.filter((item) => item.ownerId === req.user.id);
    const visibility = String(req.query.visibility || 'active');
    if (visibility === 'active') conversations = conversations.filter((item) => !item.deletedByOwnerAt);
    if (visibility === 'hidden') conversations = conversations.filter((item) => item.deletedByOwnerAt);
  }
  const query = String(req.query.q || '').trim().toLowerCase();
  if (query && ownScope) conversations = conversations.filter((conversation) => {
    const text = data.messages.filter((message) => message.conversationId === conversation.id).map((message) => message.content).join(' ');
    return `${conversation.title} ${text}`.toLowerCase().includes(query);
  });
  const state = String(req.query.state || '');
  if (state && ownScope) conversations = conversations.filter((conversation) => {
    const task = data.reviewTasks.find((item) => item.conversationId === conversation.id && activeReviewStatuses.has(item.status));
    if (state === 'active') return Boolean(task);
    if (state === 'waiting') return Boolean(task && ['GENERATING', 'WAITING_REVIEW', 'DISCUSSION'].includes(task.status));
    if (state === 'completed') return !task && data.messages.some((message) => message.conversationId === conversation.id && message.authorType === 'ASSISTANT');
    return true;
  });
  const ownerQuery = String(req.query.owner || '').trim().toLowerCase();
  if (ownerQuery && !ownScope) {
    conversations = conversations.filter((conversation) => {
      const owner = findUserRecord(data, conversation.ownerId);
      return owner && `${fullName(owner)} ${owner.email}`.toLowerCase().includes(ownerQuery);
    });
  }
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ''))
    ? new Date(`${req.query.dateFrom}T00:00:00`).getTime() : null;
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ''))
    ? new Date(`${req.query.dateTo}T23:59:59.999`).getTime() : null;
  if (dateFrom != null) conversations = conversations.filter((item) => new Date(item.updatedAt).getTime() >= dateFrom);
  if (dateTo != null) conversations = conversations.filter((item) => new Date(item.updatedAt).getTime() <= dateTo);
  const payload = conversations.map((conversation) => {
    const owner = findUserRecord(data, conversation.ownerId);
    const conversationTasks = data.reviewTasks.filter((task) => task.conversationId === conversation.id);
    const activeTask = conversationTasks.find((task) => activeReviewStatuses.has(task.status));
    const latestTask = conversationTasks.at(-1);
    const lastMessage = data.messages.filter((message) => message.conversationId === conversation.id).at(-1);
    return { ...conversation, owner: owner ? { id: owner.id, name: fullName(owner), email: owner.email, role: owner.role, deletedAt: owner.deletedAt || null } : null, activeTask: taskForViewer(activeTask, data, req.user), latestTask: taskForViewer(latestTask, data, req.user), lastMessage };
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations: payload, total: payload.length });
});

app.post('/api/conversations', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const title = String(req.body.title || 'Новый чат').trim().slice(0, 80) || 'Новый чат';
  const now = new Date().toISOString();
  const conversation = { id: id('chat'), ownerId: req.user.id, title, titleSource: 'AUTO', titleGeneratedAt: null, deletedByOwnerAt: null, createdAt: now, updatedAt: now };
  await store.mutate((data) => {
    data.conversations.push(conversation);
    audit(data, req.user.id, 'CONVERSATION_CREATED', 'conversation', conversation.id);
  });
  res.status(201).json({ conversation });
}));

app.patch('/api/conversations/:id', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Введите название чата.' });
  const conversation = await store.mutate((data) => {
    const current = data.conversations.find((item) => item.id === req.params.id && item.ownerId === req.user.id && !item.deletedByOwnerAt);
    if (!current) return null;
    current.title = title;
    current.titleSource = 'MANUAL';
    current.titleGeneratedAt = null;
    current.updatedAt = new Date().toISOString();
    audit(data, req.user.id, 'CONVERSATION_RENAMED', 'conversation', current.id, { title });
    return current;
  });
  if (!conversation) return res.status(404).json({ error: 'Чат не найден.' });
  res.json({ conversation });
}));

app.delete('/api/conversations/:id', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const conversation = await store.mutate((data) => {
    const current = data.conversations.find((item) => item.id === req.params.id && item.ownerId === req.user.id && !item.deletedByOwnerAt);
    if (!current) return null;
    current.deletedByOwnerAt = new Date().toISOString();
    current.updatedAt = current.deletedByOwnerAt;
    audit(data, req.user.id, 'CONVERSATION_SOFT_DELETED', 'conversation', current.id);
    return current;
  });
  if (!conversation) return res.status(404).json({ error: 'Чат не найден.' });
  res.status(204).end();
}));

app.post('/api/conversations/:id/restore', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const conversation = await store.mutate((data) => {
    const current = data.conversations.find((item) => item.id === req.params.id && item.ownerId === req.user.id && item.deletedByOwnerAt);
    if (!current) return null;
    current.deletedByOwnerAt = null;
    current.updatedAt = new Date().toISOString();
    audit(data, req.user.id, 'CONVERSATION_RESTORED', 'conversation', current.id);
    return current;
  });
  if (!conversation) return res.status(404).json({ error: 'Скрытый чат не найден.' });
  res.json({ conversation });
}));

app.get('/api/conversations/:id/messages', authRequired, (req, res) => {
  const data = store.read();
  const conversation = data.conversations.find((item) => item.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Чат не найден.' });
  if (conversation.ownerId !== req.user.id && !hasPermission(req.user, 'reviews.view')) {
    return res.status(403).json({ error: 'Чат недоступен.' });
  }
  const messages = data.messages.filter((message) => message.conversationId === conversation.id && (req.user.role !== 'REQUESTER' || message.isOfficial !== false));
  const activeTask = data.reviewTasks.find((task) => task.conversationId === conversation.id && activeReviewStatuses.has(task.status));
  const latestTask = data.reviewTasks.filter((task) => task.conversationId === conversation.id).at(-1);
  res.json({ conversation, messages, activeTask: taskForViewer(activeTask, data, req.user), latestTask: taskForViewer(latestTask, data, req.user) });
});

app.post('/api/conversations/:id/questions', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (question.length < 3) return res.status(400).json({ error: 'Сформулируйте вопрос подробнее.' });
  if (question.length > 5000) return res.status(400).json({ error: 'Вопрос не должен превышать 5000 символов.' });
  const now = new Date().toISOString();
  let created;
  const outcome = await store.mutate((data) => {
    const conversation = data.conversations.find((item) => item.id === req.params.id && item.ownerId === req.user.id && !item.deletedByOwnerAt);
    if (!conversation) return { error: 'not_found' };
    if (data.reviewTasks.some((task) => task.conversationId === conversation.id && activeReviewStatuses.has(task.status))) return { error: 'pending' };
    const autoTitle = isAutomaticConversationTitle(conversation);
    const message = { id: id('msg'), conversationId: conversation.id, authorType: 'USER', authorId: req.user.id, content: question, isOfficial: true, createdAt: now };
    const task = {
      id: id('review'), conversationId: conversation.id, representativeId: req.user.id,
      questionMessageId: message.id, status: 'GENERATING', aiDraft: '', finalAnswer: null,
      assignedTo: null, assignedAt: null, returnComment: '', returnHistory: [],
      approvedBy: null, approvedAt: null, reminderSentAt: null,
      reminderHistory: [], reviewPool: 'GENERAL', routingConfidence: null, routingReason: null, routingMethod: null,
      priority: 'NORMAL', slaMinutes: PRIORITIES.NORMAL.slaMinutes, productName: null, specialty: null,
      routedTo: null, routedAt: null, routingMode: null, internalComments: [], transferHistory: [], retryCount: 0,
      sources: [], webSources: [], confidence: null, ragMeta: {}, createdAt: now, updatedAt: now,
    };
    addStage(task, 'QUESTION_RECEIVED', { at: now, actorId: req.user.id });
    addStage(task, 'AI_STARTED', { at: now });
    data.messages.push(message);
    data.reviewTasks.push(task);
    if (autoTitle) {
      conversation.title = fallbackConversationTitle(question);
      conversation.titleSource = 'AUTO';
      conversation.titleGeneratedAt = null;
    }
    conversation.updatedAt = now;
    const sales = activeUsersByRole(data, ['MANAGER']);
    for (const employee of sales) addNotification(data, employee, {
      type: 'QUESTION_CREATED', title: 'Новый вопрос',
      body: `${fullName(req.user)} задал вопрос в ${moscowTime(now)}: «${conversation.title}».`,
      taskId: task.id, createdAt: now,
    });
    audit(data, req.user.id, 'QUESTION_CREATED', 'review_task', task.id, { authorRole: req.user.role, title: conversation.title });
    created = { message, task, autoTitle, sales, title: conversation.title };
    return { ok: true, conversation };
  });
  if (outcome.error === 'not_found') return res.status(404).json({ error: 'Чат не найден.' });
  if (outcome.error === 'pending') return res.status(409).json({ error: 'Дождитесь ответа на предыдущий вопрос.' });

  void pushToUsers(created.sales, {
    title: 'Новый вопрос в RagChat',
    body: `${fullName(req.user)} · ${moscowTime(now)} · «${created.title}».`,
    taskId: created.task.id,
    url: `/?section=queue&task=${encodeURIComponent(created.task.id)}`,
    icon: '/icons/icon-192.png',
  });

  const data = store.read();
  const history = data.messages
    .filter((message) => message.conversationId === req.params.id && message.isOfficial && message.id !== created.message.id)
    .slice(-8)
    .map((message) => ({ role: message.authorType === 'USER' ? 'user' : 'assistant', content: message.content }));
  void generateDraft(created.task.id, {
    reviewId: created.task.id,
    userId: req.user.id,
    conversationId: req.params.id,
    question,
    history,
  });
  if (created.autoTitle) void generateConversationTitle(req.params.id, { question, history });
  res.status(202).json({ message: created.message, task: created.task, conversation: outcome.conversation });
}));

app.post('/api/messages/:id/rating', authRequired, allowPermission('chats.use'), asyncRoute(async (req, res) => {
  const rating = req.body.rating;
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!['UP', 'DOWN', null].includes(rating)) return res.status(400).json({ error: 'Некорректная оценка.' });
  if (rating === 'DOWN' && reason.length < 3) return res.status(400).json({ error: 'Укажите, что именно было неполезно в ответе.' });
  const message = await store.mutate((data) => {
    const current = data.messages.find((item) => item.id === req.params.id && item.authorType === 'ASSISTANT');
    const conversation = current && data.conversations.find((item) => item.id === current.conversationId && item.ownerId === req.user.id);
    if (!current || !conversation) return null;
    current.rating = rating;
    current.ratingReason = rating === 'DOWN' ? reason : null;
    current.ratedAt = new Date().toISOString();
    audit(data, req.user.id, 'ANSWER_RATED', 'message', current.id, { rating, reason: current.ratingReason });
    return current;
  });
  if (!message) return res.status(404).json({ error: 'Ответ не найден.' });
  res.json({ message });
}));

app.get('/api/reviews', authRequired, allowPermission('reviews.view'), (req, res) => {
  const data = store.read();
  let tasks = data.reviewTasks.filter((task) => taskVisibleTo(req.user, task)).map((task) => enrichTask(task, data));
  const { status, representativeId, assignedTo, hasComment, dateFrom, dateTo, priority, productName, reviewPool, q, routedTo, sort = 'desc' } = req.query;
  if (status === 'OPEN') tasks = tasks.filter((task) => activeReviewStatuses.has(task.status));
  else if (status) tasks = tasks.filter((task) => task.status === status);
  if (representativeId) tasks = tasks.filter((task) => task.representativeId === representativeId);
  if (assignedTo === '__unassigned__') tasks = tasks.filter((task) => !task.assignedTo);
  else if (assignedTo) tasks = tasks.filter((task) => task.assignedTo === assignedTo || (task.status === 'WAITING_REVIEW' && task.returnTo === assignedTo));
  if (routedTo) tasks = tasks.filter((task) => task.routedTo === routedTo);
  if (priority) tasks = tasks.filter((task) => task.priority === priority);
  if (productName) tasks = tasks.filter((task) => task.productName === productName);
  if (reviewPool) tasks = tasks.filter((task) => task.reviewPool === reviewPool || task.status === 'DISCUSSION');
  if (q) tasks = tasks.filter((task) => task.question.toLowerCase().includes(String(q).toLowerCase()));
  if (hasComment === 'yes') tasks = tasks.filter((task) => task.hasComment);
  if (hasComment === 'no') tasks = tasks.filter((task) => !task.hasComment);
  if (dateFrom) tasks = tasks.filter((task) => new Date(task.createdAt) >= new Date(`${dateFrom}T00:00:00`));
  if (dateTo) tasks = tasks.filter((task) => new Date(task.createdAt) <= new Date(`${dateTo}T23:59:59.999`));
  tasks.sort(pinnedOrder(req.user.id, sort));
  const total = tasks.length;
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  tasks = tasks.slice((page - 1) * pageSize, page * pageSize);
  const representativeIds = new Set(data.reviewTasks.map((task) => task.representativeId));
  res.json({
    tasks,
    pagination: { page, pageSize, total, pages },
    representatives: data.users.filter((user) => representativeRoles.includes(user.role) || representativeIds.has(user.id)).map(publicUser),
    experts: data.users.filter((user) => user.isActive && reviewRoles.includes(user.role)).map(publicUser),
    priorities: PRIORITIES,
    products: [...new Set(data.reviewTasks.map((task) => task.productName).filter(Boolean))].sort(),
  });
});

app.get('/api/experts/workload', authRequired, allowPermission('reviews.view'), (_req, res) => {
  res.json({ experts: buildAnalytics(store.read()).experts });
});

app.get('/api/directory', authRequired, allowPermission('directory.view'), (_req, res) => {
  const data = store.read();
  const workloads = new Map(buildAnalytics(data).experts.map((item) => [item.id, item]));
  const members = data.users.filter((user) => user.isActive).map((user) => ({
    ...publicUser(user), name: fullName(user), workload: workloads.get(user.id) || null,
  }));
  res.json({ groups: {
    generalExperts: members.filter((user) => user.role === 'EXPERT'),
    representatives: members.filter((user) => user.role === 'REQUESTER'),
    sales: members.filter((user) => user.role === 'MANAGER'),
    strategy: members.filter((user) => user.role === 'SPECIALIST'),
  } });
});

app.get('/api/sales/dashboard', authRequired, allowPermission('analytics.view'), (req, res) => {
  if (!['MANAGER', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Рабочий стол доступен только руководителям и администраторам.' });
  res.json({ dashboard: buildSalesDashboard(store.read()) });
});

app.post('/api/sales/reviews/:id/remind', authRequired, allowPermission('reviews.route'), asyncRoute(async (req, res) => {
  if (!['MANAGER', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Напоминать экспертам могут только руководители и администраторы.' });
  const now = Date.now();
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((item) => item.id === req.params.id);
    const blocked = manualReminderBlock(task, now);
    if (blocked) return { blocked };
    const reviewer = data.users.find((user) => user.id === task.assignedTo && user.isActive);
    if (!reviewer) return { blocked: { status: 409, error: 'Назначенный эксперт недоступен. Обновите страницу.' } };
    const representative = findUserRecord(data, task.representativeId);
    const title = questionTitle(data, task);
    const elapsedMinutes = Math.floor((now - new Date(task.assignedAt).getTime()) / 60_000);
    const createdAt = new Date(now).toISOString();
    const body = `${fullName(req.user)} напоминает: вопрос «${title}» от ${fullName(representative)} находится в работе ${elapsedMinutes} мин.`;
    task.reminderHistory ||= [];
    task.reminderHistory.push({ type: 'MANUAL_MANAGER_REMINDER', at: createdAt, recipients: [reviewer.id], sentBy: req.user.id });
    addNotification(data, reviewer, {
      type: 'MANAGER_MANUAL_REMINDER', title: 'Руководители напоминают о вопросе', body,
      taskId: task.id, conversationId: task.conversationId, createdAt,
    });
    audit(data, req.user.id, 'MANAGER_MANUAL_REMINDER', 'review_task', task.id, { reviewerId: reviewer.id, elapsedMinutes });
    return { reviewer, taskId: task.id, conversationId: task.conversationId, body, createdAt };
  });
  if (result.blocked) return res.status(result.blocked.status).json({ error: result.blocked.error });
  const [delivery] = await pushToUsers([result.reviewer], {
    title: 'Руководители напоминают о вопросе', body: result.body, taskId: result.taskId,
    url: `/?section=queue&task=${encodeURIComponent(result.taskId)}`, icon: '/icons/icon-192.png',
  });
  res.json({ remindedAt: result.createdAt, delivery: { delivered: delivery?.delivered || 0, failed: delivery?.failed || 0 } });
}));

app.patch('/api/experts/me/presence', authRequired, allowPermission('reviews.view'), asyncRoute(async (req, res) => {
  const status = String(req.body.status || '');
  if (!EXPERT_STATUSES.has(status)) return res.status(400).json({ error: 'Некорректный статус эксперта.' });
  const user = await store.mutate((data) => {
    const current = data.users.find((item) => item.id === req.user.id);
    current.expertStatus = status;
    current.updatedAt = new Date().toISOString();
    audit(data, req.user.id, 'EXPERT_STATUS_UPDATED', 'user', current.id, { status });
    return clientUser(current);
  });
  res.json({ user });
}));

app.get('/api/review-templates', authRequired, allowPermission('reviews.view'), (_req, res) => {
  res.json({ templates: store.read().settings.reviewTemplates || [] });
});

app.post('/api/review-templates', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const content = String(req.body.content || '').trim().slice(0, 12_000);
  if (title.length < 2 || content.length < 3) return res.status(400).json({ error: 'Укажите название и текст шаблона.' });
  const template = await store.mutate((data) => {
    data.settings.reviewTemplates ||= [];
    const value = { id: id('template'), title, content, createdBy: req.user.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    data.settings.reviewTemplates.unshift(value);
    audit(data, req.user.id, 'REVIEW_TEMPLATE_CREATED', 'review_template', value.id, { title });
    return value;
  });
  res.status(201).json({ template });
}));

app.delete('/api/review-templates/:id', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const removed = await store.mutate((data) => {
    const index = (data.settings.reviewTemplates || []).findIndex((item) => item.id === req.params.id);
    if (index < 0) return null;
    const [value] = data.settings.reviewTemplates.splice(index, 1);
    audit(data, req.user.id, 'REVIEW_TEMPLATE_DELETED', 'review_template', value.id);
    return value;
  });
  if (!removed) return res.status(404).json({ error: 'Шаблон не найден.' });
  res.status(204).end();
}));

app.get('/api/reviews/:id', authRequired, allowPermission('reviews.view'), (req, res) => {
  const data = store.read();
  const task = data.reviewTasks.find((item) => item.id === req.params.id);
  if (!task || !taskVisibleTo(req.user, task)) return res.status(404).json({ error: 'Вопрос не найден.' });
  const messages = data.messages.filter((message) => message.conversationId === task.conversationId && message.createdAt <= task.createdAt);
  res.json({ task: enrichTask(task, data), history: messages });
});

app.post('/api/reviews/:id/regenerate', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const reset = await store.mutate((data) => {
    const task = data.reviewTasks.find((item) => item.id === req.params.id);
    if (!task || task.status === 'DELIVERED' || task.status === 'DISCUSSION') return null;
    if (!canManageReviewTask(req.user, task)) return null;
    if (req.user.role !== 'ADMIN' && task.assignedTo && task.assignedTo !== req.user.id) return null;
    const question = data.messages.find((message) => message.id === task.questionMessageId);
    if (!question) return null;
    task.status = 'GENERATING';
    task.aiDraft = '';
    task.assignedTo = null;
    task.assignedAt = null;
    task.sources = [];
    task.webSources = [];
    task.confidence = null;
    task.ragMeta = {};
    task.retryCount = Number(task.retryCount || 0) + 1;
    task.updatedAt = new Date().toISOString();
    addStage(task, 'AI_RETRY', { at: task.updatedAt, actorId: req.user.id, meta: { retryCount: task.retryCount } });
    addStage(task, 'AI_STARTED', { at: task.updatedAt });
    audit(data, req.user.id, 'DRAFT_REGENERATION_STARTED', 'review_task', task.id);
    return { task: { ...task }, question: question.content };
  });
  if (!reset) return res.status(409).json({ error: 'Черновик нельзя пересоздать: вопрос недоступен или уже доставлен.' });
  const data = store.read();
  const history = data.messages
    .filter((message) => message.conversationId === reset.task.conversationId && message.isOfficial && message.id !== reset.task.questionMessageId)
    .slice(-8)
    .map((message) => ({ role: message.authorType === 'USER' ? 'user' : 'assistant', content: message.content }));
  void generateDraft(reset.task.id, {
    reviewId: reset.task.id,
    userId: reset.task.representativeId,
    conversationId: reset.task.conversationId,
    question: reset.question,
    history,
  });
  res.status(202).json({ task: enrichTask(reset.task, data) });
}));

app.post('/api/reviews/:id/claim', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const result = await store.mutate((data) => {
    const current = data.reviewTasks.find((item) => item.id === req.params.id);
    const blocked = reviewClaimBlock(req.user, current);
    if (blocked) return { blocked };
    current.status = 'IN_REVIEW';
    current.assignedTo = req.user.id;
    current.assignedAt = new Date().toISOString();
    current.reminderSentAt = null;
    current.reminderHistory = [];
    current.updatedAt = current.assignedAt;
    const representative = findUserRecord(data, current.representativeId);
    const sales = activeUsersByRole(data, ['MANAGER']);
    const title = questionTitle(data, current);
    addNotification(data, representative, {
      type: 'REVIEW_CLAIMED', title: 'Вопрос взят в работу',
      body: `${fullName(req.user)} (${roleLabel(req.user.role)}) взял вопрос «${title}» в ${moscowTime(current.assignedAt)}.`,
      taskId: current.id, conversationId: current.conversationId, createdAt: current.assignedAt,
    });
    for (const employee of sales) addNotification(data, employee, {
      type: 'REVIEW_CLAIMED', title: 'Вопрос взят в работу',
      body: `${fullName(req.user)} (${roleLabel(req.user.role)}) · ${moscowTime(current.assignedAt)} · «${title}».`,
      taskId: current.id, createdAt: current.assignedAt,
    });
    addStage(current, 'REVIEW_STARTED', { at: current.assignedAt, actorId: req.user.id });
    audit(data, req.user.id, 'REVIEW_CLAIMED', 'review_task', current.id, { reviewPool: current.reviewPool || 'GENERAL', assignedAt: current.assignedAt });
    return { task: enrichTask(current, data), representative, sales: sales.filter((user) => user.id !== representative?.id), title, reviewer: publicUser(req.user) };
  });
  if (result.blocked) return res.status(result.blocked.status).json({ error: result.blocked.error, code: result.blocked.code });
  const claimPayload = { title: 'Вопрос взят в работу', body: `${fullName(req.user)} (${roleLabel(req.user.role)}) · «${result.title}».`, taskId: result.task.id, icon: '/icons/icon-192.png' };
  await Promise.all([
    result.representative ? pushToUsers([result.representative], { ...claimPayload, conversationId: result.task.conversationId, url: `/?section=my-chats&conversation=${encodeURIComponent(result.task.conversationId)}` }) : null,
    pushToUsers(result.sales, { ...claimPayload, url: `/?section=queue&task=${encodeURIComponent(result.task.id)}` }),
  ]);
  res.json({ task: result.task });
}));

async function deliverAnswer(req, res, automatic = false) {
  let knowledgePayload = null;
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((item) => item.id === req.params.id);
    const blocked = deliveryBlock(task, req.user, Number(req.body.version), automatic);
    if (blocked) return { error: blocked };
    const answer = task.discussion.answer;
    const edited = task.discussion.edited;
    const now = new Date().toISOString();
    task.discussion.delivery = { mode: automatic ? (task.discussion.votes.length ? 'MAJORITY_24H' : 'NO_VOTES_24H') : 'EARLY_CONFIRMATION',
      by: automatic ? 'system' : req.user.id, at: now, ...tally(task.discussion) };
    audit(data, automatic ? 'system' : req.user.id, 'DISCUSSION_DELIVERED', 'review_task', task.id,
      { version: task.discussion.version, ...task.discussion.delivery });
    task.status = edited ? 'EDITED' : 'APPROVED';
    task.finalAnswer = answer;
    task.responseVersions ||= [];
    task.responseVersions.push({ id: id('answer-version'), type: edited ? 'EXPERT_EDIT' : 'EXPERT_APPROVAL', content: answer, authorId: req.user.id, createdAt: now });
    task.approvedBy = req.user.id;
    task.approvedAt = now;
    task.updatedAt = now;
    addStage(task, edited ? 'REVIEW_EDITED' : 'REVIEW_APPROVED', { at: now, actorId: req.user.id });
    addStage(task, 'ANSWER_DELIVERED', { at: now, actorId: req.user.id });
    data.messages.push({
      id: id('msg'), conversationId: task.conversationId, authorType: 'ASSISTANT', authorId: req.user.id,
      content: answer, isOfficial: true, reviewTaskId: task.id, rating: null, createdAt: now, deliveredAt: now,
    });
    const conversation = data.conversations.find((item) => item.id === task.conversationId);
    if (conversation) conversation.updatedAt = now;
    if (edited && (task.reviewPool || 'GENERAL') === 'GENERAL') {
      const question = data.messages.find((message) => message.id === task.questionMessageId)?.content || '';
      const entry = {
        id: id('knowledge'), question, answer, sourceReviewTaskId: task.id,
        createdBy: req.user.id, updatedBy: req.user.id, version: 1, isActive: true,
        versions: [{ version: 1, question, answer, authorId: req.user.id, createdAt: now }],
        indexedAt: null, indexStatus: 'PENDING', createdAt: now, updatedAt: now,
      };
      data.knowledgeEntries.unshift(entry);
      knowledgePayload = entry;
    }
    task.status = 'DELIVERED';
    const representative = findUserRecord(data, task.representativeId);
    const question = data.messages.find((message) => message.id === task.questionMessageId)?.content || '';
    const title = conversation?.title || 'Вопрос без названия';
    addNotification(data, representative, {
      type: 'ANSWER_READY', title: 'Ответ готов',
      body: `${fullName(req.user)} ответил на вопрос «${title}».`, taskId: task.id, conversationId: task.conversationId, createdAt: now,
    });
    const sales = activeUsersByRole(data, ['MANAGER']);
    for (const employee of sales.filter((user) => user.id !== representative?.id)) addNotification(data, employee, {
      type: 'ANSWER_DELIVERED', title: 'Ответ отправлен',
      body: `${fullName(req.user)} (${roleLabel(req.user.role)}) ответил ${fullName(representative)} в ${moscowTime(now)} по вопросу «${title}». ${edited ? 'Ответ ИИ исправлен.' : 'Черновик ИИ согласован.'}`,
      taskId: task.id, createdAt: now,
    });
    audit(data, req.user.id, edited ? 'REVIEW_EDITED_AND_DELIVERED' : 'REVIEW_APPROVED_AND_DELIVERED', 'review_task', task.id, { traceId: task.traceId, reviewPool: task.reviewPool || 'GENERAL', timing: taskTiming(task) });
    return { task: enrichTask(task, data), delivery: { representative: representative ? { ...publicUser(representative), webPushSubscriptions: representative.webPushSubscriptions || [] } : null, sales: sales.filter((user) => user.id !== representative?.id), reviewer: publicUser(req.user), edited, question, conversationTitle: title } };
  });
  if (result.error === 'unavailable') return res.status(409).json({ error: 'Вопрос уже обработан или возвращён.' });
  if (result.error === 'owner') return res.status(403).json({ error: 'Вопрос назначен другому эксперту.' });
  if (result.error === 'scope') return res.status(403).json({ error: 'Вопрос относится к другой очереди или был задан вами.' });

  if (result.delivery.representative) {
    const representativeName = fullName(result.delivery.representative);
    const [email, pushResults] = await Promise.all([
      sendAnswerReadyEmail({ to: result.delivery.representative.email, representativeName, reviewerName: fullName(result.delivery.reviewer), question: result.delivery.question, conversationTitle: result.delivery.conversationTitle }).catch((error) => ({ channel: 'error', error: error.message })),
      pushToUsers([result.delivery.representative], { title: 'Ответ готов', body: `${fullName(result.delivery.reviewer)} ответил на вопрос «${result.delivery.conversationTitle}».`, conversationId: result.task.conversationId, taskId: result.task.id, url: `/?section=my-chats&conversation=${encodeURIComponent(result.task.conversationId)}`, icon: '/icons/icon-192.png' }).catch((error) => [{ channel: 'error', error: error.message }]),
    ]);
    await store.mutate((data) => audit(data, 'system', 'ANSWER_READY_NOTIFICATION_SENT', 'review_task', result.task.id, { email, push: pushResults[0] || null }));
  }

  await pushToUsers(result.delivery.sales, {
    title: 'Ответ отправлен',
    body: `${fullName(result.delivery.reviewer)} ответил ${fullName(result.delivery.representative)} · ${moscowTime(result.task.approvedAt)} · «${result.delivery.conversationTitle}».`,
    taskId: result.task.id,
    url: `/?section=queue&task=${encodeURIComponent(result.task.id)}`,
    icon: '/icons/icon-192.png',
  });

  if (knowledgePayload) {
    try {
      const indexed = await rag.addKnowledge({
        id: knowledgePayload.id,
        question: knowledgePayload.question,
        answer: knowledgePayload.answer,
        sourceReviewTaskId: knowledgePayload.sourceReviewTaskId,
        authorId: req.user.id,
      });
      await store.mutate((data) => {
        const entry = data.knowledgeEntries.find((item) => item.id === knowledgePayload.id);
        if (entry) { entry.indexStatus = 'READY'; entry.indexedAt = indexed.indexedAt || new Date().toISOString(); }
      });
    } catch (error) {
      await store.mutate((data) => {
        const entry = data.knowledgeEntries.find((item) => item.id === knowledgePayload.id);
        if (entry) { entry.indexStatus = 'FAILED'; entry.indexError = error.message; }
      });
    }
  }
  res.json({ task: result.task });
}

async function submitDiscussion(req, res, edited) {
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((t) => t.id === req.params.id);
    if (!task || task.status !== 'IN_REVIEW' || !canManageReviewTask(req.user, task)
      || (task.assignedTo !== req.user.id && req.user.role !== 'ADMIN')) return null;
    const answer = edited ? String(req.body.answer || '').trim() : task.aiDraft;
    if (!answer || answer.trim().length < 3) return null;
    const discussion = propose(task, req.user, answer);
    task.responseVersions ||= [];
    task.responseVersions.push({ id: id('answer-version'), type: edited ? 'EXPERT_EDIT' : 'EXPERT_APPROVAL',
      content: discussion.answer, authorId: req.user.id, createdAt: discussion.proposedAt });
    addStage(task, 'DISCUSSION_STARTED', { at: discussion.proposedAt, actorId: req.user.id });
    const recipients = activeUsersByRole(data, ['EXPERT', 'SPECIALIST', 'MANAGER', 'ADMIN'])
      .filter((u) => u.id !== req.user.id && u.id !== task.representativeId && hasPermission(u, 'reviews.view'));
    const body = `${fullName(req.user)} предложил ответ на «${questionTitle(data, task)}». Голосование открыто на 24 часа.`;
    for (const u of recipients) addNotification(data, u, { type: 'DISCUSSION_STARTED', title: 'Ответ на обсуждении', body, taskId: task.id });
    audit(data, req.user.id, 'DISCUSSION_STARTED', 'review_task', task.id, { version: discussion.version, edited: discussion.edited, deadlineAt: discussion.deadlineAt });
    return { task: enrichTask(task, data), recipients, body };
  });
  if (!result) return res.status(409).json({ error: 'Ответ нельзя отправить на обсуждение. Проверьте текст и назначение вопроса.' });
  await pushToUsers(result.recipients.filter((u) => u.expertStatus !== 'DND'), {
    title: 'Ответ на обсуждении', body: result.body, taskId: result.task.id, url: `/?section=queue&task=${encodeURIComponent(result.task.id)}` });
  res.json({ task: result.task });
}

app.post('/api/reviews/:id/approve', authRequired, allowPermission('reviews.manage'), asyncRoute((req, res) => submitDiscussion(req, res, false)));
app.post('/api/reviews/:id/edit-and-send', authRequired, allowPermission('reviews.manage'), asyncRoute((req, res) => submitDiscussion(req, res, true)));
app.post('/api/reviews/:id/confirm-early', authRequired, allowPermission('reviews.manage'), asyncRoute((req, res) => deliverAnswer(req, res)));
app.post('/api/reviews/:id/revisions', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((t) => t.id === req.params.id);
    if (!task || !taskVisibleTo(req.user, task)) return { error: 'Вопрос недоступен.' };
    try {
      const revision = saveRevision(task, req.user, id('revision'), req.body.content, req.body.baseVersion);
      audit(data, req.user.id, 'REVIEW_REVISION_SAVED', 'review_task', task.id, { revisionId: revision.id, baseVersion: revision.baseVersion });
      return { task: enrichTask(task, data), revision };
    } catch (error) { return { error: error.message }; }
  });
  res.status(result.error ? 409 : 201).json(result);
}));
app.post('/api/reviews/:id/select-revision', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((t) => t.id === req.params.id);
    if (!task || !taskVisibleTo(req.user, task)) return { error: 'Вопрос недоступен.' };
    try {
      const d = selectRevision(task, req.user, String(req.body.revisionId || ''), Number(req.body.version));
      addStage(task, 'DISCUSSION_STARTED', { at: d.proposedAt, actorId: req.user.id });
      audit(data, req.user.id, 'DISCUSSION_REVISION_SELECTED', 'review_task', task.id, { version: d.version, revisionId: d.selectedRevisionId, deadlineAt: d.deadlineAt });
      const recipients = activeUsersByRole(data, ['EXPERT', 'SPECIALIST', 'ADMIN'])
        .filter((u) => u.id !== req.user.id && u.id !== task.representativeId && hasPermission(u, 'reviews.view'));
      const body = `${fullName(req.user)} выбрал новую редакцию ответа на «${questionTitle(data, task)}». Голосование началось заново на 24 часа.`;
      for (const u of recipients) addNotification(data, u, { type: 'DISCUSSION_STARTED', title: 'Новая редакция на обсуждении', body, taskId: task.id });
      return { task: enrichTask(task, data), recipients, body };
    } catch (error) { return { error: error.message }; }
  });
  if (result.error) return res.status(409).json({ error: result.error });
  await pushToUsers(result.recipients.filter((u) => u.expertStatus !== 'DND'), { title: 'Новая редакция на обсуждении', body: result.body, taskId: result.task.id, url: `/?section=queue&task=${encodeURIComponent(result.task.id)}` });
  res.json({ task: result.task });
}));
app.post('/api/reviews/:id/vote', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  if (!['YES', 'NO'].includes(req.body.value)) return res.status(400).json({ error: 'Выберите «За» или «Против».' });
  const result = await store.mutate((data) => {
    const task = data.reviewTasks.find((t) => t.id === req.params.id);
    const error = voteBlock(req.user, task, Number(req.body.version));
    if (error) return { error };
    recordVote(task, req.user, req.body.value);
    audit(data, req.user.id, 'DISCUSSION_VOTE', 'review_task', task.id, { version: task.discussion.version, value: req.body.value });
    return { task: enrichTask(task, data) };
  });
  if (result.error) return res.status(409).json(result);
  res.json(result);
}));

let discussionTickRunning = false;
export async function processDiscussions() {
  if (discussionTickRunning) return;
  discussionTickRunning = true;
  try {
    const data = store.read();
    for (const task of data.reviewTasks.filter((t) => t.status === 'DISCUSSION' && t.discussion)) {
      if (deliveryBlock(task, null, task.discussion.version, true)) continue;
      const author = findUserRecord(data, responsibleId(task)) || {
        id: responsibleId(task), firstName: task.discussion.proposedName, lastName: '', role: 'EXPERT' };
      const response = { status() { return this; }, json() {} };
      await deliverAnswer({ params: { id: task.id }, body: { version: task.discussion.version }, user: author }, response, true);
    }
  } catch (error) { console.error('Discussion scheduler:', error.message); }
  finally { discussionTickRunning = false; }
}

app.post('/api/reviews/:id/return', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const comment = String(req.body.comment || '').trim();
  if (comment.length < 3) return res.status(400).json({ error: 'Укажите причину возврата.' });
  const expertId = String(req.body.expertId || '');
  const task = await store.mutate((data) => {
    const current = data.reviewTasks.find((item) => item.id === req.params.id);
    if (!current || !['IN_REVIEW', 'DISCUSSION'].includes(current.status)) return null;
    const isDiscussion = current.status === 'DISCUSSION';
    if (isDiscussion ? deliveryBlock(current, req.user, Number(req.body.version)) : !canManageReviewTask(req.user, current)) return null;
    if (!isDiscussion && current.assignedTo !== req.user.id && req.user.role !== 'ADMIN') return null;
    const recipient = data.users.find((u) => u.id === expertId && u.isActive && ['EXPERT', 'SPECIALIST'].includes(u.role)
      && hasPermission(u, 'reviews.manage') && u.id !== current.representativeId);
    if (!recipient) return null;
    const now = new Date().toISOString();
    if (isDiscussion) { current.aiDraft = current.discussion.answer; archiveDiscussion(current, 'RETURNED'); }
    current.returnHistory ||= [];
    current.returnHistory.push({ comment, returnedTo: expertId, returnedBy: req.user.id, returnedAt: now });
    current.returnTo = expertId;
    current.routedTo = expertId;
    current.routedAt = now;
    current.reviewPool = recipient.role === 'SPECIALIST' ? 'SPECIALIST' : 'GENERAL';
    current.returnComment = comment;
    current.status = 'WAITING_REVIEW';
    current.assignedTo = null;
    current.assignedAt = null;
    current.reminderSentAt = null;
    current.reminderHistory = [];
    current.updatedAt = new Date().toISOString();
    addStage(current, 'REVIEW_RETURNED', { at: current.updatedAt, actorId: req.user.id, meta: { comment } });
    audit(data, req.user.id, 'REVIEW_RETURNED', 'review_task', current.id, { comment, returnedTo: expertId });
    addNotification(data, recipient, { type: 'REVIEW_RETURNED', title: 'Вам адресован вопрос', body: `${questionTitle(data, current)}: ${comment}`, taskId: current.id });
    return { task: enrichTask(current, data), recipient };
  });
  if (!task) return res.status(409).json({ error: 'Вопрос недоступен для возврата.' });
  await pushToUsers([task.recipient], { title: 'Вам адресован вопрос', body: comment, taskId: task.task.id, url: `/?section=queue&task=${encodeURIComponent(task.task.id)}` });
  res.json({ task: task.task });
}));

app.patch('/api/reviews/:id/routing', authRequired, allowPermission('reviews.route'), asyncRoute(async (req, res) => {
  const priority = String(req.body.priority || '');
  const requestedPool = req.body.reviewPool == null ? undefined : String(req.body.reviewPool).toUpperCase();
  const routedTo = req.body.routedTo == null ? undefined : String(req.body.routedTo);
  const specialty = req.body.specialty == null ? undefined : String(req.body.specialty).trim().slice(0, 120);
  if (priority && !PRIORITIES[priority]) return res.status(400).json({ error: 'Некорректный приоритет.' });
  if (requestedPool !== undefined && !['GENERAL', 'SPECIALIST'].includes(requestedPool)) return res.status(400).json({ error: 'Некорректная очередь.' });
  const task = await store.mutate((data) => {
    const current = data.reviewTasks.find((item) => item.id === req.params.id && !['DELIVERED', 'DISCUSSION'].includes(item.status));
    if (!current || !taskVisibleTo(req.user, current)) return null;
    if (requestedPool !== undefined) {
      if (!['MANAGER', 'ADMIN'].includes(req.user.role)) return null;
      if (current.reviewPool !== requestedPool) {
        current.reviewPool = requestedPool;
        current.routingMode = 'MANUAL';
        current.routingConfidence = 1;
        current.routingReason = `Перенаправлено пользователем ${fullName(req.user)}.`;
        current.routedTo = null;
        current.routedAt = null;
        current.returnTo = null;
        if (current.status === 'IN_REVIEW') {
          current.status = 'WAITING_REVIEW';
          current.assignedTo = null;
          current.assignedAt = null;
          current.reminderHistory = [];
        }
      }
    }
    if (priority) { current.priority = priority; current.slaMinutes = PRIORITIES[priority].slaMinutes; }
    if (specialty !== undefined) current.specialty = specialty || null;
    if (routedTo !== undefined) {
      const expert = routedTo ? data.users.find((item) => item.id === routedTo && item.isActive && reviewRoles.includes(item.role) && reviewPoolsForRole(item.role).includes(current.reviewPool || 'GENERAL')) : null;
      if (routedTo && !expert) return null;
      current.routedTo = expert?.id || null;
      current.returnTo = null;
      current.routedAt = expert ? new Date().toISOString() : null;
      current.routingMode = expert ? 'MANUAL' : null;
    }
    current.updatedAt = new Date().toISOString();
    addStage(current, 'ROUTING_UPDATED', { at: current.updatedAt, actorId: req.user.id, meta: { priority: current.priority, reviewPool: current.reviewPool, routedTo: current.routedTo, specialty: current.specialty } });
    audit(data, req.user.id, 'REVIEW_ROUTING_UPDATED', 'review_task', current.id, { priority: current.priority, reviewPool: current.reviewPool, routedTo: current.routedTo, specialty: current.specialty });
    return enrichTask(current, data);
  });
  if (!task) return res.status(404).json({ error: 'Вопрос или эксперт не найден.' });
  res.json({ task });
}));

app.post('/api/reviews/:id/transfer', authRequired, allowPermission('reviews.manage'), asyncRoute(async (req, res) => {
  const expertId = String(req.body.expertId || '');
  const comment = String(req.body.comment || '').trim().slice(0, 1000);
  if (comment.length < 3) return res.status(400).json({ error: 'Укажите причину передачи.' });
  const result = await store.mutate((data) => {
    const current = data.reviewTasks.find((item) => item.id === req.params.id && item.status === 'IN_REVIEW');
    const expert = data.users.find((item) => item.id === expertId && item.isActive && reviewRoles.includes(item.role) && reviewPoolsForRole(item.role).includes(current?.reviewPool || 'GENERAL'));
    if (!current || !expert || !canManageReviewTask(req.user, current) || (current.assignedTo !== req.user.id && req.user.role !== 'ADMIN')) return null;
    const now = new Date().toISOString();
    current.transferHistory ||= [];
    current.transferHistory.push({ from: current.assignedTo, to: expert.id, comment, transferredBy: req.user.id, transferredAt: now });
    current.assignedTo = expert.id;
    current.assignedAt = now;
    current.updatedAt = now;
    current.reminderSentAt = null;
    current.reminderHistory = [];
    addStage(current, 'REVIEW_TRANSFERRED', { at: now, actorId: req.user.id, meta: { to: expert.id, comment } });
    data.notifications.unshift({ id: id('notice'), userId: expert.id, type: 'REVIEW_TRANSFERRED', title: 'Вам передан вопрос', body: comment, taskId: current.id, isRead: false, createdAt: now });
    audit(data, req.user.id, 'REVIEW_TRANSFERRED', 'review_task', current.id, { to: expert.id, comment });
    return { task: enrichTask(current, data), expert: { ...publicUser(expert), webPushSubscriptions: expert.webPushSubscriptions || [] } };
  });
  if (!result) return res.status(409).json({ error: 'Вопрос нельзя передать выбранному эксперту.' });
  await pushToUsers([result.expert], { title: 'Вам передан вопрос', body: comment, taskId: result.task.id, url: `/?section=queue&task=${encodeURIComponent(result.task.id)}` }).catch(() => undefined);
  res.json({ task: result.task });
}));

app.post('/api/reviews/:id/comments', authRequired, allowPermission('reviews.view'), asyncRoute(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 3000);
  const mentionIds = Array.isArray(req.body.mentionIds) ? [...new Set(req.body.mentionIds.map(String))].slice(0, 20) : [];
  if (text.length < 2) return res.status(400).json({ error: 'Введите комментарий.' });
  const result = await store.mutate((data) => {
    const current = data.reviewTasks.find((item) => item.id === req.params.id);
    if (!current || !taskVisibleTo(req.user, current)) return null;
    const mentions = data.users.filter((item) => item.isActive && mentionIds.includes(item.id) && reviewRoles.includes(item.role) && taskVisibleTo(item, current));
    const comment = { id: id('comment'), authorId: req.user.id, text, mentionIds: mentions.map((item) => item.id), createdAt: new Date().toISOString() };
    current.internalComments ||= [];
    current.internalComments.push(comment);
    current.updatedAt = comment.createdAt;
    for (const user of mentions) data.notifications.unshift({ id: id('notice'), userId: user.id, type: 'REVIEW_MENTION', title: `${fullName(req.user)} упомянул вас`, body: text.slice(0, 180), taskId: current.id, isRead: false, createdAt: comment.createdAt });
    audit(data, req.user.id, 'REVIEW_COMMENTED', 'review_task', current.id, { mentionIds: comment.mentionIds });
    return { task: enrichTask(current, data), mentions: mentions.map((user) => ({ ...publicUser(user), webPushSubscriptions: user.webPushSubscriptions || [] })) };
  });
  if (!result) return res.status(404).json({ error: 'Вопрос не найден.' });
  await pushToUsers(result.mentions, { title: 'Вас упомянули в вопросе', body: text.slice(0, 160), taskId: result.task.id, url: `/?section=queue&task=${encodeURIComponent(result.task.id)}` }).catch(() => undefined);
  res.status(201).json({ task: result.task });
}));

app.get('/api/knowledge', authRequired, allowPermission('knowledge.manage'), (_req, res) => {
  const data = store.read();
  const entries = data.knowledgeEntries.map((entry) => ({ ...entry, author: publicUser(findUserRecord(data, entry.updatedBy)) }));
  res.json({ entries });
});

app.patch('/api/knowledge/:id', authRequired, allowPermission('knowledge.manage'), asyncRoute(async (req, res) => {
  const question = String(req.body.question || '').trim();
  const answer = String(req.body.answer || '').trim();
  const isActive = req.body.isActive;
  if (question.length < 3 || answer.length < 3) return res.status(400).json({ error: 'Вопрос и ответ обязательны.' });
  const entry = await store.mutate((data) => {
    const current = data.knowledgeEntries.find((item) => item.id === req.params.id);
    if (!current) return null;
    current.versions ||= [{ version: current.version || 1, question: current.question, answer: current.answer, authorId: current.updatedBy || current.createdBy, createdAt: current.updatedAt || current.createdAt }];
    current.question = question;
    current.answer = answer;
    if (typeof isActive === 'boolean') current.isActive = isActive;
    current.updatedBy = req.user.id;
    current.updatedAt = new Date().toISOString();
    current.version += 1;
    current.versions.unshift({ version: current.version, question, answer, authorId: req.user.id, createdAt: current.updatedAt });
    current.indexStatus = 'PENDING';
    audit(data, req.user.id, 'KNOWLEDGE_UPDATED', 'knowledge_entry', current.id, { version: current.version, isActive: current.isActive });
    return current;
  });
  if (!entry) return res.status(404).json({ error: 'Запись не найдена.' });
  try {
    const indexed = await rag.updateKnowledge(entry.id, entry);
    await store.mutate((data) => {
      const current = data.knowledgeEntries.find((item) => item.id === entry.id);
      current.indexStatus = 'READY';
      current.indexedAt = indexed.indexedAt || new Date().toISOString();
      delete current.indexError;
    });
  } catch (error) {
    await store.mutate((data) => {
      const current = data.knowledgeEntries.find((item) => item.id === entry.id);
      current.indexStatus = 'FAILED'; current.indexError = error.message;
    });
  }
  res.json({ entry: store.read().knowledgeEntries.find((item) => item.id === entry.id) });
}));

app.get('/api/documents', authRequired, allowPermission('knowledge.manage'), asyncRoute(async (_req, res) => res.json(await rag.documents())));
app.post('/api/documents', authRequired, allowPermission('documents.manage'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите PDF-документ.' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) return res.status(400).json({ error: 'Поддерживаются только PDF-документы.' });
  const result = await rag.uploadDocument(req.file);
  await store.mutate((data) => audit(data, req.user.id, 'DOCUMENT_UPLOADED', 'knowledge_document', req.file.originalname));
  res.status(202).json(result);
}));
app.post('/api/documents/:filename/versions/:version/restore', authRequired, allowPermission('documents.manage'), asyncRoute(async (req, res) => {
  const result = await rag.restoreDocumentVersion(req.params.filename, Number(req.params.version));
  await store.mutate((data) => audit(data, req.user.id, 'DOCUMENT_VERSION_RESTORED', 'knowledge_document', req.params.filename, { version: Number(req.params.version) }));
  res.status(202).json(result);
}));
app.delete('/api/documents/:filename', authRequired, allowPermission('documents.manage'), asyncRoute(async (req, res) => {
  const result = await rag.deleteDocument(req.params.filename);
  await store.mutate((data) => audit(data, req.user.id, 'DOCUMENT_DELETED', 'knowledge_document', req.params.filename,
    { removedChunks: result.removedChunks, removedFiles: result.removedFiles }));
  res.json(result);
}));
app.post('/api/documents/reindex', authRequired, allowPermission('documents.manage'), asyncRoute(async (req, res) => {
  const result = await rag.reindex();
  await store.mutate((data) => audit(data, req.user.id, 'DOCUMENT_REINDEX_STARTED', 'system', 'knowledge-index'));
  res.status(202).json(result);
}));

app.get('/api/admin/users', authRequired, allowPermission('users.manage'), (_req, res) => res.json({ users: store.read().users.map(publicUser), permissionCatalog }));

app.post('/api/admin/users', authRequired, allowPermission('users.manage'), asyncRoute(async (req, res) => {
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role;
  if (!firstName || !lastName || !email.includes('@') || password.length < 8 || !userRoles.includes(role)) {
    return res.status(400).json({ error: 'Заполните имя, фамилию, корректную почту, роль и пароль от 8 символов.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const outcome = await store.mutate((data) => {
    if (data.users.some((user) => user.email.toLowerCase() === email)) return null;
    const now = new Date().toISOString();
    const user = {
      id: id('usr'), firstName, lastName, email, role, isActive: true, passwordHash,
      expertStatus: reviewRoles.includes(role) ? 'AVAILABLE' : undefined,
      specialties: Array.isArray(req.body.specialties) ? req.body.specialties.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [],
      products: Array.isArray(req.body.products) ? req.body.products.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 100) : [],
      permissionOverrides: req.body.permissionOverrides && typeof req.body.permissionOverrides === 'object' ? req.body.permissionOverrides : {},
      createdAt: now, updatedAt: now,
    };
    data.users.push(user);
    audit(data, req.user.id, 'USER_CREATED', 'user', user.id, { email, role });
    return publicUser(user);
  });
  if (!outcome) return res.status(409).json({ error: 'Пользователь с такой почтой уже существует.' });
  res.status(201).json({ user: outcome });
}));

app.patch('/api/admin/users/:id', authRequired, allowPermission('users.manage'), asyncRoute(async (req, res) => {
  const user = await store.mutate(async (data) => {
    const current = data.users.find((item) => item.id === req.params.id);
    if (!current) return null;
    for (const field of ['firstName', 'lastName', 'email']) {
      if (typeof req.body[field] === 'string' && req.body[field].trim()) current[field] = req.body[field].trim();
    }
    if (userRoles.includes(req.body.role)) current.role = req.body.role;
    if (Array.isArray(req.body.specialties)) current.specialties = req.body.specialties.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30);
    if (Array.isArray(req.body.products)) current.products = req.body.products.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 100);
    if (req.body.permissionOverrides && typeof req.body.permissionOverrides === 'object') {
      current.permissionOverrides = Object.fromEntries(Object.entries(req.body.permissionOverrides).filter(([permission, enabled]) => permissionCatalog.some((item) => item.id === permission) && typeof enabled === 'boolean'));
    }
    if (EXPERT_STATUSES.has(req.body.expertStatus)) current.expertStatus = req.body.expertStatus;
    if (typeof req.body.isActive === 'boolean') current.isActive = req.body.isActive;
    if (req.body.password && String(req.body.password).length >= 8) current.passwordHash = await bcrypt.hash(String(req.body.password), 10);
    current.updatedAt = new Date().toISOString();
    audit(data, req.user.id, 'USER_UPDATED', 'user', current.id, { role: current.role, isActive: current.isActive });
    return publicUser(current);
  });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });
  res.json({ user });
}));

app.delete('/api/admin/users/:id', authRequired, allowPermission('users.manage'), asyncRoute(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить собственную учётную запись.' });
  const outcome = await store.mutate((data) => {
    const result = deleteUserAccount(data, req.params.id);
    if (!result) return null;
    for (const taskId of result.releasedTaskIds) {
      audit(data, req.user.id, 'REVIEW_RELEASED_AFTER_USER_DELETE', 'review_task', taskId, { deletedUserId: result.user.id });
    }
    audit(data, req.user.id, 'USER_DELETED', 'user', result.user.id, {
      email: result.user.email,
      role: result.user.role,
      name: fullName(result.user),
      releasedReviewTasks: result.releasedTaskIds.length,
      removedNotifications: result.notificationCount,
    });
    return result;
  });
  if (!outcome) return res.status(404).json({ error: 'Пользователь не найден.' });
  res.json({ deleted: true, userId: outcome.user.id, releasedReviewTasks: outcome.releasedTaskIds.length });
}));

app.get('/api/admin/audit', authRequired, allowPermission('audit.view'), (req, res) => {
  const data = store.read();
  const query = String(req.query.q || '').trim().toLowerCase();
  const actorId = String(req.query.actorId || '');
  const action = String(req.query.action || '');
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ''))
    ? new Date(`${req.query.dateFrom}T00:00:00`).getTime() : null;
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ''))
    ? new Date(`${req.query.dateTo}T23:59:59.999`).getTime() : null;

  let events = data.auditEvents.map((event) => {
    const actor = findUserRecord(data, event.actorId);
    return {
      ...event,
      actorName: event.actorId === 'system' ? 'Система' : actor ? fullName(actor) : 'Неизвестный пользователь',
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
    };
  });
  if (query) {
    events = events.filter((event) => [
      event.actorName, event.actorEmail, event.action, event.entityType, event.entityId,
      JSON.stringify(event.details || {}),
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }
  if (actorId) events = events.filter((event) => event.actorId === actorId);
  if (action) events = events.filter((event) => event.action === action);
  if (dateFrom != null) events = events.filter((event) => new Date(event.createdAt).getTime() >= dateFrom);
  if (dateTo != null) events = events.filter((event) => new Date(event.createdAt).getTime() <= dateTo);
  events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = events.length;
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const pagedEvents = events.slice((page - 1) * pageSize, page * pageSize);
  const actors = [...data.users, ...(data.settings.deletedUsers || [])]
    .map((user) => ({ id: user.id, name: fullName(user), email: user.email, role: user.role, deletedAt: user.deletedAt || null }));
  const actions = [...new Set(data.auditEvents.map((event) => event.action))].sort();
  res.json({ events: pagedEvents, actors, actions, pagination: { page, pageSize, total, pages } });
});

app.get('/api/admin/dashboard', authRequired, allowPermission('analytics.view'), asyncRoute(async (_req, res) => {
  const data = store.read();
  let ragHealth;
  try { ragHealth = await rag.health(); } catch (error) { ragHealth = { status: 'down', error: error.message }; }
  let database;
  try { database = await store.health(); } catch (error) { database = { status: 'down', engine: 'PostgreSQL', error: error.message }; }
  const trackedTasks = data.reviewTasks.filter((task) => isAfterStatisticsReset(data, task.createdAt));
  const trackedMessages = data.messages.filter((message) => isAfterStatisticsReset(data, message.ratedAt || message.createdAt));
  const waitingTasks = trackedTasks.filter((task) => task.status === 'WAITING_REVIEW');
  const overdue = trackedTasks.filter((task) => task.status === 'IN_REVIEW' && task.assignedAt && Date.now() - new Date(task.assignedAt).getTime() >= 30 * 60_000);
  const auditEvents = data.auditEvents.slice(0, 30).map((event) => {
    const actor = findUserRecord(data, event.actorId);
    return { ...event, actorName: event.actorId === 'system' ? 'Система' : actor ? fullName(actor) : 'Неизвестный пользователь' };
  });
  res.json({
    stats: {
      users: data.users.filter((user) => user.isActive).length,
      waiting: trackedTasks.filter((task) => task.status === 'WAITING_REVIEW').length,
      inReview: trackedTasks.filter((task) => task.status === 'IN_REVIEW').length,
      delivered: trackedTasks.filter((task) => task.status === 'DELIVERED').length,
      knowledge: data.knowledgeEntries.filter((entry) => entry.isActive).length,
      positiveRatings: trackedMessages.filter((message) => message.rating === 'UP').length,
      negativeRatings: trackedMessages.filter((message) => message.rating === 'DOWN').length,
      overdue: overdue.length,
      oldestWaitingMinutes: waitingTasks.length ? Math.max(...waitingTasks.map((task) => Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 60_000))) : 0,
    },
    rag: ragHealth,
    components: [
      { name: 'Веб-API', status: 'ok', detail: 'Node.js отвечает' },
      { name: 'RAG-сервис', status: ragHealth.status === 'ok' ? 'ok' : 'down', detail: ragHealth.status === 'ok' ? 'Python отвечает' : (ragHealth.error || 'Нет соединения') },
      { name: 'Модель ИИ', status: ragHealth.core === 'configured' ? 'ok' : 'warning', detail: ragHealth.model || 'Ключ не настроен' },
      { name: 'Векторный индекс', status: ragHealth.indexAvailable ? 'ok' : 'warning', detail: ragHealth.indexAvailable ? `${ragHealth.chunks || 0} фрагментов` : 'Индекс не найден' },
      { name: 'PostgreSQL', status: database.status === 'ok' ? 'ok' : 'down', detail: database.status === 'ok' ? `${database.database} · ревизия ${database.revision}` : (database.error || 'Нет соединения') },
      { name: 'Почтовые уведомления', status: process.env.SMTP_HOST ? 'ok' : 'warning', detail: process.env.SMTP_HOST ? 'SMTP подключён' : 'Локальная папка outbox' },
      { name: 'PWA-уведомления', status: pushConfigured() ? 'ok' : 'warning', detail: pushConfigured() ? 'Web Push подключён' : 'VAPID-ключи не настроены' },
    ],
    audit: auditEvents,
    analytics: buildAnalytics(data),
    metricsResetAt: data.settings.metricsResetAt || null,
  });
}));

app.get('/api/admin/push/devices', authRequired, allowPermission('system.manage'), (_req, res) => {
  const users = store.read().users
    .filter((user) => user.isActive)
    .map((user) => ({
      ...publicUser(user),
      devices: (user.webPushSubscriptions || []).map(publicPushDevice),
    }))
    .sort((left, right) => `${left.lastName} ${left.firstName}`.localeCompare(`${right.lastName} ${right.firstName}`, 'ru'));
  res.json({ configured: pushConfigured(), users });
});

app.post('/api/admin/push/test', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const userId = String(req.body?.userId || '');
  const user = store.read().users.find((item) => item.id === userId && item.isActive);
  if (!user) return res.status(404).json({ error: 'Пользователь для теста не найден.' });
  if (!(user.webPushSubscriptions || []).length) return res.status(409).json({ error: 'У пользователя нет зарегистрированных push-устройств. Откройте PWA под его учётной записью.' });
  const [delivery] = await pushToUsers([user], {
    title: 'Тест RagChat',
    body: `Push-уведомления для ${fullName(user)} работают.`,
    url: '/',
    icon: '/icons/icon-192.png',
  });
  await store.mutate((data) => audit(data, req.user.id, 'PUSH_TESTED', 'user', user.id, {
    delivered: delivery?.delivered || 0,
    failed: delivery?.failed || 0,
  }));
  res.json({ delivery: { channel: delivery?.channel || 'web-push', delivered: delivery?.delivered || 0, failed: delivery?.failed || 0 } });
}));

app.delete('/api/admin/push/devices/:userId/:deviceId', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await store.mutate((data) => {
    const user = data.users.find((item) => item.id === req.params.userId);
    if (!user) return { error: 'user' };
    const before = user.webPushSubscriptions || [];
    user.webPushSubscriptions = before.filter((item) => (item.id || pushDeviceId(item.endpoint)) !== req.params.deviceId);
    if (user.webPushSubscriptions.length === before.length) return { error: 'device' };
    audit(data, req.user.id, 'PUSH_DEVICE_REMOVED', 'user', user.id, { deviceId: req.params.deviceId });
    return { userId: user.id };
  });
  if (result.error === 'user') return res.status(404).json({ error: 'Пользователь не найден.' });
  if (result.error === 'device') return res.status(404).json({ error: 'Push-устройство не найдено.' });
  res.status(204).end();
}));

app.get('/api/admin/analytics', authRequired, allowPermission('analytics.view'), (req, res) => {
  const data = store.read();
  res.json({
    analytics: buildAnalytics(data, req.query),
    representatives: data.users.filter((user) => representativeRoles.includes(user.role)).map(publicUser),
    experts: data.users.filter((user) => reviewRoles.includes(user.role)).map(publicUser),
  });
});

app.post('/api/admin/analytics/reset', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Сбрасывать статистику может только администратор.' });
  const resetAt = await store.mutate((data) => {
    const value = new Date().toISOString();
    data.settings.metricsResetAt = value;
    audit(data, req.user.id, 'ANALYTICS_RESET', 'system', 'analytics', { resetAt: value });
    return value;
  });
  res.json({ resetAt });
}));

app.get('/api/admin/analytics/export.xlsx', authRequired, allowPermission('analytics.export'), asyncRoute(async (req, res) => {
  const data = store.read();
  const analytics = buildAnalytics(data, req.query);
  const auditEvents = data.auditEvents.map((event) => {
    const actor = findUserRecord(data, event.actorId);
    return { ...event, actorName: event.actorId === 'system' ? 'Система' : actor ? fullName(actor) : 'Неизвестный пользователь', actorEmail: actor?.email || '' };
  });
  const buffer = await analyticsWorkbook(analytics, auditEvents);
  await store.mutate((next) => audit(next, req.user.id, 'ANALYTICS_EXPORTED', 'system', 'analytics', { filters: req.query }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ragchat-analytics-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

app.get('/api/admin/sources', authRequired, allowPermission('system.manage'), asyncRoute(async (_req, res) => res.json(await rag.sources())));
app.post('/api/admin/sources', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await rag.addSource(req.body);
  await store.mutate((data) => audit(data, req.user.id, 'SOURCE_CREATED', 'trusted_source', result.source.domain));
  res.status(201).json(result);
}));
app.patch('/api/admin/sources/:domain', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await rag.updateSource(req.params.domain, req.body);
  await store.mutate((data) => audit(data, req.user.id, 'SOURCE_UPDATED', 'trusted_source', result.source.domain));
  res.json(result);
}));
app.delete('/api/admin/sources/:domain', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await rag.deleteSource(req.params.domain);
  await store.mutate((data) => audit(data, req.user.id, 'SOURCE_DELETED', 'trusted_source', req.params.domain));
  res.json(result);
}));

app.get('/api/admin/api-key', authRequired, allowPermission('system.manage'), asyncRoute(async (_req, res) => res.json(await rag.getKeyStatus())));
app.put('/api/admin/api-key', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const apiKey = String(req.body.apiKey || '').trim();
  if (apiKey.length < 10) return res.status(400).json({ error: 'Введите корректный API-ключ.' });
  const result = await rag.updateKey(apiKey);
  await store.mutate((data) => audit(data, req.user.id, 'LLM_KEY_UPDATED', 'system', result.model || 'llm'));
  res.json(result);
}));

app.post('/api/admin/reminders/run', authRequired, allowPermission('system.manage'), asyncRoute(async (_req, res) => res.json(await processReminders())));
app.post('/api/admin/diagnostics/model', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await rag.selfTest();
  await store.mutate((data) => audit(data, req.user.id, 'MODEL_DIAGNOSTIC_RUN', 'system', result.model || 'llm'));
  res.json(result);
}));
app.post('/api/admin/diagnostics/email', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await sendTestEmail({ to: req.user.email, administratorName: fullName(req.user) });
  await store.mutate((data) => audit(data, req.user.id, 'EMAIL_DIAGNOSTIC_RUN', 'system', result.channel));
  res.json(result);
}));
app.post('/api/admin/diagnostics/cache', authRequired, allowPermission('system.manage'), asyncRoute(async (req, res) => {
  const result = await rag.clearCache();
  await store.mutate((data) => audit(data, req.user.id, 'RAG_CACHE_CLEARED', 'system', 'rag-core'));
  res.json(result);
}));

app.use((error, _req, res, _next) => {
  if ([400, 404, 409, 410, 413].includes(error.ragStatus)) {
    return res.status(error.ragStatus).json({ error: error.message });
  }
  console.error(error);
  res.status(500).json({ error: 'Внутренняя ошибка сервиса.' });
});

if (process.env.NODE_ENV !== 'test') {
  await store.init();
  const titleCandidates = await initializeConversationTitles();
  for (const candidate of titleCandidates) void generateConversationTitle(candidate.conversationId, candidate);
  startReminderScheduler();
  void processDiscussions();
  setInterval(() => void processDiscussions(), 30_000).unref();
  app.listen(port, () => console.log(`RagChat API: http://localhost:${port}`));
}

export default app;
