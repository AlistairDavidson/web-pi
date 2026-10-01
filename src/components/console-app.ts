// console-app.ts — <console-app>: orchestrates sidebar ↔ terminal, state
// polling, logout. Top-level island wired in index.astro.
import type { ConsoleState } from '../lib/types';
import { BASE } from '../base';
import './agent-terminal';
import './session-sidebar';

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeKey: string | null = null;

  connectedCallback(): void {
    this.innerHTML = `
      <aside class="sidebar">
        <header>
          <h1>web-pi</h1>
          <button id="logout" title="sign out">sign out</button>
        </header>
        <session-sidebar></session-sidebar>
      </aside>
      <main class="main">
        <agent-terminal></agent-terminal>
      </main>`;

    const term = this.querySelector('agent-terminal') as
      import('./agent-terminal').AgentTerminal & HTMLElement;
    const sidebar = this.querySelector('session-sidebar') as HTMLElement;

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
        alert((err as { error?: string }).error ?? 'could not create session');
        return;
      }
      const out = await r.json() as { name: string };
      this.activeKey = `live:${out.name}`;
      await this.loadState();
      term.attach('live', out.name, this.activeKey);
    });
    this.addEventListener('term-closed', () => this.loadState());
    (this.querySelector('#logout') as HTMLElement).onclick = async () => {
      await fetch(`${BASE}/logout`, { method: 'POST' });
      location.href = `${BASE}/login`;
    };

    this.loadState();
    this.pollTimer = setInterval(() => this.loadState(), 15000);
    requestAnimationFrame(() => term.refit());
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
    if (sidebar) (sidebar as import('./session-sidebar').SessionSidebar).render(st, this.activeKey);
  }
}

customElements.define('console-app', ConsoleApp);
