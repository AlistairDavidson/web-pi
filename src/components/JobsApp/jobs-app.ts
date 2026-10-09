import type { CalendarCheck, JobsState, ScheduledJob } from '../../lib/types';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';

type WaDialog = HTMLElement & { open: boolean };
type WaFormControl = HTMLElement & { value: string; disabled: boolean };
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

export class JobsApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private editing: string | null = null;
  private deleting: string | null = null;
  private inflight = false;

  connectedCallback(): void {
    (this.querySelector('#jobs-console') as HTMLElement).onclick = () => {
      location.href = `${BASE}/`;
    };
    (this.querySelector('#jobs-new') as HTMLElement).onclick = () => this.openDialog(null);
    (this.querySelector('#job-save') as HTMLElement).onclick = () => this.save();
    (this.querySelector('#job-delete-confirm') as HTMLElement).onclick = () => this.deleteJob();
    (this.querySelector('#job-schedule') as WaFormControl)
      .addEventListener('input', () => this.queueValidate());
    (this.querySelector('#job-form') as HTMLFormElement)
      .addEventListener('submit', e => { e.preventDefault(); this.save(); });

    this.load();
    this.pollTimer = setInterval(() => this.load(), 15000);
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.validateTimer) clearTimeout(this.validateTimer);
  }

  private toast(message: string, variant: string, icon: string): void {
    (this.querySelector('wa-toast') as WaToast | null)?.create(message, {
      variant, icon, duration: 6000,
    });
  }

  private async load(): Promise<void> {
    let r: Response;
    try { r = await fetch(`${BASE}/api/jobs`); } catch { return; }
    if (r.status === 401) { location.href = `${BASE}/login`; return; }
    if (!r.ok) return;
    this.render(await r.json() as JobsState);
  }

  private render(st: JobsState): void {
    const fresh = this.querySelector('#jobs-new') as HTMLElement;
    const list = this.querySelector('#jobs-list') as HTMLElement;
    fresh.classList.remove('hidden');
    list.innerHTML = st.jobs.length === 0
      ? `<p class="jobs-empty">no jobs yet — "new job" schedules a recurring command.</p>`
      : st.jobs.map(j => this.card(j)).join('');
    this.querySelectorAll<HTMLElement>('[data-run]').forEach(el => {
      el.onclick = () => this.run(el.dataset.run!);
    });
    this.querySelectorAll<HTMLElement>('[data-edit]').forEach(el => {
      el.onclick = () => {
        const job = st.jobs.find(j => j.name === el.dataset.edit);
        if (job) this.openDialog(job);
      };
    });
    this.querySelectorAll<HTMLElement>('[data-del]').forEach(el => {
      el.onclick = () => this.confirmDelete(el.dataset.del!);
    });
  }

  private card(j: ScheduledJob): string {
    const badges = [
      j.active
        ? '<wa-badge pill variant="success">scheduled</wa-badge>'
        : '<wa-badge pill>invalid schedule</wa-badge>',
      j.running
        ? `<wa-badge pill variant="brand">running</wa-badge>`
        : '',
      j.lastResult === 'failed'
        ? '<wa-badge pill variant="danger">last run failed</wa-badge>'
        : '',
    ].filter(Boolean).join('');
    const view = j.running
      ? `<a class="job-view" href="${BASE}/?live=${encodeURIComponent(j.session)}">view run<wa-icon name="play"></wa-icon></a>`
      : '';
    const last = j.last
      ? `${esc(j.last)}${j.lastResult === 'success' ? ' · ok' : j.lastResult === 'failed' ? ' · failed' : ''}`
      : 'never';
    return `
      <wa-card class="job">
        <div class="job-head">
          <span class="job-name"><wa-icon name="clock"></wa-icon>${esc(j.name)}</span>
          <span class="wa-cluster wa-gap-3xs">${badges}${view}</span>
        </div>
        <dl class="job-meta">
          <dt>schedule</dt><dd><code>${esc(j.schedule) || '—'}</code></dd>
          <dt>command</dt><dd><code>${esc(j.command) || '—'}</code></dd>
          <dt>next</dt><dd>${esc(j.next ?? '—')}</dd>
          <dt>last run</dt><dd>${esc(last)}</dd>
        </dl>
        <div class="job-actions wa-cluster wa-gap-2xs">
          <wa-button size="s" data-run="${esc(j.name)}">
            <wa-icon slot="start" name="play"></wa-icon>run now
          </wa-button>
          <wa-button size="s" appearance="plain" data-edit="${esc(j.name)}">
            <wa-icon slot="start" name="pencil"></wa-icon>edit
          </wa-button>
          <wa-button size="s" appearance="plain" variant="danger" data-del="${esc(j.name)}">
            <wa-icon slot="start" name="trash-can"></wa-icon>delete
          </wa-button>
        </div>
      </wa-card>`;
  }

  // ---- create / edit ----

  private openDialog(job: ScheduledJob | null): void {
    this.editing = job?.name ?? null;
    const dlg = this.querySelector('#job-dialog') as WaDialog;
    const name = this.querySelector('#job-name') as WaFormControl;
    const schedule = this.querySelector('#job-schedule') as WaFormControl;
    const command = this.querySelector('#job-command') as WaFormControl;
    dlg.setAttribute('label', job ? `edit job ${job.name}` : 'new job');
    name.value = job?.name ?? '';
    name.disabled = job !== null; // the name is the job identity — no renames
    schedule.value = job?.schedule ?? '';
    command.value = job?.command ?? '';
    this.setFeedback(null);
    this.validate();
    dlg.open = true;
    (job ? schedule : name).focus();
  }

  private queueValidate(): void {
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => this.validate(), 350);
  }

  private setFeedback(c: CalendarCheck | null): void {
    const el = this.querySelector('#schedule-feedback') as HTMLElement;
    el.className = 'schedule-feedback';
    el.textContent = '';
    if (!c) return;
    if (c.valid) {
      el.className = 'schedule-feedback ok';
      el.textContent = c.next ? `next: ${c.next}` : 'valid';
    } else {
      el.className = 'schedule-feedback err';
      el.textContent = c.error ?? 'invalid schedule';
    }
  }

  private async validate(): Promise<void> {
    const schedule = (this.querySelector('#job-schedule') as WaFormControl).value.trim();
    if (!schedule) { this.setFeedback(null); return; }
    try {
      const r = await fetch(`${BASE}/api/jobs/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule }),
      });
      if (r.ok) this.setFeedback(await r.json() as CalendarCheck);
    } catch { /* transient — the save path re-validates server-side */ }
  }

  private async save(): Promise<void> {
    if (this.inflight) return;
    const name = (this.querySelector('#job-name') as WaFormControl).value.trim();
    const schedule = (this.querySelector('#job-schedule') as WaFormControl).value.trim();
    const command = (this.querySelector('#job-command') as WaFormControl).value.trim();
    if (!name || !schedule || !command) {
      this.toast('name, schedule and command are all required', 'warning', 'triangle-exclamation');
      return;
    }
    this.inflight = true;
    try {
      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, schedule, command }),
      });
      const body = await r.json().catch(() => ({})) as { name?: string; session?: string; error?: string; detail?: string | null };
      if (!r.ok) {
        this.toast(`${body.error ?? 'could not save job'}${body.detail ? ` — ${body.detail}` : ''}`,
          'danger', 'triangle-exclamation');
        return;
      }
      (this.querySelector('#job-dialog') as WaDialog).open = false;
      this.toast(`job ${body.name ?? name} saved`, 'success', 'circle-check');
      await this.load();
    } finally {
      this.inflight = false;
    }
  }

  // ---- run / delete ----

  private async run(name: string): Promise<void> {
    const r = await fetch(`${BASE}/api/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { session?: string; error?: string; detail?: string | null };
    if (r.ok) {
      this.toast(`run started — see Live (session ${body.session ?? `webpi-${name}`})`, 'success', 'circle-check');
    } else if (r.status === 409) {
      this.toast(body.error ?? 'previous run still active', 'warning', 'triangle-exclamation');
    } else {
      this.toast(`${body.error ?? 'could not run job'}${body.detail ? ` — ${body.detail}` : ''}`,
        'danger', 'triangle-exclamation');
    }
    await this.load();
  }

  private confirmDelete(name: string): void {
    this.deleting = name;
    (this.querySelector('#job-delete-text') as HTMLElement).textContent =
      `Delete job "${name}"? Removes its schedule and run history. ` +
      `A run that's currently live keeps its tmux session.`;
    (this.querySelector('#job-delete-dialog') as WaDialog).open = true;
  }

  private async deleteJob(): Promise<void> {
    if (!this.deleting) return;
    const name = this.deleting;
    const r = await fetch(`${BASE}/api/jobs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({})) as { error?: string; detail?: string | null };
    (this.querySelector('#job-delete-dialog') as WaDialog).open = false;
    if (r.ok) {
      this.toast(`job ${name} deleted`, 'success', 'circle-check');
    } else {
      this.toast(`${body.error ?? 'could not delete job'}${body.detail ? ` — ${body.detail}` : ''}`,
        'danger', 'triangle-exclamation');
    }
    this.deleting = null;
    await this.load();
  }
}

customElements.define('jobs-app', JobsApp);
