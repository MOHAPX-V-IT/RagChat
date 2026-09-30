import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageReviewTask, canReviewAnswers, canUseRepresentativeWorkspace, effectivePermissions, hasPermission, permissionCatalog, reviewClaimBlock, reviewPoolsForRole } from '../src/capabilities.js';

test('administrator combines representative and expert capabilities', () => {
  assert.equal(canUseRepresentativeWorkspace('ADMIN'), true);
  assert.equal(canReviewAnswers('ADMIN'), true);
});

test('administrator receives every catalog permission by default', () => {
  assert.deepEqual(new Set(effectivePermissions({ role: 'ADMIN' })), new Set(permissionCatalog.map((item) => item.id)));
});

test('per-user overrides can grant and revoke capabilities', () => {
  const expert = { role: 'EXPERT', permissionOverrides: { 'users.manage': true, 'reviews.manage': false } };
  assert.equal(hasPermission(expert, 'users.manage'), true);
  assert.equal(hasPermission(expert, 'reviews.manage'), false);
  assert.equal(hasPermission(expert, 'reviews.view'), true);
});

test('review roles keep their dedicated capability boundaries', () => {
  assert.equal(canUseRepresentativeWorkspace('REQUESTER'), true);
  assert.equal(canReviewAnswers('REQUESTER'), false);
  assert.equal(canUseRepresentativeWorkspace('EXPERT'), false);
  assert.equal(canReviewAnswers('EXPERT'), true);
});

test('strategy and sales have the intended queue boundaries', () => {
  assert.deepEqual(reviewPoolsForRole('EXPERT'), ['GENERAL']);
  assert.deepEqual(reviewPoolsForRole('SPECIALIST'), ['SPECIALIST']);
  assert.deepEqual(reviewPoolsForRole('MANAGER'), ['GENERAL', 'SPECIALIST']);
  assert.equal(canUseRepresentativeWorkspace('MANAGER'), true);
  assert.equal(canReviewAnswers('MANAGER'), true);
});

test('sales cannot approve a question they asked, while administrator can', () => {
  const ownTask = { representativeId: 'sales-1', reviewPool: 'GENERAL' };
  assert.equal(canManageReviewTask({ id: 'sales-1', role: 'MANAGER' }, ownTask), false);
  assert.equal(canManageReviewTask({ id: 'sales-2', role: 'MANAGER' }, ownTask), true);
  assert.equal(canManageReviewTask({ id: 'admin-1', role: 'ADMIN' }, { ...ownTask, representativeId: 'admin-1' }), true);
});

test('claim rejection reports the exact blocking reason', () => {
  const expert = { id: 'expert-1', role: 'EXPERT' };
  const waiting = { status: 'WAITING_REVIEW', reviewPool: 'GENERAL', representativeId: 'rep-1' };
  assert.equal(reviewClaimBlock(expert, waiting), null);
  assert.equal(reviewClaimBlock(expert, { ...waiting, reviewPool: 'SPECIALIST' }).code, 'OTHER_POOL');
  assert.equal(reviewClaimBlock(expert, { ...waiting, representativeId: expert.id }).code, 'OWN_QUESTION');
  assert.equal(reviewClaimBlock(expert, { ...waiting, status: 'IN_REVIEW' }).code, 'STATUS_CHANGED');
});

test('exclusive claim state prevents a second reviewer after the first claim', () => {
  const task = { status: 'WAITING_REVIEW', reviewPool: 'GENERAL', representativeId: 'rep-1' };
  const first = { id: 'expert-1', role: 'EXPERT' };
  const second = { id: 'expert-2', role: 'EXPERT' };
  assert.equal(reviewClaimBlock(first, task), null);
  task.status = 'IN_REVIEW';
  task.assignedTo = first.id;
  assert.equal(reviewClaimBlock(second, task).code, 'STATUS_CHANGED');
});

test('two concurrent claim attempts produce exactly one winner', async () => {
  const task = { status: 'WAITING_REVIEW', reviewPool: 'GENERAL', representativeId: 'rep-1' };
  const claim = (user) => Promise.resolve().then(() => {
    const blocked = reviewClaimBlock(user, task);
    if (blocked) return { ok: false, code: blocked.code };
    task.status = 'IN_REVIEW';
    task.assignedTo = user.id;
    return { ok: true, userId: user.id };
  });
  const results = await Promise.all([
    claim({ id: 'expert-1', role: 'EXPERT' }),
    claim({ id: 'expert-2', role: 'EXPERT' }),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok && item.code === 'STATUS_CHANGED').length, 1);
});
