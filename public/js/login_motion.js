/**
 * WebDep Login Intro & Sign-In Choreography (Framer Motion)
 * Orchestrates the pure logo + "Hello." -> "Welcome to WebDep" -> Sign-In transition.
 */

import {
  animate,
  createScopedAnimate,
  hover,
  press,
  spring,
  stagger,
} from '../vendor/framer-motion/dom.js';

let activeControls = [];
let activeTimers = [];
let activeCleanups = [];
let buttonGesturesBound = false;
let loginExitToken = 0;

function trackControl(ctrl) {
  if (ctrl) activeControls.push(ctrl);
  return ctrl;
}

function trackTimer(fn, ms) {
  const id = setTimeout(fn, ms);
  activeTimers.push(id);
  return id;
}

function clearPlayback() {
  for (const id of activeTimers) {
    clearTimeout(id);
  }
  activeTimers = [];

  for (const ctrl of activeControls) {
    try {
      ctrl.stop();
    } catch (_) {}
  }
  activeControls = [];

  for (const fn of activeCleanups) {
    try {
      fn();
    } catch (_) {}
  }
  activeCleanups = [];
}

function getCardStaggerTargets(loginView) {
  return Array.from(
    loginView.querySelectorAll(
      '.login-card-header, #login-form .form-group, #login-btn, #login-passkey-wrap',
    ),
  );
}

function resetLoginNodes(loginView) {
  const intro = loginView.querySelector('#login-intro');
  const halo = loginView.querySelector('#login-intro-halo');
  const emblem = loginView.querySelector('#login-intro-emblem');
  const progressBar = loginView.querySelector('#login-intro-progress');
  const progressFill = loginView.querySelector('#login-intro-progress-fill');
  const helloBeat = loginView.querySelector('#login-greeting-hello');
  const welcomeBeat = loginView.querySelector('#login-greeting-welcome');
  const skipBtn = loginView.querySelector('#login-intro-skip');
  const cardContainer = loginView.querySelector('#login-card-container');
  const cardItems = getCardStaggerTargets(loginView);

  if (intro) {
    intro.style.opacity = '1';
    intro.style.visibility = 'visible';
    intro.style.pointerEvents = 'auto';
    intro.style.transform = '';
    intro.style.filter = '';
  }
  if (halo) {
    halo.style.opacity = '0';
    halo.style.transform = 'scale(0.76)';
  }
  if (emblem) {
    emblem.style.opacity = '0';
    emblem.style.transform = 'translateY(18px) scale(0.82)';
    emblem.style.filter = 'blur(14px)';
  }
  if (progressBar) {
    progressBar.style.opacity = '0';
    progressBar.style.transform = 'translateY(8px)';
  }
  if (progressFill) {
    progressFill.style.transform = 'scaleX(0)';
  }
  if (helloBeat) {
    helloBeat.style.opacity = '0';
    helloBeat.style.transform = 'translateY(22px) scale(0.96)';
    helloBeat.style.filter = 'blur(10px)';
  }
  if (welcomeBeat) {
    welcomeBeat.style.opacity = '0';
    welcomeBeat.style.transform = 'translateY(22px) scale(0.96)';
    welcomeBeat.style.filter = 'blur(10px)';
    welcomeBeat.querySelectorAll('.login-greeting-eyebrow, .login-greeting-display, .login-greeting-sub')
      .forEach((child) => {
        child.style.transform = 'translateY(12px)';
      });
  }
  if (skipBtn) {
    skipBtn.style.opacity = '0';
    skipBtn.style.transform = 'translateY(10px)';
  }
  if (cardContainer) {
    cardContainer.style.opacity = '0';
    cardContainer.style.pointerEvents = 'none';
    cardContainer.style.transform = 'translateY(28px) scale(0.96)';
    cardContainer.style.filter = 'blur(8px)';
  }
  for (const item of cardItems) {
    item.style.opacity = '0';
    item.style.transform = 'translateY(14px)';
  }
}

