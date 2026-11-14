/**
 * WebDep Panel-Wide Motion System (Framer Motion)
 * Provides responsive spring physics and coordinated transitions for views,
 * cards, modals, toasts, tabs, mobile navigation, and interactive controls.
 */

import { animate, spring, stagger } from '../vendor/framer-motion/dom.js';

const SPRING_SNAPPY = {
  type: spring,
  stiffness: 430,
  damping: 32,
  mass: 0.78,
  reduceMotion: false,
};

const SPRING_GENTLE = {
  type: spring,
  stiffness: 360,
  damping: 30,
  mass: 0.82,
  reduceMotion: false,
};

const EASE_OUT = [0.22, 1, 0.36, 1];
const EASE_EXIT = [0.4, 0, 1, 1];

const elementAnims = new WeakMap();
const modalState = new WeakMap();
const drawerState = new WeakMap();
const numericState = new WeakMap();
const barState = new WeakMap();

let pendingViewStagger = null;
let lastStaggerTs = 0;
let appRevealed = false;
let globalInteractionsBound = false;

function stopTrackedAnims(el) {
  const list = elementAnims.get(el);
  if (!list || !list.length) return;
  for (const ctrl of list) {
    try {
      ctrl.stop();
    } catch (_) {}
  }
  elementAnims.set(el, []);
}

function trackAnim(el, ctrl) {
  if (!el || !ctrl) return ctrl;
  let list = elementAnims.get(el);
  if (!list) {
    list = [];
    elementAnims.set(el, list);
  }
  list.push(ctrl);
  return ctrl;
}

function afterFinished(ctrl) {
  const finished = ctrl?.finished;
  if (typeof finished?.then === 'function') {
    return finished.catch(() => {});
  }
  return Promise.resolve();
}

function clearInlineStyles(elements, props) {
  for (const el of elements) {
    for (const prop of props) {
      if (el.style[prop]) el.style[prop] = '';
    }
  }
}

function clearStylesWhenDone(ctrl, el, props = ['transform', 'opacity', 'filter']) {
  if (!ctrl || !el) return;
  void afterFinished(ctrl)
    .then(() => clearInlineStyles([el], props))
    .catch(() => {});
}

function resolveElement(target) {
  if (!target) return null;
  if (typeof target === 'string') return document.getElementById(target);
  return target;
}

/**
 * Reveal the authenticated application chrome once after login.
 */
export function animateAppReveal({ crossfade = false } = {}) {
  if (appRevealed) return;
  appRevealed = true;

  const appEl = document.getElementById('app');
  const sidebar = document.querySelector('#app .sidebar');
  const header = document.querySelector('#app .top-header');

  if (appEl && crossfade) {
    stopTrackedAnims(appEl);
    appEl.style.opacity = '0';
    const appCtrl = trackAnim(
      appEl,
      animate(
        appEl,
        { opacity: [0, 1], scale: [0.986, 1] },
        { duration: 0.72, delay: 0.18, ease: EASE_OUT, reduceMotion: false },
      ),
    );
    clearStylesWhenDone(appCtrl, appEl, ['transform', 'opacity']);
  }

  if (sidebar) {
    stopTrackedAnims(sidebar);
    const ctrl = trackAnim(
      sidebar,
      animate(
        sidebar,
        { opacity: [0, 1], x: [crossfade ? -20 : -14, 0] },
        {
          duration: crossfade ? 0.58 : 0.28,
          delay: crossfade ? 0.26 : 0,
          ease: EASE_OUT,
          reduceMotion: false,
        },
      ),
    );
    clearStylesWhenDone(ctrl, sidebar, ['transform', 'opacity']);
  }

  if (header) {
    stopTrackedAnims(header);
    const ctrl = trackAnim(
      header,
      animate(
        header,
        { opacity: [0, 1], y: [crossfade ? -14 : -10, 0] },
        {
          duration: crossfade ? 0.54 : 0.26,
          delay: crossfade ? 0.32 : 0.04,
          ease: EASE_OUT,
          reduceMotion: false,
        },
      ),
    );
    clearStylesWhenDone(ctrl, header, ['transform', 'opacity']);
  }
}

