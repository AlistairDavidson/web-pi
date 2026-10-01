// session-sidebar.ts — <session-sidebar>: live sessions + past pi sessions.
// Emits: attach-live {name}, attach-resume {id}, new-session {name}.
import type { ConsoleState, LiveSession, PastSession } from '../lib/types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return d.toTimeString().slice(0, 5);
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toISOString().slice(0, 10);
}

export class SessionSidebar extends HTMLElement {
  private activeKey: string | null = null;

  render(st: ConsoleState, activeKey: string | null): void {
    this.activeKey = activeKey;
    this.innerHTML = `
      <section class="new-session">
        <input id="new-name" placeholder="new session name" maxlength="30">
        <button id="new-btn">new</button>
      </section>
      <nav class="nav">
        <h2>live <span class="count">${st.live.length ? `(${st.live.length})` : ''}</span></h2>
        <ul>${st.live.map(s => this.liveItem(s)).join('')}</ul>
        <h2>sessions <span class="count">${st.sessions.length ? `(${st.sessions.length})` : ''}</span></h2>
        <ul>${this.sessionList(st.sessions)}</ul>
      </nav>`;
    (this.querySelector('#new-btn') as HTMLElement).onclick = () => this.emitNew();
    const input = this.querySelector('#new-name') as HTMLInputElement;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') this.emitNew(); });
    this.querySelectorAll<HTMLElement>('[data-live]').forEach(el => {
      el.onclick = () => this.dispatchEvent(new CustomEvent('attach-live', {
        detail: el.dataset.live, bubbles: true, composed: true,
      }));
    });
    this.querySelectorAll<HTMLElement>('[data-resume]').forEach(el => {
      el.onclick = () => this.dispatchEvent(new CustomEvent('attach-resume', {
        detail: el.dataset.resume, bubbles: true, composed: true,
      }));
    });
  }

  private emitNew(): void {
    const input = this.querySelector('#new-name') as HTMLInputElement | null;
    const name = input?.value.trim() ?? '';
    if (!name) { input?.focus(); return; }
    if (input) input.value = '';
    this.dispatchEvent(new CustomEvent('new-session', { detail: name, bubbles: true, composed: true }));
  }

  private liveItem(s: LiveSession): string {
    const key = `live:${s.name}`;
    const cls = key === this.activeKey ? ' class="active"' : '';
    return `<li${cls} data-live="${esc(s.name)}" data-key="${esc(key)}" ` +
      `title="attach to live tmux session (${esc(s.socket)} socket)">` +
      `<span class="t">▸ ${esc(s.name)}</span>` +
      `<span class="d">${s.windows} win · ${esc(s.created)}${s.attached ? ' · attached' : ''}</span></li>`;
  }

  private sessionList(list: PastSession[]): string {
    let html = ''; let lastCwd: string | null = null;
    for (const s of list) {
      if (s.cwd !== lastCwd) {
        lastCwd = s.cwd;
        html += `<li class="group">${esc(s.cwd)}</li>`;
      }
      const key = `resume:${s.id}`;
      const cls = key === this.activeKey ? ' class="active"' : '';
      html += `<li${cls} data-resume="${esc(s.id)}" data-key="${esc(key)}" ` +
        `title="resume (pi --session — appends, history preserved)">` +
        `<span class="t">${esc(s.title)}</span>` +
        `<span class="d">${fmtWhen(s.mtime)}</span></li>`;
    }
    return html;
  }
}

customElements.define('session-sidebar', SessionSidebar);
