// Native scrolling remains available without JavaScript; controls are additive.
(() => {
  const track = document.getElementById('ios-gallery');
  if (!track) return;
  const previous = document.getElementById('ios-gallery-prev');
  const next = document.getElementById('ios-gallery-next');
  const position = document.getElementById('ios-gallery-position');
  const cards = [...track.children];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let drag = null, frame = 0;
  const maximum = () => Math.max(0, track.scrollWidth - track.clientWidth);
  const anchors = () => [...new Set([0, ...cards.map(card =>
    Math.min(maximum(), Math.max(0, card.offsetLeft - cards[0].offsetLeft))), maximum()])];
  const go = left => track.scrollTo({left, behavior: motion.matches ? 'instant' : 'smooth'});
  function update() {
    frame = 0;
    previous.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft >= maximum() - 2;
    const bounds = track.getBoundingClientRect();
    const visible = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      return Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left) >= rect.width / 2 ? index + 1 : 0;
    }).filter(Boolean);
    if (visible.length) position.textContent = `${visible[0]}${visible.length > 1 ? '–' + visible.at(-1) : ''} / ${cards.length}`;
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  function step(direction) {
    const stops = anchors();
    go(direction > 0 ? stops.find(left => left > track.scrollLeft + 2) ?? maximum()
      : stops.reverse().find(left => left < track.scrollLeft - 2) ?? 0);
  }
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  track.addEventListener('scroll', schedule, {passive: true});
  track.addEventListener('keydown', event => {
    if (event.target !== track || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(maximum());
    else step(event.key === 'ArrowRight' ? 1 : -1);
  });
  // Touch/pencil gestures and trackpad wheels stay fully native.
  track.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = {id: event.pointerId, x: event.clientX, left: track.scrollLeft, active: false};
  });
  track.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = event.clientX - drag.x;
    if (!drag.active && Math.abs(delta) < 6) return;
    if (!drag.active) {
      drag.active = true;
      track.classList.add('is-dragging');
      track.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    track.scrollLeft = drag.left - delta;
  });
  function finish(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const active = drag.active;
    drag = null;
    track.classList.remove('is-dragging');
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    if (active) go(anchors().reduce((a, b) => Math.abs(a - track.scrollLeft) < Math.abs(b - track.scrollLeft) ? a : b));
  }
  track.addEventListener('pointerup', finish);
  track.addEventListener('pointercancel', finish);
  track.addEventListener('lostpointercapture', finish);
  track.addEventListener('pointerleave', event => { if (drag && !drag.active) finish(event); });
  new ResizeObserver(schedule).observe(track);
  function openCourseAnchor() {
    if (location.hash !== '#ios-courses') return;
    requestAnimationFrame(() => {
      const course = document.getElementById('ios-courses');
      track.scrollLeft = Math.min(maximum(), course.offsetLeft - cards[0].offsetLeft);
      document.getElementById('ios').scrollIntoView({block: 'start'});
      schedule();
    });
  }
  window.addEventListener('hashchange', openCourseAnchor);
  openCourseAnchor();
  update();
})();
