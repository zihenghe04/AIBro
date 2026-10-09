// Session-local view history contains identities and positions, never form HTML,
// record snapshots, write callbacks or credentials.
const sheetKinds = new Set(['projects', 'tasks', 'agenda', 'notes', 'captures', 'imports']);
const copy = value => value == null ? null : structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class NavigationMemory {
  constructor() { this.positions = new Map(); this.parents = []; this.sheet = null; }
  rememberConversation(id, position) {
    if (!id || !position) return;
    this.positions.delete(id);
    this.positions.set(id, copy(position));
    if (this.positions.size > 50) this.positions.delete(this.positions.keys().next().value);
  }
  conversation(id) { return copy(this.positions.get(id)); }
  openSheet(destination, scrollTop = 0) {
    if (destination && (!sheetKinds.has(destination.kind) || typeof destination.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(destination.id)))
      throw Error('返回页面标识无效');
    destination = destination ? { kind: destination.kind, id: destination.id } : null;
    if (this.sheet && !same(this.sheet, destination)) {
      this.parents.push({ destination: copy(this.sheet), scrollTop });
      if (this.parents.length > 16) this.parents.shift();
    }
    this.sheet = copy(destination);
  }
  backSheet() {
    const parent = this.parents.pop();
    this.sheet = copy(parent?.destination);
    return parent || null;
  }
  clearSheets() { this.parents = []; this.sheet = null; }
  get hasParentSheet() { return this.parents.length > 0; }
}

export function captureConversationPosition(document, y) {
  const article = [...document.querySelectorAll('.messages [data-message]')]
    .find(node => node.getBoundingClientRect().bottom > 0);
  return { y, anchor: article ? { key: article.dataset.messageKey || '', id: article.dataset.message,
    offset: article.getBoundingClientRect().top } : null };
}

export function conversationScrollTarget(document, position, currentY = 0) {
  if (!position) return 0;
  const anchor = position.anchor;
  const matches = anchor && [...document.querySelectorAll('.messages [data-message]')]
    .filter(node => anchor.key ? node.dataset.messageKey === anchor.key : node.dataset.message === anchor.id);
  const y = matches?.length === 1 ? currentY + matches[0].getBoundingClientRect().top - anchor.offset : position.y;
  return Math.max(0, Number.isFinite(y) ? y : 0);
}
