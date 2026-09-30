import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Archive, ArrowDown, ArrowUp, Bell, BookOpen, Bot, Check, CheckCircle2,
  ChevronRight, Clipboard, Clock3, Copy, Database, Edit3, FileText, HeartPulse,
  Download, KeyRound, ListChecks, LoaderCircle, LogOut, Menu, MessageSquare, MoreHorizontal,
  Pencil, Plus, RefreshCw, RotateCcw, Search, Send, Server, ShieldCheck, SlidersHorizontal, ThumbsDown,
  ThumbsUp, Trash2, UserPlus, Users, WifiOff, X,
} from 'lucide-react';
import { api, patch, post, put, remove, session, upload } from './api';
import type { Conversation, KnowledgeEntry, Message, ReviewTask, Role, User } from './types';
import { DiscussionPanel } from './DiscussionPanel';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AnalyticsPage, EvidencePanel, ProcessTimeline, PushDevicesPanel, PushNotificationControl, SlaBadge } from './AdvancedFeatures';

const roleLabels: Record<Role, string> = {
  REQUESTER: 'Сотрудник',
  EXPERT: 'Эксперт',
  SPECIALIST: 'Профильные эксперты',
  MANAGER: 'Руководители',
  ADMIN: 'Администратор',
};

const poolLabels = { GENERAL: 'Общая', SPECIALIST: 'Профильные эксперты' } as const;

const statusLabels: Record<string, string> = {
  GENERATING: 'Формируется',
  WAITING_REVIEW: 'Ожидает проверки',
  IN_REVIEW: 'В работе',
  DISCUSSION: 'На обсуждении',
  DELIVERED: 'Доставлен',
};

const auditActionLabels: Record<string, string> = {
  DISCUSSION_STARTED: 'Ответ на обсуждении', DISCUSSION_VOTE: 'Голос по ответу', DISCUSSION_DELIVERED: 'Ответ отправлен после обсуждения',
  LOGIN: 'Выполнен вход', DRAFT_READY: 'Черновик подготовлен', DRAFT_DEGRADED: 'Черновик создан без ИИ',
  REVIEW_CLAIMED: 'Вопрос взят в работу', REVIEW_APPROVED: 'Ответ согласован', REVIEW_EDITED: 'Ответ исправлен и отправлен',
  REVIEW_APPROVED_AND_DELIVERED: 'Ответ согласован и доставлен', REVIEW_EDITED_AND_DELIVERED: 'Исправленный ответ доставлен',
  REVIEW_RETURNED: 'Вопрос возвращён', REMINDER_SENT: 'Отправлено напоминание', USER_CREATED: 'Создан пользователь',
  USER_UPDATED: 'Изменён пользователь', USER_DEACTIVATED: 'Отключён пользователь', USER_DELETED: 'Удалён пользователь',
  REVIEW_RELEASED_AFTER_USER_DELETE: 'Вопрос освобождён после удаления эксперта', LLM_KEY_UPDATED: 'Обновлён ключ модели',
  DOCUMENT_UPLOADED: 'Загружен документ', DOCUMENT_DELETED: 'Удалён PDF из базы знаний', DOCUMENT_REINDEX_STARTED: 'Запущена индексация', SOURCE_CREATED: 'Добавлен источник',
  SOURCE_UPDATED: 'Изменён источник', SOURCE_DELETED: 'Удалён источник',
  CONVERSATION_CREATED: 'Создан диалог', CONVERSATION_RENAMED: 'Переименован диалог', CONVERSATION_SOFT_DELETED: 'Диалог скрыт сотрудникставителем',
  CONVERSATION_AUTO_TITLED: 'Автоматически назван диалог',
  QUESTION_SUBMITTED: 'Отправлен вопрос', QUESTION_CREATED: 'Создан вопрос', MESSAGE_RATED: 'Ответ оценён', ANSWER_RATED: 'Ответ оценён', KNOWLEDGE_UPDATED: 'Обновлено экспертное знание',
  MODEL_DIAGNOSTIC_RUN: 'Проверена модель', EMAIL_DIAGNOSTIC_RUN: 'Проверена почта', RAG_CACHE_CLEARED: 'Очищен кэш RAG',
  DRAFT_REGENERATION_STARTED: 'Повторно запущено формирование черновика',
  QUESTION_CLASSIFIED: 'Определено направление вопроса', MANAGER_OVERDUE_ALERT: 'Продажам отправлено уведомление о просрочке',
  REMINDER_DELIVERY_RECORDED: 'Зафиксирована доставка напоминания',
  PUSH_SUBSCRIBED: 'Зарегистрировано push-устройство', PUSH_UNSUBSCRIBED: 'Отключено push-устройство',
  PUSH_TESTED: 'Проверена push-доставка', PUSH_DEVICE_REMOVED: 'Удалено push-устройство',
  MANAGER_MANUAL_REMINDER: 'Руководители напомнили эксперту о вопросе',
  ANALYTICS_RESET: 'Сброшена накопительная статистика',
};
const entityLabels: Record<string, string> = { user: 'учётная запись', review_task: 'вопрос', conversation: 'диалог', message: 'сообщение', knowledge_entry: 'экспертное знание', system: 'система', knowledge_document: 'документ', trusted_source: 'источник' };

const formatDate = (value?: string) => value ? new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)) : '—';

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');

function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const markdownPreview = (value?: string) => (value || '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`~>#]/g, '')
  .replace(/^\s*[-+]\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

function Spinner({ size = 18 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-label="Загрузка" />;
}

function Notice({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
    </div>
  );
}

function ErrorNotice({ error, onClose }: { error: string; onClose: () => void }) {
  return (
    <div className="toast toast-error" role="alert">
      <span>{error}</span>
      <button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  }}>{content}</ReactMarkdown>;
}

function LoginPage({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await post<{ token: string; user: User }>('/api/auth/login', { email, password });
      onLogin(result.token, result.user);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <main className="login-page">
      <section className="login-intro">
        <div className="brand brand-large"><span className="brand-mark">R</span><span>RagChat</span></div>
        <div className="login-statement">
          <h1>Ответ становится официальным только после проверки экспертом.</h1>
          <p>Черновик проходит экспертную проверку и обсуждение. Подключение модели, базы знаний и поиска настраивается вашей организацией.</p>
        </div>
        <div className="review-route" aria-label="Порядок обработки ответа">
          <span><MessageSquare size={18} /> Вопрос</span><ChevronRight size={17} />
          <span><Bot size={18} /> Черновик</span><ChevronRight size={17} />
          <span><ShieldCheck size={18} /> Проверка</span><ChevronRight size={17} />
          <span><CheckCircle2 size={18} /> Ответ</span>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div>
            <h2>Вход в сервис</h2>
            <p>Используйте учётную запись, созданную администратором.</p>
          </div>
          {error && <div className="inline-error">{error}</div>}
          <label>Электронная почта<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
          <label>Пароль<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          <button className="button primary wide" disabled={busy}>{busy ? <><Spinner /> Входим…</> : 'Войти'}</button>
        </form>
      </section>
    </main>
  );
}

type NavItem = { id: string; label: string; icon: typeof MessageSquare };
type NavGroup = { label?: string; items: NavItem[] };

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function InstallAppControl({ available, installed, onInstall }: {
  available: boolean; installed: boolean; onInstall: () => Promise<boolean>;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  if (installed) {
    return <div className="pwa-installed"><CheckCircle2 size={17} /><span>Приложение установлено</span></div>;
  }

  const install = async () => {
    if (available && await onInstall()) {
      setGuideOpen(false);
      return;
    }
    setGuideOpen((value) => !value);
  };

  const instruction = isIos
    ? 'В Safari нажмите «Поделиться», затем «На экран Домой».'
    : isMobile
      ? 'Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».'
      : 'В Chrome или Edge откройте меню браузера и выберите «Установить RagChat».';

  return (
    <div className="pwa-install">
      <button className="pwa-install-button" onClick={install} aria-expanded={guideOpen}>
        <Download size={18} />
        <span><strong>Установить приложение</strong><small>Телефон или компьютер</small></span>
      </button>
      {guideOpen && <div className="pwa-install-guide" role="status"><p>{instruction}</p><button onClick={() => setGuideOpen(false)} aria-label="Закрыть подсказку"><X size={14} /></button></div>}
    </div>
  );
}

function AppShell({ user, section, setSection, children, onLogout, installAvailable, appInstalled, onInstall }: {
  user: User; section: string; setSection: (section: string) => void; children: React.ReactNode; onLogout: () => void;
  installAvailable: boolean; appInstalled: boolean; onInstall: () => Promise<boolean>;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; body?: string; taskId?: string; conversationId?: string; isRead: boolean; createdAt: string }>>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [mobileQueueScope, setMobileQueueScope] = useState<'all' | 'mine'>('all');
  const [salesAttentionRequest, setSalesAttentionRequest] = useState(0);
  const [salesAttentionActive, setSalesAttentionActive] = useState(false);
  const online = useOnlineStatus();

  const permissions = new Set(user.permissions || []);
  const workItems: NavItem[] = [];
  const managementItems: NavItem[] = [];
  if (user.role === 'MANAGER') {
    if (permissions.has('analytics.view')) workItems.push({ id: 'sales-control', label: 'Контроль команды', icon: Activity });
    if (permissions.has('chats.use')) workItems.push({ id: 'my-chats', label: 'Спросить ИИ', icon: MessageSquare });
    if (permissions.has('reviews.view')) workItems.push({ id: 'queue', label: 'Ответить на вопрос', icon: ListChecks });
  } else {
    if (permissions.has('chats.use')) workItems.push({ id: user.role === 'REQUESTER' ? 'chats' : 'my-chats', label: 'Мои диалоги', icon: MessageSquare }, { id: 'faq', label: 'Как работает бот', icon: BookOpen });
    if (permissions.has('reviews.view')) workItems.push({ id: 'queue', label: 'Очередь вопросов', icon: ListChecks }, { id: 'all-chats', label: 'Все диалоги', icon: MessageSquare });
    if (permissions.has('directory.view')) workItems.push({ id: 'team', label: 'Команда', icon: Users });
    if (permissions.has('knowledge.manage')) workItems.push({ id: 'knowledge', label: 'База знаний', icon: Database });
    if (permissions.has('analytics.view')) managementItems.push({ id: 'overview', label: 'Обзор', icon: Activity }, { id: 'analytics', label: 'Аналитика', icon: Clock3 });
    if (user.role === 'ADMIN' && permissions.has('analytics.view')) managementItems.push({ id: 'sales-control', label: 'Контроль руководителей', icon: Activity });
    if (permissions.has('users.manage')) managementItems.push({ id: 'users', label: 'Пользователи', icon: Users });
    if (permissions.has('audit.view')) managementItems.push({ id: 'audit', label: 'Журнал действий', icon: ListChecks });
    if (permissions.has('system.manage')) managementItems.push({ id: 'system', label: 'Система и API', icon: Server });
  }
  const groups: NavGroup[] = [{ label: workItems.length && managementItems.length ? 'Работа с ботом' : undefined, items: workItems }, ...(managementItems.length ? [{ label: workItems.length ? 'Управление' : undefined, items: managementItems }] : [])];
  const mobileNavItems = user.role === 'REQUESTER'
    ? [{ id: 'chats', label: 'Диалоги', icon: MessageSquare }, { id: 'new-chat', label: 'Новый', icon: Plus }, { id: 'notifications', label: 'Уведомления', icon: Bell }]
    : user.role === 'EXPERT' || user.role === 'SPECIALIST'
      ? [{ id: 'queue', label: 'Очередь', icon: ListChecks }, { id: 'queue-mine', label: 'Мои', icon: ShieldCheck }, { id: 'notifications', label: 'Уведомления', icon: Bell }]
      : user.role === 'MANAGER'
        ? [{ id: 'sales-control', label: 'Контроль', icon: Activity }, { id: 'sales-attention', label: 'Внимание', icon: Clock3 }, { id: 'my-chats', label: 'Спросить', icon: MessageSquare }, { id: 'notifications', label: 'События', icon: Bell }]
        : [{ id: 'overview', label: 'Обзор', icon: Activity }, { id: 'queue', label: 'Очередь', icon: ListChecks }, { id: 'notifications', label: 'События', icon: Bell }, { id: 'more', label: 'Ещё', icon: MoreHorizontal }];

  useEffect(() => {
    const load = () => api<{ notifications: typeof notifications }>('/api/notifications').then((data) => { setNotifications(data.notifications); setNotificationError(''); }).catch(() => setNotificationError('Не удалось обновить уведомления. Проверьте соединение.'));
    load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handler = (event: Event) => setMobileQueueScope((event as CustomEvent<{ scope?: 'all' | 'mine' }>).detail?.scope === 'mine' ? 'mine' : 'all');
    window.addEventListener('ragchat:queue-scope-changed', handler);
    return () => window.removeEventListener('ragchat:queue-scope-changed', handler);
  }, []);
  useEffect(() => {
    if (!notificationsOpen) return;
    const scrollY = window.scrollY;
    const previous = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = previous.position;
      document.body.style.top = previous.top;
      document.body.style.width = previous.width;
      document.body.style.overflow = previous.overflow;
      window.scrollTo({ top: scrollY, behavior: 'auto' });
    };
  }, [notificationsOpen]);
  useEffect(() => {
    if (!salesAttentionRequest || section !== 'sales-control') return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const revealAttention = () => {
      if (cancelled) return;
      const target = document.getElementById('sales-attention');
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      attempts += 1;
      if (attempts < 20) timer = window.setTimeout(revealAttention, 100);
    };
    window.requestAnimationFrame(revealAttention);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [salesAttentionRequest, section]);
  const unread = notifications.filter((item) => !item.isRead).length;
  const markAllNotificationsRead = async () => {
    if (!unread || notificationsBusy) return;
    setNotificationsBusy(true);
    setNotificationError('');
    try {
      await post<{ updated: number }>('/api/notifications/read-all');
      setNotifications((current) => current.map((notice) => ({ ...notice, isRead: true })));
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : 'Не удалось отметить уведомления прочитанными. Повторите попытку.');
    } finally {
      setNotificationsBusy(false);
    }
  };
  const dispatchAfterNavigation = (name: string, detail?: Record<string, string>) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(name, { detail }))));
  };
  const openNotification = (item: (typeof notifications)[number]) => {
    if (!item.isRead) {
      setNotifications((current) => current.map((notice) => notice.id === item.id ? { ...notice, isRead: true } : notice));
      void post(`/api/notifications/${item.id}/read`).catch(() => setNotificationError('Не удалось сохранить отметку о прочтении.'));
    }
    setNotificationsOpen(false);
    setMobileOpen(false);
    if (item.conversationId) {
      setSection(user.role === 'REQUESTER' ? 'chats' : 'my-chats');
      dispatchAfterNavigation('ragchat:open-conversation', { conversationId: item.conversationId });
    }
    else {
      setSection('queue');
      if (item.taskId) dispatchAfterNavigation('ragchat:open-review', { taskId: item.taskId });
    }
  };
  const activateMobileNav = (id: string) => {
    if (id === 'notifications') { setMobileOpen(false); setNotificationsOpen(true); return; }
    if (id === 'more') { setMobileOpen(true); return; }
    setNotificationsOpen(false);
    if (id !== 'sales-attention') setSalesAttentionActive(false);
    if (id === 'new-chat') {
      setSection('chats');
      dispatchAfterNavigation('ragchat:new-conversation');
      return;
    }
    if (id === 'queue-mine') {
      setMobileQueueScope('mine');
      setSection('queue');
      dispatchAfterNavigation('ragchat:queue-preset', { preset: 'mine' });
      return;
    }
    if (id === 'sales-attention') {
      setSalesAttentionActive(true);
      setSection('sales-control');
      setSalesAttentionRequest((value) => value + 1);
      return;
    }
    if (id === 'queue') {
      setMobileQueueScope('all');
      dispatchAfterNavigation('ragchat:queue-preset', { preset: 'all' });
    }
    setSection(id);
  };

  return (
    <div className="app-shell">
      <aside className={cx('app-sidebar', mobileOpen && 'mobile-open')}>
        <div className="sidebar-head">
          <div className="brand"><span className="brand-mark">R</span><span>RagChat</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Закрыть меню"><X size={20} /></button>
        </div>
        <nav className="main-nav" aria-label="Основная навигация">
          {groups.map((group, index) => <div className="nav-group" key={group.label || index}>
            {group.label && <span className="nav-group-label">{group.label}</span>}
            {group.items.map(({ id, label, icon: Icon }) => (
              <button key={id} className={cx('nav-item', section === id && 'active')} onClick={() => { setSection(id); setMobileOpen(false); }}>
                <Icon size={19} strokeWidth={1.9} /><span>{label}</span>
              </button>
            ))}
          </div>)}
        </nav>
        <InstallAppControl available={installAvailable} installed={appInstalled} onInstall={onInstall} />
        <PushNotificationControl />
        <div className="sidebar-user">
          <div className="avatar">{user.firstName[0]}{user.lastName[0]}</div>
          <div><strong>{user.firstName} {user.lastName}</strong><span>{roleLabels[user.role]}</span></div>
          <button className="icon-button" onClick={onLogout} aria-label="Выйти"><LogOut size={18} /></button>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="Закрыть меню" />}
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Открыть меню"><Menu size={21} /></button>
          <div className="topbar-role"><span className="status-dot" /> {roleLabels[user.role]}</div>
          <div className="topbar-actions">
            <button className="notification-button" onClick={() => setNotificationsOpen((value) => !value)} aria-expanded={notificationsOpen} aria-label={`Уведомления: ${unread}`}><Bell size={19} />{unread > 0 && <span>{unread}</span>}</button>
          </div>
        </header>
        {!online && <div className="connection-banner" role="status"><WifiOff size={16} /><span><strong>Нет соединения</strong> Изменения сохранятся на устройстве до восстановления сети.</span></div>}
        <div className="app-content">{children}</div>
      </div>
      {notificationsOpen && <div className="notification-layer"><button className="notification-scrim" onClick={() => setNotificationsOpen(false)} aria-label="Закрыть уведомления" /><div className="notification-popover" role="dialog" aria-modal="true" aria-label="Центр уведомлений">
        <div className="notification-head">
          <div><strong>Уведомления</strong><span>{unread ? `${unread} непрочитано` : 'Новых нет'}</span></div>
          <div className="notification-head-actions">{unread > 0 && <button className="notification-read-all" onClick={markAllNotificationsRead} disabled={notificationsBusy}>{notificationsBusy ? 'Отмечаем…' : 'Прочитать всё'}</button>}<button className="icon-button notification-close" onClick={() => setNotificationsOpen(false)} aria-label="Закрыть"><X size={18} /></button></div>
        </div>
        {notificationError && <p className="notification-action-error" role="alert">{notificationError}</p>}
        {notifications.length ? <div className="notification-list">{notifications.map((item) => <button key={item.id} className={cx(!item.isRead && 'unread')} onClick={() => openNotification(item)}><span>{item.title}</span>{item.body && <small>{item.body}</small>}<time>{formatDate(item.createdAt)}</time></button>)}</div> : <p className="notification-empty">Здесь появятся напоминания о вопросах.</p>}
      </div></div>}
      <nav className="mobile-bottom-nav" aria-label="Быстрая навигация">
        {mobileNavItems.map(({ id, label, icon: Icon }) => {
          const active = (id === 'queue' && section === 'queue' && mobileQueueScope === 'all') || (id === 'queue-mine' && section === 'queue' && mobileQueueScope === 'mine') || (id === 'sales-control' && section === 'sales-control' && !salesAttentionActive) || (id === 'sales-attention' && section === 'sales-control' && salesAttentionActive) || (id !== 'queue' && id !== 'queue-mine' && id !== 'sales-control' && id !== 'sales-attention' && id === section) || (id === 'notifications' && notificationsOpen);
          return <button key={id} className={cx(active && 'active')} onClick={() => activateMobileNav(id)} aria-current={active ? 'page' : undefined}><span><Icon size={20} strokeWidth={1.9} />{id === 'notifications' && unread > 0 && <i>{unread > 99 ? '99+' : unread}</i>}</span><small>{label}</small></button>;
        })}
      </nav>
    </div>
  );
}

