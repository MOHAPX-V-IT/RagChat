import webpush from 'web-push';
import { createHash } from 'node:crypto';

const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const subject = process.env.VAPID_SUBJECT || `mailto:${process.env.SMTP_FROM || 'ragchat@localhost'}`;

if (publicKey && privateKey) webpush.setVapidDetails(subject, publicKey, privateKey);

export const pushConfigured = () => Boolean(publicKey && privateKey);
export const pushPublicKey = () => publicKey;
export const pushDeviceId = (endpoint = '') => `push_${createHash('sha256').update(endpoint).digest('hex').slice(0, 20)}`;

const notificationSubscription = (subscription) => ({
  endpoint: subscription.endpoint,
  expirationTime: subscription.expirationTime || null,
  keys: subscription.keys,
});

export function publicPushDevice(subscription) {
  const endpoint = String(subscription?.endpoint || '');
  return {
    id: subscription?.id || pushDeviceId(endpoint),
    deviceName: subscription?.deviceName || 'Неизвестное устройство',
    browser: subscription?.browser || 'Браузер не определён',
    platform: subscription?.platform || 'Платформа не определена',
    endpointHint: endpoint ? `…${endpoint.slice(-12)}` : '—',
    createdAt: subscription?.createdAt || null,
    lastSeenAt: subscription?.lastSeenAt || subscription?.createdAt || null,
    lastSuccessAt: subscription?.lastSuccessAt || null,
    lastFailureAt: subscription?.lastFailureAt || null,
    lastError: subscription?.lastError || null,
  };
}

export function describePushClient(userAgent = '') {
  const value = String(userAgent);
  const platform = /iPhone|iPad|iPod/i.test(value) ? 'iOS'
    : /Android/i.test(value) ? 'Android'
      : /Windows/i.test(value) ? 'Windows'
        : /Macintosh|Mac OS X/i.test(value) ? 'macOS'
          : /Linux/i.test(value) ? 'Linux' : 'Неизвестная платформа';
  const browser = /Edg\//i.test(value) ? 'Microsoft Edge'
    : /CriOS|Chrome\//i.test(value) ? 'Google Chrome'
      : /FxiOS|Firefox\//i.test(value) ? 'Mozilla Firefox'
        : /Safari\//i.test(value) ? 'Safari' : 'Неизвестный браузер';
  const deviceName = ['Android', 'iOS'].includes(platform) ? `Телефон · ${browser}` : `Компьютер · ${browser}`;
  return { deviceName, browser, platform };
}

export function registerPushSubscription(users, userId, subscription, client, now = new Date().toISOString()) {
  const user = users.find((item) => item.id === userId);
  if (!user) return null;
  let existing = null;
  for (const account of users) {
    const match = (account.webPushSubscriptions || []).find((item) => item.endpoint === subscription.endpoint);
    if (account.id === userId && match) existing = match;
    account.webPushSubscriptions = (account.webPushSubscriptions || []).filter((item) => item.endpoint !== subscription.endpoint);
  }
  const saved = {
    ...existing,
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime || null,
    keys: subscription.keys,
    id: existing?.id || pushDeviceId(subscription.endpoint),
    ...client,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
  };
  user.webPushSubscriptions.push(saved);
  return { saved, isNew: !existing };
}

export function applyPushDeliveries(user, result, now = new Date().toISOString()) {
  const deliveries = new Map((result?.deliveries || []).map((item) => [item.endpoint, item]));
  user.webPushSubscriptions = (user.webPushSubscriptions || []).flatMap((subscription) => {
    const delivery = deliveries.get(subscription.endpoint);
    if (!delivery) return [subscription];
    if (delivery.expired) return [];
    return [{ ...subscription, ...(delivery.ok
      ? { lastSuccessAt: now, lastError: null }
      : { lastFailureAt: now, lastError: delivery.error || 'Push не доставлен.' }) }];
  });
  return user.webPushSubscriptions;
}

export async function sendPush(user, payload) {
  if (!pushConfigured()) return { channel: 'disabled', delivered: 0, failed: 0 };
  const subscriptions = user?.webPushSubscriptions || [];
  const results = await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(notificationSubscription(subscription), JSON.stringify(payload), { TTL: 60 * 60 });
      return { ok: true, endpoint: subscription.endpoint };
    } catch (error) {
      return { ok: false, endpoint: subscription.endpoint, expired: [404, 410].includes(error.statusCode), statusCode: error.statusCode || null, error: error.message };
    }
  }));
  return {
    channel: 'web-push',
    delivered: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    expiredEndpoints: results.filter((item) => item.expired).map((item) => item.endpoint),
    deliveries: results,
  };
}
