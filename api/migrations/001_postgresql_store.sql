CREATE SCHEMA IF NOT EXISTS ragchat;

CREATE TABLE IF NOT EXISTS ragchat.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ragchat.store_meta (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ragchat.store_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ragchat.users (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON ragchat.users (lower(payload ->> 'email'));
CREATE INDEX IF NOT EXISTS users_role_idx ON ragchat.users ((payload ->> 'role'));
CREATE INDEX IF NOT EXISTS users_active_idx ON ragchat.users (((payload ->> 'isActive')::boolean));

CREATE TABLE IF NOT EXISTS ragchat.conversations (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_owner_idx ON ragchat.conversations ((payload ->> 'ownerId'));
CREATE INDEX IF NOT EXISTS conversations_updated_idx ON ragchat.conversations ((payload ->> 'updatedAt'));

CREATE TABLE IF NOT EXISTS ragchat.messages (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON ragchat.messages ((payload ->> 'conversationId'));
CREATE INDEX IF NOT EXISTS messages_created_idx ON ragchat.messages ((payload ->> 'createdAt'));

CREATE TABLE IF NOT EXISTS ragchat.review_tasks (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_tasks_status_idx ON ragchat.review_tasks ((payload ->> 'status'));
CREATE INDEX IF NOT EXISTS review_tasks_assigned_idx ON ragchat.review_tasks ((payload ->> 'assignedTo'));
CREATE INDEX IF NOT EXISTS review_tasks_created_idx ON ragchat.review_tasks ((payload ->> 'createdAt'));

CREATE TABLE IF NOT EXISTS ragchat.knowledge_entries (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_entries_active_idx ON ragchat.knowledge_entries (((payload ->> 'isActive')::boolean));

CREATE TABLE IF NOT EXISTS ragchat.notifications (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON ragchat.notifications ((payload ->> 'userId'));
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON ragchat.notifications ((payload ->> 'userId'), ((payload ->> 'isRead')::boolean));

CREATE TABLE IF NOT EXISTS ragchat.audit_events (
  id text PRIMARY KEY,
  position integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON ragchat.audit_events ((payload ->> 'actorId'));
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON ragchat.audit_events ((payload ->> 'action'));
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON ragchat.audit_events ((payload ->> 'createdAt'));

CREATE TABLE IF NOT EXISTS ragchat.settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ragchat.schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING;
