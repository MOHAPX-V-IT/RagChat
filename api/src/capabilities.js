export const userRoles = ['REQUESTER', 'EXPERT', 'SPECIALIST', 'MANAGER', 'ADMIN'];
export const representativeRoles = ['REQUESTER', 'MANAGER', 'ADMIN'];
export const reviewRoles = ['EXPERT', 'SPECIALIST', 'MANAGER', 'ADMIN'];
export const oversightRoles = ['MANAGER', 'ADMIN'];

export const canUseRepresentativeWorkspace = (role) => representativeRoles.includes(role);
export const canReviewAnswers = (role) => reviewRoles.includes(role);

export const permissionCatalog = [
  { id: 'chats.use', label: 'Создавать собственные диалоги' },
  { id: 'reviews.view', label: 'Просматривать очередь вопросов' },
  { id: 'reviews.manage', label: 'Брать и согласовывать вопросы' },
  { id: 'reviews.route', label: 'Менять приоритет и назначение' },
  { id: 'directory.view', label: 'Просматривать сотрудников и их статусы' },
  { id: 'knowledge.manage', label: 'Управлять экспертными знаниями' },
  { id: 'documents.manage', label: 'Управлять документами' },
  { id: 'users.manage', label: 'Управлять пользователями' },
  { id: 'audit.view', label: 'Просматривать аудит' },
  { id: 'analytics.view', label: 'Просматривать аналитику' },
  { id: 'analytics.export', label: 'Экспортировать аналитику' },
  { id: 'system.manage', label: 'Управлять системой и API' },
];

const defaults = {
  REQUESTER: new Set(['chats.use']),
  EXPERT: new Set(['reviews.view', 'reviews.manage', 'reviews.route', 'knowledge.manage']),
  SPECIALIST: new Set(['reviews.view', 'reviews.manage', 'reviews.route']),
  MANAGER: new Set(['chats.use', 'reviews.view', 'reviews.manage', 'reviews.route', 'directory.view', 'audit.view', 'analytics.view', 'analytics.export']),
  ADMIN: new Set(permissionCatalog.map((item) => item.id)),
};

export function reviewPoolsForRole(role) {
  if (role === 'EXPERT') return ['GENERAL'];
  if (role === 'SPECIALIST') return ['SPECIALIST'];
  if (role === 'MANAGER' || role === 'ADMIN') return ['GENERAL', 'SPECIALIST'];
  return [];
}

export function canAccessReviewPool(user, pool) {
  return reviewPoolsForRole(user?.role).includes(pool || 'GENERAL');
}

export function canManageReviewTask(user, task) {
  if (!hasPermission(user, 'reviews.manage') || !canAccessReviewPool(user, task?.reviewPool)) return false;
  return user.role === 'ADMIN' || task?.representativeId !== user?.id;
}

export function reviewClaimBlock(user, task, now = Date.now()) {
  if (!task) return { code: 'NOT_FOUND', status: 404, error: 'Вопрос не найден. Обновите очередь.' };
  if (task.status !== 'WAITING_REVIEW') return { code: 'STATUS_CHANGED', status: 409, error: task.status === 'IN_REVIEW' ? 'Вопрос уже взят другим сотрудником. Обновите очередь.' : 'Статус вопроса изменился. Обновите очередь.' };
  if (!hasPermission(user, 'reviews.manage')) return { code: 'PERMISSION', status: 403, error: 'У вашей учётной записи нет права брать вопросы в работу.' };
  if (!canAccessReviewPool(user, task.reviewPool)) return { code: 'OTHER_POOL', status: 403, error: task.reviewPool === 'SPECIALIST' ? 'Вопрос относится к очереди профильных экспертов.' : 'Вопрос относится к общей очереди.' };
  if (user.role !== 'ADMIN' && task.representativeId === user.id) return { code: 'OWN_QUESTION', status: 409, error: 'Нельзя согласовывать собственный вопрос.' };
  const protectedUntil = task.routedAt ? new Date(task.routedAt).getTime() + 15 * 60_000 : 0;
  if (user.role !== 'ADMIN' && task.routedTo && task.routedTo !== user.id && now < protectedUntil) {
    return { code: 'ROUTED_TO_ANOTHER', status: 409, error: 'Вопрос временно назначен другому сотруднику.' };
  }
  return null;
}

export function effectivePermissions(user) {
  const values = new Set(defaults[user?.role] || []);
  for (const [permission, enabled] of Object.entries(user?.permissionOverrides || {})) {
    if (enabled) values.add(permission);
    else values.delete(permission);
  }
  return [...values];
}

export function hasPermission(user, permission) {
  return effectivePermissions(user).includes(permission);
}

export function allowPermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permission)) return res.status(403).json({ error: 'Недостаточно прав для этого действия.' });
    next();
  };
}
