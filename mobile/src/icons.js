// Offline navigation glyphs share one stroke, viewBox and touch target.
const paths = {
  today: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  captures: '<path d="M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-9M16 3l5 5M11 13l-1 4 4-1 8-8-3-3Z"/>',
  knowledge: '<path d="M3 4h6a4 4 0 0 1 3 1.4A4 4 0 0 1 15 4h6v16h-6a4 4 0 0 0-3 1.4A4 4 0 0 0 9 20H3ZM12 6v15"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.8 7.3L3 21l1.6-5.2A8.5 8.5 0 1 1 21 11.5Z"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  microphone: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/>',
  send: '<path d="m5 11 7-7 7 7M12 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
export const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.chat}</svg>`;
