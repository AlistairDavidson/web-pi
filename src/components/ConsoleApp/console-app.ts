// console-app.ts — <console-app>: orchestrates sidebar ↔ terminal on a
// <wa-page> app shell (sidebar + free mobile drawer), state polling,
// logout, toasts. Shell markup is SSR'd by ConsoleApp.astro; this module
// registers <console-app> client-side and drives it.
import type { ConsoleState } from '../../lib/types';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '../AgentTerminal/agent-terminal';
import '../session-sidebar';

/** Minimal typing for <wa-toast>.create(). */
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeKey: string | null = null;
  /** Deep-link target (/?live=<session>) — attached on the first state
   *  load that sees the session alive (e.g. "view run" from /jobs). */
  private pendingLive: string | null = (() => {
    const v = new URLSearchParams(location.search).get('live') ?? '';
    return /^[a-zA-Z0-9_-]{1,40}$/.test(v) ? v : null;
  })();

  connectedCallback(): void {
    const term = this.querySelector('agent-terminal') as
      import('../AgentTerminal/agent-terminal').AgentTerminal & HTMLElement;

    this.addEventListener('attach-live', e => {
      const name = (e as CustomEvent<string>).detail;
      this.activeKey = `live:${name}`;
      term.attach('live', name, this.activeKey);
      this.loadState();
    });
    this.addEventListener('attach-resume', e => {
      const id = (e as CustomEvent<string>).detail;
      this.activeKey = `resume:${id}`;
      term.attach('resume', id, this.activeKey);
    });
    this.addEventListener('new-session', async e => {
      const name = (e as CustomEvent<string>).detail;
      const r = await fetch(`${BASE}/api/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'could not create session' }));
        const msg = (err as { error?: string }).error ?? 'could not create session';
        (this.querySelector('wa-toast') as WaToast | null)?.create(msg, {
          variant: 'danger', icon: 'triangle-exclamation', duration: 6000,
        });
        return;
      }
      const out = await r.json() as { name: string };
      this.activeKey = `live:${out.name}`;
      await this.loadState();
      term.attach('live', out.name, this.activeKey);
    });
    this.addEventListener('terminal-closed', () => this.loadState());
    (this.querySelector('#nav-jobs') as HTMLElement).onclick = () => {
      location.href = `${BASE}/jobs`;
    };
    (this.querySelector('#logout') as HTMLElement).onclick = async () => {
      await fetch(`${BASE}/logout`, { method: 'POST' });
      location.href = `${BASE}/login`;
    };

    this.loadState();
    this.pollTimer = setInterval(() => this.loadState(), 15000);
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async loadState(): Promise<void> {
    let r: Response;
    try { r = await fetch(`${BASE}/api/state`); } catch { return; }
    if (r.status === 401) { location.href = `${BASE}/login`; return; }
    if (!r.ok) return;
    const st = await r.json() as ConsoleState;
    const sidebar = this.querySelector('session-sidebar');
    if (sidebar) (sidebar as import('../session-sidebar').SessionSidebar).render(st, this.activeKey);
    if (this.pendingLive) {
      const target = this.pendingLive;
      if (st.live.some(s => s.name === target)) {
        this.pendingLive = null;
        this.activeKey = `live:${target}`;
        const term = this.querySelector('agent-terminal') as
          (import('../AgentTerminal/agent-terminal').AgentTerminal & HTMLElement) | null;
        term?.attach('live', target, this.activeKey);
        (sidebar as import('../session-sidebar').SessionSidebar | null)
          ?.render(st, this.activeKey);
      }
    }
  }
}

customElements.define('console-app', ConsoleApp);
