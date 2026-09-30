import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackConversationTitle,
  isAutomaticConversationTitle,
  normalizeGeneratedTitle,
} from '../src/conversation-title.js';

test('new and explicitly automatic conversations can be retitled', () => {
  assert.equal(isAutomaticConversationTitle({ title: 'Новый диалог 3' }), true);
  assert.equal(isAutomaticConversationTitle({ title: 'Продукт A при ОРВИ', titleSource: 'AUTO' }), true);
  assert.equal(isAutomaticConversationTitle({ title: 'Мой важный чат', titleSource: 'MANUAL' }), false);
});

test('fallback title is readable and safely limited', () => {
  assert.equal(fallbackConversationTitle('  Расскажи про Продукт A?  '), 'Продукт A: общая информация');
  assert.equal(fallbackConversationTitle('Можно ли применять Продукт A при ОРВИ?'), 'Продукт A при ОРВИ');
  assert.equal(fallbackConversationTitle('Какие противопоказания у Продукт Bа?'), 'Продукт Bа: противопоказания');
  assert.ok(fallbackConversationTitle('Очень длинный общий вопрос '.repeat(5)).length <= 64);
});

test('generated title is stripped of markdown, quotes and labels', () => {
  assert.equal(normalizeGeneratedTitle('Заголовок: **«Продукт A при ОРВИ»**\nЛишний текст', 'Вопрос'), 'Продукт A при ОРВИ');
});