function RepWorkspace({ user, showFaq }: { user: User; showFaq: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTask, setActiveTask] = useState<ReviewTask | null>(null);
  const [latestTask, setLatestTask] = useState<ReviewTask | null>(null);
  const [chatSearch, setChatSearch] = useState('');
  const [chatState, setChatState] = useState('');
  const [visibility, setVisibility] = useState<'active' | 'hidden'>('active');
  const [ratingTarget, setRatingTarget] = useState<Message | null>(null);
  const [ratingReason, setRatingReason] = useState('');
  const [question, setQuestion] = useState('');
  const [faq, setFaq] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [renameId, setRenameId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const previousConversationRef = useRef('');

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams({ scope: 'mine', visibility });
    if (chatSearch.trim()) params.set('q', chatSearch.trim());
    if (chatState) params.set('state', chatState);
    const data = await api<{ conversations: Conversation[] }>(`/api/conversations?${params}`);
    setConversations(data.conversations);
    setSelectedId((current) => data.conversations.some((item) => item.id === current) ? current : data.conversations[0]?.id || '');
  }, [chatSearch, chatState, visibility]);

  const loadMessages = useCallback(async (idValue: string) => {
    if (!idValue) { setMessages([]); setActiveTask(null); setLatestTask(null); return; }
    const data = await api<{ messages: Message[]; activeTask: ReviewTask | null; latestTask: ReviewTask | null }>(`/api/conversations/${idValue}/messages`);
    setMessages(data.messages); setActiveTask(data.activeTask); setLatestTask(data.latestTask);
  }, []);

  useEffect(() => {
    Promise.all([loadConversations(), api<{ items: string[] }>('/api/faq').then((data) => setFaq(data.items))])
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [loadConversations]);

  useEffect(() => { loadMessages(selectedId).catch((e) => setError(e.message)); }, [selectedId, loadMessages]);
  useEffect(() => { const handler = (event: Event) => { const id = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId; if (id) setSelectedId(id); }; window.addEventListener('ragchat:open-conversation', handler); return () => window.removeEventListener('ragchat:open-conversation', handler); }, []);
  useEffect(() => {
    if (!selectedId) { setQuestion(''); return; }
    setQuestion(localStorage.getItem(`ragchat:question-draft:${user.id}:${selectedId}`) || '');
  }, [selectedId, user.id]);
  useEffect(() => {
    if (!selectedId) return;
    const key = `ragchat:question-draft:${user.id}:${selectedId}`;
    if (question) localStorage.setItem(key, question);
    else localStorage.removeItem(key);
  }, [question, selectedId, user.id]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadConversations().catch(() => undefined);
      if (selectedId) loadMessages(selectedId).catch(() => undefined);
    }, 3_500);
    return () => clearInterval(timer);
  }, [selectedId, loadConversations, loadMessages]);

  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container) return;
    const conversationChanged = previousConversationRef.current !== selectedId;
    const newMessageAppeared = messages.length > previousMessageCountRef.current;
    if (conversationChanged || (newMessageAppeared && stickToBottomRef.current)) {
      requestAnimationFrame(() => container.scrollTo({ top: container.scrollHeight, behavior: conversationChanged ? 'auto' : 'smooth' }));
    }
    previousConversationRef.current = selectedId;
    previousMessageCountRef.current = messages.length;
  }, [selectedId, messages.length]);

  const trackMessageScroll = () => {
    const container = messagesScrollRef.current;
    if (!container) return;
    stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  };

  const createChat = async () => {
    try {
      const result = await post<{ conversation: Conversation }>('/api/conversations', { title: `Новый диалог ${conversations.length + 1}` });
      await loadConversations(); setSelectedId(result.conversation.id);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    const handler = () => { createChat(); };
    window.addEventListener('ragchat:new-conversation', handler);
    return () => window.removeEventListener('ragchat:new-conversation', handler);
  }, [createChat]);

  const saveRename = async () => {
    if (!renameValue.trim()) return;
    try { await patch(`/api/conversations/${renameId}`, { title: renameValue }); setRenameId(''); await loadConversations(); }
    catch (e) { setError((e as Error).message); }
  };

  const deleteChat = async (conversation: Conversation) => {
    if (!window.confirm(`Скрыть диалог «${conversation.title}»? Эксперты и администратор сохранят к нему доступ.`)) return;
    try { await remove(`/api/conversations/${conversation.id}`); if (selectedId === conversation.id) setSelectedId(''); await loadConversations(); }
    catch (e) { setError((e as Error).message); }
  };

  const restoreChat = async (conversation: Conversation) => {
    try { await post(`/api/conversations/${conversation.id}/restore`); await loadConversations(); setNotice('Диалог восстановлен'); }
    catch (e) { setError((e as Error).message); }
  };

  const sendQuestion = async () => {
    if (!selectedId || !question.trim() || activeTask) return;
    setSending(true); setError('');
    try {
      await post(`/api/conversations/${selectedId}/questions`, { question });
      localStorage.removeItem(`ragchat:question-draft:${user.id}:${selectedId}`);
      setQuestion(''); await loadMessages(selectedId); await loadConversations();
    } catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  };

  const copyAnswer = async (text: string) => {
    await navigator.clipboard.writeText(text); setNotice('Ответ скопирован');
  };

  const rate = async (messageId: string, rating: 'UP' | 'DOWN', reason = '') => {
    try { await post(`/api/messages/${messageId}/rating`, { rating, reason }); setRatingTarget(null); setRatingReason(''); await loadMessages(selectedId); }
    catch (e) { setError((e as Error).message); }
  };

  if (showFaq) return (
    <section className="content-page readable-page">
      <header className="page-heading"><div><h1>Как работает бот</h1><p>Короткая памятка для сотрудника, задающего вопросы.</p></div></header>
      <div className="faq-flow">
        {faq.map((item, index) => <div className="faq-row" key={item}><span>{index + 1}</span><p>{item}</p></div>)}
      </div>
      <div className="information-note"><ShieldCheck size={22} /><div><strong>Ответ проверяется человеком</strong><p>ИИ не отправляет общий ответ напрямую. До согласования в чате отображается только статус подготовки.</p></div></div>
    </section>
  );

  return (
    <div className="chat-workspace">
      {error && <ErrorNotice error={error} onClose={() => setError('')} />}
      {notice && <Notice message={notice} onClose={() => setNotice('')} />}
      <aside className="chat-list-pane">
        <div className="pane-title"><div><h1>Диалоги</h1><span>{conversations.length}</span></div><button className="button primary compact" onClick={createChat}><Plus size={17} /> Новый</button></div>
        <div className="chat-filters">
          <label><Search size={15} /><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Поиск в чатах" /></label>
          <div><select value={chatState} onChange={(event) => setChatState(event.target.value)} aria-label="Состояние диалога"><option value="">Все состояния</option><option value="active">Активные</option><option value="waiting">Ожидающие</option><option value="completed">Завершённые</option></select><select value={visibility} onChange={(event) => setVisibility(event.target.value as 'active' | 'hidden')} aria-label="Видимость"><option value="active">Текущие</option><option value="hidden">Скрытые</option></select></div>
        </div>
        <div className="chat-list">
          {loading && <div className="loading-row"><Spinner /> Загружаем диалоги</div>}
          {!loading && conversations.length === 0 && <div className="empty-small"><MessageSquare size={24} /><p>Создайте первый диалог</p></div>}
          {conversations.map((conversation) => (
            <div className={cx('chat-list-item', selectedId === conversation.id && 'selected')} key={conversation.id}>
              {renameId === conversation.id ? (
                <div className="inline-rename"><input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveRename()} autoFocus /><button onClick={saveRename}><Check size={16} /></button></div>
              ) : (
                <button className="chat-select" onClick={() => setSelectedId(conversation.id)}>
                  <strong>{conversation.title}</strong>
                  <span>{conversation.activeTask ? 'Ответ проверяется' : markdownPreview(conversation.lastMessage?.content).slice(0, 56) || 'Пустой диалог'}</span>
                </button>
              )}
              <div className="chat-row-actions">
                {!conversation.deletedByOwnerAt && <button onClick={() => { setRenameId(conversation.id); setRenameValue(conversation.title); }} aria-label="Переименовать"><Pencil size={14} /></button>}
                {conversation.deletedByOwnerAt ? <button onClick={() => restoreChat(conversation)} aria-label="Восстановить"><RotateCcw size={14} /></button> : <button onClick={() => deleteChat(conversation)} aria-label="Скрыть"><Archive size={14} /></button>}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <section className="conversation-pane">
        {!selectedId ? (
          <div className="conversation-empty"><div className="conversation-symbol"><HeartPulse size={28} /></div><h2>Начните диалог</h2><p>Создайте чат, сформулируйте общий или профильный вопрос и дождитесь согласованного ответа.</p><button className="button primary" onClick={createChat}><Plus size={18} /> Создать диалог</button></div>
        ) : (
          <>
            <div className="conversation-header"><button className="icon-button mobile-chat-back" onClick={() => setSelectedId('')} aria-label="К списку диалогов"><ChevronRight size={20} /></button><div><h2>{conversations.find((item) => item.id === selectedId)?.title}</h2><span><span className="status-dot" /> База знаний подключена</span></div></div>
            <div className="messages-scroll" ref={messagesScrollRef} onScroll={trackMessageScroll}>
              {messages.length === 0 && <div className="conversation-starter"><Bot size={30} /><h3>Что вы хотите уточнить?</h3><p>Бот проверит внутренние материалы и выполнит поиск в интернете. Черновик проверит эксперт.</p></div>}
              {messages.map((message) => (
                <article className={cx('message', message.authorType === 'USER' ? 'message-user' : 'message-assistant')} key={message.id}>
                  <div className="message-author">{message.authorType === 'USER' ? `${user.firstName} ${user.lastName}` : 'RagChat'}<time>{formatDate(message.createdAt)}</time></div>
                  <div className={cx('message-body', message.authorType === 'ASSISTANT' && 'message-markdown')}>
                    {message.authorType === 'ASSISTANT' ? <MarkdownMessage content={message.content} /> : message.content}
                  </div>
                  {message.authorType === 'ASSISTANT' && <div className="message-actions"><button onClick={() => copyAnswer(message.content)}><Copy size={15} /> Скопировать</button><button className={message.rating === 'UP' ? 'selected' : ''} onClick={() => rate(message.id, 'UP')} aria-label="Ответ полезен"><ThumbsUp size={15} /></button><button className={message.rating === 'DOWN' ? 'selected down' : ''} onClick={() => { setRatingTarget(message); setRatingReason(message.ratingReason || ''); }} aria-label="Ответ не полезен"><ThumbsDown size={15} /></button></div>}
                </article>
              ))}
              <ProcessTimeline task={activeTask || latestTask} />
              {activeTask && <div className="pending-answer"><div className="pending-pulse"><span /><span /><span /></div><div><strong>Ответ готовится и проходит проверку</strong><p>{activeTask.status === 'DISCUSSION' ? 'Ответ проходит коллективное обсуждение. После согласования вы получите уведомление.' : activeTask.status === 'GENERATING' ? 'ИИ определяет направление, собирает материалы и формирует черновик.' : activeTask.status === 'IN_REVIEW' ? `${activeTask.assignedExpert?.name || (activeTask.reviewPool === 'SPECIALIST' ? 'Сотрудник профильных экспертов' : 'Эксперт')} уже работает с ответом.` : activeTask.reviewPool === 'SPECIALIST' ? 'Вопрос находится в очереди профильных экспертов.' : 'Вопрос находится в очереди экспертов.'}</p></div></div>}
              <div />
            </div>
            <div className="composer-wrap">
              <div className={cx('composer', activeTask && 'disabled')}>
                <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={activeTask ? 'Дождитесь официального ответа на текущий вопрос' : 'Введите вопрос…'} disabled={Boolean(activeTask) || sending} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } }} />
                <button className="send-button" onClick={sendQuestion} disabled={!question.trim() || Boolean(activeTask) || sending} aria-label="Отправить вопрос">{sending ? <Spinner /> : <Send size={18} />}</button>
              </div>
              <p>Ответ ИИ будет отправлен только после проверки ответственным сотрудником.</p>
            </div>
          </>
        )}
      </section>
      {ratingTarget && <div className="dialog-scrim" role="presentation" onMouseDown={() => setRatingTarget(null)}><section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onMouseDown={(event) => event.stopPropagation()}><div><h2 id="feedback-title">Что было неполезно?</h2><p>Комментарий поможет улучшить будущие ответы.</p></div><textarea value={ratingReason} onChange={(event) => setRatingReason(event.target.value)} placeholder="Например: не хватило подробностей или источник устарел" autoFocus /><div><button className="button secondary" onClick={() => setRatingTarget(null)}>Отмена</button><button className="button primary" disabled={ratingReason.trim().length < 3} onClick={() => rate(ratingTarget.id, 'DOWN', ratingReason)}>Отправить оценку</button></div></section></div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={cx('status-badge', `status-${status.toLowerCase()}`)}>{statusLabels[status] || status}</span>;
}

