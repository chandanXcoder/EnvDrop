// @ts-check
// Shared helpers for EnvDrop webviews. All DOM writes go through textContent or
// createElementNS. innerHTML is never used, so keys/values can't inject markup.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node|string|null|undefined|false)[]} [kids] */
  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = String(v);
      else if (k === 'class') e.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'style')
        e.style.cssText = v; // CSSOM: allowed by our CSP, unlike style=""
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
    for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  }

  /** @param {string} tag @param {Record<string, string|number>} [attrs] @param {Element[]} [kids] */
  function svg(tag, attrs = {}, kids = []) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    for (const kid of kids) e.append(kid);
    return e;
  }

  /** Codicon span. @param {string} name @param {string} [extra] */
  const icon = (name, extra = '') =>
    el('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });

  let gradId = 0;
  /** EnvDrop logo: a drop with a keyhole. */
  function logo(cls = 'logo') {
    const id = `edg${gradId++}`;
    return svg('svg', { viewBox: '0 0 24 24', class: cls, role: 'img', 'aria-label': 'EnvDrop' }, [
      svg('defs', {}, [
        svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, [
          svg('stop', { offset: '0', 'stop-color': '#7c5cff' }),
          svg('stop', { offset: '1', 'stop-color': '#22d3ee' }),
        ]),
      ]),
      svg('path', {
        d: 'M12 1.8C11.6 2.3 4.6 10 4.6 14.7a7.4 7.4 0 0 0 14.8 0C19.4 10 12.4 2.3 12 1.8z',
        fill: `url(#${id})`,
      }),
      svg('circle', { cx: '12', cy: '13.4', r: '2', fill: '#fff' }),
      svg('path', { d: 'M11 14.6h2l.7 3.6h-3.4z', fill: '#fff' }),
    ]);
  }

  /** Git logo mark (Git Logo by Jason Long, CC BY 3.0). */
  function gitLogo() {
    return svg('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-label': 'Git' }, [
      svg('path', {
        fill: '#F05032',
        d: 'M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187',
      }),
    ]);
  }

  /** GitHub mark (Octicons, MIT). Used only to link to the project's GitHub repository. */
  function githubLogo() {
    return svg('svg', { viewBox: '0 0 16 16', class: 'gh', role: 'img', 'aria-label': 'GitHub' }, [
      svg('path', {
        d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z',
      }),
    ]);
  }

  /** Animated number counter. @param {HTMLElement} node @param {number} to */
  function countUp(node, to, ms = 600) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || to === 0) {
      node.textContent = String(to);
      return;
    }
    const start = performance.now();
    const step = (/** @type {number} */ t) => {
      const p = Math.min(1, (t - start) / ms);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** "12m 04s" / "3h 10m" / "expired" @param {number} ms */
  function formatLeft(ms) {
    if (ms <= 0) return 'expired';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  /** @param {string} text */
  function toast(text) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = el('div', { class: 'toast', role: 'status', text });
    document.body.append(t);
    setTimeout(() => t.remove(), 2300);
  }

  /** Accessible toggle switch. @param {string} label @param {boolean} checked @param {(v:boolean)=>void} onChange */
  function toggle(label, checked, onChange) {
    const input = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', checked }));
    input.addEventListener('change', () => onChange(input.checked));
    return {
      node: el('label', { class: 'switch' }, [
        input,
        el('span', { class: 'track' }),
        el('span', { text: label }),
      ]),
      input,
    };
  }

  const ENV_LABEL = /** @type {Record<string,string>} */ ({
    base: 'default',
    local: 'local',
    development: 'dev',
    staging: 'staging',
    production: 'prod',
    test: 'test',
  });
  /** @param {string} env */
  const envChip = (env) => el('span', { class: `chip env-${env}`, text: ENV_LABEL[env] ?? env });

  // @ts-ignore
  window.EnvDropUI = {
    el,
    svg,
    icon,
    logo,
    gitLogo,
    githubLogo,
    countUp,
    formatLeft,
    toast,
    toggle,
    envChip,
  };
})();
