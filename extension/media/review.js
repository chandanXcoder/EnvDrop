// @ts-check
// EnvDrop pull review. Values never arrive unless the user clicks Reveal; revealed
// values are wiped after 10 seconds (with a draining progress bar).
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { el, icon, logo, countUp, toggle } = window.EnvDropUI;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const send = (/** @type {Record<string, unknown>} */ m) => vscode.postMessage(m);
  const REVEAL_MS = 10_000;
  /** @type {Map<string, number>} */
  const timers = new Map();
  /** @type {Map<string, boolean>} */
  const selected = new Map();
  let mask = '••••••••';
  let filter = 'all';
  let query = '';
  /** @type {any} */
  let init;

  const STATUS =
    /** @type {Record<string, {label: string, cls: string, stripe: string, icon: string}>} */ ({
      added: { label: 'new', cls: 'add', stripe: 'stripe-add', icon: 'diff-added' },
      changed: { label: 'changed', cls: 'mod', stripe: 'stripe-mod', icon: 'diff-modified' },
      removed: { label: 'only in local', cls: 'del', stripe: 'stripe-del', icon: 'diff-removed' },
      unchanged: { label: 'unchanged', cls: '', stripe: '', icon: 'pass' },
    });

  const vid = (/** @type {string} */ side, /** @type {string} */ key) =>
    `v-${side}-${encodeURIComponent(key)}`;

  function hide(/** @type {string} */ side, /** @type {string} */ key) {
    const cell = document.getElementById(vid(side, key));
    if (cell) {
      cell.textContent = mask;
      cell.classList.remove('revealed');
    }
    document.getElementById(`b-${vid(side, key)}`)?.remove();
    const t = timers.get(side + key);
    if (t) clearTimeout(t);
    timers.delete(side + key);
  }

  /** @param {any} r */
  function row(r) {
    const st = STATUS[r.status];
    const side = r.status === 'removed' ? 'local' : 'incoming';
    const cb = /** @type {HTMLInputElement} */ (
      el('input', {
        type: 'checkbox',
        class: 'check',
        checked: selected.get(r.key),
        'aria-label': `${st.label}: ${r.key}`,
      })
    );
    cb.addEventListener('change', () => {
      selected.set(r.key, cb.checked);
      updateFooter();
    });
    return el('div', { class: `card ${st.stripe} enter`, 'data-key': r.key }, [
      el('div', { class: 'row' }, [
        init.isNew || r.status === 'unchanged' ? icon(st.icon) : cb,
        el('span', { class: 'title', text: r.key }),
        el('span', { class: `chip ${st.cls}` }, [icon(st.icon), st.label]),
        el('span', { class: 'spacer' }),
        el('span', { class: 'val', id: vid(side, r.key), text: mask }),
        el(
          'button',
          {
            class: 'btn small ghost',
            title: 'Show this value for 10 seconds',
            'aria-label': `Reveal ${r.key}`,
            on: { click: () => send({ type: 'reveal', key: r.key, side }) },
          },
          [icon('eye')],
        ),
      ]),
    ]);
  }

  function visibleRows() {
    return init.rows.filter(
      (/** @type {any} */ r) =>
        (filter === 'all' ? r.status !== 'unchanged' || init.isNew : r.status === filter) &&
        r.key.toLowerCase().includes(query.toLowerCase()),
    );
  }

  function renderList() {
    const list = /** @type {HTMLElement} */ (document.getElementById('list'));
    const rows = visibleRows();
    list.replaceChildren(
      ...(rows.length
        ? rows.map(row)
        : [
            el('div', { class: 'empty' }, [
              icon(query ? 'search' : 'pass-filled'),
              query ? 'No keys match.' : 'Nothing to show here.',
            ]),
          ]),
    );
  }

  /** @type {HTMLElement} */
  let applyBtn;
  function updateFooter() {
    if (!applyBtn || init.isNew) return;
    const n = [...selected.values()].filter(Boolean).length;
    applyBtn.replaceChildren(icon('check'), `Apply ${n} selected`);
    applyBtn.toggleAttribute('disabled', n === 0);
  }

  /** @param {string} key @param {string} label @param {number} n @param {string} cls */
  function stat(key, label, n, cls) {
    const num = el('div', { class: 'n', text: '0' });
    const b = el(
      'button',
      {
        class: `stat ${cls} ${filter === key ? 'active' : ''}`,
        'aria-pressed': String(filter === key),
        on: { click: () => setFilter(key) },
      },
      [num, el('div', { class: 'l', text: label })],
    );
    countUp(num, n);
    return b;
  }

  /** @param {string} f */
  function setFilter(f) {
    filter = filter === f ? 'all' : f;
    document.querySelectorAll('.stat').forEach((s) => s.classList.remove('active'));
    document.querySelector(`.stat[data-f="${filter}"]`)?.classList.add('active');
    renderList();
  }

  function render() {
    mask = init.mask;
    const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    for (const r of init.rows) {
      counts[/** @type {keyof typeof counts} */ (r.status)]++;
      selected.set(r.key, r.status === 'added' || r.status === 'changed');
    }

    const stats = init.isNew
      ? null
      : el('div', { class: 'stats enter' }, [
          stat('added', 'new keys', counts.added, 'add'),
          stat('changed', 'changed values', counts.changed, 'mod'),
          stat('removed', 'only in local', counts.removed, 'del'),
          stat('unchanged', 'unchanged', counts.unchanged, ''),
        ]);
    stats
      ?.querySelectorAll('.stat')
      .forEach((s, i) => s.setAttribute('data-f', ['added', 'changed', 'removed', 'unchanged'][i]));

    const search = /** @type {HTMLInputElement} */ (
      el('input', { type: 'search', placeholder: 'Filter keys…', 'aria-label': 'Filter keys' })
    );
    search.addEventListener('input', () => {
      query = search.value;
      renderList();
    });

    const bulk = (/** @type {boolean} */ v) => {
      for (const r of init.rows) if (r.status !== 'unchanged') selected.set(r.key, v);
      renderList();
      updateFooter();
    };

    const backup = toggle(
      `Back up current file as ${init.targetName}.backup`,
      !init.isNew,
      () => {},
    );
    applyBtn = el('button', { class: 'btn brand', on: { click: () => apply() } }, []);

    app.replaceChildren(
      el('div', { class: 'wrap' }, [
        el('div', { class: 'hero enter' }, [
          logo(),
          el('div', {}, [
            el('h1', {
              text: init.isNew
                ? `Create ${init.targetName}`
                : `Review changes to ${init.targetName}`,
            }),
            el('div', { class: 'tag' }, [
              icon('lock'),
              ` Decrypted locally · from ${init.origin} · `,
              init.viewsLeft > 0
                ? `${init.viewsLeft} view(s) left on the link`
                : el('span', {}, [icon('flame'), ' link burned']),
            ]),
          ]),
        ]),
        init.parseWarnings > 0
          ? el('div', { class: 'card stripe-warn enter' }, [
              icon('warning'),
              ` ${init.parseWarnings} line(s) couldn't be parsed. "Replace whole file" keeps them as-is.`,
            ])
          : null,
        stats,
        el(
          'div',
          { class: 'row enter', style: 'display:flex;gap:8px;align-items:center;margin:8px 0' },
          [
            search,
            init.isNew
              ? null
              : el('button', { class: 'btn small ghost', on: { click: () => bulk(true) } }, [
                  'All',
                ]),
            init.isNew
              ? null
              : el('button', { class: 'btn small ghost', on: { click: () => bulk(false) } }, [
                  'None',
                ]),
          ],
        ),
        el('p', { class: 'muted', style: 'font-size:.85em' }, [
          icon('eye-closed'),
          ' Values stay masked. Reveal shows one value for 10 seconds.',
        ]),
        el('div', { id: 'list' }),
      ]),
      el('div', { class: 'footer' }, [
        init.isNew ? null : backup.node,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn ghost', on: { click: () => send({ type: 'cancel' }) } }, [
          'Cancel',
        ]),
        init.isNew
          ? null
          : el(
              'button',
              {
                class: 'btn secondary',
                on: {
                  click: () =>
                    send({ type: 'apply', mode: 'replace', backup: backup.input.checked }),
                },
              },
              [icon('replace-all'), 'Replace whole file'],
            ),
        init.isNew
          ? el(
              'button',
              {
                class: 'btn brand',
                on: { click: () => send({ type: 'apply', mode: 'replace', backup: false }) },
              },
              [icon('save'), `Write ${init.targetName} (${init.rows.length} keys)`],
            )
          : applyBtn,
      ]),
    );

    function apply() {
      const keys = init.rows.filter(
        (/** @type {any} */ r) => selected.get(r.key) && r.status !== 'unchanged',
      );
      send({
        type: 'apply',
        mode: 'merge',
        apply: keys
          .filter((/** @type {any} */ r) => r.status !== 'removed')
          .map((/** @type {any} */ r) => r.key),
        remove: keys
          .filter((/** @type {any} */ r) => r.status === 'removed')
          .map((/** @type {any} */ r) => r.key),
        backup: backup.input.checked,
      });
    }
    renderList();
    updateFooter();
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m?.type === 'init') {
      init = m;
      render();
    }
    if (m?.type === 'revealed') {
      const id = vid(m.side, m.key);
      const cell = document.getElementById(id);
      if (!cell) return;
      hide(m.side, m.key);
      cell.textContent = m.value === '' ? '(empty)' : m.value;
      cell.classList.add('revealed');
      const card = cell.closest('.card');
      const bar = el('div', { class: 'bar drain', id: `b-${id}` }, [
        el('i', { style: `animation-duration:${REVEAL_MS}ms` }),
      ]);
      card?.append(bar);
      timers.set(
        m.side + m.key,
        setTimeout(() => hide(m.side, m.key), REVEAL_MS),
      );
    }
  });
  send({ type: 'ready' });
})();