function ReviewWorkspace({ user, embedded = false }: { user: User; embedded?: boolean }) {
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [selected, setSelected] = useState<ReviewTask | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [sort, setSort] = useState<'desc' | 'asc'>('desc');
  const [status, setStatus] = useState('OPEN');
  const [hasComment, setHasComment] = useState('');
  const [representative, setRepresentative] = useState('');
  const [assigned, setAssigned] = useState('');
  const [reviewPool, setReviewPool] = useState(user.role === 'EXPERT' ? 'GENERAL' : user.role === 'SPECIALIST' ? 'SPECIALIST' : '');
  const [representatives, setRepresentatives] = useState<User[]>([]);
  const [experts, setExperts] = useState<User[]>([]);
  const [returnExpert, setReturnExpert] = useState('');
  const [busy, setBusy] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [answer, setAnswer] = useState('');
  const [initialAnswer, setInitialAnswer] = useState('');
  const [priority, setPriority] = useState('');
  const [product, setProduct] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Array<{ id: string; title: string; content: string }>>([]);
  const [workload, setWorkload] = useState<Array<{ id: string; name: string; role?: Role; status: string; workload: number; completed: number; averageReviewMinutes: number }>>([]);
  const [presence, setPresence] = useState(user.expertStatus || 'AVAILABLE');
  const [internalComment, setInternalComment] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [transferExpert, setTransferExpert] = useState('');
  const [transferComment, setTransferComment] = useState('');
  const [returnMode, setReturnMode] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [restoredDraftAt, setRestoredDraftAt] = useState('');
  const online = useOnlineStatus();

  const reviewDraftKey = (taskId: string) => `ragchat:review-draft:${user.id}:${taskId}`;
  const clearReviewDraft = (taskId?: string) => {
    if (taskId) localStorage.removeItem(reviewDraftKey(taskId));
    setRestoredDraftAt('');
  };

  const load = useCallback(async () => {
    const params = new URLSearchParams({ sort, status, page: String(page), pageSize: '25' });
    if (hasComment) params.set('hasComment', hasComment);
    if (representative) params.set('representativeId', representative);
    if (assigned) params.set('assignedTo', assigned);
    if (reviewPool) params.set('reviewPool', reviewPool);
    if (priority) params.set('priority', priority);
    if (product) params.set('productName', product);
    if (search.trim()) params.set('q', search.trim());
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    try {
      const data = await api<{ tasks: ReviewTask[]; pagination: { page: number; pages: number; total: number }; representatives: User[]; experts: User[]; products: string[] }>(`/api/reviews?${params}`);
      setTasks(data.tasks); setPagination(data.pagination); setRepresentatives(data.representatives); setExperts(data.experts); setProducts(data.products || []);
      setLastSyncedAt(new Date()); setSyncFailed(false);
    } catch (requestError) {
      setSyncFailed(true);
      throw requestError;
    }
  }, [sort, status, hasComment, representative, assigned, reviewPool, priority, product, search, dateFrom, dateTo, page]);

  const openTask = async (taskId: string, preserveEditor = false) => {
    try {
      const data = await api<{ task: ReviewTask; history: Message[] }>(`/api/reviews/${taskId}`);
      setSelected(data.task); setHistory(data.history);
      if (!preserveEditor) {
        const initial = data.task.aiDraft || '';
        let restored: { answer?: string; updatedAt?: string } | null = null;
        try { restored = JSON.parse(localStorage.getItem(reviewDraftKey(taskId)) || 'null'); } catch { localStorage.removeItem(reviewDraftKey(taskId)); }
        const canRestore = Boolean(restored?.answer?.trim()) && data.task.status === 'IN_REVIEW' && (data.task.assignedTo === user.id || user.role === 'ADMIN');
        setAnswer(canRestore ? restored?.answer || initial : initial);
        setInitialAnswer(initial);
        setEditMode(canRestore);
        setRestoredDraftAt(canRestore ? restored?.updatedAt || new Date().toISOString() : '');
        setReturnMode(false);
        setReturnExpert('');
        setComment('');
      }
    } catch (e) { setError((e as Error).message); }
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => { Promise.all([api<{ templates: typeof templates }>('/api/review-templates').then((data) => setTemplates(data.templates)), api<{ experts: typeof workload }>('/api/experts/workload').then((data) => setWorkload(data.experts))]).catch(() => undefined); }, []);
  useEffect(() => {
    const timer = setInterval(() => { load().catch(() => undefined); if (selected) openTask(selected.id, editMode || returnMode); }, 4_000);
    return () => clearInterval(timer);
  }, [load, selected?.id, editMode, returnMode]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (editMode) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [editMode]);
  useEffect(() => { const handler = (event: Event) => { const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId; if (!taskId) return; if (editMode && taskId !== selected?.id) { setError('Сначала завершите редактирование текущего ответа.'); return; } openTask(taskId, editMode || returnMode); }; window.addEventListener('ragchat:open-review', handler); return () => window.removeEventListener('ragchat:open-review', handler); }, [editMode, returnMode, selected?.id]);
  useEffect(() => {
    const handler = (event: Event) => {
      const preset = (event as CustomEvent<{ preset?: string }>).detail?.preset;
      if (preset === 'mine') { setAssigned(user.id); setPage(1); }
      if (preset === 'all') { setAssigned(''); setPage(1); }
      if (preset === 'unassigned') { setAssigned('__unassigned__'); setPage(1); }
    };
    window.addEventListener('ragchat:queue-preset', handler);
    return () => window.removeEventListener('ragchat:queue-preset', handler);
  }, [user.id]);
  useEffect(() => {
    if (!editMode || !selected?.id) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(reviewDraftKey(selected.id), JSON.stringify({ answer, updatedAt: new Date().toISOString() }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [answer, editMode, selected?.id, user.id]);

  const action = async (kind: 'claim' | 'approve' | 'edit' | 'return' | 'regenerate') => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      if (kind === 'claim') await post(`/api/reviews/${selected.id}/claim`);
      if (kind === 'approve') await post(`/api/reviews/${selected.id}/approve`);
      if (kind === 'edit') await post(`/api/reviews/${selected.id}/edit-and-send`, { answer });
      if (kind === 'return') await post(`/api/reviews/${selected.id}/return`, { comment, expertId: returnExpert, version: selected.discussion?.version });
      if (kind === 'regenerate') await post(`/api/reviews/${selected.id}/regenerate`);
      if (kind === 'approve' || kind === 'edit' || kind === 'return' || kind === 'regenerate') clearReviewDraft(selected.id);
      await load();
      if (kind === 'approve' || kind === 'edit' || kind === 'return' || kind === 'regenerate') { setSelected(null); setEditMode(false); setReturnMode(false); }
      else await openTask(selected.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const chooseTask = (taskId: string) => {
    if (editMode) {
      if (taskId !== selected?.id) setError('Сначала нажмите «Отмена», «Правку на обсуждение» или «Вернуть».');
      return;
    }
    openTask(taskId);
  };
  const closeTask = () => { if (editMode) { setError('Сначала нажмите «Отмена», «Правку на обсуждение» или «Вернуть».'); return; } setSelected(null); };
  const cancelEdit = () => {
    if (answer !== initialAnswer && !window.confirm('Удалить сохранённую на устройстве правку?')) return;
    clearReviewDraft(selected?.id);
    setEditMode(false);
    setAnswer(initialAnswer);
  };
  const updatePresence = async (next: 'AVAILABLE' | 'BUSY' | 'DND') => { setPresence(next); try { await patch('/api/experts/me/presence', { status: next }); } catch (e) { setError((e as Error).message); } };
  const route = async (body: Record<string, unknown>) => { if (!selected) return; try { const data = await patch<{ task: ReviewTask }>(`/api/reviews/${selected.id}/routing`, body); setSelected(data.task); await load(); } catch (e) { setError((e as Error).message); } };
  const addInternalComment = async () => { if (!selected || internalComment.trim().length < 2) return; try { const data = await post<{ task: ReviewTask }>(`/api/reviews/${selected.id}/comments`, { text: internalComment, mentionIds }); setSelected(data.task); setInternalComment(''); setMentionIds([]); } catch (e) { setError((e as Error).message); } };
  const transfer = async () => { if (!selected || !transferExpert || transferComment.trim().length < 3) return; try { await post(`/api/reviews/${selected.id}/transfer`, { expertId: transferExpert, comment: transferComment }); setSelected(null); setTransferExpert(''); setTransferComment(''); await load(); } catch (e) { setError((e as Error).message); } };
  const saveTemplate = async () => { const title = window.prompt('Название шаблона'); if (!title?.trim() || answer.trim().length < 3) return; try { const data = await post<{ template: { id: string; title: string; content: string } }>('/api/review-templates', { title, content: answer }); setTemplates((current) => [...current, data.template]); } catch (e) { setError((e as Error).message); } };

  const filteredTasks = tasks;
  const canAct = selected?.status === 'IN_REVIEW' && (user.role === 'ADMIN' || selected.representativeId !== user.id) && (selected.assignedTo === user.id || user.role === 'ADMIN');
  const selectedPool = selected?.reviewPool || 'GENERAL';
  const poolAllowed = user.role === 'ADMIN' || user.role === 'MANAGER' || (user.role === 'EXPERT' && selectedPool === 'GENERAL') || (user.role === 'SPECIALIST' && selectedPool === 'SPECIALIST');
  const routeProtected = Boolean(selected?.routedTo && selected.routedTo !== user.id && selected.routedAt && Date.now() < new Date(selected.routedAt).getTime() + 15 * 60_000 && user.role !== 'ADMIN');
  const claimBlockedReason = !selected || selected.status !== 'WAITING_REVIEW' ? ''
    : !(user.permissions?.includes('reviews.manage') ?? false) ? 'У вашей учётной записи нет права брать вопросы в работу'
      : !poolAllowed ? selectedPool === 'SPECIALIST' ? 'Вопрос относится к очереди профильных экспертов' : 'Вопрос относится к общей очереди'
        : user.role !== 'ADMIN' && selected.representativeId === user.id ? 'Собственный вопрос нельзя согласовывать самостоятельно'
          : routeProtected ? 'Вопрос временно назначен другому сотруднику' : '';
  const canClaim = selected?.status === 'WAITING_REVIEW' && !claimBlockedReason;
  const visibleWorkload = workload.filter((expert) => user.role === 'MANAGER' || user.role === 'ADMIN' || expert.role === user.role);
  const eligibleExperts = experts.filter((expert) => selected?.status === 'DISCUSSION' || expert.role === 'MANAGER' || expert.role === 'ADMIN' || (selected?.reviewPool === 'SPECIALIST' ? expert.role === 'SPECIALIST' : expert.role === 'EXPERT'));
  const queueScope = assigned === user.id ? 'mine' : assigned === '__unassigned__' ? 'unassigned' : 'all';
  const setQueueScope = (scope: 'all' | 'mine' | 'unassigned') => { setAssigned(scope === 'mine' ? user.id : scope === 'unassigned' ? '__unassigned__' : ''); setPage(1); window.dispatchEvent(new CustomEvent('ragchat:queue-scope-changed', { detail: { scope: scope === 'mine' ? 'mine' : 'all' } })); };
  const defaultPool = user.role === 'EXPERT' ? 'GENERAL' : user.role === 'SPECIALIST' ? 'SPECIALIST' : '';
  const resetFilters = () => { setStatus('OPEN'); setHasComment(''); setRepresentative(''); setAssigned(''); setReviewPool(defaultPool); setPriority(''); setProduct(''); setDateFrom(''); setDateTo(''); setSort('desc'); setPage(1); };
  const activeFilterCount = [status !== 'OPEN', hasComment, representative, assigned, reviewPool !== defaultPool, priority, product, dateFrom, dateTo, sort !== 'desc'].filter(Boolean).length;
  const filterChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (status !== 'OPEN') filterChips.push({ key: 'status', label: status ? statusLabels[status] || status : 'Все статусы', clear: () => setStatus('OPEN') });
  if (priority) filterChips.push({ key: 'priority', label: priority === 'CRITICAL' ? 'Критические' : priority === 'URGENT' ? 'Срочные' : 'Обычные', clear: () => setPriority('') });
  if (hasComment) filterChips.push({ key: 'comment', label: hasComment === 'yes' ? 'С комментарием' : 'Без комментария', clear: () => setHasComment('') });
  if (product) filterChips.push({ key: 'product', label: product, clear: () => setProduct('') });
  if (dateFrom || dateTo) filterChips.push({ key: 'date', label: `${dateFrom || '…'} — ${dateTo || '…'}`, clear: () => { setDateFrom(''); setDateTo(''); } });

  return (
    <section className={cx('review-page', embedded && 'embedded')}>
      {error && <ErrorNotice error={error} onClose={() => setError('')} />}
      <header className="page-heading"><div><h1>Очередь вопросов</h1><p>Изучите вопрос и источники до принятия в работу.</p></div><div className="expert-toolbar"><label>Мой статус<select value={presence} onChange={(event) => updatePresence(event.target.value as 'AVAILABLE' | 'BUSY' | 'DND')}><option value="AVAILABLE">Доступен</option><option value="BUSY">В работе</option><option value="DND">Не беспокоить</option></select></label><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button></div></header>
      <div className="expert-load-strip">{visibleWorkload.map((expert) => <div key={expert.id} className={expert.id === user.id ? 'current' : ''}><span className={`presence-dot ${expert.status.toLowerCase()}`} /><strong>{expert.name}</strong><span>{expert.role ? `${roleLabels[expert.role]} · ` : ''}{expert.workload} в работе · {expert.averageReviewMinutes || 0} мин в среднем</span></div>)}</div>
      <div className="review-layout">
        <div className="queue-pane">
          <div className="mobile-queue-tools">
            <label className="search-field"><Search size={17} /><input aria-label="Поиск по вопросу" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Поиск по вопросу" /></label>
            <div className="queue-quick-scopes" aria-label="Быстрый фильтр"><button className={queueScope === 'mine' ? 'active' : ''} onClick={() => setQueueScope('mine')}>Мои</button><button className={queueScope === 'all' ? 'active' : ''} onClick={() => setQueueScope('all')}>Все</button><button className={queueScope === 'unassigned' ? 'active' : ''} onClick={() => setQueueScope('unassigned')}>Свободные</button></div>
            <button className={cx('mobile-filters-trigger', activeFilterCount > 0 && 'active')} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={18} /><span>Фильтры{activeFilterCount ? ` · ${activeFilterCount}` : ''}</span></button>
          </div>
          {filtersOpen && <button className="filter-sheet-scrim" onClick={() => setFiltersOpen(false)} aria-label="Закрыть фильтры" />}
          <div className={cx('filter-bar', filtersOpen && 'mobile-open')}>
            <div className="mobile-filter-sheet-head"><div><strong>Фильтры очереди</strong><span>{activeFilterCount ? `Выбрано: ${activeFilterCount}` : 'Показываются активные вопросы'}</span></div><button className="icon-button" onClick={() => setFiltersOpen(false)} aria-label="Закрыть"><X size={19} /></button></div>
            <label className="search-field desktop-filter-search"><Search size={16} /><input aria-label="Поиск по вопросу" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Поиск по вопросу" /></label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Статус"><option value="OPEN">Активные</option><option value="WAITING_REVIEW">Ожидают</option><option value="IN_REVIEW">В работе</option><option value="DISCUSSION">На обсуждении</option><option value="DELIVERED">Доставлены</option><option value="">Все</option></select>
            <select value={representative} onChange={(e) => { setRepresentative(e.target.value); setPage(1); }} aria-label="Сотрудник"><option value="">Все сотрудники</option>{representatives.map((rep) => <option key={rep.id} value={rep.id}>{rep.firstName} {rep.lastName}</option>)}</select>
            <select value={assigned} onChange={(e) => { setAssigned(e.target.value); setPage(1); }} aria-label="Назначенный эксперт"><option value="">Все эксперты</option><option value="__unassigned__">Без исполнителя</option>{experts.map((expert) => <option key={expert.id} value={expert.id}>{expert.firstName} {expert.lastName}</option>)}</select>
            {(user.role === 'MANAGER' || user.role === 'ADMIN') && <select value={reviewPool} onChange={(e) => { setReviewPool(e.target.value); setPage(1); }} aria-label="Направление"><option value="">Все направления</option><option value="GENERAL">Общие</option><option value="SPECIALIST">Профильные эксперты</option></select>}
            <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} aria-label="Приоритет"><option value="">Любой приоритет</option><option value="NORMAL">Обычный</option><option value="URGENT">Срочный</option><option value="CRITICAL">Критический</option></select>
            <select value={product} onChange={(e) => { setProduct(e.target.value); setPage(1); }} aria-label="Тема"><option value="">Все темы</option>{products.map((item) => <option key={item}>{item}</option>)}</select>
            <select value={hasComment} onChange={(e) => { setHasComment(e.target.value); setPage(1); }} aria-label="Наличие комментария"><option value="">Комментарий: любой</option><option value="yes">Комментарий: да</option><option value="no">Комментарий: нет</option></select>
            <label className="date-filter">С<input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} /></label>
            <label className="date-filter">По<input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} /></label>
            <button className="sort-button" onClick={() => setSort(sort === 'desc' ? 'asc' : 'desc')}>{sort === 'desc' ? <ArrowDown size={16} /> : <ArrowUp size={16} />}{sort === 'desc' ? 'Сначала новые' : 'Сначала старые'}</button>
            <div className="mobile-filter-sheet-actions"><button className="button secondary" onClick={resetFilters}>Сбросить всё</button><button className="button primary" onClick={() => setFiltersOpen(false)}>Показать {pagination.total}</button></div>
          </div>
          {filterChips.length > 0 && <div className="mobile-filter-chips">{filterChips.map((chip) => <button key={chip.key} onClick={() => { chip.clear(); setPage(1); }}>{chip.label}<X size={13} /></button>)}</div>}
          <div className={cx('queue-summary', (!online || syncFailed) && 'stale')}><strong>{pagination.total}</strong> вопросов <span>•</span> {!online ? 'офлайн, показаны сохранённые данные' : syncFailed ? 'не удалось обновить' : lastSyncedAt ? `обновлено в ${lastSyncedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'обновление…'}</div>
          <div className="table-wrap review-queue-table-wrap">
            <table className="queue-table">
              <thead><tr><th>Поступил</th><th>SLA</th><th>Направление</th><th>Статус</th><th>Вопрос</th><th>Тема</th><th>Автор</th><th>Исполнитель</th><th>Комментарий</th><th /></tr></thead>
              <tbody>
                {filteredTasks.map((task) => (
                  <tr key={task.id} className={cx(selected?.id === task.id && 'selected-row', `priority-${(task.priority || 'NORMAL').toLowerCase()}`)} onClick={() => chooseTask(task.id)}>
                    <td><time>{formatDate(task.createdAt)}</time></td><td><SlaBadge task={task} /></td><td><span className={cx('pool-badge', task.reviewPool === 'SPECIALIST' && 'strategy')}>{poolLabels[task.reviewPool || 'GENERAL']}</span></td><td><StatusBadge status={task.status} /></td>
                    <td className="question-cell">{task.status === 'WAITING_REVIEW' && task.returnTo === user.id && <span className="addressed-label">Закреплён за вами</span>}<strong>{task.question}</strong></td><td>{task.productName || 'Не определён'}</td><td>{task.representative?.name}</td><td>{task.assignedExpert?.name || (task.routedTo ? 'Назначен автоматически' : '—')}</td>
                    <td>{task.hasComment ? <span className="comment-yes" title={task.returnComment}>Да</span> : <span className="muted">Нет</span>}</td>
                    <td><button className="icon-button row-open" onClick={(event) => { event.stopPropagation(); chooseTask(task.id); }} aria-label={`Открыть вопрос: ${task.question}`}><ChevronRight size={17} /></button></td>
                  </tr>
                ))}
                {filteredTasks.length === 0 && <tr><td colSpan={10}><div className="table-empty"><CheckCircle2 size={24} /><strong>По выбранным условиям вопросов нет</strong><span>Измените фильтры или дождитесь новых обращений.</span></div></td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mobile-review-list" aria-label="Очередь вопросов">
            {filteredTasks.map((task) => (
              <button type="button" key={task.id} className={cx('mobile-review-card', selected?.id === task.id && 'selected', `priority-${(task.priority || 'NORMAL').toLowerCase()}`)} onClick={() => chooseTask(task.id)}>
                <span className="mobile-review-card-top">
                  <StatusBadge status={task.status} />
                  <SlaBadge task={task} />
                  <span className={cx('pool-badge', task.reviewPool === 'SPECIALIST' && 'strategy')}>{poolLabels[task.reviewPool || 'GENERAL']}</span>
                  <ChevronRight className="mobile-review-open" size={19} aria-hidden="true" />
                </span>
                {task.status === 'WAITING_REVIEW' && task.returnTo === user.id && <span className="addressed-label">Закреплён за вами</span>}<strong className="mobile-review-question">{task.question}</strong>
                <span className="mobile-review-product">{task.productName || 'Тема не определён'}</span>
                <span className="mobile-review-meta">
                  <span><small>Поступил</small><time>{formatDate(task.createdAt)}</time></span>
                  <span><small>Автор</small><strong>{task.representative?.name || 'Не указан'}</strong></span>
                  <span className="mobile-review-executor"><small>Исполнитель</small><strong>{task.assignedExpert?.name || (task.routedTo ? 'Назначен автоматически' : 'Не назначен')}</strong></span>
                </span>
                {task.hasComment && <span className="mobile-review-comment"><small>Комментарий</small><span>{task.returnComment || 'К вопросу добавлен комментарий'}</span></span>}
              </button>
            ))}
            {filteredTasks.length === 0 && <div className="mobile-review-empty"><CheckCircle2 size={25} /><strong>По выбранным условиям вопросов нет</strong><span>Измените фильтры или дождитесь новых обращений.</span></div>}
          </div>
          {pagination.pages > 1 && <nav className="pagination" aria-label="Страницы очереди"><button className="button secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><span>Страница {pagination.page} из {pagination.pages}</span><button className="button secondary" disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>Далее</button></nav>}
        </div>

        <aside className={cx('review-detail', selected && 'open')}>
          {!selected ? <div className="detail-empty"><Clipboard size={28} /><h2>Выберите вопрос</h2><p>Полный текст, черновик и источники откроются здесь.</p></div> : (
            <>
              <div className="detail-head"><div><StatusBadge status={selected.status} /><SlaBadge task={selected} detailed /><time>{formatDate(selected.createdAt)}</time></div><button className="icon-button" onClick={closeTask} aria-label="Закрыть"><X size={20} /></button></div>
              <div className="detail-scroll">
                <section className="review-block"><div className="block-title"><h3>Вопрос сотрудника</h3><span className={cx('pool-badge', selected.reviewPool === 'SPECIALIST' && 'strategy')}>{poolLabels[selected.reviewPool || 'GENERAL']}</span></div><p className="review-question">{selected.question}</p><div className="metadata-line"><span>{selected.representative?.name}</span><span>{selected.conversationTitle}</span><span>{selected.productName || 'Тема не определён'}</span></div>{selected.routingReason && <p className="routing-reason">Маршрутизация ИИ: {selected.routingReason}{selected.routingConfidence != null ? ` · ${Math.round(selected.routingConfidence * 100)}%` : ''}</p>}</section>
                <section className="review-block task-timing mobile-hidden-review-context"><h3>Время по этапам</h3><div><span><small>Генерация ИИ</small><strong>{selected.timing?.generationMinutes ?? '—'} мин</strong></span><span><small>Ожидание эксперта</small><strong>{selected.timing?.queueMinutes ?? '—'} мин</strong></span><span><small>Проверка</small><strong>{selected.timing?.reviewMinutes ?? '—'} мин</strong></span></div>{selected.delayReason && <p><Clock3 size={15} /> Причина задержки: {selected.delayReason}</p>}</section>
                {(user.permissions?.includes('reviews.route') ?? user.role === 'ADMIN') && !['DELIVERED', 'DISCUSSION'].includes(selected.status) && <section className="review-block routing-controls mobile-hidden-review-context"><h3>Маршрутизация</h3><div>{(user.role === 'MANAGER' || user.role === 'ADMIN') && <label>Направление<select value={selected.reviewPool || 'GENERAL'} onChange={(event) => route({ reviewPool: event.target.value })}><option value="GENERAL">Общая очередь</option><option value="SPECIALIST">Очередь профильных экспертов</option></select></label>}<label>Приоритет<select value={selected.priority || 'NORMAL'} onChange={(event) => route({ priority: event.target.value })}><option value="NORMAL">Обычный · 120 мин</option><option value="URGENT">Срочный · 60 мин</option><option value="CRITICAL">Критический · 30 мин</option></select></label><label>Назначить<select value={selected.routedTo || ''} onChange={(event) => route({ routedTo: event.target.value })}><option value="">Без назначения</option>{eligibleExperts.map((expert) => <option key={expert.id} value={expert.id}>{expert.firstName} {expert.lastName} · {roleLabels[expert.role]}</option>)}</select></label></div></section>}
                {selected.returnComment && <section className="return-note"><RotateCcw size={18} /><div><strong>Комментарий возврата</strong><p>{selected.returnComment}</p></div></section>}
                <DiscussionPanel task={selected} user={user} onChange={async () => { await load(); await openTask(selected.id, true); }} onReturn={() => { setReturnExpert(''); setReturnMode(true); }} />
                <section className="review-block"><div className="block-title"><h3>{selected.status === 'DELIVERED' ? 'Отправленный ответ' : selected.discussion ? 'Ответ на обсуждении' : 'Черновик ИИ'}</h3>{selected.confidence != null && <span>Уверенность поиска: {Math.round(selected.confidence * 100)}%</span>}</div>
                  {editMode ? <>{restoredDraftAt && <div className="draft-restored" role="status"><CheckCircle2 size={16} /><span>Восстановлена правка с устройства · {formatDate(restoredDraftAt)}</span></div>}<div className="template-picker"><select defaultValue="" onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) setAnswer((current) => `${current}${current ? '\n\n' : ''}${template.content}`); event.target.value = ''; }}><option value="">Вставить шаблон…</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}</select><button onClick={saveTemplate}>Сохранить как шаблон</button><span>{answer !== initialAnswer ? 'Сохранено на устройстве' : 'Без изменений'}</span></div><textarea className="answer-editor" aria-label="Исправленный ответ" value={answer} onChange={(e) => setAnswer(e.target.value)} /></> : <div className="draft-text message-markdown"><MarkdownMessage content={selected.discussion?.answer || selected.aiDraft || 'Черновик ещё формируется.'} /></div>}
                </section>
                <EvidencePanel task={selected} />
                <section className="review-block response-history mobile-hidden-review-context"><h3>История версий ответа</h3>{selected.responseVersions?.length ? [...selected.responseVersions].reverse().map((version, index) => <details key={version.id} open={index === 0}><summary><span>{version.type === 'AI_DRAFT' ? 'Черновик ИИ' : version.type === 'AI_DEGRADED' ? 'Резервный черновик' : version.type === 'EXPERT_EDIT' ? 'Правка эксперта' : 'Согласованная версия'}</span><time>{formatDate(version.createdAt)}</time></summary><div className="message-markdown"><MarkdownMessage content={version.content} /></div></details>) : <p className="muted">Версии появятся после подготовки первого черновика.</p>}</section>
                <section className="review-block mobile-hidden-review-context"><h3>Утверждённые ответы экспертов</h3>{selected.ragMeta?.expertKnowledgeMatches?.length ? <div className="source-list">{selected.ragMeta.expertKnowledgeMatches.map((match) => <div className="source-item source-preview" key={match.id}><ShieldCheck size={17} /><div><strong>{match.question}</strong><p>{match.answer}</p><span>Версия {match.version} · совпадение {Math.round(match.score * 100)}%</span></div></div>)}</div> : <p className="muted">Ранее утверждённых ответов по этому вопросу не найдено.</p>}</section>
                <section className="review-block mobile-hidden-review-context"><h3>Внутренние документы</h3>{selected.sources?.length ? <div className="source-list">{selected.sources.map((source, index) => <div className="source-item source-preview" key={`${source.source}-${index}`}><FileText size={17} /><div><strong>{source.title || source.source}</strong>{source.text && <p>{source.text}</p>}<span>{source.page ? `Страница ${source.page}` : 'Страница не указана'}{source.version ? ` · ред. ${source.version}` : ''}</span></div></div>)}</div> : <p className="muted">Подходящие внутренние фрагменты не найдены.</p>}</section>
                <section className="review-block mobile-hidden-review-context"><h3>Интернет-источники</h3>{selected.webSources?.length ? <div className="source-list">{selected.webSources.map((source, index) => <a className="source-item source-preview" key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer"><BookOpen size={17} /><div><strong>{source.title || source.url}</strong>{source.text && <p>{source.text}</p>}<span>{source.trustCategory || 'Интернет-источник: проверьте достоверность'} · {source.url}</span></div></a>)}</div> : <p className="muted">Интернет-источники не получены. Причина указана в черновике; это не означает, что сведений в сети нет.</p>}</section>
                {history.length > 1 && <section className="review-block"><h3>Контекст диалога</h3><div className="history-list">{history.slice(0, -1).map((message) => <p key={message.id}><strong>{message.authorType === 'USER' ? 'Сотрудник' : 'Официальный ответ'}:</strong> {message.content}</p>)}</div></section>}
                <section className="review-block collaboration-block"><h3>Внутренние комментарии</h3><div className="internal-comments">{selected.internalComments?.map((item) => <div key={item.id}><strong>{item.authorName || 'Эксперт'}</strong><p>{item.text}</p><time>{formatDate(item.createdAt)}</time></div>)}{!selected.internalComments?.length && <p className="muted">Комментариев пока нет.</p>}</div><textarea value={internalComment} onChange={(event) => setInternalComment(event.target.value)} placeholder="Комментарий для команды" /><div className="mention-picker">{eligibleExperts.filter((expert) => expert.id !== user.id).map((expert) => <label key={expert.id}><input type="checkbox" checked={mentionIds.includes(expert.id)} onChange={(event) => setMentionIds((current) => event.target.checked ? [...current, expert.id] : current.filter((id) => id !== expert.id))} /> @{expert.firstName} {expert.lastName}</label>)}</div><button className="button secondary compact" disabled={internalComment.trim().length < 2} onClick={addInternalComment}>Добавить комментарий</button></section>
                {canAct && <section className="review-block transfer-block"><h3>Передать коллеге</h3><select value={transferExpert} onChange={(event) => setTransferExpert(event.target.value)}><option value="">Выберите сотрудника</option>{eligibleExperts.filter((expert) => expert.id !== user.id).map((expert) => <option key={expert.id} value={expert.id}>{expert.firstName} {expert.lastName} · {roleLabels[expert.role]}</option>)}</select><textarea value={transferComment} onChange={(event) => setTransferComment(event.target.value)} placeholder="Причина передачи" /><button className="button secondary compact" disabled={!transferExpert || transferComment.trim().length < 3} onClick={transfer}>Передать вопрос</button></section>}
                {returnMode && <section className="return-form"><label>Кому вернуть вопрос?<select value={returnExpert} onChange={(e) => setReturnExpert(e.target.value)}><option value="">Выберите эксперта</option>{experts.filter((e) => e.isActive && ['EXPERT', 'SPECIALIST'].includes(e.role) && e.id !== selected.representativeId).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} · {roleLabels[e.role]}</option>)}</select></label><label>Почему вопрос возвращается в очередь?<textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий увидят другие эксперты" autoFocus /></label><div><button className="button secondary" onClick={() => setReturnMode(false)}>Отмена</button><button className="button danger" disabled={busy || !returnExpert || comment.trim().length < 3} onClick={() => action('return')}>Вернуть адресату</button></div></section>}
              </div>
              <div className="detail-actions">
                {!selected.aiDraft?.trim() && selected.status !== 'DELIVERED' && (user.role === 'ADMIN' || selected.assignedTo === user.id || !selected.assignedTo) && <button className="button secondary wide" disabled={busy} onClick={() => action('regenerate')}>{busy ? <Spinner /> : <RefreshCw size={17} />} Повторить формирование черновика</button>}
                {canClaim && <button className="button primary wide" disabled={busy} onClick={() => action('claim')}>{busy ? <Spinner /> : <ShieldCheck size={17} />} Взять в работу</button>}
                {selected.status === 'WAITING_REVIEW' && !canClaim && <div className="locked-message"><ShieldCheck size={18} /> {claimBlockedReason || 'Вопрос сейчас недоступен для взятия в работу'}</div>}
                {selected.status === 'IN_REVIEW' && !canAct && <div className="locked-message"><Clock3 size={18} /> Вопрос уже закреплён за {selected.assignedExpert?.name || 'другим экспертом'}</div>}
                {canAct && !returnMode && <>
                  <button className="button secondary" onClick={() => { setReturnMode(true); setEditMode(false); }}><RotateCcw size={16} /> Вернуть</button>
                  {!editMode ? <button className="button secondary" onClick={() => { setRestoredDraftAt(''); setEditMode(true); setAnswer(selected.aiDraft); setInitialAnswer(selected.aiDraft); }}><Edit3 size={16} /> Исправить</button> : <button className="button secondary" onClick={cancelEdit}>Отмена</button>}
                  {editMode ? <button className="button primary" disabled={busy || answer.trim().length < 3} onClick={() => action('edit')}>{busy ? <Spinner /> : <Send size={16} />} Правку на обсуждение</button> : <button className="button primary" disabled={busy} onClick={() => action('approve')}>{busy ? <Spinner /> : <Check size={16} />} Согласовать и обсудить</button>}
                </>}
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function KnowledgePage({ user }: { user: User }) {
  const [documentNotice, setDocumentNotice] = useState('');
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [documents, setDocuments] = useState<Array<{ name: string; title: string; version: string; chunks: number; pages: number; versions?: Array<{ version: number; createdAt: string; size: number; sha256: string; current?: boolean }> }>>([]);
  const [reindex, setReindex] = useState<{ status: string; error?: string } | null>(null);
  const indexing = reindex?.status === 'running' || reindex?.status === 'scheduled';
  const canManageDocuments = user.permissions?.includes('documents.manage');
  const [view, setView] = useState<'expert' | 'documents'>('expert');
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const [knowledgeData, documentData] = await Promise.all([
      api<{ entries: KnowledgeEntry[] }>('/api/knowledge'),
      api<{ documents: typeof documents; reindex: { status: string; error?: string } }>('/api/documents'),
    ]);
    setEntries(knowledgeData.entries); setDocuments(documentData.documents); setReindex(documentData.reindex);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    if (!indexing) return;
    const timer = window.setInterval(() => { load().catch((e) => setError(e.message)); }, 2500);
    return () => window.clearInterval(timer);
  }, [indexing, load]);
  const choose = (entry: KnowledgeEntry) => { setSelected(entry); setQuestion(entry.question); setAnswer(entry.answer); };
  const save = async (isActive = selected?.isActive) => {
    if (!selected) return; setBusy(true);
    try { await patch(`/api/knowledge/${selected.id}`, { question, answer, isActive }); await load(); setSelected(null); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const uploadDocument = async (file?: File) => {
    if (!file) return;
    setError(''); setDocumentNotice('');
    const form = new FormData(); form.append('file', file); setBusy(true);
    try { await upload('/api/documents', form); setView('documents'); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const startReindex = async () => {
    setError(''); setDocumentNotice('');
    setBusy(true);
    try { await post('/api/documents/reindex'); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const restoreDocument = async (name: string, version: number) => { if (!window.confirm(`Восстановить версию ${version} документа ${name}? Она станет новой текущей версией.`)) return; setBusy(true); try { await post(`/api/documents/${encodeURIComponent(name)}/versions/${version}/restore`); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const deleteDocument = async (name: string) => {
    if (!window.confirm(`Удалить «${name}» из базы знаний?\n\nБудут удалены PDF, все сохранённые версии и фрагменты из поискового индекса. Экспертные ответы и история чатов сохранятся. Отменить удаление в интерфейсе нельзя.`)) return;
    setBusy(true); setError(''); setDocumentNotice('');
    try {
      await remove(`/api/documents/${encodeURIComponent(name)}`);
      setDocuments((items) => items.filter((item) => item.name !== name));
      setDocumentNotice(`«${name}» удалён из базы знаний и поиска.`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="content-page">
      {error && <ErrorNotice error={error} onClose={() => setError('')} />}
      <header className="page-heading"><div><h1>База знаний</h1><p>Документы и ответы, исправленные при согласовании.</p></div><div className="heading-actions"><input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => uploadDocument(event.target.files?.[0])} /><button className="button secondary" onClick={() => load().catch((e) => setError(e.message))}><RefreshCw size={16} /> Обновить</button>{canManageDocuments && <button className="button primary" disabled={busy || indexing} onClick={() => fileRef.current?.click()}><Plus size={16} /> Загрузить PDF</button>}</div></header>
      <div className="segmented"><button className={view === 'expert' ? 'active' : ''} onClick={() => setView('expert')}>Экспертные ответы <span>{entries.length}</span></button><button className={view === 'documents' ? 'active' : ''} onClick={() => setView('documents')}>Документы <span>{documents.length}</span></button></div>
      {view === 'expert' ? <div className="knowledge-layout">
        <div className="knowledge-list">
          <div className="list-caption"><strong>{entries.length}</strong> записей <span>•</span> изменения индексируются сразу</div>
          {entries.map((entry) => <button key={entry.id} className={cx('knowledge-row', selected?.id === entry.id && 'selected')} onClick={() => choose(entry)}><div><strong>{entry.question}</strong><p>{entry.answer}</p></div><div className="knowledge-meta"><span>v{entry.version}</span><span className={cx('index-state', entry.indexStatus.toLowerCase())}>{entry.indexStatus === 'READY' ? 'В поиске' : entry.indexStatus === 'FAILED' ? 'Ошибка' : 'Индексация'}</span>{!entry.isActive && <span>Отключено</span>}</div></button>)}
          {entries.length === 0 && <div className="empty-state"><Database size={30} /><h2>Исправленных ответов пока нет</h2><p>Первая запись появится после отправки экспертом изменённого черновика.</p></div>}
        </div>
        <aside className="knowledge-editor">
          {!selected ? <div className="detail-empty"><Edit3 size={28} /><h2>Выберите запись</h2><p>Можно изменить текст, отключить запись и сразу обновить индекс.</p></div> : <>
            <div className="editor-head"><div><span>Версия {selected.version}</span><h2>Редактирование знания</h2></div><button className="icon-button" onClick={() => setSelected(null)}><X size={20} /></button></div>
            <label>Вопрос<textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
            <label>Утверждённый ответ<textarea className="large" value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
            <div className="editor-actions"><button className="button secondary" onClick={() => save(!selected.isActive)}>{selected.isActive ? <Archive size={16} /> : <Check size={16} />}{selected.isActive ? 'Отключить' : 'Включить'}</button><button className="button primary" disabled={busy} onClick={() => save()}>{busy ? <Spinner /> : <RefreshCw size={16} />} Сохранить и переиндексировать</button></div>
            <section className="version-history"><h3>История версий</h3>{selected.versions?.map((version) => <details key={version.version}><summary><strong>Версия {version.version}</strong><span>{formatDate(version.createdAt)}</span></summary><p>{version.question}</p><div className="message-markdown"><MarkdownMessage content={version.answer} /></div></details>)}</section>
          </>}
        </aside>
      </div> : <div className="documents-pane">
        <div className="documents-toolbar"><div><strong>Индекс документов</strong><span className={cx('index-state', reindex?.status === 'ready' ? 'ready' : reindex?.status === 'failed' ? 'failed' : '')}>{indexing ? 'Переиндексация выполняется' : reindex?.status === 'failed' ? 'Ошибка индексации' : documents.length === 0 ? 'Нет PDF-документов' : 'Готов к поиску'}</span></div>{canManageDocuments && <button className="button secondary" disabled={busy || indexing} onClick={startReindex}>{busy ? <Spinner /> : <RefreshCw size={16} />} Переиндексировать всё</button>}</div>
        {reindex?.error && <div className="inline-error">{reindex.error}</div>}
        {documentNotice && <p className="document-notice" role="status">{documentNotice}</p>}
        <div className="document-list">{documents.map((document) => <div className="document-row document-version-row" key={document.name}>
          <div className="document-icon"><FileText size={20} /></div>
          <div><strong title={document.title}>{document.title}</strong><span title={document.name}>{document.name}</span>{document.chunks === 0 && <span>Пока нет фрагментов в индексе</span>}
            {Boolean(document.versions?.length) && <details><summary>{document.versions?.length} версий</summary><div className="document-versions">{document.versions?.map((version) => <div key={version.version}><span>v{version.version} · {formatDate(version.createdAt)} · {Math.round(version.size / 1024)} КБ</span>{!version.current && canManageDocuments && <button className="button secondary compact" disabled={busy || indexing} onClick={() => restoreDocument(document.name, version.version)}>Восстановить</button>}</div>)}</div></details>}
          </div>
          <div className="document-actions"><dl><div><dt>Редакция</dt><dd>{document.version}</dd></div><div><dt>Страницы</dt><dd>{document.pages}</dd></div><div><dt>Фрагменты</dt><dd>{document.chunks}</dd></div></dl>
            {canManageDocuments && <button className="button secondary document-delete" disabled={busy || indexing} aria-label={`Удалить PDF ${document.name}`} onClick={() => deleteDocument(document.name)}><Trash2 size={16} /> Удалить PDF</button>}
          </div>
        </div>)}</div>
        {documents.length === 0 && <div className="empty-state"><FileText size={30} /><h2>PDF-документов пока нет</h2><p>{canManageDocuments ? 'Нажмите «Загрузить PDF», чтобы добавить книгу. ' : ''}Экспертные ответы остаются в отдельной вкладке.</p></div>}
      </div>}
    </section>
  );
}

type SalesDashboard = {
  generatedAt: string;
  periodDays: number;
  summary: {
    questions: number; delivered: number; active: number; overdue: number; attention: number;
    averageResponseMinutes: number; withinSlaPercent: number; positiveRatingPercent: number; ratings: number;
  };
  attention: Array<{
    id: string; title: string; question: string; reviewPool: 'GENERAL' | 'SPECIALIST'; priority: string;
    representative: { id: string; name: string } | null;
    assignedExpert: { id: string; name: string; role: Role } | null;
    elapsedMinutes: number; isOverdue: boolean; canRemind: boolean; lastReminderAt: string | null;
  }>;
  representatives: Array<{ id: string; name: string; questions: number; delivered: number; active: number }>;
  experts: Array<{ id: string; name: string; role: Role; status: string; workload: number; overdue: number; completed: number; averageReviewMinutes: number }>;
};

const minutesLabel = (value: number) => {
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} ч ${remainder} мин` : `${hours} ч`;
};

function SalesControlPage({ setSection }: { setSection: (section: string) => void }) {
  const [dashboard, setDashboard] = useState<SalesDashboard | null>(null);
  const [busyTaskId, setBusyTaskId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(() => api<{ dashboard: SalesDashboard }>('/api/sales/dashboard').then((result) => setDashboard(result.dashboard)), []);

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message));
    const timer = window.setInterval(() => load().catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openTask = (taskId: string) => {
    setSection('queue');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('ragchat:open-review', { detail: { taskId } })), 0);
  };

  const remind = async (taskId: string) => {
    setBusyTaskId(taskId); setError(''); setNotice('');
    try {
      const result = await post<{ delivery: { delivered: number; failed: number } }>(`/api/sales/reviews/${taskId}/remind`);
      setNotice(result.delivery.delivered > 0 ? 'Эксперт получил напоминание внутри сервиса и через PWA.' : 'Внутреннее напоминание отправлено. У эксперта нет активного PWA-устройства.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось отправить напоминание.');
    } finally {
      setBusyTaskId('');
    }
  };

  if (!dashboard) return <div className="page-loader"><Spinner /> Загружаем контроль команды</div>;
  const activeExperts = dashboard.experts.filter((expert) => expert.status !== 'DND').length;

  return <section className="content-page sales-control-page">
    {error && <ErrorNotice error={error} onClose={() => setError('')} />}
    {notice && <Notice message={notice} onClose={() => setNotice('')} />}
    <header className="page-heading sales-control-heading">
      <div><h1>Контроль команды</h1><p>Скорость вопросов, качество ответов и сотрудники, которым пора напомнить о работе.</p></div>
      <div className="heading-actions"><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button><button className="button primary" onClick={() => setSection('my-chats')}><MessageSquare size={16} /> Спросить ИИ</button></div>
    </header>

    <section className={cx('sales-attention-signal', dashboard.summary.overdue > 0 && 'urgent')}>
      <div><span>{dashboard.summary.overdue > 0 ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}</span><div><strong>{dashboard.summary.overdue > 0 ? `${dashboard.summary.overdue} ${dashboard.summary.overdue === 1 ? 'вопрос просрочен' : 'вопроса просрочено'}` : 'Просроченных вопросов нет'}</strong><p>{dashboard.summary.attention > dashboard.summary.overdue ? `Ещё ${dashboard.summary.attention - dashboard.summary.overdue} требуют внимания после 15 минут.` : 'Команда укладывается в текущий темп.'}</p></div></div>
      {dashboard.summary.attention > 0 && <button className="button secondary" onClick={() => document.getElementById('sales-attention')?.scrollIntoView({ behavior: 'smooth' })}>К списку внимания</button>}
    </section>

    <div className="sales-speed-ledger" aria-label={`Показатели за последние ${dashboard.periodDays} дней`}>
      <div><span>Вопросы за {dashboard.periodDays} дней</span><strong>{dashboard.summary.questions}</strong><small>{dashboard.summary.active} сейчас активны</small></div>
      <div><span>Средний ответ</span><strong>{minutesLabel(dashboard.summary.averageResponseMinutes)}</strong><small>{dashboard.summary.delivered} доставлено</small></div>
      <div><span>В пределах SLA</span><strong>{dashboard.summary.withinSlaPercent}%</strong><small>по завершённым вопросам</small></div>
      <div><span>Полезные ответы</span><strong>{dashboard.summary.positiveRatingPercent}%</strong><small>{dashboard.summary.ratings ? `${dashboard.summary.ratings} оценок` : 'оценок пока нет'}</small></div>
    </div>

    <section className="sales-attention-section" id="sales-attention">
      <div className="section-heading"><h2>Требуют внимания</h2><span>{dashboard.attention.length}</span></div>
      {dashboard.attention.length ? <div className="sales-attention-list">{dashboard.attention.map((task) => <article key={task.id} className={cx(task.isOverdue && 'overdue')}>
        <button className="sales-task-main" onClick={() => openTask(task.id)}>
          <span className={cx('sales-wait-time', task.isOverdue && 'overdue')}>{minutesLabel(task.elapsedMinutes)}</span>
          <div><strong>{task.title}</strong><p>{task.question}</p><small>{task.representative?.name || 'Автор не найден'} · {task.reviewPool === 'SPECIALIST' ? 'Профильные эксперты' : 'Общий вопрос'}</small></div>
        </button>
        <div className="sales-task-owner"><span>Ответственный</span><strong>{task.assignedExpert?.name || 'Не назначен'}</strong><small>{task.assignedExpert ? roleLabels[task.assignedExpert.role] : '—'}</small></div>
        <button className="button secondary compact" disabled={!task.canRemind || busyTaskId === task.id} onClick={() => remind(task.id)}>{busyTaskId === task.id ? <Spinner size={15} /> : <Bell size={15} />}{task.canRemind ? 'Напомнить' : task.lastReminderAt ? 'Уже напомнили' : 'Ещё рано'}</button>
      </article>)}</div> : <div className="sales-calm-state"><CheckCircle2 size={22} /><div><strong>Никого не нужно подгонять</strong><p>Здесь появятся вопросы, которые находятся у эксперта дольше 15 минут.</p></div></div>}
    </section>

    <div className="sales-team-split">
      <section className="sales-team-section"><div className="section-heading"><h2>Сотрудникставители</h2><span>за {dashboard.periodDays} дней</span></div><div className="sales-team-list">{dashboard.representatives.map((member) => <div key={member.id}><strong>{member.name}</strong><span>{member.questions} вопросов · {member.delivered} завершено</span><small>{member.active ? `${member.active} ожидают ответа` : 'нет активных вопросов'}</small></div>)}{!dashboard.representatives.length && <p className="muted">Активных сотрудников нет.</p>}</div></section>
      <section className="sales-team-section"><div className="section-heading"><h2>Эксперты</h2><span>{activeExperts} доступны</span></div><div className="sales-expert-list">{dashboard.experts.map((expert) => <div key={expert.id}><span className={cx('presence-label', expert.status.toLowerCase())}>{expert.status === 'BUSY' ? 'В работе' : expert.status === 'DND' ? 'Не беспокоить' : 'Доступен'}</span><div><strong>{expert.name}</strong><small>{expert.role === 'SPECIALIST' ? 'Профильные эксперты' : 'Эксперт'}</small></div><dl><div><dt>Сейчас</dt><dd>{expert.workload}</dd></div><div><dt>За 7 дней</dt><dd>{expert.completed}</dd></div><div className={cx(expert.overdue > 0 && 'danger')}><dt>Просрочено</dt><dd>{expert.overdue}</dd></div></dl></div>)}</div></section>
    </div>
  </section>;
}

function AdminOverview() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api('/api/admin/dashboard').then(setData).catch(() => undefined); }, []);
  if (!data) return <div className="page-loader"><Spinner /> Загружаем состояние платформы</div>;
  return <section className="content-page"><header className="page-heading"><div><h1>Состояние платформы</h1><p>Сначала — вопросы, требующие внимания; затем здоровье и накопленные знания.</p></div><span className={cx('health-pill', data.rag.status === 'ok' && 'ok')}><span />{data.rag.status === 'ok' ? 'RAG-ядро доступно' : 'Требуется внимание'}</span></header>
    <div className="operations-overview">
      <section className="operations-focus"><div className="section-heading"><h2>Очередь согласования</h2><span>{data.stats.overdue ? 'Есть просроченные' : 'В пределах регламента'}</span></div><div className="operations-numbers"><div><strong>{data.stats.waiting}</strong><span>ожидают исполнителя</span></div><div><strong>{data.stats.inReview}</strong><span>в работе</span></div><div className={cx(data.stats.overdue > 0 && 'attention')}><strong>{data.stats.overdue}</strong><span>более 30 минут</span></div></div><p>Самый ранний ожидающий вопрос: {data.stats.oldestWaitingMinutes < 60 ? `${data.stats.oldestWaitingMinutes} мин` : `${Math.floor(data.stats.oldestWaitingMinutes / 60)} ч ${data.stats.oldestWaitingMinutes % 60} мин`} назад.</p></section>
      <aside className="operations-secondary"><div><CheckCircle2 size={18} /><span>Доставлено</span><strong>{data.stats.delivered}</strong></div><div><Database size={18} /><span>Экспертных знаний</span><strong>{data.stats.knowledge}</strong></div><div><Users size={18} /><span>Активных сотрудников</span><strong>{data.stats.users}</strong></div><div><ThumbsUp size={18} /><span>Полезных оценок</span><strong>{data.stats.positiveRatings}</strong></div></aside>
    </div>
    <section className="component-summary"><div className="section-heading"><h2>Компоненты</h2><span>{data.components.filter((item: any) => item.status === 'ok').length} из {data.components.length} штатно</span></div><div>{data.components.map((component: any) => <span key={component.name} className={cx('component-chip', component.status)}><i />{component.name}<small>{component.detail}</small></span>)}</div></section>
    <section className="audit-section"><div className="section-heading"><h2>Последние события</h2><span>{data.audit.length}</span></div><div className="audit-list">{data.audit.slice(0, 12).map((event: any) => <div key={event.id}><Activity size={15} /><strong>{event.actorName} · {auditActionLabels[event.action] || event.action}</strong><span>{entityLabels[event.entityType] || event.entityType}: {event.entityId}</span><time>{formatDate(event.createdAt)}</time></div>)}</div></section>
  </section>;
}

