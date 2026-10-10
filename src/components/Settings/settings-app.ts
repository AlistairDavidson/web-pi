// settings-app.ts — <settings-app>: enhances the server-rendered /settings
// dashboard (SettingsView.astro). Data arrives as HTML; this element only
// wires the actions — the manual pi update (POST /api/update-pi), the
// auto-update toggle (POST /api/auto-update-pi), log out everywhere — and,
// after an update, refreshes the data regions from /partials/settings
// (swapping the [data-refresh] elements by id: plain HTML, no wa-*
// inside, so nothing re-hydrates). Events are delegated to this element.
import type { UpdateResult } from '../../lib/types';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';

interface WaButtonLike extends HTMLElement { loading: boolean; disabled: boolean }
interface WaCalloutLike extends HTMLElement { variant: string }
interface WaDetailsLike extends HTMLElement { open: boolean }
interface WaSwitchLike extends HTMLElement { checked: boolean; disabled: boolean }

export class SettingsApp extends HTMLElement {
  private $<T extends HTMLElement>(id: string): T {
    return this.querySelector(`#${id}`) as T;
  }

  connectedCallback(): void {
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest('wa-button');
      if (button?.id === 'update-pi') void this.updatePi();
      else if (button?.id === 'logout-all') void this.logoutAll();
    });
    this.addEventListener('change', e => {
      if ((e.target as HTMLElement).id === 'pi-auto-update') void this.toggleAutoUpdate();
    });
    this.localizeTimes();
    // Rendered without the server's state (astro dev's own render): load
    // the regions now.
    if (this.$('pi-flags').dataset.loaded !== 'true') void this.refresh();
  }

  /** Server-rendered <time> values are ISO; show them in the browser's
   *  locale and timezone. */
  private localizeTimes(): void {
    this.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach(t => {
      t.textContent = new Date(t.dateTime).toLocaleString();
    });
  }

  /** Re-render the data regions from the partial and re-apply the flags. */
  private async refresh(): Promise<void> {
    let r: Response;
    try { r = await fetch(`${BASE}/partials/settings`); } catch { return; }
    if (r.status === 401) { location.href = `${BASE}/login`; return; }
    if (!r.ok) return;
    const fresh = new DOMParser().parseFromString(await r.text(), 'text/html');
    fresh.querySelectorAll<HTMLElement>('[data-refresh][id]').forEach(region => {
      this.querySelector(`#${CSS.escape(region.id)}`)?.replaceWith(document.importNode(region, true));
    });
    this.localizeTimes();
    const flags = this.$('pi-flags').dataset;
    const npmAvailable = flags.npmAvailable === 'true';
    this.$<WaButtonLike>('update-pi').disabled = !npmAvailable;
    const autoSwitch = this.$<WaSwitchLike>('pi-auto-update');
    autoSwitch.checked = flags.autoEnabled === 'true';
    autoSwitch.disabled = !npmAvailable;
    this.$('auto-update-output').classList.toggle('hidden', !this.$('auto-update-output-text').textContent);
  }

  private npmAvailable(): boolean {
    return this.$('pi-flags').dataset.npmAvailable === 'true';
  }

  private async updatePi(): Promise<void> {
    const updateBtn = this.$<WaButtonLike>('update-pi');
    const result = this.$<WaCalloutLike>('update-result');
    const outputWrap = this.$<WaDetailsLike>('update-output');
    const output = outputWrap.querySelector('pre')!;
    if (updateBtn.disabled) return;
    updateBtn.loading = true;
    updateBtn.disabled = true;
    result.classList.add('hidden');
    outputWrap.classList.add('hidden');
    try {
      const res = await fetch(`${BASE}/api/update-pi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (res.status === 401) { location.href = `${BASE}/login`; return; }
      const r = await res.json() as UpdateResult;
      if (r.ok && !r.dryRun && r.after !== r.before) {
        result.variant = 'success';
        result.textContent = `updated pi ${r.before ?? 'not installed'} → ${r.after ?? 'not installed'} — new sessions use it`;
        void this.refresh(); // npm may have re-pinned the declared range
      } else if (r.ok) {
        result.variant = 'success';
        result.textContent = `pi ${r.after ?? 'not installed'} is already installed — no change`;
      } else {
        result.variant = 'danger';
        result.textContent = r.error ?? `update failed (HTTP ${res.status})`;
      }
      if (r.output) { output.textContent = r.output; outputWrap.open = true; outputWrap.classList.remove('hidden'); }
      result.classList.remove('hidden');
    } catch (e) {
      result.variant = 'danger';
      result.textContent = `request failed: ${(e as Error).message}`;
      result.classList.remove('hidden');
    } finally {
      updateBtn.loading = false;
      updateBtn.disabled = !this.npmAvailable();
    }
  }

  // The auto-update toggle applies immediately (no form): persist via the
  // API, revert the switch when the save fails. The first check runs
  // within a minute of turning the setting on, so the status line says so.
  private async toggleAutoUpdate(): Promise<void> {
    const autoSwitch = this.$<WaSwitchLike>('pi-auto-update');
    const autoResult = this.$<WaCalloutLike>('auto-result');
    const enabled = autoSwitch.checked;
    autoSwitch.disabled = true;
    autoResult.classList.add('hidden');
    try {
      const res = await fetch(`${BASE}/api/auto-update-pi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.status === 401) { location.href = `${BASE}/login`; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (enabled) this.$('auto-check-line').textContent = 'not checked yet — first check within a minute';
    } catch (e) {
      autoSwitch.checked = !enabled; // the save failed — restore what's persisted
      autoResult.variant = 'danger';
      autoResult.textContent = `could not save the setting: ${(e as Error).message}`;
      autoResult.classList.remove('hidden');
    } finally {
      autoSwitch.disabled = false;
    }
  }

  // 'Log out everywhere': the server drops every session token and ends
  // every live terminal. This browser is sent back to the sign-in page —
  // other browsers find out on their next request (or terminal message).
  private async logoutAll(): Promise<void> {
    const logoutAllBtn = this.$<WaButtonLike>('logout-all');
    const logoutResult = this.$<WaCalloutLike>('logout-result');
    if (logoutAllBtn.disabled) return;
    logoutAllBtn.loading = true;
    logoutAllBtn.disabled = true;
    logoutResult.classList.add('hidden');
    try {
      const res = await fetch(`${BASE}/api/logout-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      // 401 = the session already expired elsewhere — back to sign-in too.
      if (res.ok || res.status === 401) { location.href = `${BASE}/login`; return; }
      logoutResult.textContent = `log out everywhere failed (HTTP ${res.status})`;
      logoutResult.classList.remove('hidden');
    } catch (e) {
      logoutResult.textContent = `request failed: ${(e as Error).message}`;
      logoutResult.classList.remove('hidden');
    } finally {
      logoutAllBtn.loading = false;
      logoutAllBtn.disabled = false;
    }
  }
}

if (!customElements.get('settings-app')) customElements.define('settings-app', SettingsApp);
