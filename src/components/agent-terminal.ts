// agent-terminal.ts — <agent-terminal>: xterm.js over WS to node-pty/tmux.
// Light DOM (xterm injects its own styles; global CSS applies).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { ClientMsg, ServerMsg } from '../lib/types';
import { BASE } from '../base';

export class AgentTerminal extends HTMLElement {
  static get observedAttributes(): string[] { return ['status']; }
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private ws: WebSocket | null = null;
  private activeKey: string | null = null;
  private ro: ResizeObserver | null = null;

  connectedCallback(): void {
    if (this.term) return;
    this.innerHTML = '<div class="term-box"></div><div class="term-status"></div>';
    const box = this.querySelector('.term-box') as HTMLElement;
    // Keep the xterm canvas glued to the themed page surface (fall back to
    // the :root override value if the custom property isn't resolvable).
    const surface = getComputedStyle(this).getPropertyValue('--wa-color-surface-default').trim()
      || '#11131a';
    this.term = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'monospace',
      scrollback: 5000, theme: { background: surface },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(box);
    this.fit.fit();
    this.term.onData(d => this.send({ type: 'input', data: d }));
    this.term.onResize(() => this.sendSize());
    // Refit whenever the container's size changes for ANY reason — initial
    // layout settling after mount, status-bar reflow, window resizes — not
    // just window resizes. (RO also fires once on observe, covering the
    // initial fit once layout is real.)
    this.ro = new ResizeObserver(() => this.fit?.fit());
    this.ro.observe(box);
    this.fit.fit();
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    this.ro = null;
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  private sendSize(): void {
    if (this.term) this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
  }
  /** Update the status bar; `kind` picks the leading indicator. */
  private status(text: string, kind: 'busy' | 'ok' | 'err' | 'info' = 'busy'): void {
    const el = this.querySelector('.term-status');
    if (!el) return;
    const indicator =
      kind === 'busy' ? '<wa-spinner></wa-spinner>' :
      kind === 'ok' ? '<wa-icon name="circle-check"></wa-icon>' :
      kind === 'err' ? '<wa-icon name="triangle-exclamation"></wa-icon>' :
      '<wa-icon name="circle-info"></wa-icon>';
    el.className = `term-status ${kind}`;
    el.innerHTML = `${indicator}<span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
  }

  /** Attach to a live tmux session or resume a past pi session. */
  attach(mode: 'live' | 'resume', target: string, key: string): void {
    if (this.ws) { try { this.ws.close(); } catch { /* ok */ } }
    this.term?.reset();
    this.term?.focus();
    this.activeKey = key;
    this.status(`connecting: ${target} …`, 'busy');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${BASE}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      const msg: ClientMsg = mode === 'live'
        ? { type: 'attach', mode: 'live', target }
        : { type: 'attach', mode: 'resume', id: target };
      ws.send(JSON.stringify(msg));
      this.sendSize();
    };
    ws.onmessage = ev => {
      let m: ServerMsg; try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
      if (m.type === 'output') this.term?.write(m.data);
      else if (m.type === 'attached') this.status(`attached: ${m.target} (${m.socket} socket)`, 'ok');
      else if (m.type === 'error') { this.status(m.message, 'err'); this.term?.write(`\r\n\u001b[31m${m.message}\u001b[0m\r\n`); }
      else if (m.type === 'exit') this.status(`detached: ${m.target}`, 'info');
    };
    ws.onclose = () => {
      if (this.activeKey === key) this.dispatchEvent(new CustomEvent('term-closed', { detail: key }));
    };
  }

  refit(): void { this.fit?.fit(); }
}

customElements.define('agent-terminal', AgentTerminal);
