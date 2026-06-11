// Touch controls for phones/tablets: a left-thumb movement joystick, plus
// drag-anywhere-on-the-right to control the view angle, and on-screen action
// buttons. The joystick base re-centres under the thumb when pressed and
// returns to its home corner on release.
export function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

export function setupMobileControls(player, ui, actions) {
  document.body.classList.add('touch');
  const layer = document.getElementById('touch-layer');
  layer.classList.remove('hidden');

  const moveStick = document.getElementById('joystick');
  const moveKnob = moveStick.querySelector('.knob');

  // Look sensitivity (radians per pixel dragged) — shares the Settings slider
  // with the desktop mouse (stored as vc_sensitivity), scaled for touch drags.
  const lookSens = () => {
    const v = parseFloat(localStorage.getItem('vc_sensitivity'));
    return (Number.isFinite(v) && v > 0 ? v : 0.0013) * 3.85;
  };
  // The joystick size is responsive (scaled in CSS), so derive the knob travel
  // and centring offset from the element's actual rendered size each time.
  const baseSize = () => moveStick.offsetWidth || 130;
  const maxTravel = () => baseSize() * 0.37; // knob travel from centre, in px

  let moveId = null, lookId = null;
  let moveOrigin = { x: 0, y: 0 };
  let lookLast = { x: 0, y: 0 };

  const half = () => window.innerWidth / 2;

  // Move a joystick base so its centre is under the thumb.
  function placeBase(stick, t) {
    const hb = stick.offsetWidth / 2;
    stick.style.left = (t.clientX - hb) + 'px';
    stick.style.top = (t.clientY - hb) + 'px';
    stick.style.right = 'auto';
    stick.style.bottom = 'auto';
    stick.classList.add('active');
  }
  // Restore a base to its CSS home corner.
  function resetBase(stick, knob) {
    stick.style.left = stick.style.top = stick.style.right = stick.style.bottom = '';
    stick.classList.remove('active');
    knob.style.transform = 'translate(0,0)';
  }
  // Update knob position; return deflection in -1..1 on each axis.
  function deflect(origin, t, knob) {
    const MAX = maxTravel();
    let dx = t.clientX - origin.x, dy = t.clientY - origin.y;
    const d = Math.hypot(dx, dy);
    if (d > MAX) { dx = dx / d * MAX; dy = dy / d * MAX; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    return { x: dx / MAX, y: dy / MAX };
  }

  // ---- movement (left) ----
  function startMove(t) {
    moveId = t.identifier;
    moveOrigin = { x: t.clientX, y: t.clientY };
    placeBase(moveStick, t);
  }
  function updateMove(t) {
    const v = deflect(moveOrigin, t, moveKnob);
    player.input.strafe = v.x;
    player.input.forward = -v.y;
    // Push the stick to the outer ring while heading forward to sprint. The
    // existing stamina/cooldown rules in Player apply unchanged.
    const sprint = Math.hypot(v.x, v.y) > 0.9 && -v.y > 0.3;
    player.input.sprint = sprint;
    moveStick.classList.toggle('sprint', sprint);
  }
  function endMove() {
    moveId = null;
    player.input.forward = 0;
    player.input.strafe = 0;
    player.input.sprint = false;
    moveStick.classList.remove('sprint');
    resetBase(moveStick, moveKnob);
  }

  // ---- look (drag anywhere on the right side); a quick tap = jump ----
  let lookStart = { x: 0, y: 0, t: 0, moved: false };
  function startLook(t) {
    lookId = t.identifier;
    lookLast = { x: t.clientX, y: t.clientY };
    lookStart = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false };
  }
  function updateLook(t) {
    if (Math.hypot(t.clientX - lookStart.x, t.clientY - lookStart.y) > 12) lookStart.moved = true;
    const s = lookSens();
    player.look((t.clientX - lookLast.x) * s, (t.clientY - lookLast.y) * s);
    lookLast = { x: t.clientX, y: t.clientY };
  }
  function endLook() {
    // A short tap that didn't drag = jump.
    if (!lookStart.moved && performance.now() - lookStart.t < 250) {
      player.input.jump = true;
      setTimeout(() => { player.input.jump = false; }, 140);
    }
    lookId = null;
  }

  layer.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      // Only the bare world area drives move/look; taps on any HUD button
      // (target is the button, not the layer) are left to that button.
      if (t.target !== layer) continue;
      if (t.clientX < half()) { if (moveId === null) startMove(t); }
      else if (lookId === null) startLook(t);
    }
  }, { passive: false });

  layer.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) updateMove(t);
      else if (t.identifier === lookId) updateLook(t);
    }
  }, { passive: false });

  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) endMove();
      if (t.identifier === lookId) endLook();
    }
  };
  layer.addEventListener('touchend', endTouch);
  layer.addEventListener('touchcancel', endTouch);

  // Action buttons (stop propagation so they never start a look drag).
  const btn = (id, down, up) => {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(); }, { passive: false });
    if (up) el.addEventListener('touchend', (e) => { e.preventDefault(); up(); });
  };
  btn('btn-mine', () => actions.onPrimaryDown(), () => actions.onPrimaryUp()); // hold=mine, tap=build/attack

  // Tap-toggle buttons.
  const toggle = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(el); }, { passive: false });
  };
  // Sprinting is driven by the movement joystick (push forward to the outer
  // ring); there is no separate sprint button on touch.
  toggle('btn-view', () => actions.onView());
  // Target-lock: tap with a monster/player in the crosshair to keep the view on
  // them while you move; tap again to release.
  toggle('btn-lock', () => actions.onToggleLock && actions.onToggleLock());

  // Fly button (wings): toggles flight mode. While flight is OFF a screen tap
  // still jumps normally; while ON, tapping the screen climbs and the joystick +
  // look steer you through the air.
  toggle('btn-fly', () => actions.onToggleFly && actions.onToggleFly());
}
