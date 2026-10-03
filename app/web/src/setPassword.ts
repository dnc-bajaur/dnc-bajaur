/**
 * The sign-in link's page — ADR-0043, Bajaur E5.
 *
 * The token is the last part of this page's own address (`/set-password/<token>`). Opening the
 * page asks the server whose link it is (`GET /auth/link/<token>`, which spends nothing); the
 * form's submit uses it (`POST`), which sets the password and signs the officer in. A member
 * lands on Activities; anyone else on the control room.
 */

import { drawLangSwitch, startUrdu } from './i18n.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const token = location.pathname.split('/').pop() ?? '';

function stop(message: string): void {
  const status = el('status');
  status.textContent = message;
  status.className = 'error';
  status.hidden = false;
  el('form').hidden = true;
  el('toSignIn').hidden = false;
}

async function open(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/auth/link/${encodeURIComponent(token)}`);
  } catch {
    stop('Cannot reach the server. Check your connection and reload this page.');
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { fullName?: string; error?: string };
  if (!res.ok) {
    stop(body.error ?? 'This link is not valid. Ask the DC office for a new one.');
    return;
  }
  el('who').textContent = body.fullName ?? '';
  el('status').hidden = true;
  el('form').hidden = false;
  el<HTMLInputElement>('pw1').focus();
}

el<HTMLInputElement>('showPw').addEventListener('change', (e) => {
  const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
  el<HTMLInputElement>('pw1').type = type;
  el<HTMLInputElement>('pw2').type = type;
});

el<HTMLFormElement>('form').addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const error = el('error');
    error.hidden = true;
    const pw1 = el<HTMLInputElement>('pw1').value;
    const pw2 = el<HTMLInputElement>('pw2').value;
    if (pw1 !== pw2) {
      error.textContent = 'The two passwords are not the same.';
      error.hidden = false;
      return;
    }
    const save = el<HTMLButtonElement>('save');
    save.disabled = true;
    try {
      const res = await fetch(`/auth/link/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pw1 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        identity?: { role?: string };
      };
      if (res.status === 400 && body.reason === 'weak') {
        error.textContent = body.error ?? 'Choose a longer password.';
        error.hidden = false;
        return;
      }
      if (!res.ok) {
        stop(body.error ?? 'This link cannot be used. Ask the DC office for a new one.');
        return;
      }
      el('form').hidden = true;
      el('done').hidden = false;
      location.replace(body.identity?.role === 'member' ? '/activities.html' : '/');
    } catch {
      error.textContent = 'Cannot reach the server. Check your connection and try again.';
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  })();
});

drawLangSwitch(el('langSlot'));
void startUrdu();
void open();