export function resetAppRevealFlag() {
  appRevealed = false;
  for (const id of ['stat-cpu-pct', 'stat-mem-pct', 'stat-disk-free']) {
    const el = document.getElementById(id);
    if (el) numericState.delete(el);
  }
  for (const id of ['stat-cpu-bar', 'stat-mem-bar', 'stat-disk-bar']) {
    const bar = document.getElementById(id);
    if (bar) {
      barState.delete(bar);
      bar.style.width = '0%';
    }
  }
}

/**
 * Mark a view name so its async card/section renderer runs an entrance stagger
 * on the upcoming render pass (without re-triggering on 4.5s background polls).
 */
export function markViewStaggerPending(viewName) {
  pendingViewStagger = viewName || null;
  lastStaggerTs = Date.now();
}

export function consumePendingViewStagger(viewName) {
  if (!pendingViewStagger || pendingViewStagger !== viewName) return false;
  pendingViewStagger = null;
  // Expire stale flags after 4s just in case a view had no cards to consume it
  return Date.now() - lastStaggerTs < 4000;
}

/**
 * Smooth entrance when switching top-level dashboard views.
 */
export function animateViewEnter(sectionEl) {
  const el = resolveElement(sectionEl);
  if (!el) return;
  stopTrackedAnims(el);

  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: [0, 1], y: [10, 0] },
      { duration: 0.22, ease: EASE_OUT, reduceMotion: false },
    ),
  );
  clearStylesWhenDone(ctrl, el, ['transform', 'opacity']);
}

/**
 * Subtle slide-down reveal for the project/database workspace context banner.
 */
export function animateWorkspaceBanner(bannerEl) {
  const el = resolveElement(bannerEl);
  if (!el) return;
  stopTrackedAnims(el);

  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: [0, 1], y: [8, 0] },
      { ...SPRING_GENTLE },
    ),
  );
  clearStylesWhenDone(ctrl, el, ['transform', 'opacity']);
}

/**
 * Stagger a collection of cards or dashboard sections cleanly without dragging
 * out large grids.
 */
export function staggerElements(elements, options = {}) {
  const items = Array.from(elements || []).filter((el) => el instanceof HTMLElement);
  if (!items.length) return;

  const yOffset = typeof options.y === 'number' ? options.y : 12;
  const step = Math.min(0.032, 0.2 / Math.max(items.length, 1));

  for (const item of items) {
    stopTrackedAnims(item);
  }

  const ctrl = animate(
    items,
    { opacity: [0, 1], y: [yOffset, 0], scale: [0.985, 1] },
    {
      ...SPRING_GENTLE,
      delay: stagger(step, { startDelay: options.startDelay || 0.02 }),
    },
  );

  for (const item of items) {
    trackAnim(item, ctrl);
  }

  void afterFinished(ctrl)
    .then(() => clearInlineStyles(items, ['transform', 'opacity']))
    .catch(() => {});
}

/**
 * Open a modal overlay + container with spring scale/rise physics.
 */
export function animateModalOpen(modalTarget) {
  const overlay = resolveElement(modalTarget);
  if (!overlay) return;

  const entry = modalState.get(overlay) || { token: 0, ctrls: [] };
  entry.token += 1;
  const myToken = entry.token;
  for (const c of entry.ctrls) {
    try {
      c.stop();
    } catch (_) {}
  }
  entry.ctrls = [];
  modalState.set(overlay, entry);

  const container = overlay.querySelector('.modal-container');
  overlay.style.opacity = '';
  if (container) {
    container.style.opacity = '';
    container.style.transform = '';
  }

  overlay.classList.add('active');

  const overlayCtrl = animate(
    overlay,
    { opacity: [0, 1] },
    { duration: 0.18, ease: EASE_OUT, reduceMotion: false },
  );
  entry.ctrls.push(overlayCtrl);

  if (container) {
    const boxCtrl = animate(
      container,
      { opacity: [0, 1], y: [14, 0], scale: [0.965, 1] },
      SPRING_SNAPPY,
    );
    entry.ctrls.push(boxCtrl);
    void afterFinished(boxCtrl)
      .then(() => {
        const latest = modalState.get(overlay);
        if (latest && latest.token === myToken) {
          overlay.style.opacity = '';
          container.style.opacity = '';
          container.style.transform = '';
        }
      })
      .catch(() => {});
  }
}

