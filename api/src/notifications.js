export function markAllNotificationsRead(notifications, userId) {
  let updated = 0;
  for (const notification of notifications) {
    if (notification.userId !== userId || notification.isRead) continue;
    notification.isRead = true;
    updated += 1;
  }
  return updated;
}
