// @ts-check
// Phase 2: .env vs .env.example key check (key names only, never values).
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { el, icon, logo, countUp, toast } = window.EnvDropUI;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const send = (/** @type {Record<string, unknown>} */ m) => vscode.postMessage(m);

  /** @param {string} title @param {string} hint @param {string[]} keys @param {string} stripe @param {string} ic @param {HTMLElement|null} action */
  function group(title, hint, keys, stripe, ic, action) {
    return el('div', { class: `card ${stripe} enter` }, [
      el('div', { class: 'row' }, [
        icon(ic),
        el('strong', { text: `${title} (${keys.length})` }),
        el('span', { class: 'spacer' }),
        action,
      ]),
      el('p', { class: 'muted', style: 'font-size:.9em', text: hint }),
      keys.length
        ? el(
            'div',
            { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' },
            keys.map((k) => el('span', { class: 'chip mono', text: k })),
          )
        : el('p', { class: 'muted' }, [icon('pass'), ' None']),
    ]);
  }

  /** @param {any} s */
  function render(s) {
    const r = s.result;
    const healthy = r.missing.length === 0 && r.extra.length === 0 && r.empty.length === 0;
    const total = r.ok + r.missing.length + r.empty.length;
    const pct = total ? Math.round((r.ok / total) * 100) : 100;
    const score = el('span', { text: '0' });
    countUp(score, pct);

    app.replaceChildren(
      el('div', { class: 'wrap' }, [
        el('div', { class: 'hero enter' }, [
          logo(),
          el('div', {}, [
            el('h1', { text: healthy ? 'All keys accounted for' : 'Key check' }),
            el('div', { class: 'tag' }, [
              el('button', {
                class: 'linklike mono',
                text: s.envName,
                on: { click: () => send({ type: 'openEnv' }) },
              }),
              ' vs ',
              el('button', {
                class: 'linklike mono',
                text: s.exampleName,
                on: { click: () => send({ type: 'openExample' }) },
              }),
            ]),
          ]),
        ]),
        el('div', { class: 'stats enter' }, [
          el('div', { class: 'stat add' }, [
            el('div', { class: 'n' }, [score, '%']),
            el('div', { class: 'l', text: 'coverage' }),
          ]),
          el('div', { class: 'stat del' }, [
            el('div', { class: 'n', text: String(r.missing.length) }),
            el('div', { class: 'l', text: 'missing' }),
          ]),
          el('div', { class: 'stat mod' }, [
            el('div', { class: 'n', text: String(r.empty.length) }),
            el('div', { class: 'l', text: 'empty' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'n', text: String(r.extra.length) }),
            el('div', { class: 'l', text: 'undocumented' }),
          ]),
        ]),
        el('div', { class: 'bar enter' }, [el('i', { style: `width:${pct}%` })]),
        group(
          'Missing in your .env',
          'Listed in the example but not set locally. Your app may fail without them.',
          r.missing,
          'stripe-del',
          'error',
          r.missing.length
            ? el(
                'button',
                { class: 'btn small', on: { click: () => send({ type: 'addMissing' }) } },
                [icon('add'), 'Add as empty keys'],
              )
            : null,
        ),
        group(
          'Empty values',
          'Present but blank. Ask a teammate to share them with EnvDrop.',
          r.empty,
          'stripe-mod',
          'circle-large-outline',
          null,
        ),
        group(
          'Undocumented keys',
          'Set locally but missing from the example, so teammates won’t know they exist.',
          r.extra,
          'stripe-warn',
          'question',
          r.extra.length
            ? el(
                'button',
                { class: 'btn small', on: { click: () => send({ type: 'addExtra' }) } },
                [icon('book'), 'Add to example'],
              )
            : null,
        ),
        el('div', { class: 'btn-row enter', style: 'margin-top:12px' }, [
          el('button', { class: 'btn ghost', on: { click: () => send({ type: 'regenerate' }) } }, [
            icon('sync'),
            'Regenerate example from .env',
          ]),
          el('button', { class: 'btn ghost', on: { click: () => send({ type: 'refresh' }) } }, [
            icon('refresh'),
            'Re-check',
          ]),
        ]),
      ]),
    );
    if (s.flash) toast(s.flash);
  }

  window.addEventListener('message', (e) => e.data?.type === 'state' && render(e.data));
  send({ type: 'ready' });
})();