function revealLoginCard(loginView, scopedMotion, quickSkip = false) {
  const intro = loginView.querySelector('#login-intro');
  const cardContainer = loginView.querySelector('#login-card-container');
  const cardItems = getCardStaggerTargets(loginView);

  if (intro) {
    intro.style.pointerEvents = 'none';
    if (quickSkip) {
      const introExit = trackControl(
        scopedMotion(
          intro,
          { opacity: 0, scale: 0.94, y: -16, filter: 'blur(10px)' },
          { duration: 0.38, ease: [0.4, 0, 0.2, 1] },
        ),
      );
      introExit.finished.then(() => {
        intro.style.visibility = 'hidden';
      }).catch(() => {});
    } else {
      intro.style.visibility = 'hidden';
    }
  }

  if (!cardContainer) return;

  cardContainer.style.pointerEvents = 'auto';
  trackControl(
    animate(
      cardContainer,
      {
        opacity: [0, 1],
        y: [quickSkip ? 20 : 28, 0],
        scale: [0.96, 1],
        filter: ['blur(8px)', 'blur(0px)'],
      },
      {
        type: 'spring',
        stiffness: 165,
        damping: 24,
        mass: 0.92,
        reduceMotion: false,
      },
    ),
  );

  if (cardItems.length > 0) {
    trackControl(
      animate(
        cardItems,
        {
          opacity: [0, 1],
          y: [14, 0],
        },
        {
          delay: stagger(quickSkip ? 0.045 : 0.065, { startDelay: quickSkip ? 0.05 : 0.09 }),
          duration: 0.55,
          ease: [0.22, 1, 0.36, 1],
          reduceMotion: false,
        },
      ),
    );
  }

  trackTimer(() => {
    const userInput = document.getElementById('login-username');
    if (userInput && !userInput.value && loginView.style.display === 'flex') {
      try {
        userInput.focus({ preventScroll: true });
      } catch (_) {}
    }
  }, quickSkip ? 320 : 520);
}

/**
 * Plays the Framer Motion pure logo + "Hello." -> "Welcome to WebDep" -> Sign-In sequence.
 * Pass `{ immediate: true }` to smoothly jump straight to the sign-in card.
 */
export function playLoginWelcomeSequence(loginView, { immediate = false } = {}) {
  if (!loginView) return;
  stopLoginMotion();
  bindLoginButtonMotion();
  resetLoginNodes(loginView);

  const scopedMotion = createScopedAnimate({
    scope: { current: loginView, animations: [] },
    reduceMotion: false,
  });

  if (immediate) {
    revealLoginCard(loginView, scopedMotion, true);
    return;
  }

  const intro = loginView.querySelector('#login-intro');
  const skipBtn = loginView.querySelector('#login-intro-skip');

  const sequence = [
    // Ambient glow + floating transparent logo mark entrance
    ['.login-glow-top', { opacity: [0, 0.9], scale: [0.88, 1] }, { at: 0, duration: 1.0, ease: [0.22, 1, 0.36, 1] }],
    ['#login-intro-halo', { opacity: [0, 0.8], scale: [0.76, 1.05] }, { at: 0, duration: 1.15, ease: [0.22, 1, 0.36, 1] }],
    ['#login-intro-emblem', { opacity: [0, 1], y: [18, 0], scale: [0.82, 1], filter: ['blur(14px)', 'blur(0px)'] }, { at: 0.06, type: spring, stiffness: 170, damping: 21, mass: 0.95 }],

    // Minimal hairline progress sweep + skip cue
    ['#login-intro-progress', { opacity: [0, 1], y: [8, 0] }, { at: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }],
    ['#login-intro-progress-fill', { scaleX: [0, 1] }, { at: 0.35, duration: 4.7, ease: [0.45, 0.05, 0.55, 0.95] }],
    ['#login-intro-skip', { opacity: [0, 0.72], y: [10, 0] }, { at: 0.85, duration: 0.45, ease: [0.22, 1, 0.36, 1] }],

    // Beat 1: "Hello."
    ['#login-greeting-hello', { opacity: [0, 1], y: [22, 0], scale: [0.96, 1], filter: ['blur(10px)', 'blur(0px)'] }, { at: 0.42, duration: 0.75, ease: [0.22, 1, 0.36, 1] }],
    ['#login-greeting-hello', { opacity: [1, 0], y: [0, -18], scale: [1, 0.97], filter: ['blur(0px)', 'blur(8px)'] }, { at: 2.25, duration: 0.55, ease: [0.4, 0, 0.2, 1] }],

    // Beat 2: "Welcome to WebDep"
    ['#login-greeting-welcome', { opacity: [0, 1], y: [22, 0], scale: [0.96, 1], filter: ['blur(10px)', 'blur(0px)'] }, { at: 2.55, duration: 0.8, ease: [0.22, 1, 0.36, 1] }],
    [
      '#login-greeting-welcome .login-greeting-eyebrow, #login-greeting-welcome .login-greeting-display, #login-greeting-welcome .login-greeting-sub',
      { y: [12, 0] },
      { at: 2.55, delay: stagger(0.09), duration: 0.65, ease: [0.22, 1, 0.36, 1] },
    ],

    // Subtle breath when hairline completes, then seamless exit into Login Card
    ['#login-intro-emblem', { scale: [1, 1.04, 1] }, { at: 4.95, duration: 0.42, ease: 'easeInOut' }],
    ['#login-intro-skip, #login-intro-progress', { opacity: 0, y: 8 }, { at: 5.15, duration: 0.35, ease: [0.4, 0, 0.2, 1] }],
    ['#login-intro-halo', { opacity: 0, scale: 0.88 }, { at: 5.2, duration: 0.7, ease: [0.4, 0, 0.2, 1] }],
    ['#login-intro-emblem, #login-intro-stage', { opacity: 0, scale: 0.94, y: -18, filter: 'blur(10px)' }, { at: 5.22, duration: 0.7, ease: [0.4, 0, 0.2, 1] }],
  ];

  const mainTimeline = trackControl(scopedMotion(sequence));

  trackTimer(() => {
    revealLoginCard(loginView, scopedMotion, false);
  }, 5550);

  let skipped = false;
  const triggerSkip = (e) => {
    if (skipped) return;
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    skipped = true;
    clearPlayback();
    revealLoginCard(loginView, scopedMotion, true);
  };

  const onKeyDown = (e) => {
    if (loginView.style.display !== 'flex') return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      if (intro && intro.style.visibility !== 'hidden') {
        e.preventDefault();
        triggerSkip();
      }
    }
  };

  skipBtn?.addEventListener('click', triggerSkip, { once: true });
  intro?.addEventListener('click', triggerSkip, { once: true });
  document.addEventListener('keydown', onKeyDown);

  activeCleanups.push(() => {
    skipBtn?.removeEventListener('click', triggerSkip);
    intro?.removeEventListener('click', triggerSkip);
    document.removeEventListener('keydown', onKeyDown);
  });

  mainTimeline.finished.then(() => {
    document.removeEventListener('keydown', onKeyDown);
  }).catch(() => {});
}

