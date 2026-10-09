import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportState, mountMobileViewport, revealFocusedSheetInput } from '../src/mobile-viewport.js';
import { composerHeight, sizeComposers } from '../src/composer-size.js';

test('native resize uses the resized WebView once and browser overlay accounts only for its uncovered bottom', () => {
  assert.deepEqual(viewportState({ layoutHeight: 510, visualHeight: 510, baselineHeight: 844,
    native: true, focused: true, nativeKeyboardOpen: true }),
  { visibleHeight: 510, offsetTop: 0, bottomInset: 0, keyboardOpen: true });
  assert.deepEqual(viewportState({ layoutHeight: 844, visualHeight: 510, offsetTop: 20,
    baselineHeight: 844, focused: true }),
  { visibleHeight: 510, offsetTop: 20, bottomInset: 314, keyboardOpen: true });
  assert.equal(viewportState({ layoutHeight: 510, visualHeight: 510, baselineHeight: 844,
    focused: true }).keyboardOpen, true);
});

test('pinch zoom, toolbar changes and unfocused viewport changes do not hide navigation as a keyboard', () => {
  assert.equal(viewportState({ layoutHeight: 844, visualHeight: 500, focused: true, scale: 1.5 }).keyboardOpen, false);
  assert.equal(viewportState({ layoutHeight: 844, visualHeight: 750, focused: true }).keyboardOpen, false);
  assert.equal(viewportState({ layoutHeight: 510, visualHeight: 510, baselineHeight: 844 }).keyboardOpen, false);
  assert.equal(viewportState({ layoutHeight: 510, visualHeight: 510, native: true,
    nativeKeyboardOpen: false, baselineHeight: 844, focused: true }).keyboardOpen, false);
});

function surface() {
  const win = new EventTarget(), doc = new EventTarget(), viewport = new EventTarget();
  const vars = new Map(), classes = new Set(), frames = new Map(); let frameID = 0;
  Object.assign(win, { innerHeight: 844, innerWidth: 390, visualViewport: viewport,
    requestAnimationFrame(fn) { frames.set(++frameID, fn); return frameID; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
  doc.body = { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } } };
  doc.documentElement = { style: { setProperty(name, value) { vars.set(name, value); } } };
  return { win, doc, vars, classes, frames, flush() { const all = [...frames.values()]; frames.clear(); all.forEach(fn => fn()); } };
}

test('native show/resize/hide restores viewport and teardown cancels pending callbacks', () => {
  const s = surface(), changes = [];
  const controller = mountMobileViewport({ window: s.win, document: s.doc, native: true, onChange: state => changes.push(state) });
  s.doc.activeElement = { matches: () => true };
  controller.keyboardWillShow({ keyboardHeight: 334 });
  s.win.innerHeight = s.win.visualViewport.height = 510;
  s.win.dispatchEvent(new Event('resize')); s.win.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(s.frames.size, 1); s.flush();
  assert.equal(s.vars.get('--app-viewport-height'), '510px');
  assert.equal(s.vars.get('--keyboard-inset'), '0px');
  assert.equal(s.classes.has('keyboard-open'), true);
  controller.keyboardWillHide();
  s.win.innerHeight = s.win.visualViewport.height = 844; controller.refresh();
  assert.equal(s.vars.get('--app-viewport-height'), '844px');
  assert.equal(s.classes.has('keyboard-open'), false);
  s.win.dispatchEvent(new Event('resize')); controller.dispose();
  const count = changes.length;
  s.win.innerHeight = 500; s.win.dispatchEvent(new Event('resize')); s.doc.dispatchEvent(new Event('focusin')); s.flush();
  assert.equal(changes.length, count); assert.equal(s.frames.size, 0);
});

test('browser viewport restores after shrink and orientation resets its baseline', () => {
  const s = surface(); const controller = mountMobileViewport({ window: s.win, document: s.doc });
  s.doc.activeElement = { matches: () => true };
  s.win.innerHeight = s.win.visualViewport.height = 510; controller.refresh();
  assert.equal(controller.state.keyboardOpen, true);
  s.win.innerHeight = s.win.visualViewport.height = 844; controller.refresh();
  assert.equal(controller.state.keyboardOpen, false);
  s.win.innerWidth = 844; s.win.innerHeight = s.win.visualViewport.height = 390; controller.refresh();
  assert.equal(controller.state.keyboardOpen, false); controller.dispose();
});

test('composer grows with content, reserves typing space on reduced viewport and shrinks to its own minimum', () => {
  assert.equal(composerHeight({ scrollHeight: 120, border: 2, visibleHeight: 844 }), 122);
  assert.equal(composerHeight({ scrollHeight: 2000, visibleHeight: 844 }), 180);
  assert.equal(composerHeight({ scrollHeight: 2000, visibleHeight: 400 }), 120);
  assert.equal(composerHeight({ scrollHeight: 24, visibleHeight: 844 }), 64);
  assert.equal(composerHeight({ scrollHeight: 24, minimum: 82, visibleHeight: 300 }), 82);
});

test('async form content updates latest-reply placement without resizing input, and old form observers disconnect', () => {
  const observers = [], properties = new Map();
  const doc = { documentElement: { style: { setProperty: (name, value) => properties.set(name, value) } },
    defaultView: { innerHeight: 844, getComputedStyle: () => ({ minHeight: '64px' }),
      ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); }
        observe(form) { this.form = form; } disconnect() { this.disconnected = true; } },
    } };
  const form = height => ({ height, ownerDocument: doc, isConnected: true, getBoundingClientRect() { return { height: this.height }; } });
  const input = form => ({ id: 'chat-text', form, ownerDocument: doc, matches: () => true,
    value: '中文🙂', selectionStart: 1, selectionEnd: 3, clientWidth: 260, clientHeight: 64, scrollHeight: 64, scrollTop: 0, style: {} });
  const first = form(180), a = input(first); let inputs = [a];
  const root = { querySelectorAll: () => inputs };
  sizeComposers(root); assert.equal(properties.get('--chat-composer-height'), '180px');
  first.height = 275; observers[0].callback();
  assert.equal(properties.get('--chat-composer-height'), '275px');
  assert.equal(a.style.height, '64px'); assert.equal(a.value, '中文🙂');
  assert.equal(a.selectionStart, 1); assert.equal(a.selectionEnd, 3);
  const second = form(196); inputs = [input(second)]; sizeComposers(root);
  assert.equal(observers[0].disconnected, true); assert.equal(properties.get('--chat-composer-height'), '196px');
  first.height = 400; observers[0].callback(); assert.equal(properties.get('--chat-composer-height'), '196px');
  inputs = []; sizeComposers(root); assert.equal(observers[1].disconnected, true);
});