/**
 * Smoothly exit a modal overlay + container before removing `.active`.
 */
export function animateModalClose(modalTarget) {
  const overlay = resolveElement(modalTarget);
  if (!overlay || !overlay.classList.contains('active')) return;

  const entry = modalState.get(overlay) || { token: 0, ctrls: [] };
  entry.token += 1;
  const myToken = entry.token;
  for (const c of entry.ctrls) {
    try {
      c.stop();
    } catch (_) {}
  }
  entry.ctrls = [];
  modalState.set(overlay, entry);

  const container = overlay.querySelector('.modal-container');
  const overlayCtrl = animate(
    overlay,
    { opacity: [1, 0] },
    { duration: 0.15, ease: EASE_EXIT, reduceMotion: false },
  );
  entry.ctrls.push(overlayCtrl);

  let boxCtrl = null;
  if (container) {
    boxCtrl = animate(
      container,
      { opacity: [1, 0], y: [0, 10], scale: [1, 0.972] },
      { duration: 0.15, ease: EASE_EXIT, reduceMotion: false },
    );
    entry.ctrls.push(boxCtrl);
  }

  void Promise.all([afterFinished(overlayCtrl), afterFinished(boxCtrl)])
    .then(() => {
      const latest = modalState.get(overlay);
      if (latest && latest.token !== myToken) return;
      overlay.classList.remove('active');
      overlay.style.opacity = '';
      if (container) {
        container.style.opacity = '';
        container.style.transform = '';
      }
    })
    .catch(() => {});
}

/**
 * Smooth fade+slide for switched tab panes (e.g., Security modal tabs).
 */
export function animateTabPane(paneEl) {
  const el = resolveElement(paneEl);
  if (!el) return;
  stopTrackedAnims(el);

  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: [0, 1], y: [6, 0] },
      { duration: 0.18, ease: EASE_OUT, reduceMotion: false },
    ),
  );
  clearStylesWhenDone(ctrl, el, ['transform', 'opacity']);
}

/**
 * Toast entrance + exit choreography.
 */
export function animateToastEnter(toastEl) {
  const el = resolveElement(toastEl);
  if (!el) return;
  stopTrackedAnims(el);

  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: [0, 1], y: [14, 0], scale: [0.95, 1] },
      SPRING_SNAPPY,
    ),
  );
  clearStylesWhenDone(ctrl, el, ['transform', 'opacity']);
}

export function animateToastExit(toastEl) {
  const el = resolveElement(toastEl);
  if (!el || !el.isConnected) return;
  if (el.dataset.exiting === '1') return;
  el.dataset.exiting = '1';

  stopTrackedAnims(el);
  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: 0, x: 20, scale: 0.96 },
      { duration: 0.18, ease: EASE_EXIT, reduceMotion: false },
    ),
  );

  let removed = false;
  const finishRemove = () => {
    if (removed) return;
    removed = true;
    el.remove();
  };

  if (typeof ctrl?.finished?.then === 'function') {
    void ctrl.finished.then(finishRemove, finishRemove);
  }
  setTimeout(finishRemove, 260);
}

/**
 * Mobile drawer slide + backdrop fade.
 */
