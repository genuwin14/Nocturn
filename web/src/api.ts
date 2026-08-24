// REST and WebSocket access to a nocturn-agent.

export interface Connection {
  /** Origin of the daemon, e.g. https://vm.tail1234.ts.net */
  origin: string;
  token: string;
}

export interface SessionInfo {
  id: string;
  created_at: number;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  exit_code: number | null;
  scrollback_bytes: number;
}

export interface Entry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  modified: number;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

const STORAGE_KEY = 'nocturn.connection';

/**
 * The client is normally served by the daemon itself (`--web`), in which case
 * the origin is simply wherever the page came from and only a token is needed.
 * A separately hosted client has to be told both.
 */
export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Connection;
    if (!parsed.token) return null;
    return { origin: parsed.origin || window.location.origin, token: parsed.token };
  } catch {
    // Private browsing and blocked site data both throw here rather than
    // returning null, so treat any failure as "not configured yet".
    return null;
  }
}

export function saveConnection(connection: Connection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  } catch {
    // Not fatal: the connection still works for this tab, it just will not be
    // remembered next launch.
  }
}

export function clearConnection(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(
  connection: Connection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${connection.origin}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${connection.token}`,
    },
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* the body was not JSON; the status text will do */
    }
    if (response.status === 401 || response.status === 403) {
      message = 'Token rejected. Check it against /etc/nocturn/agent.env.';
    }
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export async function checkHealth(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export const listSessions = (c: Connection) =>
  request<SessionInfo[]>(c, '/api/sessions');

export const deleteSession = (c: Connection, id: string) =>
  fetch(`${c.origin}/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${c.token}` },
  });

export const listFiles = (c: Connection, path: string) =>
  request<Listing>(c, `/api/fs/list?path=${encodeURIComponent(path)}`);

export const readFile = (c: Connection, path: string) =>
  request<FileContent>(c, `/api/fs/read?path=${encodeURIComponent(path)}`);

export const writeFile = (c: Connection, path: string, content: string) =>
  request<{ path: string; bytes: number }>(c, '/api/fs/write', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });

/**
 * Opens a terminal socket.
 *
 * The token travels as a WebSocket subprotocol rather than a query parameter:
 * the browser WebSocket API cannot set an Authorization header, and query
 * strings end up in proxy and server access logs. This is the same approach the
 * Kubernetes API server uses.
 */
export function openTerminal(
  connection: Connection,
  session: string,
  cols: number,
  rows: number,
): WebSocket {
  const url = new URL(connection.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/terminal';
  url.searchParams.set('session', session);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));

  const socket = new WebSocket(url.toString(), [
    'nocturn.v1',
    `bearer.${connection.token}`,
  ]);
  socket.binaryType = 'arraybuffer';
  return socket;
}