function formSurface(s) {
  const sheet = {open:true,scrollTop:0,getBoundingClientRect:()=>({top:6,bottom:305}),
    querySelector:()=>({getBoundingClientRect:()=>({bottom:62})})};
  const form={closest:selector=>selector==='#sheet'?sheet:null};
  const input={matches:()=>true,closest:selector=>selector==='#task-form,#event-form'?form:null,
    value:'保留中文输入',selectionStart:2,selectionEnd:4,scrollTop:7,
    getBoundingClientRect:()=>({top:280-sheet.scrollTop,bottom:372-sheet.scrollTop,height:92})};
  s.doc.activeElement=input;
  return {sheet,input};
}
test('keyboard reveal scrolls only the task sheet and preserves input value, selection and inner scroll',()=>{
  const s=surface(),{sheet,input}=formSurface(s);
  assert.equal(revealFocusedSheetInput(s.doc,{offsetTop:0,visibleHeight:305}),true);
  assert.equal(sheet.scrollTop,79);assert.equal(input.getBoundingClientRect().bottom,293);
  assert.equal(input.value,'保留中文输入');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,4);assert.equal(input.scrollTop,7);
  assert.equal(revealFocusedSheetInput(s.doc,{offsetTop:0,visibleHeight:305}),false);
  sheet.open=false;sheet.scrollTop=0;assert.equal(revealFocusedSheetInput(s.doc,{offsetTop:0,visibleHeight:305}),false);
});
test('native resize reveals the focused sheet once and later user scrolling is not snapped back',()=>{
  const s=surface(),{sheet}=formSurface(s),controller=mountMobileViewport({window:s.win,document:s.doc,native:true});
  s.win.innerHeight=s.win.visualViewport.height=305;controller.keyboardWillShow({keyboardHeight:400});s.flush();
  assert.equal(sheet.scrollTop,79);
  sheet.scrollTop=0;s.win.visualViewport.dispatchEvent(new Event('scroll'));s.flush();s.flush();
  assert.equal(sheet.scrollTop,0);assert.equal(s.frames.size,0);
  controller.dispose();
});
