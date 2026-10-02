/**
 * Activities — the page a `member` account lives on (ADR-0038 / ADR-0039, Bajaur).
 *
 * Phase B: who is signed in, change password, sign out. Phase C adds the Activities themselves.
 *
 * Nothing here enforces anything. The server decides what this account may do (INV-05); this
 * page only reads `/auth/me` to say who is signed in, and sends anybody without a session back
 * to the shell's sign-in.
 */

interface Me {
  readonly identity: {
    readonly fullName: string;
    readonly role: string;
    readonly mustChangePassword: boolean;
  };
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is missing from activities.html`);
  return found as T;
}

const ROLE_TEXT: Readonly<Record<string, string>> = {
  member: 'Officer account — Activities only.',
  owner: 'Owner account.',
  admin: 'Administrator account.',
  operator: 'Control-room account.',
  viewer: 'Viewer account.',
};

async function load(): Promise<void> {
  const status = el('status');
  let me: Me;
  try {
    const res = await fetch('/auth/me', { cache: 'no-store' });
    if (res.status === 401) {
      location.replace('/');
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    me = (await res.json()) as Me;
  } catch {
    status.textContent = 'Cannot reach the server. Check your connection and reload.';
    return;
  }

  el('who').textContent = me.identity.fullName;
  el('role').textContent = ROLE_TEXT[me.identity.role] ?? '';
  el('mustChange').hidden = !me.identity.mustChangePassword;
  status.hidden = true;
  el('page').hidden = false;
}

el('signOut').addEventListener('click', () => {
  void (async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      location.replace('/');
    }
  })();
});

el<HTMLFormElement>('password').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const error = el('passwordError');
  const ok = el('passwordOk');
  error.hidden = true;
  ok.hidden = true;

  const data = new FormData(form);
  void (async () => {
    try {
      const res = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: String(data.get('current') ?? ''),
          newPassword: String(data.get('next') ?? ''),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        error.textContent =
          typeof body?.error === 'string'
            ? body.error
            : 'The password could not be changed — try again in a moment.';
        error.hidden = false;
        return;
      }
      form.reset();
      ok.hidden = false;
      el('mustChange').hidden = true;
    } catch {
      error.textContent = 'Cannot reach the server. Check your connection and try again.';
      error.hidden = false;
    }
  })();
});

void load();

export {};
