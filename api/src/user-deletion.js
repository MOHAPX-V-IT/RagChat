const archivedUsers = (data) => Array.isArray(data.settings?.deletedUsers) ? data.settings.deletedUsers : [];

export function findUserRecord(data, userId) {
  if (!userId) return null;
  return data.users.find((user) => user.id === userId)
    || archivedUsers(data).find((user) => user.id === userId)
    || null;
}

export function deleteUserAccount(data, userId, deletedAt = new Date().toISOString()) {
  const userIndex = data.users.findIndex((user) => user.id === userId);
  if (userIndex < 0) return null;

  const [user] = data.users.splice(userIndex, 1);
  const snapshot = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    isActive: false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    deletedAt,
  };

  data.settings.deletedUsers = [
    ...archivedUsers(data).filter((item) => item.id !== user.id),
    snapshot,
  ];

  const releasedTaskIds = [];
  for (const task of data.reviewTasks) {
    if (task.status !== 'IN_REVIEW' || task.assignedTo !== user.id) continue;
    task.status = 'WAITING_REVIEW';
    task.assignedTo = null;
    task.assignedAt = null;
    task.returnComment = 'Назначенный эксперт был удалён администратором. Вопрос возвращён в общую очередь.';
    task.updatedAt = deletedAt;
    releasedTaskIds.push(task.id);
  }

  const notificationCount = data.notifications.filter((item) => item.userId === user.id).length;
  data.notifications = data.notifications.filter((item) => item.userId !== user.id);

  return { user: snapshot, releasedTaskIds, notificationCount };
}
