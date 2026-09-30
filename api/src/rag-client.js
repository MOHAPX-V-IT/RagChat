const baseUrl = process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8010';
const serviceToken = process.env.INTERNAL_SERVICE_TOKEN || 'local-service-token';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Token': serviceToken,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeout || 125_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.detail || body.error || `RAG HTTP ${response.status}`);
    error.ragStatus = response.status;
    throw error;
  }
  return body;
}

export const rag = {
  classify: (payload) => request('/v1/classify', { method: 'POST', body: JSON.stringify(payload), timeout: 45_000 }),
  draft: (payload) => request('/v1/drafts', { method: 'POST', body: JSON.stringify(payload) }),
  title: (payload) => request('/v1/titles', { method: 'POST', body: JSON.stringify(payload), timeout: 20_000 }),
  health: () => request('/health', { timeout: 5_000 }),
  addKnowledge: (payload) => request('/v1/expert-knowledge', { method: 'POST', body: JSON.stringify(payload), timeout: 30_000 }),
  updateKnowledge: (entryId, payload) => request(`/v1/expert-knowledge/${entryId}`, { method: 'PATCH', body: JSON.stringify(payload), timeout: 30_000 }),
  getKeyStatus: () => request('/admin/api-key', { timeout: 5_000 }),
  updateKey: (apiKey) => request('/admin/api-key', { method: 'PUT', body: JSON.stringify({ apiKey }), timeout: 10_000 }),
  selfTest: () => request('/admin/self-test', { method: 'POST', body: '{}', timeout: 125_000 }),
  clearCache: () => request('/admin/cache/clear', { method: 'POST', body: '{}', timeout: 10_000 }),
  documents: () => request('/v1/documents', { timeout: 10_000 }),
  deleteDocument: (filename) => request(`/v1/documents/${encodeURIComponent(filename)}`, { method: 'DELETE', timeout: 30_000 }),
  restoreDocumentVersion: (filename, version) => request(`/v1/documents/${encodeURIComponent(filename)}/versions/${encodeURIComponent(version)}/restore`, { method: 'POST', body: '{}', timeout: 15_000 }),
  reindex: () => request('/v1/reindex', { method: 'POST', body: '{}', timeout: 10_000 }),
  sources: () => request('/v1/sources', { timeout: 5_000 }),
  addSource: (payload) => request('/v1/sources', { method: 'POST', body: JSON.stringify(payload), timeout: 5_000 }),
  updateSource: (domain, payload) => request(`/v1/sources/${encodeURIComponent(domain)}`, { method: 'PATCH', body: JSON.stringify(payload), timeout: 5_000 }),
  deleteSource: (domain) => request(`/v1/sources/${encodeURIComponent(domain)}`, { method: 'DELETE', timeout: 5_000 }),
  uploadDocument: async (file) => {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    const response = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST', body: form,
      headers: { 'X-Service-Token': serviceToken },
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.detail || body.error || `RAG HTTP ${response.status}`);
      error.ragStatus = response.status;
      throw error;
    }
    return body;
  },
};