/**
 * Stops all active Framer Motion splash animations and clears listeners.
 */
export function stopLoginMotion() {
  loginExitToken += 1;
  clearPlayback();
}

/**
 * Smoothly dissolves the login screen into the authenticated dashboard.
 */
export function animateLoginToDashboard(loginView) {
  if (!loginView || loginView.style.display === 'none') {
    return Promise.resolve();
  }

  stopLoginMotion();
  const myToken = loginExitToken;

  loginView.style.pointerEvents = 'none';
  const cardContainer = loginView.querySelector('#login-card-container');
  const intro = loginView.querySelector('#login-intro');

  if (intro && intro.style.visibility !== 'hidden') {
    trackControl(
      animate(
        intro,
        { opacity: 0, scale: 0.96 },
        { duration: 0.25, ease: [0.4, 0, 0.2, 1], reduceMotion: false },
      ),
    );
  }

  const anims = [];
  if (cardContainer && Number(getComputedStyle(cardContainer).opacity) > 0.02) {
    anims.push(
      trackControl(
        animate(
          cardContainer,
          {
            opacity: [Number(getComputedStyle(cardContainer).opacity) || 1, 0],
            y: [0, -14],
            scale: [1, 0.955],
            filter: ['blur(0px)', 'blur(8px)'],
          },
          {
            duration: 0.42,
            ease: [0.4, 0, 0.2, 1],
            reduceMotion: false,
          },
        ),
      ),
    );
  }

  const overlayExit = trackControl(
    animate(
      loginView,
      {
        opacity: [1, 0],
        scale: [1, 1.018],
      },
      {
        delay: 0.18,
        duration: 0.7,
        ease: [0.22, 1, 0.36, 1],
        reduceMotion: false,
      },
    ),
  );
  anims.push(overlayExit);

  return Promise.all(
    anims.map((ctrl) => ctrl?.finished?.catch(() => {}) || Promise.resolve()),
  ).then(() => {
    if (loginExitToken !== myToken) return;
    loginView.style.display = 'none';
    loginView.style.opacity = '';
    loginView.style.transform = '';
    loginView.style.pointerEvents = '';
    if (intro) {
      intro.style.visibility = 'hidden';
      intro.style.opacity = '';
      intro.style.transform = '';
    }
  });
}

/**
 * Smoothly reveals either the primary login form or the 2FA verification form.
 */
export function animateLoginStepSwap(formEl) {
  if (!formEl) return;
  animate(
    formEl,
    {
      opacity: [0, 1],
      y: [12, 0],
      filter: ['blur(4px)', 'blur(0px)'],
    },
    {
      duration: 0.38,
      ease: [0.22, 1, 0.36, 1],
      reduceMotion: false,
    },
  );
}

/**
 * Attaches subtle spring hover/press feedback to login action buttons once.
 */
export function bindLoginButtonMotion() {
  if (buttonGesturesBound) return;
  const buttons = ['#login-btn', '#login-passkey-btn', '#login-2fa-btn'];
  let boundAny = false;

  for (const selector of buttons) {
    const el = document.querySelector(selector);
    if (!el) continue;
    boundAny = true;

    hover(el, () => {
      if (el.disabled) return;
      animate(el, { scale: 1.012 }, { type: 'spring', stiffness: 420, damping: 28, reduceMotion: false });
      return () => {
        animate(el, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 28, reduceMotion: false });
      };
    });

    press(el, () => {
      if (el.disabled) return;
      animate(el, { scale: 0.985 }, { type: 'spring', stiffness: 520, damping: 32, reduceMotion: false });
      return () => {
        animate(el, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 28, reduceMotion: false });
      };
    });
  }

  buttonGesturesBound = boundAny;
}
