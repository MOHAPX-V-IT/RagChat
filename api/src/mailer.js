import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';

const outbox = resolve(import.meta.dirname, '..', 'data', 'outbox');

export async function sendReminderEmail({ to, reviewerName, question, elapsedMinutes = 15 }) {
  const subject = 'RagChat — вопрос ожидает проверки';
  const text = `${reviewerName}, вопрос находится у вас в работе уже ${elapsedMinutes} мин.\n\n${question}\n\nОткройте очередь RagChat, чтобы согласовать ответ или вернуть вопрос.`;

  return deliverEmail({ to, subject, text });
}

export async function sendTestEmail({ to, administratorName }) {
  return deliverEmail({
    to,
    subject: 'RagChat — проверка почтовых уведомлений',
    text: `${administratorName}, почтовый канал RagChat работает. Это диагностическое сообщение из панели администратора.`,
  });
}

export async function sendAnswerReadyEmail({ to, representativeName, reviewerName, question, conversationTitle }) {
  return deliverEmail({
    to,
    subject: `RagChat — ответ готов${conversationTitle ? `: ${conversationTitle}` : ''}`,
    text: `${representativeName}, ${reviewerName || 'сотрудник'} согласовал ответ на ваш вопрос.\n\n${question}\n\nОткройте RagChat, чтобы прочитать официальный ответ.`,
  });
}

async function deliverEmail({ to, subject, text }) {

  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
    await transporter.sendMail({ from: process.env.SMTP_FROM || 'ragchat@localhost', to, subject, text });
    return { channel: 'smtp' };
  }

  await mkdir(outbox, { recursive: true });
  const file = resolve(outbox, `${Date.now()}-${to.replaceAll(/[^a-z0-9]/gi, '_')}.json`);
  await writeFile(file, JSON.stringify({ to, subject, text, createdAt: new Date().toISOString() }, null, 2));
  return { channel: 'local-outbox', file };
}
