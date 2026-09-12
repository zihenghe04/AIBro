'use strict';
const os = require('node:os');
const MAX_REGIONS = 16;
const ALLOWED = new Set(['id','x','y','width','height','radius','style']);
function normalizeRegions(input, bounds, zoom = 1) {
  if (!Array.isArray(input) || input.length > MAX_REGIONS) throw new TypeError('Expected at most 16 native glass regions.');
  if (![bounds?.width,bounds?.height,zoom].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || zoom <= 0 || zoom > 5) throw new TypeError('Invalid native glass viewport.');
  const seen = new Set(), result = [];
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !ALLOWED.has(key))) throw new TypeError('Invalid native glass region.');
    if (typeof value.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.id) || seen.has(value.id)) throw new TypeError('Native glass IDs must be unique and stable.');
    seen.add(value.id);
    const numbers = [value.x,value.y,value.width,value.height,value.radius];
    if (!numbers.every(number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 32768) || value.width <= 0 || value.height <= 0 || value.radius < 0 || !['regular','clear'].includes(value.style)) throw new TypeError('Invalid native glass geometry or public style.');
    const x = Math.max(0,value.x*zoom), y = Math.max(0,value.y*zoom);
    const right = Math.min(bounds.width,(value.x+value.width)*zoom), bottom = Math.min(bounds.height,(value.y+value.height)*zoom);
    if (right <= x || bottom <= y) continue;
    result.push({id:value.id,x,y,width:right-x,height:bottom-y,radius:Math.min(value.radius*zoom,(right-x)/2,(bottom-y)/2),style:value.style});
  }
  return result;
}
function createNativeGlass(options) {
  const {getWindow,getLocalOrigin} = options;
  const platform = options.platform || process.platform, release = options.release || os.release();
  const loadAddon = options.loadAddon || (() => require('./native-glass.node'));
  let addon, checked = false, supported = false, reason = '', count = 0, currentHandle;
  function support() {
    if (checked) return supported;
    checked = true;
    if (platform !== 'darwin') { reason='platform';return false; }
    if (Number(String(release).split('.')[0]) < 25) { reason='macos-version';return false; }
    try {
      addon = loadAddon();
      supported = typeof addon?.isSupported === 'function' && typeof addon?.setRegions === 'function' && typeof addon?.clear === 'function' && addon.isSupported() === true;
      if (!supported) { addon=undefined;reason='native-unavailable'; }
    } catch (_) { addon=undefined;reason='native-unavailable'; }
    return supported;
  }
  function trusted(event) {
    const window=getWindow();
    if (!window || window.isDestroyed?.()) throw new Error('Native glass window is unavailable.');
    const contents=window.webContents;
    let url;
    try { url=new URL(event?.senderFrame?.url || ''); } catch (_) { throw new Error('Untrusted native glass sender.'); }
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || url.origin !== getLocalOrigin() || !['/','/index.html'].includes(url.pathname)) throw new Error('Untrusted native glass sender.');
    return window;
  }
  function status(event) {
    if (event !== undefined) trusted(event);
    support();
    const window=getWindow();if (!window || window.isDestroyed?.()) count=0;
    return {supported,active:supported&&count>0,regions:count,...(reason?{reason}:{})};
  }
  function dispose() {
    try { if (addon) addon.clear(); } catch (_) {}
    count=0;currentHandle=undefined;
  }
  function setRegions(event, input) {
    const window=trusted(event);
    const regions=normalizeRegions(input,window.getContentBounds(),window.webContents.getZoomFactor?.() || 1);
    if (!support()) return status();
    try {
      const handle=window.getNativeWindowHandle();
      if (!Buffer.isBuffer(handle) || handle.length !== 8) throw new Error('Invalid native window.');
      currentHandle=handle;
      const active=addon.setRegions(handle,regions);
      if (!Number.isSafeInteger(active) || active<0 || active>regions.length) throw new Error('Invalid native glass result.');
      count=active;reason='';return status();
    } catch (_) { dispose();reason='native-failure';return status(); }
  }
  return {setRegions,status,dispose};
}
module.exports={createNativeGlass,normalizeRegions,MAX_REGIONS};