export function animateMobileDrawer(sidebarEl, backdropEl, shouldOpen) {
  if (!sidebarEl || !backdropEl) return;

  const prev = drawerState.get(sidebarEl) || { token: 0, ctrls: [] };
  prev.token += 1;
  const myToken = prev.token;
  for (const c of prev.ctrls) {
    try {
      c.stop();
    } catch (_) {}
  }
  prev.ctrls = [];
  drawerState.set(sidebarEl, prev);

  if (shouldOpen) {
    sidebarEl.classList.add('mobile-open');
    backdropEl.classList.add('active');
    const sCtrl = animate(
      sidebarEl,
      { x: [-240, 0] },
      { ...SPRING_GENTLE },
    );
    const bCtrl = animate(
      backdropEl,
      { opacity: [0, 1] },
      { duration: 0.2, ease: EASE_OUT, reduceMotion: false },
    );
    prev.ctrls.push(sCtrl, bCtrl);
    void afterFinished(sCtrl)
      .then(() => {
        const latest = drawerState.get(sidebarEl);
        if (latest && latest.token === myToken) {
          sidebarEl.style.transform = '';
          backdropEl.style.opacity = '';
        }
      })
      .catch(() => {});
    return;
  }

  const sCtrl = animate(
    sidebarEl,
    { x: [0, -240] },
    { duration: 0.18, ease: EASE_EXIT, reduceMotion: false },
  );
  const bCtrl = animate(
    backdropEl,
    { opacity: [1, 0] },
    { duration: 0.18, ease: EASE_EXIT, reduceMotion: false },
  );
  prev.ctrls.push(sCtrl, bCtrl);

  void Promise.all([afterFinished(sCtrl), afterFinished(bCtrl)])
    .then(() => {
      const latest = drawerState.get(sidebarEl);
      if (latest && latest.token !== myToken) return;
      sidebarEl.classList.remove('mobile-open');
      backdropEl.classList.remove('active');
      sidebarEl.style.transform = '';
      backdropEl.style.opacity = '';
    })
    .catch(() => {});
}

/**
 * Delegated tactile spring press feedback for buttons, nav items, tabs, pills,
 * pagination controls, and theme swatches (works on dynamically rendered DOM).
 */
export function initGlobalMotionInteractions() {
  if (globalInteractionsBound) return;
  globalInteractionsBound = true;

  const PRESS_SELECTOR =
    '.btn:not(:disabled), .nav-item:not(:disabled), .workspace-tab:not(:disabled), .modal-tab-btn:not(:disabled), .pill:not(:disabled), .theme-swatch-card:not(:disabled)';

  let activePressed = null;

  const releasePressed = () => {
    if (!activePressed) return;
    const el = activePressed;
    activePressed = null;
    if (!el.isConnected) return;
    const ctrl = animate(
      el,
      { scale: 1 },
      { type: spring, stiffness: 520, damping: 28, mass: 0.65, reduceMotion: false },
    );
    clearStylesWhenDone(ctrl, el, ['transform']);
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target.closest(PRESS_SELECTOR) : null;
      if (!target || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') {
        return;
      }
      if (activePressed && activePressed !== target) {
        releasePressed();
      }
      activePressed = target;
      animate(
        target,
        { scale: 0.972 },
        { duration: 0.08, ease: EASE_OUT, reduceMotion: false },
      );
    },
    { passive: true },
  );

  window.addEventListener('pointerup', releasePressed, { passive: true });
  window.addEventListener('pointercancel', releasePressed, { passive: true });
  window.addEventListener('blur', releasePressed, { passive: true });
}

/**
 * Smoothly interpolates displayed numeric metric text (CPU %, RAM %, Disk GB)
 * while skipping unchanged background poll values.
 */
export function animateNumberValue(elTarget, toValue, formatFn) {
  const el = resolveElement(elTarget);
  if (!el || !Number.isFinite(toValue) || typeof formatFn !== 'function') return;

  const entry = numericState.get(el) || { val: 0, initialized: false, ctrl: null };
  if (entry.initialized && Math.abs(entry.val - toValue) < 0.001) {
    el.textContent = formatFn(toValue);
    return;
  }

  const fromVal = entry.initialized ? entry.val : 0;
  if (entry.ctrl) {
    try {
      entry.ctrl.stop();
    } catch (_) {}
  }

  entry.val = toValue;
  entry.initialized = true;
  entry.ctrl = animate(fromVal, toValue, {
    duration: 0.48,
    ease: EASE_OUT,
    reduceMotion: false,
    onUpdate: (latest) => {
      if (el.isConnected) el.textContent = formatFn(latest);
    },
    onComplete: () => {
      if (el.isConnected) el.textContent = formatFn(toValue);
    },
  });
  numericState.set(el, entry);
}

