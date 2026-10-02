// session-sidebar.ts — <session-sidebar>: live sessions + past pi sessions.
// Emits: attach-live {name}, attach-resume {id}, new-session {name}.
import type { ConsoleState, LiveSession, PastSession } from '../lib/types';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** <wa-input> surface used by this component (it's form-associated). */
interface WaInputLike extends HTMLElement {
  value: string;
}

export class SessionSidebar extends HTMLElement {
  private activeKey: string | null = null;

  render(st: ConsoleState, activeKey: string | null): void {
    this.activeKey = activeKey;
    // Preserve in-progress typing + focus across the 15s poll re-render.
    const prev = this.querySelector('#new-name') as WaInputLike | null;
    const typing = prev && document.activeElement === prev ? prev.value : null;
    this.innerHTML = `
      <section class="new-session wa-cluster wa-gap-2xs">
        <wa-input id="new-name" placeholder="new session name" maxlength="30" size="s"></wa-input>
        <wa-button id="new-btn" variant="brand" size="s">
          <wa-icon slot="start" name="plus"></wa-icon>new
        </wa-button>
      </section>
      <nav class="nav">
        <h2>live ${st.live.length ? `<wa-badge pill>${st.live.length}</wa-badge>` : ''}</h2>
        <ul>${st.live.map(s => this.liveItem(s)).join('')}</ul>
        <h2>sessions ${st.sessions.length ? `<wa-badge pill>${st.sessions.length}</wa-badge>` : ''}</h2>
        <ul>${this.sessionList(st.sessions)}</ul>
      </nav>`;
    const input = this.querySelector('#new-name') as WaInputLike | null;
    if (input && typing !== null) { input.value = typing; input.focus(); }
    (this.querySelector('#new-btn') as HTMLElement).onclick = () => this.emitNew();
    input?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') this.emitNew(); });
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
    const input = this.querySelector('#new-name') as WaInputLike | null;
    const name = input?.value.trim() ?? '';
    if (!name) { input?.focus(); return; }
    if (input) input.value = '';
    this.dispatchEvent(new CustomEvent('new-session', { detail: name, bubbles: true, composed: true }));
  }

  private liveItem(s: LiveSession): string {
    const key = `live:${s.name}`;
    const cls = key === this.activeKey ? ' class="active"' : '';
    return `<li${cls} data-live="${esc(s.name)}" data-key="${esc(key)}" data-drawer="close" ` +
      `title="attach to live tmux session (${esc(s.socket)} socket)">` +
      `<span class="t"><wa-icon name="play"></wa-icon><span class="t-name">${esc(s.name)}</span></span>` +
      `<span class="d">${s.windows} win · ${esc(s.created)}${s.attached ? ' · attached' : ''}</span></li>`;
  }

  private sessionList(list: PastSession[]): string {
    let html = ''; let lastCwd: string | null = null;
    for (const s of list) {
      if (s.cwd !== lastCwd) {
        lastCwd = s.cwd;
        html += `<li class="group"><wa-icon name="folder"></wa-icon>` +
          `<span class="t-name">${esc(s.cwd)}</span></li>`;
      }
      const key = `resume:${s.id}`;
      const cls = key === this.activeKey ? ' class="active"' : '';
      html += `<li${cls} data-resume="${esc(s.id)}" data-key="${esc(key)}" data-drawer="close" ` +
        `title="resume (pi --session — appends, history preserved)">` +
        `<span class="t"><span class="t-name">${esc(s.title)}</span></span>` +
        `<span class="d"><wa-relative-time date="${new Date(s.mtime).toISOString()}" format="narrow" sync></wa-relative-time></span></li>`;
    }
    return html;
  }
}

customElements.define('session-sidebar', SessionSidebar);
