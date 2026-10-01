import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { id } from './ids.js';

const { Pool } = pg;
const migrationPath = resolve(import.meta.dirname, '..', 'migrations', '001_postgresql_store.sql');
const databaseUrl = process.env.DATABASE_URL || 'postgresql://ragchat:ragchat-local-password@127.0.0.1:5432/ragchat';
const storeLockQuery = "SELECT pg_advisory_xact_lock(hashtext('ragchat-store'))";

const collections = [
  { key: 'users', table: 'users' },
  { key: 'conversations', table: 'conversations' },
  { key: 'messages', table: 'messages' },
  { key: 'reviewTasks', table: 'review_tasks' },
  { key: 'knowledgeEntries', table: 'knowledge_entries', newestFirst: true },
  { key: 'notifications', table: 'notifications', newestFirst: true },
  { key: 'auditEvents', table: 'audit_events', newestFirst: true },
];

const clone = (value) => structuredClone(value);
const emptyData = () => Object.fromEntries(collections.map(({ key }) => [key, []]));

async function seedStore() {
  const now = new Date().toISOString();
  if (!process.env.ADMIN_EMAIL || (process.env.ADMIN_PASSWORD || '').length < 16) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (16+ characters) before first startup.');
  const users = await Promise.all([
    ['usr_admin', 'Platform', 'Administrator', process.env.ADMIN_EMAIL, 'ADMIN', process.env.ADMIN_PASSWORD],
  ].map(async ([userId, firstName, lastName, email, role, password]) => ({
    id: userId,
    firstName,
    lastName,
    email,
    role,
    isActive: true,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: now,
    updatedAt: now,
  })));

  return {
    ...emptyData(),
    users,
    settings: {
      faq: [
        'Задавайте один общий вопрос за раз и дождитесь согласованного ответа.',
        'Модель и интернет-поиск работают только после подключения адаптеров. Демонстрационный режим не генерирует фактических ответов.',
        'После проверки ответ проходит коллективное обсуждение. Через 24 часа текущая версия отправляется при большинстве «за» или отсутствии голосов; при ничьей с голосами либо большинстве «против» остаётся на обсуждении.',
        'Каждый эксперт сохраняет собственные редакции. Ответственный выбирает одну из них, после чего начинается новое голосование на 24 часа.',
        'Каждый ответ проверяется экспертом. До согласования вы увидите статус ожидания.',
        'Официальный ответ можно скопировать и оценить кнопками полезности.',
      ],
      reminderMinutes: Number(process.env.REVIEW_REMINDER_MINUTES || 15),
      salesEscalationMinutes: Number(process.env.MANAGER_ESCALATION_MINUTES || 30),
    },
  };
}

class PostgresStore {
  #data;
  #pool;
  #queue = Promise.resolve();
  #revision = 0;

  constructor() {
    this.#pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_SIZE || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined,
    });
    this.#pool.on('error', (error) => console.error(`PostgreSQL pool error: ${error.message}`));
  }

  async init() {
    await this.#waitForDatabase();
    const client = await this.#pool.connect();
    try {
      await client.query(await readFile(migrationPath, 'utf8'));
      await client.query('BEGIN');
      await client.query(storeLockQuery);
      const current = await this.#load(client);
      if (!current.settings) {
        const initial = await seedStore();
        await this.#persistChanges(client, { ...emptyData(), settings: null }, initial);
        await client.query('UPDATE ragchat.store_meta SET revision = revision + 1, updated_at = now() WHERE id = 1');
      }
      await client.query('COMMIT');
      this.#data = await this.#load(client);
      const meta = await client.query('SELECT revision FROM ragchat.store_meta WHERE id = 1');
      this.#revision = Number(meta.rows[0]?.revision || 0);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  read() {
    if (!this.#data) throw new Error('PostgreSQL store is not initialized.');
    return clone(this.#data);
  }

  async mutate(mutator) {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(storeLockQuery);
        const current = await this.#load(client);
        const next = clone(current);
        const result = await mutator(next);
        await this.#persistChanges(client, current, next);
        const meta = await client.query('UPDATE ragchat.store_meta SET revision = revision + 1, updated_at = now() WHERE id = 1 RETURNING revision');
        await client.query('COMMIT');
        this.#data = next;
        this.#revision = Number(meta.rows[0]?.revision || this.#revision + 1);
        return clone(result);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async health() {
    const startedAt = Date.now();
    const result = await this.#pool.query(`
      SELECT current_database() AS database,
             current_setting('server_version') AS version,
             (SELECT revision FROM ragchat.store_meta WHERE id = 1) AS revision
    `);
    return {
      status: 'ok',
      engine: 'PostgreSQL',
      database: result.rows[0].database,
      version: result.rows[0].version,
      revision: Number(result.rows[0].revision || this.#revision),
      latencyMs: Date.now() - startedAt,
    };
  }

  async close() {
    await this.#pool.end();
  }

  async #waitForDatabase() {
    const attempts = Number(process.env.DATABASE_CONNECT_ATTEMPTS || 20);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#pool.query('SELECT 1');
        return;
      } catch (error) {
        if (attempt === attempts) throw new Error(`PostgreSQL недоступен после ${attempts} попыток: ${error.message}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5000, attempt * 500)));
      }
    }
  }

  async #load(client) {
    const data = emptyData();
    for (const { key, table, newestFirst } of collections) {
      const orderBy = newestFirst ? "payload ->> 'createdAt' DESC, id" : 'position, id';
      const result = await client.query(`SELECT payload FROM ragchat.${table} ORDER BY ${orderBy}`);
      data[key] = result.rows.map((row) => row.payload);
    }
    const settings = await client.query('SELECT payload FROM ragchat.settings WHERE id = 1');
    data.settings = settings.rows[0]?.payload || null;
    return data;
  }

  async #persistChanges(client, previous, next) {
    for (const { key, table, newestFirst } of collections) {
      await this.#syncCollection(client, table, previous[key] || [], next[key] || [], !newestFirst);
    }
    if (JSON.stringify(previous.settings) !== JSON.stringify(next.settings)) {
      await client.query(`
        INSERT INTO ragchat.settings (id, payload, updated_at)
        VALUES (1, $1::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
      `, [JSON.stringify(next.settings)]);
    }
  }

  async #syncCollection(client, table, previousItems, nextItems, trackPosition) {
    const previous = new Map(previousItems.map((item, position) => [item.id, { item, position }]));
    const nextIds = new Set(nextItems.map((item) => item.id));
    const removed = [...previous.keys()].filter((recordId) => !nextIds.has(recordId));
    if (removed.length) await client.query(`DELETE FROM ragchat.${table} WHERE id = ANY($1::text[])`, [removed]);

    for (let position = 0; position < nextItems.length; position += 1) {
      const item = nextItems[position];
      const old = previous.get(item.id);
      if (old && (!trackPosition || old.position === position) && JSON.stringify(old.item) === JSON.stringify(item)) continue;
      await client.query(`
        INSERT INTO ragchat.${table} (id, position, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, now())
        ON CONFLICT (id) DO UPDATE
        SET position = EXCLUDED.position, payload = EXCLUDED.payload, updated_at = now()
      `, [item.id, trackPosition ? position : 0, JSON.stringify(item)]);
    }
  }
}

export const store = new PostgresStore();

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _, webPushSubscriptions: __, ...safe } = user;
  return safe;
}

export function audit(data, actorId, action, entityType, entityId, details = {}) {
  data.auditEvents.unshift({
    id: id('audit'), actorId, action, entityType, entityId, details,
    createdAt: new Date().toISOString(),
  });
}
