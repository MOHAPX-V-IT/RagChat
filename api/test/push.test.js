import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPushDeliveries, describePushClient, publicPushDevice, pushDeviceId, registerPushSubscription } from '../src/push.js';

const subscription = {
  endpoint: 'https://push.example.test/device/abc123',
  expirationTime: null,
  keys: { p256dh: 'public-key', auth: 'auth-key' },
};

test('push device id is stable and endpoint is masked for the UI', () => {
  assert.equal(pushDeviceId(subscription.endpoint), pushDeviceId(subscription.endpoint));
  const device = publicPushDevice({ ...subscription, deviceName: 'Телефон · Chrome' });
  assert.equal(device.endpointHint, '…evice/abc123');
  assert.equal(Object.hasOwn(device, 'endpoint'), false);
  assert.equal(Object.hasOwn(device, 'keys'), false);
});

test('client description distinguishes mobile and desktop browsers', () => {
  assert.deepEqual(describePushClient('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/130.0'), {
    deviceName: 'Телефон · Google Chrome', browser: 'Google Chrome', platform: 'Android',
  });
  assert.deepEqual(describePushClient('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Edg/130.0'), {
    deviceName: 'Компьютер · Microsoft Edge', browser: 'Microsoft Edge', platform: 'Windows',
  });
});

test('one browser endpoint belongs only to the most recently signed-in account', () => {
  const users = [
    { id: 'sales', webPushSubscriptions: [{ ...subscription, id: 'legacy' }] },
    { id: 'expert', webPushSubscriptions: [] },
  ];
  const result = registerPushSubscription(users, 'expert', subscription, describePushClient('Android Chrome/130.0'), '2026-08-31T10:00:00.000Z');
  assert.equal(users[0].webPushSubscriptions.length, 0);
  assert.equal(users[1].webPushSubscriptions.length, 1);
  assert.equal(result.saved.endpoint, subscription.endpoint);
});

test('delivery state records success and removes expired endpoints', () => {
  const user = { webPushSubscriptions: [{ ...subscription }, { ...subscription, endpoint: 'https://push.example.test/expired' }] };
  applyPushDeliveries(user, { deliveries: [
    { endpoint: subscription.endpoint, ok: true },
    { endpoint: 'https://push.example.test/expired', ok: false, expired: true },
  ] }, '2026-08-31T10:05:00.000Z');
  assert.equal(user.webPushSubscriptions.length, 1);
  assert.equal(user.webPushSubscriptions[0].lastSuccessAt, '2026-08-31T10:05:00.000Z');
});
