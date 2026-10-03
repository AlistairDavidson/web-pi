// agent-terminal.ts — <agent-terminal>: xterm.js over websocket to node-pty/tmux.
// Light DOM (xterm injects its own styles; global CSS applies).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { ClientMsg, ServerMsg } from '../../lib/types';
import { BASE } from '../../base';

export class AgentTerminal extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['status'];
  }

  terminal?: Terminal;
  fitXtermAddon?: FitAddon;
  websocket?: WebSocket;
  activeKey?: string;
  resizeObserver?: ResizeObserver;
  connectedCallback(): void {
    if (this.terminal) {
      return;
    }

    const terminalContainer = this.querySelector('.terminal-container') as HTMLElement;

    const surfaceColor = getComputedStyle(this).getPropertyValue('--wa-color-surface-default').trim() || '#11131a';

    this.terminal = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'monospace',
      scrollback: 5000, theme: {
        background: surfaceColor
      },
    });

    this.fitXtermAddon = new FitAddon();
    this.terminal.loadAddon(this.fitXtermAddon);

    this.terminal.open(terminalContainer);

    // URLs in agent output become clickable (a custom handler — e.g.
    // copy-to-clipboard instead of navigate — can come later).
    this.terminal.loadAddon(new WebLinksAddon());

    this.fitXtermAddon.fit();

    this.terminal.onData(d =>
      this.send({ type: 'input', data: d })
    );

    this.terminal.onResize(
      () => this.sendSize()
    );

    this.resizeObserver = new ResizeObserver(
      () => this.fitXtermAddon?.fit()
    );
    this.resizeObserver.observe(terminalContainer);

    this.fitXtermAddon.fit();

    // WebGL renderer — the big win for pi's full-screen TUI redraws.
    // Lazy-imported so the chunk never blocks first paint. Disposing the
    // addon (on context loss; or never loading it if WebGL is missing)
    // leaves xterm on its built-in DOM renderer.
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (!this.terminal) return;
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          this.terminal.loadAddon(webgl);
        } catch { /* no WebGL: stay on the DOM renderer */ }
      })
      .catch(() => { /* chunk failed to load: stay on the DOM renderer */ });
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private send(msg: ClientMsg): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(msg));
    }
  }

  private sendSize(): void {
    if (this.terminal) {
      this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
    }
  }

  private status(text: string, kind: 'busy' | 'ok' | 'err' | 'info' = 'busy'): void {
    const el = this.querySelector('.terminal-status');
    if (!el) return;
    const indicator =
      kind === 'busy' ? '<wa-spinner></wa-spinner>' :
      kind === 'ok' ? '<wa-icon name="circle-check"></wa-icon>' :
      kind === 'err' ? '<wa-icon name="triangle-exclamation"></wa-icon>' :
      '<wa-icon name="circle-info"></wa-icon>';
    el.className = `terminal-status ${kind}`;
    el.innerHTML = `${indicator}<span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
  }

  attach(mode: 'live' | 'resume', target: string, key: string): void {
    if (this.websocket) {
      try {
        this.websocket.close();
      } catch { }
    }

    this.terminal?.reset();
    this.terminal?.focus();
    this.activeKey = key;
    this.status(`connecting: ${target} …`, 'busy');

    // Browser WebSocket only accepts ws:/wss: — and the server's upgrade
    // handler (server/main.ts) serves ${BASE}/ws.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocket = new WebSocket(`${proto}//${location.host}${BASE}/ws`);

    this.websocket = websocket;
    websocket.onopen = () => {
      const msg: ClientMsg = mode === 'live'
        ? { type: 'attach', mode: 'live', target }
        : { type: 'attach', mode: 'resume', id: target };
      websocket.send(JSON.stringify(msg));
      this.sendSize();
    };

    websocket.onmessage = ev => {
      let m: ServerMsg; try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
      if (m.type === 'output') this.terminal?.write(m.data);
      else if (m.type === 'attached') this.status(`attached: ${m.target} (${m.socket} socket)`, 'ok');
      else if (m.type === 'error') { this.status(m.message, 'err'); this.terminal?.write(`\r\n\u001b[31m${m.message}\u001b[0m\r\n`); }
      else if (m.type === 'exit') this.status(`detached: ${m.target}`, 'info');
    };

    websocket.onclose = () => {
      if (this.activeKey === key) this.dispatchEvent(new CustomEvent('terminal-closed', { detail: key }));
    };
  }

  refit(): void { this.fitXtermAddon?.fit(); }
}

customElements.define('agent-terminal', AgentTerminal);
