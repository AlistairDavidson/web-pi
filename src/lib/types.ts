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
  /** hidden from the sidebar list (hide ≠ delete: reversible, file kept) */
  hidden?: boolean;
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
  /** total ids in the hidden-sessions state file (may exceed the
   *  hidden ones inside `sessions`, which is capped like the list) */
  hiddenCount: number;
}

// ---- scheduled jobs (systemd user units — see src/lib/jobs.ts) ----

export interface ScheduledJob {
  /** job name (unit stem: webpi-<name>.service/.timer) */
  name: string;
  /** OnCalendar spec */
  schedule: string;
  /** shell command a run executes (inside tmux session webpi-<name>) */
  command: string;
  /** timer armed */
  active: boolean;
  /** the run's tmux session is alive (visible in Live) */
  running: boolean;
  /** tmux session name a run opens */
  session: string;
  /** next elapse, human-formatted by systemd; null when unknown */
  next: string | null;
  /** last trigger, human-formatted by systemd; null when never */
  last: string | null;
  /** outcome of the last triggered run */
  lastResult: 'success' | 'failed' | 'unknown';
}

export interface JobsState {
  /** false when systemctl --user is unusable (page degrades to a notice) */
  available: boolean;
  /** probe detail for the degraded notice */
  detail: string | null;
  jobs: ScheduledJob[];
}

export interface CalendarCheck {
  valid: boolean;
  /** human-formatted first elapse on success */
  next: string | null;
  error: string | null;
  /** 'systemd-analyze' when the real parser accepted it, 'basic' when only
   *  the built-in sanity check ran (systemd-analyze absent) */
  validatedBy: 'systemd-analyze' | 'basic';
}

// ---- settings dashboard (/settings ← /api/settings; /api/update-pi) ----
// Effective (resolved, defaults applied) config for the read-only dashboard.
// Paths only — never credential or hash contents.
export interface SettingsState {
  me: 'ok';
  appVersion: string;
  nodeVersion: string;
  host: string;
  port: number;
  base: string;
  command: string;
  newSessionCwd: string;
  agentDir: string;
  sessionsDir: string;
  stateDb: string;
  tmuxSocket: string;
  tmuxConf: string | null;
  appRoot: string;
  piPackage: string;
  piDeclared: string;
  piInstalled: string | null;
  npmAvailable: boolean;
}

/** Result of POST /api/update-pi (manual `npm install pi@latest`). */
export interface UpdateResult {
  ok: boolean;
  dryRun: boolean;
  /** what ran / would run, for display */
  command: string;
  /** installed pi version before (null: not installed) */
  before: string | null;
  /** installed pi version after */
  after: string | null;
  /** captured npm output (dry-run: check output), capped */
  output: string;
  /** failure reason when !ok */
  error?: string;
}

// ---- WS wire protocol (JSON envelopes) ----
// The server checks every client frame against these shapes
// (parseClientMsg, server/main.ts) and drops anything else. A big paste
// arrives as several consecutive input frames (agent-terminal.ts chunks it).
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
