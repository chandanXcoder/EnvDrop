/** Browser decrypt page. Bundled by build-web.mjs; runs entirely client-side. */
import {
  decryptPayload,
  DecryptionError,
  type Envelope,
  type GetSecretResponse,
  isValidId,
  needsPassphrase,
} from '@envdrop/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

function setStatus(msg: string, error = false) {
  status.textContent = msg;
  status.className = error ? 'error' : '';
}

const id = location.pathname.split('/')[2] ?? '';
const key = location.hash.slice(1);
let envelope: Envelope | undefined;
let viewsLeft = 0;

function stripKeyFromUrl() {
  // Remove the key from the address bar / history once we've used it.
  history.replaceState(null, '', location.pathname);
}

async function fetchBlob(): Promise<boolean> {
  const res = await fetch(`/api/secrets/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (res.status === 404) {
    setStatus('This link has expired, was revoked, or was already viewed.', true);
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

async function tryDecrypt(passphrase?: string) {
  if (!envelope) return;
  try {
    const payload = await decryptPayload(envelope, key, passphrase);
    stripKeyFromUrl();
    $('pass').hidden = true;
    $('result').hidden = false;
    $('filename').textContent = payload.name;
    $('views').textContent =
      viewsLeft > 0 ? `${viewsLeft} view(s) left on this link` : 'This link is now burned';
    $<HTMLTextAreaElement>('content').value = payload.content;
    setStatus('Decrypted locally.');
    $('download').onclick = () => {
      const url = URL.createObjectURL(new Blob([payload.content], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = payload.name.replace(/[\\/]/g, '_') || '.env';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  } catch (e) {
    setStatus(e instanceof DecryptionError ? e.message : 'Decryption failed.', true);
  }
}

$('decrypt').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('decrypt');
  btn.disabled = true;
  setStatus('Fetching…');
  try {
    if (!(await fetchBlob())) return;
    $('intro').hidden = true;
    if (envelope && needsPassphrase(envelope)) {
      $('pass').hidden = false;
      $('passphrase').focus();
      setStatus('Enter the passphrase the sender gave you (separately from the link).');
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
  const input = $<HTMLInputElement>('passphrase');
  const btn = $<HTMLButtonElement>('unlock');
  btn.disabled = true;
  setStatus('Deriving key…');
  await tryDecrypt(input.value);
  btn.disabled = false;
}
$('unlock').addEventListener('click', unlock);
$('passphrase').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void unlock();
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($<HTMLTextAreaElement>('content').value);
  setStatus('Copied. Remember to clear your clipboard.');
});
$('clear').addEventListener('click', () => {
  $<HTMLTextAreaElement>('content').value = '';
  $('result').hidden = true;
  envelope = undefined;
  setStatus('Cleared.');
});

if (!isValidId(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
  $('intro').hidden = true;
  setStatus(
    'This link is incomplete. Make sure you copied the whole URL, including the part after #.',
    true,
  );
}
