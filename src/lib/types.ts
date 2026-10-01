// Shared types across server + client (the WS wire protocol is
// described exactly once, on both ends).

export interface PastSession {
  /** pi session id (uuid) — resume target */
  id: string;
  /** first-user-message preview */
  title: string;
  mtime: number;
  timestamp: string;
  cwd: string;
}

export interface LiveSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  /** tmux socket name owning the session */
  socket: string;
}

export interface ConsoleState {
  me: 'ok';
  configured: boolean;
  live: LiveSession[];
  sessions: PastSession[];
}

// ---- WS wire protocol (JSON envelopes) ----
export type ClientMsg =
  | { type: 'attach'; mode: 'live'; target: string }
  | { type: 'attach'; mode: 'resume'; id: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMsg =
  | { type: 'attached'; target: string; socket: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; target: string }
  | { type: 'error'; message: string };
