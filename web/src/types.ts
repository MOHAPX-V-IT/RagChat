export type Role = 'REQUESTER' | 'EXPERT' | 'SPECIALIST' | 'MANAGER' | 'ADMIN';

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string;
  permissions?: string[];
  expertStatus?: 'AVAILABLE' | 'BUSY' | 'DND';
  specialties?: string[];
  products?: string[];
  permissionOverrides?: Record<string, boolean>;
};

export type Message = {
  id: string;
  conversationId: string;
  authorType: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: string;
  rating?: 'UP' | 'DOWN' | null;
  ratingReason?: string | null;
  ratedAt?: string | null;
};

export type ReviewStatus = 'GENERATING' | 'WAITING_REVIEW' | 'IN_REVIEW' | 'DISCUSSION' | 'DELIVERED';

export type Source = {
  title?: string;
  source?: string;
  page?: number;
  version?: string;
  score?: number;
  text?: string;
  url?: string;
  trustCategory?: string;
};

export type ReviewTask = {
  id: string;
  conversationId: string;
  representativeId: string;
  questionMessageId: string;
  status: ReviewStatus;
  reviewPool?: 'GENERAL' | 'SPECIALIST';
  routingConfidence?: number | null;
  routingReason?: string | null;
  question: string;
  aiDraft: string;
  finalAnswer?: string | null;
  returnTo?: string | null;
  returnExpert?: User | null;
  revisions?: Array<{ id: string; authorId: string; authorName: string; content: string; baseVersion: number; createdAt: string }>;
  discussion?: {
    version: number; proposedBy: string; proposedName: string; proposedAt: string; deadlineAt: string;
    answer: string; edited: boolean; yes: number; no: number;
    autoReleaseWithoutVotes?: boolean; selectedRevisionId?: string; answerAuthorId?: string; answerAuthorName?: string;
    votes: Array<{ userId: string; name: string; value: 'YES' | 'NO'; at: string }>;
    delivery?: { mode: string; by: string; at: string; yes: number; no: number };
  } | null;
  assignedTo?: string | null;
  assignedAt?: string | null;
  reminderHistory?: Array<{ type: string; at: string; recipients: string[] }>;
  assignedExpert?: { id: string; name: string; role?: Role } | null;
  representative?: { id: string; name: string; email: string; role?: Role } | null;
  conversationTitle?: string;
  returnComment?: string;
  hasComment?: boolean;
  sources: Source[];
  webSources: Source[];
  confidence?: number | null;
  waitMinutes?: number;
  traceId?: string;
  priority?: 'NORMAL' | 'URGENT' | 'CRITICAL';
  slaMinutes?: number;
  productName?: string | null;
  specialty?: string | null;
  routedTo?: string | null;
  routedAt?: string | null;
  routingMode?: 'AUTO' | 'MANUAL' | null;
  estimatedWaitMinutes?: number;
  delayReason?: string | null;
  timing?: {
    generationMinutes?: number | null;
    queueMinutes?: number | null;
    reviewMinutes?: number | null;
    totalMinutes?: number | null;
    elapsedMinutes: number;
    slaMinutes: number;
    slaRemainingMinutes: number;
    slaState: 'OK' | 'RISK' | 'BREACHED';
  };
  stageHistory?: Array<{ id: string; stage: string; at: string; actorId: string; meta?: Record<string, unknown> }>;
  internalComments?: Array<{ id: string; authorId: string; authorName?: string; text: string; mentionIds: string[]; createdAt: string }>;
  transferHistory?: Array<{ from?: string | null; to: string; comment: string; transferredBy: string; transferredAt: string }>;
  responseVersions?: Array<{ id: string; type: 'AI_DRAFT' | 'AI_DEGRADED' | 'EXPERT_EDIT' | 'EXPERT_APPROVAL'; content: string; authorId: string; createdAt: string; metrics?: Record<string, unknown>; error?: string }>;
  ragMeta?: {
    expertKnowledgeMatches?: Array<{ id: string; question: string; answer: string; version: number; score: number }>;
    evidenceMap?: Array<{ id?: string; claim?: string; text?: string; sourceIds?: string[]; sources?: Array<{ sourceId?: string; kind?: string; score?: number }>; supported: boolean }>;
    contradictions?: Array<{ claim?: string; reason?: string; message?: string; severity?: string }> | { claim?: string; reason?: string; message?: string; severity?: string };
    metrics?: {
      totalDraftMs?: number;
      retrievalMs?: number;
      internetSearchMs?: number;
      llmMs?: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      estimatedCostRub?: number;
    };
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  ownerId: string;
  title: string;
  titleSource?: 'AUTO' | 'MANUAL';
  titleGeneratedAt?: string | null;
  deletedByOwnerAt?: string | null;
  createdAt: string;
  updatedAt: string;
  activeTask?: ReviewTask | null;
  latestTask?: ReviewTask | null;
  owner?: { id: string; name: string; email?: string; role?: Role; deletedAt?: string | null } | null;
  lastMessage?: Message;
};

export type KnowledgeEntry = {
  id: string;
  question: string;
  answer: string;
  version: number;
  isActive: boolean;
  indexStatus: 'PENDING' | 'READY' | 'FAILED';
  indexedAt?: string;
  updatedAt: string;
  author?: User | null;
  versions?: Array<{ version: number; question: string; answer: string; authorId?: string; createdAt: string }>;
};