type DirectoryMember = User & {
  name: string;
  workload?: { workload: number; completed: number; averageReviewMinutes: number; status: string } | null;
};

function DirectoryPage() {
  const [groups, setGroups] = useState<Record<string, DirectoryMember[]> | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const load = useCallback(() => api<{ groups: Record<string, DirectoryMember[]> }>('/api/directory').then((data) => setGroups(data.groups)), []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  if (!groups) return <div className="page-loader"><Spinner /> Загружаем состав команды</div>;
  const sections = [
    ['generalExperts', 'Эксперты'], ['representatives', 'Сотрудники'],
    ['sales', 'Руководители'], ['strategy', 'Профильные эксперты'],
  ] as const;
  const query = search.trim().toLowerCase();
  return <section className="content-page directory-page">
    {error && <ErrorNotice error={error} onClose={() => setError('')} />}
    <header className="page-heading"><div><h1>Команда</h1><p>Состав рабочих пулов, доступность сотрудников и текущая нагрузка.</p></div><button className="button secondary" onClick={load}><RefreshCw size={16} /> Обновить</button></header>
    <label className="search-field directory-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по имени, почте или роли" /></label>
    <div className="directory-groups">{sections.map(([key, title]) => {
      const members = (groups[key] || []).filter((member) => !query || `${member.name} ${member.email} ${roleLabels[member.role]}`.toLowerCase().includes(query));
      return <section className="directory-group" key={key}><div className="section-heading"><h2>{title}</h2><span>{members.length}</span></div><div className="directory-cards">{members.map((member) => <article key={member.id} className="directory-card"><div className="user-cell"><span>{member.firstName[0]}{member.lastName[0]}</span><div><strong>{member.name}</strong><small>{member.email}</small></div></div><span className={cx('presence-label', (member.expertStatus || member.workload?.status || 'AVAILABLE').toLowerCase())}>{(member.expertStatus || member.workload?.status) === 'BUSY' ? 'В работе' : (member.expertStatus || member.workload?.status) === 'DND' ? 'Не беспокоить' : 'Доступен'}</span>{member.workload && <div className="directory-metrics"><span><strong>{member.workload.workload}</strong> сейчас</span><span><strong>{member.workload.completed}</strong> завершено</span><span><strong>{member.workload.averageReviewMinutes || 0}</strong> мин среднее</span></div>}</article>)}{!members.length && <p className="muted">Сотрудники не найдены.</p>}</div></section>;
    })}</div>
  </section>;
}

function UsersPage({ currentUser }: { currentUser: User }) {
  const emptyForm = { firstName: '', lastName: '', email: '', password: '', role: 'REQUESTER' as Role, specialtiesText: '', productsText: '', expertStatus: 'AVAILABLE', permissionOverrides: {} as Record<string, boolean> };
  const [users, setUsers] = useState<User[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<Array<{ id: string; label: string }>>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const load = useCallback(() => api<{ users: User[]; permissionCatalog: Array<{ id: string; label: string }> }>('/api/admin/users').then((data) => { setUsers(data.users); setPermissionCatalog(data.permissionCatalog || []); }), []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const body = { ...form, specialties: form.specialtiesText.split(',').map((item) => item.trim()).filter(Boolean), products: form.productsText.split(',').map((item) => item.trim()).filter(Boolean) };
      if (editingId) await patch(`/api/admin/users/${editingId}`, body);
      else await post('/api/admin/users', body);
      setForm(emptyForm); setShowForm(false); setEditingId(''); await load();
    } catch (e) { setError((e as Error).message); }
  };
  const startCreate = () => { setEditingId(''); setForm(emptyForm); setShowForm(true); };
  const startEdit = (user: User) => {
    setEditingId(user.id);
    setForm({ firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, password: '', specialtiesText: (user.specialties || []).join(', '), productsText: (user.products || []).join(', '), expertStatus: user.expertStatus || 'AVAILABLE', permissionOverrides: user.permissionOverrides || {} });
    setShowForm(true);
  };
  const toggle = async (user: User) => { try { await patch(`/api/admin/users/${user.id}`, { isActive: !user.isActive }); await load(); } catch (e) { setError((e as Error).message); } };
  const deleteUser = async (user: User) => {
    const confirmed = window.confirm(`Удалить учётную запись ${user.email} без возможности восстановления?\n\nПользователь сразу потеряет доступ. История диалогов и действий останется в системе.`);
    if (!confirmed) return;
    setDeletingId(user.id); setError(''); setNotice('');
    try {
      await remove(`/api/admin/users/${user.id}`);
      if (editingId === user.id) closeForm();
      await load();
      setNotice(`Учётная запись ${user.email} удалена.`);
    } catch (e) { setError((e as Error).message); }
    finally { setDeletingId(''); }
  };
  const closeForm = () => { setShowForm(false); setEditingId(''); setForm(emptyForm); };
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => `${user.firstName} ${user.lastName} ${user.email} ${roleLabels[user.role]}`.toLowerCase().includes(query));
  }, [users, search]);
  return <section className="content-page">
    {error && <ErrorNotice error={error} onClose={() => setError('')} />}
    {notice && <Notice message={notice} onClose={() => setNotice('')} />}
    <header className="page-heading"><div><h1>Пользователи</h1><p>Учётные записи создаёт только администратор.</p></div><button className="button primary" onClick={showForm ? closeForm : startCreate}>{showForm ? <X size={17} /> : <UserPlus size={17} />}{showForm ? 'Закрыть' : 'Добавить пользователя'}</button></header>
    {showForm && <form className="user-create-form" onSubmit={submit}>
      <label>Имя<input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required /></label>
      <label>Фамилия<input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required /></label>
      <label>Почта<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
      <label>Роль<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}><option value="REQUESTER">Сотрудник</option><option value="EXPERT">Эксперт</option><option value="SPECIALIST">Профильные эксперты</option><option value="MANAGER">Руководители</option><option value="ADMIN">Администратор</option></select></label>
      <label>{editingId ? 'Новый пароль (необязательно)' : 'Временный пароль'}<input type="password" minLength={form.password ? 8 : undefined} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editingId} /></label>
      {form.role !== 'REQUESTER' && <><label>Рабочий статус<select value={form.expertStatus} onChange={(e) => setForm({ ...form, expertStatus: e.target.value })}><option value="AVAILABLE">Доступен</option><option value="BUSY">В работе</option><option value="DND">Не беспокоить</option></select></label><label>Специализации<input value={form.specialtiesText} onChange={(e) => setForm({ ...form, specialtiesText: e.target.value })} placeholder="гинекология, гастроэнтерология, стратегия" /></label><label>Темы<input value={form.productsText} onChange={(e) => setForm({ ...form, productsText: e.target.value })} placeholder="Продукт B, ..." /></label></>}
      <fieldset className="permission-editor"><legend>Точечные права</legend><p>«По роли» сохраняет стандартный доступ. Разрешение или запрет переопределяют его для этой учётной записи.</p>{permissionCatalog.map((permission) => <label key={permission.id}><span>{permission.label}</span><select value={permission.id in form.permissionOverrides ? String(form.permissionOverrides[permission.id]) : 'default'} onChange={(event) => { const next = { ...form.permissionOverrides }; if (event.target.value === 'default') delete next[permission.id]; else next[permission.id] = event.target.value === 'true'; setForm({ ...form, permissionOverrides: next }); }}><option value="default">По роли</option><option value="true">Разрешить</option><option value="false">Запретить</option></select></label>)}</fieldset>
      <button className="button primary">{editingId ? 'Сохранить изменения' : 'Создать учётную запись'}</button>
    </form>}
    <div className="directory-toolbar"><label className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по имени, почте или роли" /></label><span>Найдено: {filteredUsers.length} из {users.length}</span>{search && <button className="button secondary compact" onClick={() => setSearch('')}><X size={14} /> Сбросить</button>}</div>
    <div className="table-wrap user-table-wrap"><table className="queue-table"><thead><tr><th>Сотрудник</th><th>Почта</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th /></tr></thead><tbody>{filteredUsers.map((user) => <tr key={user.id}><td><div className="user-cell"><span>{user.firstName[0]}{user.lastName[0]}</span><strong>{user.firstName} {user.lastName}</strong></div></td><td>{user.email}</td><td>{roleLabels[user.role]}</td><td><button className={cx('account-state', user.isActive && 'active')} onClick={() => toggle(user)}>{user.isActive ? 'Активен' : 'Отключён'}</button></td><td>{formatDate(user.lastLoginAt)}</td><td><div className="row-buttons"><button className="icon-button" onClick={() => startEdit(user)} aria-label="Изменить пользователя"><Pencil size={16} /></button>{user.id !== currentUser.id && <button className="icon-button danger-icon" disabled={deletingId === user.id} onClick={() => deleteUser(user)} aria-label={`Удалить пользователя ${user.firstName} ${user.lastName}`}>{deletingId === user.id ? <Spinner size={17} /> : <Trash2 size={17} />}</button>}</div></td></tr>)}{filteredUsers.length === 0 && <tr><td colSpan={6}><div className="table-empty"><Search size={23} /><strong>Пользователи не найдены</strong><span>Проверьте имя, почту или роль в строке поиска.</span></div></td></tr>}</tbody></table></div>
    <div className="mobile-admin-list mobile-user-list">{filteredUsers.map((user) => <article className="mobile-admin-card" key={user.id}><div className="mobile-admin-card-head"><div className="user-cell"><span>{user.firstName[0]}{user.lastName[0]}</span><div><strong>{user.firstName} {user.lastName}</strong><small>{user.email}</small></div></div><span className="mobile-role-label">{roleLabels[user.role]}</span></div><dl><div><dt>Статус</dt><dd><button className={cx('account-state', user.isActive && 'active')} onClick={() => toggle(user)}>{user.isActive ? 'Активен' : 'Отключён'}</button></dd></div><div><dt>Последний вход</dt><dd>{formatDate(user.lastLoginAt)}</dd></div></dl><div className="mobile-admin-actions"><button className="button secondary" onClick={() => startEdit(user)}><Pencil size={16} /> Изменить</button>{user.id !== currentUser.id && <button className="button danger" disabled={deletingId === user.id} onClick={() => deleteUser(user)}>{deletingId === user.id ? <Spinner size={17} /> : <Trash2 size={17} />} Удалить</button>}</div></article>)}{filteredUsers.length === 0 && <div className="mobile-admin-empty"><Search size={23} /><strong>Пользователи не найдены</strong><span>Измените строку поиска.</span></div>}</div>
  </section>;
}

function AllChatsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [dateMode, setDateMode] = useState<'all' | 'exact' | 'range'>('all');
  const [exactDate, setExactDate] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (ownerSearch.trim()) params.set('owner', ownerSearch.trim());
    if (dateMode === 'exact' && exactDate) { params.set('dateFrom', exactDate); params.set('dateTo', exactDate); }
    if (dateMode === 'range' && dateFrom) params.set('dateFrom', dateFrom);
    if (dateMode === 'range' && dateTo) params.set('dateTo', dateTo);
    const data = await api<{ conversations: Conversation[] }>(`/api/conversations?${params}`);
    setConversations(data.conversations);
  }, [ownerSearch, dateMode, exactDate, dateFrom, dateTo]);
  useEffect(() => {
    const timer = setTimeout(() => load().catch((e) => setError(e.message)).finally(() => setLoading(false)), 250);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (selected && !conversations.some((conversation) => conversation.id === selected.id)) { setSelected(null); setMessages([]); }
  }, [conversations, selected]);
  const open = async (conversation: Conversation) => {
    setSelected(conversation);
    const data = await api<{ messages: Message[] }>(`/api/conversations/${conversation.id}/messages`);
    setMessages(data.messages);
  };
  const resetFilters = () => { setOwnerSearch(''); setDateMode('all'); setExactDate(''); setDateFrom(''); setDateTo(''); };
  const hasFilters = Boolean(ownerSearch || dateMode !== 'all');
  return <section className="content-page">{error && <ErrorNotice error={error} onClose={() => setError('')} />}<header className="page-heading"><div><h1>Все диалоги</h1><p>Полная история, включая чаты, скрытые предметными представителями.</p></div><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button></header>
    <div className="directory-toolbar chat-directory-toolbar"><label className="search-field"><Search size={16} /><input value={ownerSearch} onChange={(e) => setOwnerSearch(e.target.value)} placeholder="ФИО или почта пользователя" /></label><select value={dateMode} onChange={(e) => setDateMode(e.target.value as typeof dateMode)} aria-label="Способ выбора даты"><option value="all">Любая дата</option><option value="exact">Конкретная дата</option><option value="range">Период</option></select>{dateMode === 'exact' && <label className="date-filter">Дата обновления<input type="date" value={exactDate} onChange={(e) => setExactDate(e.target.value)} /></label>}{dateMode === 'range' && <><label className="date-filter">С<input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></label><label className="date-filter">По<input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></label></>}<span>{loading ? 'Поиск…' : `Найдено: ${conversations.length}`}</span>{hasFilters && <button className="button secondary compact" onClick={resetFilters}><X size={14} /> Сбросить</button>}</div>
    <div className="chat-audit-layout"><div className="table-wrap chat-audit-table-wrap"><table className="queue-table"><thead><tr><th>Обновлён</th><th>Название</th><th>Владелец</th><th>Состояние</th><th>Удалён сотрудником</th><th /></tr></thead><tbody>{conversations.map((conversation) => <tr key={conversation.id} className={selected?.id === conversation.id ? 'selected-row' : ''} onClick={() => open(conversation)}><td>{formatDate(conversation.updatedAt)}</td><td><strong>{conversation.title}</strong></td><td><div className="owner-cell"><strong>{conversation.owner?.name}</strong><span>{conversation.owner?.email}</span></div></td><td>{conversation.activeTask ? <StatusBadge status={conversation.activeTask.status} /> : 'Нет активного вопроса'}</td><td>{conversation.deletedByOwnerAt ? `Да, ${formatDate(conversation.deletedByOwnerAt)}` : 'Нет'}</td><td><button className="icon-button row-open" onClick={(event) => { event.stopPropagation(); open(conversation); }} aria-label={`Открыть диалог ${conversation.title}`}><ChevronRight size={17} /></button></td></tr>)}{!loading && conversations.length === 0 && <tr><td colSpan={6}><div className="table-empty"><MessageSquare size={23} /><strong>Диалоги не найдены</strong><span>Измените пользователя или диапазон дат.</span></div></td></tr>}</tbody></table></div><div className="mobile-admin-list mobile-chat-list">{conversations.map((conversation) => <button key={conversation.id} className={cx('mobile-admin-card', selected?.id === conversation.id && 'selected')} onClick={() => open(conversation)}><span className="mobile-admin-card-head"><span><strong>{conversation.title}</strong><small>{conversation.owner?.name} · {conversation.owner?.email}</small></span><ChevronRight size={19} /></span><span className="mobile-chat-card-meta"><time>{formatDate(conversation.updatedAt)}</time>{conversation.activeTask ? <StatusBadge status={conversation.activeTask.status} /> : <small>Нет активного вопроса</small>}</span>{conversation.deletedByOwnerAt && <span className="mobile-deleted-label">Скрыт сотрудником · {formatDate(conversation.deletedByOwnerAt)}</span>}</button>)}{!loading && conversations.length === 0 && <div className="mobile-admin-empty"><MessageSquare size={23} /><strong>Диалоги не найдены</strong><span>Измените фильтры.</span></div>}</div><aside className="chat-audit-detail">{!selected ? <div className="detail-empty"><MessageSquare size={28} /><h2>Выберите диалог</h2><p>Эксперт и администратор могут прочитать полный официальный диалог.</p></div> : <><div className="editor-head"><div><span>{selected.owner?.name}</span><h2>{selected.title}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Закрыть диалог"><X size={20} /></button></div><div className="audit-messages">{messages.map((message) => <div key={message.id} className={message.authorType === 'USER' ? 'from-user' : 'from-bot'}><strong>{message.authorType === 'USER' ? 'Сотрудник' : 'Официальный ответ'}</strong>{message.authorType === 'ASSISTANT' ? <div className="message-markdown audit-markdown"><MarkdownMessage content={message.content} /></div> : <p>{message.content}</p>}<time>{formatDate(message.createdAt)}</time></div>)}</div></>}</aside></div></section>;
}

