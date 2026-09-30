const TOKEN_KEY = 'ragchat-rag-token';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
  set token(value: string) { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); },
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.detail || 'Не удалось выполнить запрос.');
  return body as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const remove = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export async function upload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', body: form, cache: 'no-store',
    headers: session.token ? { Authorization: `Bearer ${session.token}` } : {},
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.detail || 'Не удалось загрузить файл.');
  return body as T;
}

export async function download(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { cache: 'no-store', headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Не удалось скачать файл.');
  }
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = href; link.download = filename; link.click();
  URL.revokeObjectURL(href);
}
