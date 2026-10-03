// One latest heading, not a text playback queue. A short phase may be skipped;
// terminal states and the message/tool content are never held by this policy.
export function createLifecycleHeading({ initial, identity, onChange, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout, minimum = 150 }) {
  const equal = (left, right) => left.phase === right.phase && left.label === right.label && left.detail === right.detail;
  let displayed = { ...initial }, desired = displayed, displayedAt = now(), timer = null, generation = 0, disposed = false;
  function clear() { generation++; if (timer !== null) cancel(timer); timer = null; }
  function commit() {
    clear(); displayedAt = now();
    if (equal(displayed, desired)) return;
    displayed = { ...desired }; onChange(displayed);
  }
  return {
    update(next, { active, immediate = false, identity: nextIdentity = identity } = {}) {
      if (disposed) return;
      desired = { ...next };
      const replaced = identity !== nextIdentity; identity = nextIdentity;
      if (replaced || !active || immediate) { commit(); return; }
      if (equal(displayed, desired)) { clear(); return; }
      const remaining = Math.min(minimum, Math.max(0, minimum - (now() - displayedAt)));
      if (remaining === 0) { commit(); return; }
      if (timer !== null) return;
      const ticket = ++generation;
      timer = schedule(() => { if (!disposed && ticket === generation) commit(); }, remaining);
    },
    flush() { if (!disposed) commit(); },
    destroy() { disposed = true; clear(); },
  };
}