type AuditEvent = { id: string; actorId: string; actorName: string; actorEmail?: string | null; actorRole?: Role | null; action: string; entityType: string; entityId: string; details?: Record<string, unknown>; createdAt: string };

function AuditLogPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [actors, setActors] = useState<Array<{ id: string; name: string; email: string; role: Role }>>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (search.trim()) params.set('q', search.trim());
    if (actorId) params.set('actorId', actorId);
    if (action) params.set('action', action);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const data = await api<{ events: AuditEvent[]; actors: typeof actors; actions: string[]; pagination: typeof pagination }>(`/api/admin/audit?${params}`);
    setEvents(data.events); setActors(data.actors); setActions(data.actions); setPagination(data.pagination);
  }, [search, actorId, action, dateFrom, dateTo, page]);
  useEffect(() => { const timer = setTimeout(() => load().catch((e) => setError(e.message)).finally(() => setLoading(false)), 250); return () => clearTimeout(timer); }, [load]);
  const reset = () => { setSearch(''); setActorId(''); setAction(''); setDateFrom(''); setDateTo(''); setPage(1); };
  const hasFilters = Boolean(search || actorId || action || dateFrom || dateTo);
  return <section className="audit-log-window">{error && <ErrorNotice error={error} onClose={() => setError('')} />}<div className="audit-log-heading"><div><h2>Журнал действий</h2><p>Полная история действий пользователей и системных процессов.</p></div><button className="button secondary" onClick={() => load()}><RefreshCw size={16} /> Обновить</button></div>
    <div className="audit-filter-bar"><label className="search-field"><Search size={16} /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Пользователь, объект или ID" /></label><select value={actorId} onChange={(e) => { setActorId(e.target.value); setPage(1); }} aria-label="Пользователь"><option value="">Все пользователи</option><option value="system">Система</option>{actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name} · {actor.email}</option>)}</select><select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Действие"><option value="">Все действия</option>{actions.map((item) => <option key={item} value={item}>{auditActionLabels[item] || item}</option>)}</select><label className="date-filter">С<input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} /></label><label className="date-filter">По<input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} /></label>{hasFilters && <button className="button secondary compact" onClick={reset}><X size={14} /> Сбросить</button>}</div>
    <div className="queue-summary"><strong>{pagination.total}</strong> событий <span>•</span> по 50 на странице</div>
    <div className="table-wrap audit-table-wrap"><table className="queue-table audit-table"><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Подробности</th></tr></thead><tbody>{events.map((event) => { const details = event.details && Object.keys(event.details).length ? JSON.stringify(event.details, null, 2) : ''; return <tr key={event.id}><td><time>{formatDate(event.createdAt)}</time></td><td><div className="audit-actor"><strong>{event.actorName}</strong><span>{event.actorEmail || (event.actorId === 'system' ? 'Системный процесс' : event.actorId)}</span>{event.actorRole && <small>{roleLabels[event.actorRole]}</small>}</div></td><td><strong>{auditActionLabels[event.action] || event.action}</strong><span className="technical-label">{event.action}</span></td><td><span>{entityLabels[event.entityType] || event.entityType}</span><code>{event.entityId}</code></td><td>{details ? <details><summary>Показать данные</summary><pre>{details}</pre></details> : <span className="muted">—</span>}</td></tr>; })}{!loading && events.length === 0 && <tr><td colSpan={5}><div className="table-empty"><Activity size={23} /><strong>Событий не найдено</strong><span>Измените фильтры журнала.</span></div></td></tr>}</tbody></table></div>
    <div className="mobile-admin-list mobile-audit-list">{events.map((event) => { const details = event.details && Object.keys(event.details).length ? JSON.stringify(event.details, null, 2) : ''; return <article className="mobile-admin-card" key={event.id}><div className="mobile-admin-card-head"><div><strong>{auditActionLabels[event.action] || event.action}</strong><small>{event.actorName} · {event.actorEmail || (event.actorId === 'system' ? 'Система' : event.actorId)}</small></div><time>{formatDate(event.createdAt)}</time></div><dl><div><dt>Объект</dt><dd>{entityLabels[event.entityType] || event.entityType}</dd></div><div><dt>ID</dt><dd><code>{event.entityId}</code></dd></div></dl>{details && <details><summary>Показать данные</summary><pre>{details}</pre></details>}</article>; })}{!loading && events.length === 0 && <div className="mobile-admin-empty"><Activity size={23} /><strong>Событий не найдено</strong><span>Измените фильтры журнала.</span></div>}</div>
    {pagination.pages > 1 && <nav className="pagination" aria-label="Страницы журнала"><button className="button secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><span>Страница {pagination.page} из {pagination.pages}</span><button className="button secondary" disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>Далее</button></nav>}
  </section>;
}

