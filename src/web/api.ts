export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

const WS_KEY = 'panel.workspace';

function initialWorkspace() {
  // ?ws= из ссылки в оповещении важнее запомненного
  const fromUrl = Number(new URLSearchParams(window.location.search).get('ws'));
  if (fromUrl) return fromUrl;
  try {
    return Number(localStorage.getItem(WS_KEY)) || null;
  } catch {
    return null;
  }
}

/** Текущее пространство уходит заголовком в каждом запросе: сервер сверяет членство */
// Берётся при загрузке модуля, чтобы и первый /api/me ушёл с заголовком
let currentWorkspace = initialWorkspace();
export const setApiWorkspace = (id: number) => (currentWorkspace = id);
export const getApiWorkspace = () => currentWorkspace;

/** Запомнить пространство: уходит заголовком в запросах и переживает перезагрузку */
export function rememberWorkspace(id: number) {
  setApiWorkspace(id);
  try {
    localStorage.setItem(WS_KEY, String(id));
  } catch {
    /* приватный режим */
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (currentWorkspace) headers['x-workspace'] = String(currentWorkspace);
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/me') onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? `Ошибка ${res.status}`, data?.code, data?.fields);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};
