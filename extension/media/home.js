// @ts-check
// EnvDrop sidebar: quick actions, env files + git protection, live links, guardrails.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { el, icon, logo, gitLogo, githubLogo, formatLeft, toggle, envChip } = window.EnvDropUI;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  let first = true;
  /** @type {{ node: HTMLElement, bar: HTMLElement, expiresAt: number, createdAt: number }[]} */
  let countdowns = [];

  const send = (/** @type {Record<string, unknown>} */ m) => vscode.postMessage(m);
  const enter = () => (first ? 'enter' : '');

  /** @param {string} status */
  function gitChip(status) {
    const g = gitLogo();
    switch (status) {
      case 'ignored':
        return el('span', { class: 'chip ok', title: 'Protected: git will ignore this file' }, [
          g,
          'gitignored',
        ]);
      case 'not-ignored':
        return el(
          'span',
          { class: 'chip warn', title: 'Not in .gitignore: `git add .` would stage it' },
          [g, 'not ignored'],
        );
      case 'tracked':
        return el('span', { class: 'chip err', title: 'Tracked by git: it will be committed' }, [
          g,
          'tracked!',
        ]);
      default:
        return el('span', { class: 'chip', title: 'Not inside a git repository' }, [
          icon('circle-slash'),
          'no repo',
        ]);
    }
  }

  /** @param {any} f */
  function fileCard(f) {
    const risky = f.ignore === 'not-ignored' || f.ignore === 'tracked';
    const stripe =
      f.ignore === 'tracked'
        ? 'stripe-err'
        : f.ignore === 'not-ignored'
          ? 'stripe-warn'
          : f.ignore === 'ignored'
            ? 'stripe-ok'
            : '';
    return el('div', { class: `card ${stripe} ${enter()}` }, [
      el('div', { class: 'row' }, [
        icon('file-code'),
        el('span', { class: 'title', title: f.rel, text: f.name }),
        envChip(f.env),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted', text: `${f.keyCount} keys` }),
      ]),
      f.rel !== f.name
        ? el('div', { class: 'muted mono', style: 'font-size:.85em', text: f.rel })
        : null,
      el('div', { class: 'row', style: 'margin-top:6px' }, [gitChip(f.ignore)]),
      el('div', { class: 'actions' }, [
        risky
          ? el(
              'button',
              {
                class: 'btn small',
                title: 'Add to .gitignore',
                on: { click: () => send({ type: 'fix', path: f.path }) },
              },
              [icon('shield'), 'Protect'],
            )
          : null,
        el(
          'button',
          {
            class: `btn small ${risky ? 'secondary' : ''}`,
            on: { click: () => send({ type: 'share', path: f.path }) },
          },
          [icon('cloud-upload'), 'Share'],
        ),
        f.hasExample
          ? el(
              'button',
              {
                class: 'btn small ghost',
                title: 'Compare with .env.example',
                on: { click: () => send({ type: 'checkKeys', path: f.path }) },
              },
              [icon('checklist'), 'Keys'],
            )
          : el(
              'button',
              {
                class: 'btn small ghost',
                title: 'Create .env.example (values stripped)',
                on: { click: () => send({ type: 'genExample', path: f.path }) },
              },
              [icon('new-file'), 'Example'],
            ),
        el(
          'button',
          {
            class: 'btn small ghost',
            title: 'Reveal in Explorer',
            'aria-label': 'Reveal in Explorer',
            on: { click: () => send({ type: 'reveal', path: f.path }) },
          },
          [icon('go-to-file')],
        ),
      ]),
    ]);
  }

  /** @param {any} l */
  function linkCard(l) {
    const left = el('span', { class: 'mono', text: formatLeft(l.expiresAt - Date.now()) });
    const fill = el('i', { style: `width:${pct(l)}%` });
    countdowns.push({ node: left, bar: fill, expiresAt: l.expiresAt, createdAt: l.createdAt });
    return el('div', { class: `card ${enter()}` }, [
      el('div', { class: 'row' }, [
        icon('link'),
        el('span', { class: 'title', text: l.fileName }),
        el('span', { class: 'spacer' }),
        icon('watch'),
        left,
      ]),
      el('div', {
        class: 'muted',
        style: 'font-size:.85em',
        text: `${l.host} · ${l.maxViews === 1 ? 'burns after 1 view' : `${l.maxViews} views max`}`,
      }),
      el('div', { class: 'bar' }, [fill]),
      el('div', { class: 'actions' }, [
        el(
          'button',
          { class: 'btn small danger', on: { click: () => send({ type: 'revoke', id: l.id }) } },
          [icon('circle-slash'), 'Revoke'],
        ),
      ]),
    ]);
  }

  /** @param {{expiresAt:number, createdAt:number}} l */
  function pct(l) {
    const total = l.expiresAt - l.createdAt;
    return total > 0 ? Math.max(0, Math.min(100, ((l.expiresAt - Date.now()) / total) * 100)) : 0;
  }

  /** @param {any} s */
  function render(s) {
    countdowns = [];
    const problems = s.files.filter(
      (/** @type {any} */ f) => f.ignore === 'not-ignored' || f.ignore === 'tracked',
    );
    const hero = el('div', { class: `hero ${enter()}` }, [
      logo(),
      el('div', {}, [
        el('h1', {}, [el('span', { class: 'grad-text', text: 'EnvDrop' })]),
        el('div', {
          class: 'tag',
          text: 'Share .env files end-to-end encrypted. Links expire and burn after reading.',
        }),
      ]),
    ]);
    const actions = el('div', { class: `grid2 ${enter()}` }, [
      el('button', { class: 'btn brand big', on: { click: () => send({ type: 'share' }) } }, [
        icon('cloud-upload'),
        'Share',
      ]),
      el('button', { class: 'btn secondary big', on: { click: () => send({ type: 'pull' }) } }, [
        icon('cloud-download'),
        'Pull',
      ]),
    ]);

    const filesSection = [
      el('h3', {}, [
        icon('files'),
        `Env files (${s.files.length})`,
        el('span', { class: 'spacer', style: 'flex:1' }),
        el(
          'button',
          {
            class: 'linklike',
            title: 'Refresh',
            'aria-label': 'Refresh',
            on: { click: () => send({ type: 'refresh' }) },
          },
          [icon('refresh')],
        ),
      ]),
      problems.length > 0
        ? el('div', { class: `card stripe-warn ${enter()}` }, [
            el('div', { class: 'row' }, [
              icon('warning'),
              el('strong', { text: `${problems.length} file(s) could be committed to git` }),
            ]),
            el('p', { class: 'muted', text: 'Click Protect to add them to .gitignore.' }),
          ])
        : null,
      ...(s.files.length
        ? s.files.map(fileCard)
        : [
            el('div', { class: 'empty' }, [
              icon('search'),
              s.hasWorkspace
                ? 'No .env files found in this workspace.'
                : 'Open a folder to see its env files.',
            ]),
          ]),
    ];

    const linksSection = [
      el('h3', {}, [icon('link'), `Active links (${s.links.length})`]),
      ...(s.links.length
        ? s.links.map(linkCard)
        : [
            el('div', { class: 'empty' }, [
              icon('send'),
              'Links you share appear here with a live countdown.',
            ]),
          ]),
    ];

    const enabled = toggle(
      'Warn when secrets are staged',
      s.guard.enabled,
      (/** @type {boolean} */ v) => send({ type: 'guard', key: 'enabled', value: v }),
    );
    const scan = toggle(
      'Scan staged file contents',
      s.guard.scanContent,
      (/** @type {boolean} */ v) => send({ type: 'guard', key: 'scanContent', value: v }),
    );
    const guardSection = [
      el('h3', {}, [icon('shield'), 'Guardrails']),
      el('div', { class: `card ${enter()}` }, [
        el('div', { class: 'row', style: 'gap:10px' }, [
          gitLogo(),
          el('strong', { text: 'Pre-commit warning' }),
        ]),
        !s.trusted
          ? el('p', {
              class: 'muted',
              text: 'Off in Restricted Mode (EnvDrop never runs git in untrusted workspaces).',
            })
          : null,
        el('div', { style: 'display:grid;gap:8px;margin-top:8px' }, [enabled.node, scan.node]),
      ]),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-top:8px' }, [
        icon('server'),
        ` Server: `,
        el('span', { class: 'mono', text: s.server }),
        ' · ',
        el('button', {
          class: 'linklike',
          text: 'Settings',
          on: { click: () => send({ type: 'settings' }) },
        }),
      ]),
    ];

    const brand = el('div', { class: 'brandbar' }, [
      el('button', { class: 'linklike', on: { click: () => send({ type: 'link', to: 'repo' }) } }, [
        githubLogo(),
        ' Star on GitHub',
      ]),
      el(
        'button',
        { class: 'linklike', on: { click: () => send({ type: 'link', to: 'issues' }) } },
        [icon('bug'), ' Report issue'],
      ),
      el(
        'button',
        { class: 'linklike', on: { click: () => send({ type: 'link', to: 'threat' }) } },
        [icon('law'), ' Threat model'],
      ),
    ]);

    app.replaceChildren(hero, actions, ...filesSection, ...linksSection, ...guardSection, brand);
    first = false;
  }

  setInterval(() => {
    for (const c of countdowns) {
      c.node.textContent = formatLeft(c.expiresAt - Date.now());
      c.bar.style.width = `${pct(c)}%`;
    }
    if (countdowns.some((c) => c.expiresAt <= Date.now())) send({ type: 'refresh' });
  }, 1000);

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'state') render(e.data);
  });
  app.append(el('div', { class: 'empty' }, [icon('loading', 'spin'), 'Loading…']));
  send({ type: 'ready' });
})();
