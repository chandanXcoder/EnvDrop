// @ts-check
// Share success screen: animated seal, countdown ring, copy / QR / revoke.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { el, svg, icon, logo, formatLeft, toast } = window.EnvDropUI;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const send = (/** @type {Record<string, unknown>} */ m) => vscode.postMessage(m);
  /** @type {any} */
  let s;
  let timer = 0;

  const R = 26;
  const C = 2 * Math.PI * R;

  function ring() {
    return svg('svg', { viewBox: '0 0 64 64', class: 'ring', 'aria-hidden': 'true' }, [
      svg('defs', {}, [
        svg('linearGradient', { id: 'ed-grad', x1: '0', y1: '0', x2: '1', y2: '1' }, [
          svg('stop', { offset: '0', 'stop-color': '#7c5cff' }),
          svg('stop', { offset: '1', 'stop-color': '#22d3ee' }),
        ]),
      ]),
      svg('circle', { class: 'bg', cx: '32', cy: '32', r: String(R) }),
      svg('circle', {
        class: 'fg',
        cx: '32',
        cy: '32',
        r: String(R),
        'stroke-dasharray': String(C),
        'stroke-dashoffset': '0',
      }),
    ]);
  }

  /** The "sealed" animation: drop logo with orbiting sparkles and a check badge. */
  function seal() {
    const wrap = el('div', { class: 'seal pop' }, [
      logo('seal-logo'),
      el('span', { class: 'seal-check' }, [icon('check')]),
    ]);
    for (let i = 0; i < 8; i++)
      wrap.append(el('i', { class: 'spark', style: `--a:${i * 45}deg;--d:${0.1 + i * 0.03}s` }));
    return wrap;
  }

  /** @param {boolean[][]} m */
  function qrSvg(m) {
    const n = m.length;
    const rects = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (m[y][x]) rects.push(svg('rect', { x, y, width: 1.02, height: 1.02 }));
    return svg(
      'svg',
      {
        viewBox: `0 0 ${n} ${n}`,
        class: 'qr pop',
        role: 'img',
        'aria-label': 'QR code of the share link',
      },
      [
        svg('rect', { x: 0, y: 0, width: n, height: n, fill: '#fff' }),
        svg('g', { fill: '#111' }, rects),
      ],
    );
  }

  function render() {
    const left = el('div', { class: 'big-left mono' });
    const r = ring();
    const qrBox = el('div', { class: 'qr-box' }, [
      el('button', { class: 'btn ghost', on: { click: () => send({ type: 'qr' }) } }, [
        icon('device-mobile'),
        'Show QR code',
      ]),
      el('p', {
        class: 'muted',
        style: 'font-size:.85em',
        text: 'The QR contains the full link, including the key. Only show it to the recipient.',
      }),
    ]);
    qrBox.id = 'qr';

    app.replaceChildren(
      el('div', { class: 'wrap' }, [
        el('div', { class: 'success' }, [
          seal(),
          el('h1', { class: 'enter' }, [
            'Sealed & shared ',
            el('span', { class: 'grad-text', text: s.fileName }),
          ]),
          el('p', {
            class: 'muted enter',
            text: `${s.keyCount} keys, encrypted on your machine with AES-256-GCM. The server only ever sees ciphertext.`,
          }),
        ]),
        el('div', { class: 'card enter link-card' }, [
          el('div', { class: 'row' }, [
            icon('link'),
            el('span', { class: 'mono title', text: s.masked }),
            el('span', { class: 'spacer' }),
            el('span', { class: 'chip ok' }, [icon('copy'), 'copied to clipboard']),
          ]),
          el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
            el(
              'button',
              { class: 'btn brand', id: 'copy', on: { click: () => send({ type: 'copy' }) } },
              [icon('copy'), 'Copy link again'],
            ),
            el(
              'button',
              { class: 'btn ghost', on: { click: () => send({ type: 'clearClipboard' }) } },
              [icon('clear-all'), 'Clear clipboard'],
            ),
            el(
              'button',
              { class: 'btn danger', id: 'revoke', on: { click: () => send({ type: 'revoke' }) } },
              [icon('circle-slash'), 'Revoke'],
            ),
          ]),
        ]),
        el('div', { class: 'facts enter' }, [
          el('div', { class: 'card fact' }, [
            r,
            el('div', {}, [left, el('div', { class: 'muted', text: 'until it self-destructs' })]),
          ]),
          el('div', { class: 'card fact' }, [
            el('div', { class: 'fact-icon' }, [icon(s.maxViews === 1 ? 'flame' : 'eye')]),
            el('div', {}, [
              el('div', {
                class: 'big-left',
                text: s.maxViews === 1 ? '1 view' : `${s.maxViews} views`,
              }),
              el('div', {
                class: 'muted',
                text: s.maxViews === 1 ? 'burns after reading' : 'then deleted',
              }),
            ]),
          ]),
          el('div', { class: 'card fact' }, [
            el('div', { class: 'fact-icon' }, [icon(s.passphrase ? 'key' : 'unlock')]),
            el('div', {}, [
              el('div', { class: 'big-left', text: s.passphrase ? 'Passphrase' : 'Link only' }),
              el('div', {
                class: 'muted',
                text: s.passphrase
                  ? 'send it via another channel'
                  : 'anyone with the link can open it',
              }),
            ]),
          ]),
        ]),
        el('div', { class: 'enter' }, [qrBox]),
        el('h3', {}, [icon('lightbulb'), 'Tips']),
        el('ul', { class: 'muted tips enter' }, [
          el('li', { text: 'Send the link directly to one person. Avoid group chats.' }),
          el('li', {
            text: 'The recipient runs "EnvDrop: Pull .env" in VS Code, or opens the link in a browser.',
          }),
          el('li', {
            text: 'If the recipient sees "already viewed", someone else opened it first. Revoke and rotate.',
          }),
        ]),
      ]),
    );

    const circle = /** @type {SVGCircleElement} */ (r.querySelector('.fg'));
    const tick = () => {
      const total = s.expiresAt - s.createdAt;
      const rem = Math.max(0, s.expiresAt - Date.now());
      left.textContent = formatLeft(rem);
      circle.setAttribute('stroke-dashoffset', String(C * (1 - rem / total)));
      if (rem <= 0) ended('Expired: the server has deleted it.');
    };
    tick();
    timer = window.setInterval(tick, 1000);
  }

  /** @param {string} why */
  function ended(why) {
    clearInterval(timer);
    document.querySelectorAll('#copy, #revoke').forEach((b) => b.setAttribute('disabled', ''));
    const qr = document.getElementById('qr');
    if (qr) qr.replaceChildren(el('div', { class: 'empty' }, [icon('trash'), why]));
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'init') {
      s = m;
      render();
    } else if (m?.type === 'copied') toast('Link copied');
    else if (m?.type === 'cleared') toast('Clipboard cleared');
    else if (m?.type === 'qr') {
      const box = document.getElementById('qr');
      if (box)
        box.replaceChildren(
          qrSvg(m.matrix),
          el(
            'button',
            { class: 'btn ghost small', style: 'margin-top:8px', on: { click: () => render() } },
            [icon('eye-closed'), 'Hide QR'],
          ),
        );
    } else if (m?.type === 'revoked') {
      toast(m.ok ? 'Link revoked' : 'Link was already gone');
      ended(
        m.ok ? 'Revoked: the link no longer works.' : 'This link had already expired or been used.',
      );
    }
  });
  send({ type: 'ready' });
})();
