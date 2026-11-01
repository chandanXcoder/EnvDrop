/** Browser decrypt page. Bundled by build-web.mjs; runs entirely client-side. */
import {
  decryptPayload,
  DecryptionError,
  type Envelope,
  type GetSecretResponse,
  isValidId,
  needsPassphrase,
  parseEnv,
  type SharePayload,
} from '@envdrop/shared';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MASK = '••••••••';
const REVEAL_MS = 10_000;

const id = location.pathname.split('/')[2] ?? '';
const key = location.hash.slice(1);
let envelope: Envelope | undefined;
let viewsLeft = 0;
let payload: SharePayload | undefined;
let showAll = false;

function setStatus(msg: string, error = false) {
  const s = $('status');
  s.textContent = msg;
  s.className = error ? 'status error' : 'status';
}

function step(n: number) {
  document.querySelectorAll<HTMLElement>('#steps li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('done', s < n);
    li.classList.toggle('active', s === n);
  });
}

function gone(title: string, text: string) {
  $('intro').hidden = true;
  $('pass').hidden = true;
  $('gone').hidden = false;
  $('goneTitle').textContent = title;
  $('goneText').textContent = text;
  setStatus('');
}

async function fetchBlob(): Promise<boolean> {
  const res = await fetch(`/api/secrets/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (res.status === 404) {
    gone(
      'This link has burned',
      'It expired, was revoked, or was already opened. Ask the sender for a new one.',
    );
    return false;
  }
  if (res.status === 429) {
    setStatus('Too many requests. Try again in a minute.', true);
    return false;
  }
  if (!res.ok) {
    setStatus(`Server error (${res.status}).`, true);
    return false;
  }
  const body = (await res.json()) as GetSecretResponse;
  envelope = body.envelope;
  viewsLeft = body.viewsLeft;
  return true;
}

function renderKeys() {
  if (!payload) return;
  const list = $('keys');
  const parsed = parseEnv(payload.content);
  list.replaceChildren();
  let i = 0;
  for (const [k, entry] of parsed.entries) {
    const row = document.createElement('div');
    row.className = 'key';
    row.setAttribute('role', 'listitem');
    row.style.animationDelay = `${Math.min(i++ * 30, 400)}ms`;
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    kEl.title = k;
    const vEl = document.createElement('span');
    vEl.className = showAll ? 'v shown' : 'v';
    vEl.textContent = showAll ? entry.value || '(empty)' : MASK;
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.type = 'button';
    eye.title = 'Reveal for 10 seconds';
    eye.setAttribute('aria-label', `Reveal ${k}`);
    eye.textContent = '👁';
    let t: number | undefined;
    eye.onclick = () => {
      window.clearTimeout(t);
      vEl.textContent = entry.value || '(empty)';
      vEl.className = 'v shown';
      t = window.setTimeout(() => {
        if (!showAll) {
          vEl.textContent = MASK;
          vEl.className = 'v';
        }
      }, REVEAL_MS);
    };
    row.append(kEl, vEl, eye);
    list.append(row);
  }
}

async function tryDecrypt(passphrase?: string) {
  if (!envelope) return;
  step(2);
  const seal = $('seal');
  seal.classList.add('unlocking');
  try {
    payload = await decryptPayload(envelope, key, passphrase);
  } catch (e) {
    seal.classList.remove('unlocking');
    if (passphrase !== undefined) {
      const input = $('passphrase');
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
    }
    setStatus(e instanceof DecryptionError ? e.message : 'Decryption failed.', true);
    return;
  }
  // Remove the key from the address bar / history now that we've used it.
  history.replaceState(null, '', location.pathname);
  await new Promise((r) => setTimeout(r, 450)); // let the unlock animation land
  step(3);
  $('intro').hidden = true;
  $('pass').hidden = true;
  $('result').hidden = false;
  $('filename').textContent = payload.name;
  $('keycount').textContent = `${parseEnv(payload.content).entries.size} keys`;
  $('views').textContent =
    viewsLeft > 0 ? `${viewsLeft} view(s) left on this link` : 'this link is now burned 🔥';
  $<HTMLTextAreaElement>('content').value = payload.content;
  renderKeys();
  setStatus('Decrypted locally. Nothing was sent anywhere.');
}

$('decrypt').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('decrypt');
  btn.disabled = true;
  step(1);
  setStatus('Fetching ciphertext…');
  try {
    if (!(await fetchBlob())) return;
    if (envelope && needsPassphrase(envelope)) {
      $('intro').hidden = true;
      $('pass').hidden = false;
      $('passphrase').focus();
      setStatus('');
    } else {
      await tryDecrypt();
    }
  } catch {
    setStatus('Network error.', true);
  } finally {
    btn.disabled = false;
  }
});

async function unlock() {
  const btn = $<HTMLButtonElement>('unlock');
  btn.disabled = true;
  setStatus('Deriving key from passphrase…');
  await tryDecrypt($<HTMLInputElement>('passphrase').value);
  btn.disabled = false;
}
$('unlock').addEventListener('click', unlock);
$('passphrase').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void unlock();
});

$('toggleAll').addEventListener('click', () => {
  showAll = !showAll;
  $('toggleAll').textContent = showAll ? 'Hide all values' : 'Show all values';
  renderKeys();
});
$('toggleRaw').addEventListener('click', () => {
  const ta = $('content');
  ta.hidden = !ta.hidden;
  $('keys').hidden = !ta.hidden;
  $('toggleAll').hidden = !ta.hidden;
  $('toggleRaw').textContent = ta.hidden ? 'Raw file' : 'Key list';
});
$('download').addEventListener('click', () => {
  if (!payload) return;
  const url = URL.createObjectURL(new Blob([payload.content], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = payload.name.replace(/[\\/]/g, '_') || '.env';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Downloaded. Some browsers drop the leading dot, so rename it to .env if needed.');
});
$('copy').addEventListener('click', async () => {
  if (!payload) return;
  await navigator.clipboard.writeText(payload.content);
  setStatus('Copied. Remember to clear your clipboard afterwards.');
});
$('clear').addEventListener('click', () => {
  payload = undefined;
  envelope = undefined;
  $<HTMLTextAreaElement>('content').value = '';
  $('keys').replaceChildren();
  gone('Wiped from this page', 'The decrypted data is gone from this tab. Close it to be sure.');
});

if (!isValidId(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
  gone(
    'This link is incomplete',
    'Make sure you copied the whole URL, including the part after #.',
  );
}
