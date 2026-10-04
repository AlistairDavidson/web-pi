// console-app.ts — <console-app>: orchestrates sidebar ↔ terminal on a
// <wa-page> app shell (sidebar + free mobile drawer), state polling,
// logout, hide/unhide dialogs, toasts. Shell markup is SSR'd by
// ConsoleApp.astro; this module registers <console-app> client-side and
// drives it. Dialogs live here (outside the sidebar's innerHTML poll):
// the sidebar only emits hide-session / manage-hidden and stays stateless.
import type { ConsoleState, PastSession } from '../../lib/types';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '../AgentTerminal/agent-terminal';
import '../session-sidebar';

/** Minimal typing for <wa-toast>.create(). */
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** Minimal typing for <wa-dialog>. */
type WaDialog = HTMLElement & { show(): void; open: boolean };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeKey: string | null = null;
  /** Deep-link target (/?live=<session>) — attached on the first state
   *  load that sees the session alive (e.g. "view run" from /jobs). */
  private pendingLive: string | null = (() => {
    const v = new URLSearchParams(location.search).get('live') ?? '';
    return /^[a-zA-Z0-9_-]{1,40}$/.test(v) ? v : null;
  })();
  private state: ConsoleState | null = null;
  private pendingHide: { id: string; title: string } | null = null;

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
        this.toast(msg, { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
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

    // Sidebar hide/manage affordances → the dialogs owned here.
    this.addEventListener('hide-session', e => {
      this.pendingHide = (e as CustomEvent<{ id: string; title: string }>).detail;
      (this.querySelector('#confirm-hide-title') as HTMLElement).textContent =
        `“${this.pendingHide.title}”`;
      this.dialog('#confirm-hide').show();
    });
    this.addEventListener('manage-hidden', () => {
      this.renderHiddenList();
      this.dialog('#hidden-dialog').show();
    });
    (this.querySelector('#confirm-hide-ok') as HTMLElement).onclick = () => void this.confirmHide();
    (this.querySelector('#unhide-all') as HTMLElement).onclick = () => void this.unhideAll();
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

  private dialog(sel: string): WaDialog {
    return this.querySelector(sel) as WaDialog;
  }

  private toast(message: string, options?: Record<string, unknown>): void {
    (this.querySelector('wa-toast') as WaToast | null)?.create(message, options);
  }

  /** POST JSON; toasts on failure. False → caller keeps its UI as-is. */
  private async post(path: string, body: Record<string, unknown>): Promise<boolean> {
    let r: Response;
    try {
      r = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      this.toast('network error — try again', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
      return false;
    }
    if (r.status === 401) { location.href = `${BASE}/login`; return false; }
    if (!r.ok) {
      this.toast('could not save — try again', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
      return false;
    }
    return true;
  }

  private async confirmHide(): Promise<void> {
    const pending = this.pendingHide;
    if (!pending) return;
    const ok = await this.post('/api/session/hide', { id: pending.id });
    this.pendingHide = null;
    this.dialog('#confirm-hide').open = false;
    if (!ok) return;
    await this.loadState();
    this.toast('hidden from the list — undo via “hidden — manage”', { variant: 'neutral', icon: 'eye-slash', duration: 6000 });
  }

  private async unhide(id: string): Promise<void> {
    if (await this.post('/api/session/unhide', { id })) {
      await this.loadState();          // refreshes sidebar + this dialog
      this.renderHiddenList();
    }
  }

  private async unhideAll(): Promise<void> {
    if (await this.post('/api/session/unhide', { all: true })) {
      await this.loadState();
      this.renderHiddenList();
    }
  }

  /** Body of the manage-hidden dialog: hidden sessions from the last
   *  state poll (the dialog itself is static, so polls only swap this). */
  private renderHiddenList(): void {
    const body = this.querySelector('#hidden-list') as HTMLElement | null;
    if (!body) return;
    const hidden = (this.state?.sessions ?? []).filter(s => s.hidden);
    const older = (this.state?.hiddenCount ?? 0) - hidden.length;
    body.innerHTML = hidden.length
      ? hidden.map(s => this.hiddenRow(s)).join('')
        + (older > 0 ? `<p class="dialog-note">… and ${older} older hidden session${older === 1 ? '' : 's'} ` +
          `(beyond the newest cap) — “unhide all” restores those too.</p>` : '')
      : '<p class="dialog-note">No hidden sessions.</p>';
    body.querySelectorAll<HTMLElement>('[data-unhide]').forEach(btn => {
      btn.onclick = () => void this.unhide(btn.dataset.unhide!);
    });
    (this.querySelector('#unhide-all') as HTMLElement).toggleAttribute('disabled', hidden.length === 0);
  }

  private hiddenRow(s: PastSession): string {
    return `<div class="hidden-row">` +
      `<span class="hidden-meta">` +
      `<span class="t-name" title="${esc(s.id)}">${esc(s.title)}</span>` +
      `<span class="d">${esc(s.cwd)} · ` +
      `<wa-relative-time date="${new Date(s.mtime).toISOString()}" format="narrow" sync></wa-relative-time>` +
      `</span></span>` +
      `<wa-button data-unhide="${esc(s.id)}" size="s" appearance="accent" variant="neutral" ` +
      `title="show this session in the list again">` +
      `<wa-icon slot="start" name="eye"></wa-icon>unhide</wa-button></div>`;
  }

  async loadState(): Promise<void> {
    let r: Response;
    try { r = await fetch(`${BASE}/api/state`); } catch { return; }
    if (r.status === 401) { location.href = `${BASE}/login`; return; }
    if (!r.ok) return;
    const st = await r.json() as ConsoleState;
    this.state = st;
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

    const dlg = this.dialog('#hidden-dialog');
    if (dlg.open) this.renderHiddenList(); // keep an open manage dialog fresh
  }
}

customElements.define('console-app', ConsoleApp);
