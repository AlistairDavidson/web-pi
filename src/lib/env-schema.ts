export type EnvFieldType = 'string' | 'number' | 'boolean';

export interface ServerEnvField {
  context: 'server';
  access: 'secret';
  type: EnvFieldType;

  optional?: true;
  default?: string | number | boolean;
}

type PrimitiveOf = { string: string; number: number; boolean: boolean };

export type EnvValue<F extends ServerEnvField> =
  PrimitiveOf[F['type']] | ('default' extends keyof F ? never : undefined);

export const envSchema = {
  // Static defaults, applied by the schema-driven reader in env.ts.
  WEB_PI_HOST: { type: 'string', context: 'server', access: 'secret', default: '127.0.0.1' },
  WEB_PI_PORT: { type: 'number', context: 'server', access: 'secret', default: 3000 },
  WEB_PI_BASE: { type: 'string', context: 'server', access: 'secret', default: '/' },
  WEB_PI_TMUX_SOCKET: { type: 'string', context: 'server', access: 'secret', default: 'web-pi' },
  // Reverse-proxy hops in front of the server whose X-Forwarded-For entries
  // are trusted (nginx = 1, ALB → nginx = 2). 0: XFF is ignored entirely.
  WEB_PI_TRUST_PROXY: { type: 'number', context: 'server', access: 'secret', default: 0 },
  // Dynamic defaults — see env.ts (homedir / app root / fs probe / cross-var).
  WEB_PI_HOME: { type: 'string', context: 'server', access: 'secret', optional: true },
  // One directory for all web-pi state (db, runtime pi agent dir) —
  // dynamic default in env.ts ($WEB_PI_HOME/.local/state/web-pi).
  WEB_PI_STATE_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_AGENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // sqlite state db (credential + hidden sessions) — dynamic default in env.ts.
  WEB_PI_DB_FILE: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_CLIENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_ASTRO_ENTRY: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_SESSIONS_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_NEW_SESSION_CWD: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_TMUX_CONF: { type: 'string', context: 'server', access: 'secret', optional: true },
} as const satisfies Record<string, ServerEnvField>;