function SystemPage() {
  const [view, setView] = useState<'system' | 'push' | 'logs'>('system');
  const [dashboard, setDashboard] = useState<any>(null);
  const [key, setKey] = useState<any>(null);
  const [sources, setSources] = useState<Array<{ domain: string; category: string; enabled: boolean }>>([]);
  const [sourceForm, setSourceForm] = useState({ domain: '', category: 'Справочный источник' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diagnosticBusy, setDiagnosticBusy] = useState('');
  const load = useCallback(async () => { const [dashboardData, keyData, sourceData] = await Promise.all([api<any>('/api/admin/dashboard'), api<any>('/api/admin/api-key'), api<{ sources: typeof sources }>('/api/admin/sources')]); setDashboard(dashboardData); setKey(keyData); setSources(sourceData.sources); }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const addSource = async (event: React.FormEvent) => { event.preventDefault(); try { await post('/api/admin/sources', { ...sourceForm, enabled: true }); setSourceForm({ domain: '', category: 'Справочный источник' }); await load(); } catch (e) { setError((e as Error).message); } };
  const toggleSource = async (source: (typeof sources)[number]) => { try { await patch(`/api/admin/sources/${encodeURIComponent(source.domain)}`, { ...source, enabled: !source.enabled }); await load(); } catch (e) { setError((e as Error).message); } };
  const deleteSource = async (domain: string) => { if (!window.confirm(`Удалить ${domain} из доверенных источников?`)) return; try { await remove(`/api/admin/sources/${encodeURIComponent(domain)}`); await load(); } catch (e) { setError((e as Error).message); } };
  const runDiagnostic = async (kind: 'model' | 'email' | 'cache' | 'index') => { setDiagnosticBusy(kind); setError(''); try {
    if (kind === 'model') { const result = await post<{ latencyMs: number; model: string }>('/api/admin/diagnostics/model'); setNotice(`${result.model || 'Модель ИИ'} ответила за ${result.latencyMs} мс.`); }
    if (kind === 'email') { const result = await post<{ channel: string }>('/api/admin/diagnostics/email'); setNotice(result.channel === 'smtp' ? 'Тестовое письмо отправлено через SMTP.' : 'Тестовое письмо сохранено в локальный outbox.'); }
    if (kind === 'cache') { await post('/api/admin/diagnostics/cache'); setNotice('Кэш RAG очищен, настройки и экспертные знания перечитаны.'); }
    if (kind === 'index') { await post('/api/documents/reindex'); setNotice('Переиндексация документов запущена.'); }
    await load();
  } catch (e) { setError((e as Error).message); } finally { setDiagnosticBusy(''); } };
  const copyReport = async () => { const report = { generatedAt: new Date().toISOString(), components: dashboard.components, rag: dashboard.rag, stats: dashboard.stats }; await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setNotice('Диагностический отчёт скопирован.'); };
  const health = dashboard?.rag;
  return <section className="content-page">{error && <ErrorNotice error={error} onClose={() => setError('')} />}{notice && <Notice message={notice} onClose={() => setNotice('')} />}<header className="page-heading"><div><h1>Система и API</h1><p>Фактическое состояние компонентов, push-устройств, ключа модели и журнала действий.</p></div>{view === 'system' && <button className="button secondary" onClick={load}><RefreshCw size={16} /> Проверить</button>}</header><div className="segmented system-segmented"><button className={view === 'system' ? 'active' : ''} onClick={() => setView('system')}><Server size={15} /> Компоненты и API</button><button className={view === 'push' ? 'active' : ''} onClick={() => setView('push')}><Bell size={15} /> Push-устройства</button><button className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}><ListChecks size={15} /> Журнал действий</button></div>{view === 'logs' ? <AuditLogPanel /> : view === 'push' ? <PushDevicesPanel /> : !health ? <div className="page-loader"><Spinner /> Проверяем компоненты</div> : <>
    <div className="component-matrix">{dashboard.components.map((component: any) => <div key={component.name}><span className={cx('component-state', component.status)}><i />{component.status === 'ok' ? 'Работает' : component.status === 'warning' ? 'Ограниченно' : 'Недоступен'}</span><strong>{component.name}</strong><p>{component.detail}</p></div>)}</div>
    <section className="diagnostic-actions"><div><h2>Диагностика</h2><p>Действия выполняются на сервере и записываются в журнал событий.</p></div><div><button className="button secondary" disabled={Boolean(diagnosticBusy)} onClick={() => runDiagnostic('model')}>{diagnosticBusy === 'model' ? <Spinner /> : <Bot size={16} />} Тест модели ИИ</button><button className="button secondary" disabled={Boolean(diagnosticBusy)} onClick={() => runDiagnostic('email')}>{diagnosticBusy === 'email' ? <Spinner /> : <Send size={16} />} Тест почты</button><button className="button secondary" disabled={Boolean(diagnosticBusy)} onClick={() => runDiagnostic('index')}>{diagnosticBusy === 'index' ? <Spinner /> : <RefreshCw size={16} />} Переиндексировать</button><button className="button secondary" disabled={Boolean(diagnosticBusy)} onClick={() => runDiagnostic('cache')}>{diagnosticBusy === 'cache' ? <Spinner /> : <RotateCcw size={16} />} Сбросить кэш</button><button className="button secondary" onClick={copyReport}><Copy size={16} /> Копировать отчёт</button></div></section>
    <div className="system-status"><div className="system-primary"><div className={cx('service-orb', health.status === 'ok' && 'ok')}><HeartPulse size={26} /></div><div><span>Поисковое ядро</span><h2>{health.status === 'ok' ? 'Работает штатно' : 'Недоступно'}</h2><p>Модель: {health.model || '—'} · индекс: {health.indexAvailable ? 'подключён' : 'не найден'}</p></div></div><dl><div><dt>Документы</dt><dd>{health.documents ?? '—'}</dd></div><div><dt>Фрагменты</dt><dd>{health.chunks ?? '—'}</dd></div><div><dt>Экспертные знания</dt><dd>{health.expertKnowledge ?? '—'}</dd></div><div><dt>Домены в каталоге</dt><dd>{sources.filter((source) => source.enabled).length}</dd></div></dl></div>
    <div className="api-key-section"><div><KeyRound size={21} /><div><h2>Подключение модели</h2><p>Адаптер модели и ключ задаются администратором сервера через MODEL_PROVIDER, MODEL_ADAPTER_URL и MODEL_API_KEY. Демонстрационный режим не использует внешнюю модель.</p></div></div><div className="key-current"><span>Настройка ключа</span><strong>{key?.configured ? "Задан на сервере" : "Не настроен"}</strong></div></div>
    <section className="domain-section"><div className="section-heading"><h2>Каталог интернет-источников</h2><span>{sources.length}</span></div><form className="source-create" onSubmit={addSource}><input value={sourceForm.domain} onChange={(e) => setSourceForm({ ...sourceForm, domain: e.target.value })} placeholder="Домен, например docs.example.org" required /><input value={sourceForm.category} onChange={(e) => setSourceForm({ ...sourceForm, category: e.target.value })} placeholder="Категория доверия" required /><button className="button primary"><Plus size={16} /> Добавить</button></form><div className="source-policy-list">{sources.map((source) => <div key={source.domain}><button className={cx('source-toggle', source.enabled && 'active')} onClick={() => toggleSource(source)} aria-label={`${source.enabled ? 'Отключить' : 'Включить'} ${source.domain}`}><span /></button><div><strong>{source.domain}</strong><span>{source.category}</span></div><button className="icon-button danger-icon" onClick={() => deleteSource(source.domain)} aria-label={`Удалить ${source.domain}`}><Trash2 size={16} /></button></div>)}</div></section>
  </>}</section>;
}

function WorkspaceRouter({ user, section, setSection }: { user: User; section: string; setSection: (section: string) => void }) {
  if (section === 'my-chats' || section === 'faq' || (section === 'chats' && user.role === 'REQUESTER')) return <RepWorkspace user={user} showFaq={section === 'faq'} />;
  if (section === 'sales-control') return <SalesControlPage setSection={setSection} />;
  if (section === 'queue') return <ReviewWorkspace user={user} embedded />;
  if (section === 'team') return <DirectoryPage />;
  if (section === 'users') return <UsersPage currentUser={user} />;
  if (section === 'all-chats') return <AllChatsPage />;
  if (section === 'knowledge') return <KnowledgePage user={user} />;
  if (section === 'analytics') return <AnalyticsPage />;
  if (section === 'audit') return <section className="content-page"><AuditLogPanel /></section>;
  if (section === 'system') return <SystemPage />;
  if (section === 'overview') return <AdminOverview />;
  return <section className="content-page"><div className="empty-state"><ShieldCheck size={30} /><h2>Нет доступных разделов</h2><p>Обратитесь к администратору платформы для выдачи прав.</p></div></section>;
}

const initialSectionFor = (user: User) => {
  const permissions = new Set(user.permissions || []);
  const requested = new URLSearchParams(window.location.search).get('section');
  if (requested === 'sales-control' && ['MANAGER', 'ADMIN'].includes(user.role) && permissions.has('analytics.view')) return 'sales-control';
  if (requested === 'queue' && permissions.has('reviews.view')) return 'queue';
  if ((requested === 'chats' || requested === 'my-chats') && permissions.has('chats.use')) return user.role === 'REQUESTER' ? 'chats' : 'my-chats';
  if (user.role === 'REQUESTER' && permissions.has('chats.use')) return 'chats';
  if (user.role === 'MANAGER' && permissions.has('analytics.view')) return 'sales-control';
  if (permissions.has('reviews.view')) return 'queue';
  if (permissions.has('chats.use')) return 'my-chats';
  if (permissions.has('analytics.view')) return 'overview';
  if (permissions.has('knowledge.manage')) return 'knowledge';
  if (permissions.has('users.manage')) return 'users';
  if (permissions.has('audit.view')) return 'audit';
  if (permissions.has('system.manage')) return 'system';
  return 'none';
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(session.token));
  const [section, setSection] = useState('');
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [installAvailable, setInstallAvailable] = useState(false);
  const [appInstalled, setAppInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));

  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as BeforeInstallPromptEvent;
      setInstallAvailable(true);
    };
    const confirmInstallation = () => {
      installPromptRef.current = null;
      setInstallAvailable(false);
      setAppInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('appinstalled', confirmInstallation);
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('appinstalled', confirmInstallation);
    };
  }, []);

  useEffect(() => {
    if (!session.token) return;
    api<{ user: User }>('/api/auth/me').then((result) => { setUser(result.user); setSection(initialSectionFor(result.user)); }).catch(() => { session.token = ''; }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user || !section) return;
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get('task');
    const conversationId = params.get('conversation');
    if (!taskId && !conversationId) return;
    const timer = window.setTimeout(() => {
      if (taskId && section === 'queue') window.dispatchEvent(new CustomEvent('ragchat:open-review', { detail: { taskId } }));
      if (conversationId && (section === 'chats' || section === 'my-chats')) window.dispatchEvent(new CustomEvent('ragchat:open-conversation', { detail: { conversationId } }));
      window.history.replaceState({}, '', window.location.pathname);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [user, section]);

  const login = (token: string, nextUser: User) => { session.token = token; setUser(nextUser); setSection(initialSectionFor(nextUser)); };
  const logout = () => { session.token = ''; setUser(null); setSection(''); };
  const installApp = async () => {
    const prompt = installPromptRef.current;
    if (!prompt) return false;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    installPromptRef.current = null;
    setInstallAvailable(false);
    if (choice.outcome === 'accepted') setAppInstalled(true);
    return choice.outcome === 'accepted';
  };

  if (loading) return <div className="app-loading"><div className="brand"><span className="brand-mark">R</span><span>RagChat</span></div><Spinner size={24} /></div>;
  if (!user) return <LoginPage onLogin={login} />;

  return (
    <AppShell user={user} section={section} setSection={setSection} onLogout={logout} installAvailable={installAvailable} appInstalled={appInstalled} onInstall={installApp}>
      <WorkspaceRouter user={user} section={section} setSection={setSection} />
    </AppShell>
  );
}
