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

  const MAX = 48;          // knob travel from centre, in px
  const HALF_BASE = 65;    // half the base size (130px) for centring under thumb
  const LOOK_SENS = 0.005; // radians of turn per pixel dragged

  let moveId = null, lookId = null;
  let moveOrigin = { x: 0, y: 0 };
  let lookLast = { x: 0, y: 0 };

  const half = () => window.innerWidth / 2;

  // Move a joystick base so its centre is under the thumb.
  function placeBase(stick, t) {
    stick.style.left = (t.clientX - HALF_BASE) + 'px';
    stick.style.top = (t.clientY - HALF_BASE) + 'px';
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
    player.look((t.clientX - lookLast.x) * LOOK_SENS, (t.clientY - lookLast.y) * LOOK_SENS);
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
}
