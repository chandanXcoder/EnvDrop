// @ts-check
// EnvDrop review webview. Values never arrive here unless the user clicks "Reveal",
// and revealed values are wiped after 10 seconds. All DOM writes use textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const REVEAL_MS = 10_000;
  /** @type {Map<string, number>} */
  const timers = new Map();
  let mask = '••••••••';

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node|string)[]} [kids] */
  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v !== undefined) e.setAttribute(k, String(v));
    }
    for (const kid of kids) e.append(kid);
    return e;
  }

  const cellId = (/** @type {string} */ side, /** @type {string} */ key) =>
    `v-${side}-${encodeURIComponent(key)}`;

  function hide(/** @type {string} */ side, /** @type {string} */ key) {
    const cell = document.getElementById(cellId(side, key));
    if (cell) cell.textContent = mask;
    const t = timers.get(side + key);
    if (t) clearTimeout(t);
    timers.delete(side + key);
  }

  /** @param {any} init */
  function render(init) {
    mask = init.mask;
    const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    for (const r of init.rows) counts[/** @type {keyof typeof counts} */ (r.status)]++;

    app.append(
      el('h1', {
        text: init.isNew ? `Create ${init.targetName}` : `Review changes to ${init.targetName}`,
      }),
      el('p', {
        class: 'meta',
        text: `From ${init.origin} · ${init.viewsLeft > 0 ? `${init.viewsLeft} view(s) left on the link` : 'the link is now burned'}`,
      }),
    );
    if (init.parseWarnings > 0) {
      app.append(
        el('p', {
          class: 'warn',
          text: `${init.parseWarnings} line(s) in the incoming file could not be parsed. They are kept as-is with "Replace whole file".`,
        }),
      );
    }
    if (!init.isNew) {
      app.append(
        el('div', { class: 'summary' }, [
          el('span', { class: 'pill status-added', text: `${counts.added} added` }),
          el('span', { class: 'pill status-changed', text: `${counts.changed} changed` }),
          el('span', { class: 'pill status-removed', text: `${counts.removed} only in local` }),
          el('span', { class: 'pill status-unchanged', text: `${counts.unchanged} unchanged` }),
        ]),
      );
    }

    const tbody = el('tbody');
    for (const r of init.rows) {
      if (r.status === 'unchanged') continue;
      const checked = r.status === 'added' || r.status === 'changed';
      const label =
        r.status === 'removed' ? 'remove from local' : r.status === 'added' ? 'add' : 'update';
      const cb = el('input', {
        type: 'checkbox',
        'data-key': r.key,
        'data-status': r.status,
        checked,
        'aria-label': `${label} ${r.key}`,
      });
      const side = r.status === 'removed' ? 'local' : 'incoming';
      const valCell = el('td', { class: 'val', id: cellId(side, r.key), text: mask });
      const reveal = el('button', {
        class: 'link',
        text: 'Reveal',
        title: 'Show this value for 10 seconds',
        on: { click: () => vscode.postMessage({ type: 'reveal', key: r.key, side }) },
      });
      tbody.append(
        el('tr', {}, [
          el('td', {}, [init.isNew ? '' : cb]),
          el('td', { class: 'key', text: r.key }),
          el('td', {
            class: `status-${r.status}`,
            text: r.status === 'removed' ? 'only in local' : r.status,
          }),
          valCell,
          el('td', {}, [reveal]),
        ]),
      );
    }
    app.append(
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: init.isNew ? '' : 'Apply' }),
            el('th', { text: 'Key' }),
            el('th', { text: 'Status' }),
            el('th', { text: 'Value' }),
            el('th'),
          ]),
        ]),
        tbody,
      ]),
    );
    if (counts.unchanged > 0 && !init.isNew) {
      app.append(
        el('p', { class: 'hint', text: `${counts.unchanged} unchanged key(s) not shown.` }),
      );
    }

    const backup = el('input', {
      type: 'checkbox',
      id: 'backup',
      checked: !init.isNew,
      disabled: init.isNew,
    });
    const selected = () =>
      /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[data-key]')]).filter(
        (c) => c.checked,
      );
    const actions = el('div', { class: 'actions' });
    if (init.isNew) {
      actions.append(
        el('button', {
          text: `Write ${init.targetName}`,
          on: {
            click: () => vscode.postMessage({ type: 'apply', mode: 'replace', backup: false }),
          },
        }),
      );
    } else {
      actions.append(
        el('button', {
          text: 'Apply selected',
          on: {
            click: () => {
              const sel = selected();
              vscode.postMessage({
                type: 'apply',
                mode: 'merge',
                apply: sel.filter((c) => c.dataset.status !== 'removed').map((c) => c.dataset.key),
                remove: sel.filter((c) => c.dataset.status === 'removed').map((c) => c.dataset.key),
                backup: /** @type {HTMLInputElement} */ (backup).checked,
              });
            },
          },
        }),
        el('button', {
          class: 'secondary',
          text: 'Replace whole file',
          on: {
            click: () =>
              vscode.postMessage({
                type: 'apply',
                mode: 'replace',
                backup: /** @type {HTMLInputElement} */ (backup).checked,
              }),
          },
        }),
        el('label', {}, [backup, ` Back up current file as ${init.targetName}.backup`]),
      );
    }
    actions.append(
      el('button', {
        class: 'secondary',
        text: 'Cancel',
        on: { click: () => vscode.postMessage({ type: 'cancel' }) },
      }),
    );
    app.append(actions);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m?.type === 'init') render(m);
    if (m?.type === 'revealed') {
      const cell = document.getElementById(cellId(m.side, m.key));
      if (!cell) return;
      hide(m.side, m.key);
      cell.textContent = m.value === '' ? '(empty)' : m.value;
      timers.set(
        m.side + m.key,
        setTimeout(() => hide(m.side, m.key), REVEAL_MS),
      );
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
