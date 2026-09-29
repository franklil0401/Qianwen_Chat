let activeAccountId: string | null = null;

/** Capture the displayed account to prevent another tab's login from rerouting a write. */
export function setActiveAccount(id: string | null) { activeAccountId = id; }
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Qianwen-Client', 'web');
  headers.set('X-Qianwen-Account', activeAccountId ?? 'guest');
  return fetch(input, { ...init, headers });
}