/**
 * Spring-animates progress meter fills without fighting CSS color transitions.
 */
export function animateProgressBar(barTarget, pct) {
  const el = resolveElement(barTarget);
  if (!el) return;
  const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
  const targetWidth = `${clamped}%`;
  const prev = barState.get(el);
  const canAnimate =
    el.isConnected
    && document.visibilityState !== 'hidden'
    && el.getClientRects().length > 0;

  if (prev && prev.val === clamped) {
    if (prev.active && canAnimate) return;
    if (el.style.width !== targetWidth) {
      el.style.width = targetWidth;
    }
    return;
  }

  if (prev?.ctrl) {
    try {
      prev.ctrl.stop();
    } catch (_) {}
  }

  if (!canAnimate) {
    el.style.width = targetWidth;
    barState.set(el, { val: clamped, ctrl: null, active: false });
    return;
  }

  const entry = { val: clamped, ctrl: null, active: true };
  barState.set(el, entry);
  const ctrl = animate(
    el,
    { width: targetWidth },
    { type: spring, stiffness: 260, damping: 28, mass: 0.85, reduceMotion: false },
  );
  entry.ctrl = ctrl;

  void afterFinished(ctrl).then(() => {
    const cur = barState.get(el);
    if (cur === entry) {
      entry.active = false;
      if (el.isConnected && el.style.width !== targetWidth) {
        el.style.width = targetWidth;
      }
    }
  });
}

/**
 * Staggers Overview resource breakdown table rows smoothly on enter/filter.
 */
export function animateTableRowsStagger(tbodyTarget) {
  const tbody = resolveElement(tbodyTarget);
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr')).filter((el) => el instanceof HTMLElement);
  if (!rows.length) return;

  const step = Math.min(0.024, 0.16 / Math.max(rows.length, 1));
  for (const row of rows) {
    stopTrackedAnims(row);
  }

  const ctrl = animate(
    rows,
    { opacity: [0, 1], y: [8, 0] },
    {
      duration: 0.24,
      ease: EASE_OUT,
      delay: stagger(step, { startDelay: 0.015 }),
      reduceMotion: false,
    },
  );

  for (const row of rows) {
    trackAnim(row, ctrl);
  }
  void afterFinished(ctrl)
    .then(() => clearInlineStyles(rows, ['opacity', 'transform']))
    .catch(() => {});
}

/**
 * Subtle reveal when a conditional card (like Active Deployment) appears.
 */
export function animateSectionShow(target) {
  const el = resolveElement(target);
  if (!el) return;
  stopTrackedAnims(el);
  const ctrl = trackAnim(
    el,
    animate(
      el,
      { opacity: [0, 1], y: [-8, 0], scale: [0.99, 1] },
      SPRING_GENTLE,
    ),
  );
  clearStylesWhenDone(ctrl, el, ['transform', 'opacity']);
}

/**
 * Coordinated Framer Motion entrance across Overview stats, cards, summary
 * cells, and workload table rows on initial/navigated Overview render.
 */
export function animateOverviewReveal() {
  const view = document.getElementById('view-overview');
  if (!view) return;

  const statCards = view.querySelectorAll('.overview-stats-grid .stat-card');
  if (statCards.length) {
    staggerElements(statCards, { y: 14, startDelay: 0.02 });
  }

  const cards = Array.from(view.querySelectorAll('.card')).filter(
    (c) => getComputedStyle(c).display !== 'none',
  );
  if (cards.length) {
    staggerElements(cards, { y: 16, startDelay: 0.08 });
  }

  const summaryItems = view.querySelectorAll('.resource-summary-bar .res-summary-item');
  if (summaryItems.length) {
    staggerElements(summaryItems, { y: 8, startDelay: 0.12 });
  }

  const tbody = document.getElementById('resource-breakdown-table');
  if (tbody) {
    animateTableRowsStagger(tbody);
  }
}
