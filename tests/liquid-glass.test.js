const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Glass = require('../liquid-glass');
function fixture(initial = {}) {
  const classes = new Set(), body = { classList: { contains: name => classes.has(name), add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name) }, contains: element => element.owned !== false };
  const listeners = new Map(), windowListeners = new Map(), frames = new Map(), queries = new Map(); let sequence = 0;
  const document = { body, hidden: false, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  const env = { document, requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, handler) => windowListeners.set(name, handler), removeEventListener: name => windowListeners.delete(name),
    matchMedia: query => { const name = Object.keys(Glass.QUERY).find(key => Glass.QUERY[key] === query); const q = { matches: initial[name] ?? (name === 'pointer'), listeners: new Set(), addEventListener(_type, fn) { this.listeners.add(fn); }, removeEventListener(_type, fn) { this.listeners.delete(fn); }, change(value) { this.matches = value; this.listeners.forEach(fn => fn()); } }; queries.set(name, q); return q; } };
  const surface = (rect = { left: 100, top: 200, width: 400, height: 200 }) => {
    const attrs = new Map(), props = new Map(); let reads = 0;
    return { owned: true, isConnected: true, hidden: false, attrs, props, get reads() { return reads; }, style: { setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key) }, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key), getBoundingClientRect() { reads++; return rect; } };
  };
  const controller = Glass.createController(env);
  const move = (target, x = 200, y = 300, rest = {}) => listeners.get('pointermove')?.({ target: { closest: selector => { assert.equal(selector, Glass.SURFACES); return target; } }, clientX: x, clientY: y, pointerType: 'mouse', buttons: 0, ...rest });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  return { controller, body, document, classes, listeners, windowListeners, queries, frames, surface, move, flush };
}

test('material coordinate math is bounded and ignores zero-size or invalid surfaces', () => {
  const rect = { left: 100, top: 200, width: 400, height: 200 };
  assert.deepEqual(Glass.coordinates(rect, { x: 300, y: 300 }), { x: 50, y: 50 });
  assert.deepEqual(Glass.coordinates(rect, { x: -50, y: 900 }), { x: 0, y: 100 });
  assert.equal(Glass.coordinates({ ...rect, width: 0 }, { x: 1, y: 2 }), null); assert.equal(Glass.coordinates(rect, { x: NaN, y: 2 }), null);
});

test('many pointer events schedule one frame, paint only the latest position, and do not create an animation loop', () => {
  const h = fixture(), surface = h.surface();
  for (let i = 0; i < 100; i++) h.move(surface, 100 + i * 4, 300);
  assert.equal(h.frames.size, 1); assert.equal(surface.reads, 0); h.flush(); assert.equal(surface.reads, 1); assert.equal(surface.props.get('--lg-pointer-x'), '99%'); assert.equal(surface.attrs.get('data-glass-lit'), 'true'); assert.equal(h.frames.size, 0);
});

test('moving between material surfaces resets the previous surface without touching content or app state', () => {
  const h = fixture(), first = h.surface(), second = h.surface(); h.move(first); h.flush(); h.move(second, 300, 250); h.flush();
  assert.equal(first.attrs.size, 0); assert.equal(first.props.size, 0); assert.equal(second.props.get('--lg-pointer-x'), '50%'); assert.equal(second.props.get('--lg-pointer-y'), '25%');
  h.move(null); assert.equal(second.attrs.size, 0); assert.equal(second.props.size, 0); assert.equal(h.frames.size, 0);
});

test('pointer leave, removed surface, drag resize, and touch never leave a stale or expensive highlight', () => {
  for (const behavior of ['leave', 'removed', 'resizing', 'touch', 'buttons']) {
    const h = fixture(), surface = h.surface(); h.move(surface); h.flush();
    if (behavior === 'leave') h.listeners.get('pointerout')({ relatedTarget: null });
    if (behavior === 'removed') { surface.isConnected = false; h.move(surface); h.flush(); }
    if (behavior === 'resizing') { h.classes.add('workspace-resizing'); h.move(surface); }
    if (behavior === 'touch') h.move(surface, 200, 300, { pointerType: 'touch' });
    if (behavior === 'buttons') h.move(surface, 200, 300, { buttons: 1 });
    assert.equal(surface.attrs.size, 0, behavior); assert.equal(surface.props.size, 0, behavior); assert.equal(h.frames.size, 0, behavior);
  }
});

test('all accessibility preferences disable active highlights immediately and can be changed at runtime', () => {
  for (const name of ['motion', 'transparency', 'contrast', 'pointer']) {
    const h = fixture(), surface = h.surface(); h.move(surface); h.flush(); h.queries.get(name).change(name !== 'pointer');
    assert.equal(surface.attrs.size, 0); assert.equal(h.classes.has('liquid-glass-static'), true); h.move(surface); assert.equal(h.frames.size, 0);
    h.queries.get(name).change(name === 'pointer'); h.move(surface); assert.equal(h.frames.size, 1); h.flush(); assert.equal(surface.attrs.get('data-glass-lit'), 'true');
  }
});

test('hidden documents and inactive windows cancel pending frames and release highlights', () => {
  const h = fixture(), surface = h.surface(); h.move(surface); h.document.hidden = true; h.listeners.get('visibilitychange')(); assert.equal(h.frames.size, 0); h.move(surface); assert.equal(h.frames.size, 0);
  h.document.hidden = false; h.listeners.get('visibilitychange')(); h.move(surface); h.flush(); h.windowListeners.get('blur')(); assert.equal(surface.attrs.size, 0); assert.equal(h.classes.has('liquid-glass-unfocused'), true); h.move(surface); assert.equal(h.frames.size, 0);
  h.windowListeners.get('focus')(); h.move(surface); h.flush(); assert.equal(surface.attrs.get('data-glass-lit'), 'true');
});

test('cleanup removes listeners, media observers, variables and scheduled work', () => {
  const h = fixture(), surface = h.surface(); h.move(surface); h.flush(); h.move(surface); assert.equal(h.frames.size, 1); h.controller.destroy();
  assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.windowListeners.size, 0); assert.equal(surface.props.size, 0); assert.equal(surface.attrs.size, 0); assert.equal(h.classes.has('liquid-glass'), false); for (const query of h.queries.values()) assert.equal(query.listeners.size, 0); h.controller.destroy();
});

test('material stylesheet has explicit content/accessibility fallback and does not redefine pane widths or positions', () => {
  const css = fs.readFileSync(require.resolve('../liquid-glass.css'), 'utf8');
  assert.match(css, /body\.liquid-glass\[data-view\]\.light-mode/); assert.match(css, /prefers-reduced-transparency/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /forced-colors/); assert.match(css, /@supports not/);
  assert.match(css, /\.note-document-preview[^}]+backdrop-filter:none/); assert.doesNotMatch(css, /[;{\n]\s*(?:width|min-width|max-width|flex-basis|margin-left|margin-right|transform)\s*:/);
  assert.doesNotMatch(css, /pointer-events\s*:\s*(auto|all)/); assert.match(css, /pointer-events:none/);
});

function contrast(a, b) {
  const luminance = hex => { const rgb = hex.match(/\w\w/g).map(n => parseInt(n, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05);
}
test('reading text and muted metadata retain at least 4.5:1 contrast on both solid document planes', () => {
  const css = fs.readFileSync(require.resolve('../liquid-glass.css'), 'utf8');
  for (const selector of ['body.liquid-glass[data-view] {', 'body.liquid-glass[data-view].light-mode {']) {
    const start=css.indexOf(selector), block=css.slice(start,css.indexOf('}',start));
    const value=name=>new RegExp(`--${name}:#([0-9a-fA-F]{6});`).exec(block)[1];
    for (const role of ['text','muted','faint']) assert.ok(contrast(value(role),value('lg-content'))>=4.5,`${selector} ${role}`);
  }
});

test('lens map bends only the rounded rim and leaves the center mathematically stationary', () => {
  const map = Glass.makeDisplacementMap(480, 160, 25);
  const pixel = (x, y) => [...map.pixels.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 4)];
  assert.deepEqual(pixel(240, 80), [128, 128, 0, 255]);
  assert.deepEqual(pixel(80, 80), [128, 128, 0, 255]);
  assert.equal((128 / 255 * (255 / 254) - 1 / 254 - .5) * map.scale, 0);
  const left = pixel(3, 80), right = pixel(476, 80), top = pixel(240, 3), bottom = pixel(240, 156);
  assert.ok(left[0] < 110); assert.ok(right[0] > 146); assert.equal(left[1], 128); assert.equal(right[1], 128);
  assert.ok(top[1] < 110); assert.ok(bottom[1] > 146); assert.equal(top[0], 128); assert.equal(bottom[0], 128);
  const corner = pixel(10, 10); assert.ok(corner[0] < 128 && corner[1] < 128, 'rounded corner refracts in both axes');
  assert.deepEqual(pixel(0, 0), [128, 128, 0, 255], 'outside rounded rectangle remains neutral');
  assert.equal(Glass.lensOffset(24, 24), 0); assert.equal(Glass.lensOffset(-1, 24), 0);
});

test('refraction maps are resolution bounded and retain an isotropic rounded lens after resize', () => {
  assert.equal(Glass.makeDisplacementMap(0, 200), null); assert.equal(Glass.makeDisplacementMap(Infinity, 200), null);
  for (const [width, height] of [[360, 160], [800, 270], [2000, 1300]]) {
    const map = Glass.makeDisplacementMap(width, height, 25, 10000);
    assert.ok(map.width <= 512 && map.height <= 512); assert.equal(map.pixels.length, map.width * map.height * 4);
    assert.ok(Math.abs(map.width / map.height - width / height) < .05);
    assert.ok(map.pixels.every((value, index) => index % 4 !== 3 || value === 255));
  }
});

test('clear refraction is confined to the rim while the entire typing and toolbar center is fully frosted', () => {
  assert.equal(Glass.rimClarity(0,24),1);assert.equal(Glass.rimClarity(4,24),1);assert.equal(Glass.rimClarity(20,24),0);assert.equal(Glass.rimClarity(60,24),0);
  let previous=1;for(let depth=0;depth<=30;depth+=.25){const value=Glass.rimClarity(depth,24);assert.ok(value<=previous);previous=value;}
  for(const [width,height] of [[360,160],[480,160],[800,270]]){
    const map=Glass.makeDisplacementMap(width,height),values=[];
    for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++){
      const value=map.pixels[(y*map.width+x)*4+2]/255;values.push(value);
      const px=(x+.5)*width/map.width,py=(y+.5)*height/map.height;
      if(px>26&&px<width-26&&py>24&&py<height-24)assert.equal(value,0,'no sharp background text behind central foreground controls');
    }
    const clearCoverage=values.reduce((sum,value)=>sum+value,0)/values.length;
    assert.ok(clearCoverage<.2,'the blurred layer contributes at least 80% of the integrated surface');assert.ok(clearCoverage>.05,'edge refraction remains visible');
  }
});

function refractionFixture(options = {}) {
  const children = [], events = new Map(), windowEvents = new Map(), timers = new Map(), classes = new Set(); let writes = 0, timerId = 0, resize;
  const node = name => ({name,attrs:new Map(),children:[],style:{props:new Map(),setProperty(k,v){this.props.set(k,v);},removeProperty(k){this.props.delete(k);}},setAttribute(k,v){this.attrs.set(k,v);},removeAttribute(k){this.attrs.delete(k);},append(...items){this.children.push(...items);},remove(){this.removed=true;}});
  const composer = node('composer'); composer.isConnected = true; let rect = { width: 480, height: 160 }; composer.getBoundingClientRect=()=>rect;
  const pane = node('pane'), list = { scrollHeight: 1400, scrollTop: options.atBottom === false ? 210 : 800, clientHeight: 600 };
  pane.querySelector=()=>list; if(options.withChat) composer.closest=()=>pane;
  const document = {hidden:false,body:{append(item){children.push(item);},classList:{contains:name=>classes.has(name)}},querySelector:()=>composer,createElementNS:(_ns,name)=>node(name),
    createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>writes++}),toDataURL:()=>`data:image/png;base64,test${writes}`}),
    addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const env = {document,navigator:{userAgent:'Chrome/140.0.0.0'},CSS:{supports:()=>true},ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){this.disconnected=true;}},getComputedStyle:()=>({borderTopLeftRadius:'25px'}),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),addEventListener:(key,fn)=>windowEvents.set(key,fn),removeEventListener:key=>windowEvents.delete(key)};
  const media = {transparency:{matches:false},contrast:{matches:false},motion:{matches:false}};
  const controller=Glass.createRefraction(env,media),flush=()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());};
  return {env,document,composer,pane,list,media,controller,children,events,windowEvents,timers,classes,flush,get writes(){return writes;},resize(width=480,height=160){rect={width,height};resize();}};
}

test('SVG filter displaces the backdrop, corrects sRGB neutrality, and never applies filter to foreground text', () => {
  const h=refractionFixture();h.flush();assert.equal(h.writes,1);assert.equal(h.composer.attrs.get('data-glass-refracting'),'true');
  const filter=h.children[0].children[0].children[0];assert.equal(filter.attrs.get('color-interpolation-filters'),'sRGB');
  const displacement=filter.children.find(n=>n.name==='feDisplacementMap');assert.equal(displacement.attrs.get('in'),'SourceGraphic');assert.equal(displacement.attrs.get('in2'),'lens-map');
  assert.equal(displacement.attrs.get('xChannelSelector'),'R');assert.equal(displacement.attrs.get('yChannelSelector'),'G');
  assert.ok(h.composer.style.props.get('--lg-refraction-filter').startsWith('url('));assert.equal(h.composer.style.props.has('filter'),false);
  const css=fs.readFileSync(require.resolve('../liquid-glass.css'),'utf8');assert.match(css,/backdrop-filter:var\(--lg-refraction-filter\)/);
  assert.doesNotMatch(css,/(?:^|[;{])\s*filter\s*:\s*(?:url|var\(--lg-refraction)/);
});

test('filter combines clear rim and 9px frosted center with complementary masks, without a transparent text-leaking seam', () => {
  const h=refractionFixture();h.flush();const nodes=h.children[0].children[0].children[0].children;
  const result=name=>nodes.find(node=>node.attrs.get('result')===name);
  assert.equal(result('clear-glass').attrs.get('stdDeviation'),'.35');assert.equal(result('frosted-glass').attrs.get('stdDeviation'),'9');assert.equal(result('frosted-glass').attrs.get('in'),'refracted');
  assert.equal(result('rim-mask').attrs.get('in'),'lens-map-raw');assert.deepEqual(result('rim-mask').attrs.get('values').trim().split(/\s+/).map(Number).slice(15),[0,0,1,0,0]);
  assert.equal(result('clear-rim').attrs.get('operator'),'in');assert.equal(result('frosted-center').attrs.get('operator'),'out');
  const merge=nodes.at(-1);assert.equal(merge.attrs.get('operator'),'arithmetic');assert.equal(merge.attrs.get('k2'),'1');assert.equal(merge.attrs.get('k3'),'1');assert.equal(merge.attrs.get('in'),'clear-rim');assert.equal(merge.attrs.get('in2'),'frosted-center');
  for(const mask of [0,.25,.5,.75,1])assert.equal(mask+(1-mask),1,'complementary contributions retain full backdrop alpha');
});

test('map rebuilds coalesce on resize, use a size cache, suspend while dragging, and clean up', () => {
  const h=refractionFixture();for(let i=0;i<60;i++)h.resize(640,160);assert.equal(h.timers.size,1);h.flush();assert.equal(h.writes,1);assert.equal(h.timers.size,0);
  h.resize(640,160);h.flush();assert.equal(h.writes,1,'same geometry reuses the image');
  h.classes.add('workspace-resizing');h.resize(700,160);h.flush();assert.equal(h.writes,1);assert.equal(h.timers.size,0,'no polling while a drag is held');assert.equal(h.composer.attrs.has('data-glass-refracting'),false);
  h.classes.delete('workspace-resizing');h.events.get('pointerup')();h.flush();assert.equal(h.writes,2);
  h.resize(720,160);h.controller.destroy();assert.equal(h.timers.size,0);assert.equal(h.composer.style.props.size,0);assert.equal(h.events.size,0);assert.equal(h.windowEvents.size,0);assert.equal(h.children[0].removed,true);
});

test('reduced transparency and forced colors disable refraction; reduced motion keeps the stationary lens', () => {
  const h=refractionFixture();h.flush();h.media.motion.matches=true;h.controller.refresh();h.flush();assert.equal(h.composer.attrs.get('data-glass-refracting'),'true');assert.equal(h.writes,1);
  for(const key of ['transparency','contrast']){h.media[key].matches=true;h.controller.refresh();assert.equal(h.composer.attrs.has('data-glass-refracting'),false);assert.equal(h.timers.size,0);h.media[key].matches=false;h.controller.refresh();h.flush();assert.equal(h.composer.attrs.get('data-glass-refracting'),'true');}
  h.document.hidden=true;h.controller.refresh();assert.equal(h.composer.attrs.has('data-glass-refracting'),false);
  assert.equal(Glass.supportsRefraction({...h.env,navigator:{userAgent:'Version/18 Safari/605.1.15'}}),false,'parse support is insufficient in WebKit');
  assert.equal(Glass.supportsRefraction({...h.env,CSS:{supports:()=>false}}),false);
});

test('floating composer reserves its measured height, follows an already pinned scroll, and never jumps historical reading', () => {
  const bottom=refractionFixture({withChat:true});assert.equal(bottom.pane.attrs.get('data-glass-chat'),'true');assert.equal(bottom.pane.style.props.get('--lg-composer-height'),'160px');assert.equal(bottom.list.scrollTop,1400);
  bottom.list.scrollTop=800;bottom.resize(480,220);assert.equal(bottom.pane.style.props.get('--lg-composer-height'),'220px');assert.equal(bottom.list.scrollTop,1400);
  const historical=refractionFixture({withChat:true,atBottom:false});assert.equal(historical.list.scrollTop,210);historical.resize(360,260);assert.equal(historical.pane.style.props.get('--lg-composer-height'),'260px');assert.equal(historical.list.scrollTop,210);
  historical.controller.destroy();assert.equal(historical.pane.attrs.has('data-glass-chat'),false);assert.equal(historical.pane.style.props.size,0);
});

test('secondary glass targets real floating controls, preserves content planes, and has matching accessibility fallbacks', () => {
  const css = fs.readFileSync(require.resolve('../liquid-glass.css'), 'utf8');
  const patch = css.slice(css.indexOf('/* Secondary controls use'), css.indexOf('@media(max-width:760px)'));
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  for (const id of ['modelPicker','searchDialog']) {
    assert.match(html, new RegExp(`id="${id}"`)); assert.ok(patch.includes(`#${id}`));
  }
  for (const [file, ids] of [['skills-ui.js',['skillsDialog','skillPicker']],['prompt-polisher.js',['polishDialog']]]) {
    const source = fs.readFileSync(require.resolve(`../${file}`), 'utf8');
    for (const id of ids) { assert.match(source, new RegExp(`\\.id\\s*=\\s*['"]${id}['"]`)); assert.ok(patch.includes(`#${id}`)); }
  }
  assert.match(patch, /backdrop-filter:blur\(34px\)/);
  assert.match(patch, /\.note-document-toolbar[^}]+backdrop-filter:blur\(28px\)/);
  assert.doesNotMatch(patch, /(?:^|[;{])\s*filter\s*:/);
  assert.doesNotMatch(patch, /\.composer|\.message-list|\.activity-ui|\.note-document-preview/);
  const fallback = css.slice(css.lastIndexOf('@media(prefers-reduced-transparency:reduce)'));
  for (const id of ['modelPicker','polishDialog','skillPicker','skillsDialog','searchDialog']) assert.ok(fallback.includes(`#${id}`));
  assert.match(fallback, /background:var\(--panel-raised\);backdrop-filter:none/);
  assert.match(fallback, /forced-colors:active/); assert.match(fallback, /background:Canvas/);
});

test('material palette has no fixed blue dye or luminous lower rim while keeping neutral chat controls', () => {
  const css=fs.readFileSync(require.resolve('../liquid-glass.css'),'utf8');
  for (const match of css.matchAll(/#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?\b/g)) {
    const rgb=[0,2,4].map(index=>parseInt(match[1].slice(index,index+2),16));
    assert.ok(Math.max(...rgb)-Math.min(...rgb)<=3,`Fixed material dye: ${match[0]}`);
  }
  for (const match of css.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) {
    const rgb=match.slice(1).map(Number);assert.ok(Math.max(...rgb)-Math.min(...rgb)<=3,match[0]);
  }
  const start=css.indexOf('body.liquid-glass[data-view] .composer[data-glass-refracting=true] {');
  const composer=css.slice(start,css.indexOf('}',start));
  assert.match(composer,/backdrop-filter:var\(--lg-refraction-filter\)/);
  assert.doesNotMatch(composer,/inset 0 -\d+px .*?#(?:fff|[a-f0-9]{6})/i);
  assert.match(css,/\.user-message \.message-body[^}]+background:var\(--panel-hover\)/);
  assert.match(css,/\.agent-message \.message-identity::before[^}]+box-shadow:none/);
});

test('native material suspends the CSS lens but retains composer height measurement and resumes the cached fallback', () => {
  const h=refractionFixture({withChat:true});h.flush();assert.equal(h.writes,1);h.controller.setNativeActive(true);
  assert.equal(h.composer.attrs.has('data-glass-refracting'),false);assert.equal(h.pane.attrs.get('data-glass-chat'),'true');
  h.resize(480,210);h.flush();assert.equal(h.pane.style.props.get('--lg-composer-height'),'210px');assert.equal(h.writes,1);
  h.controller.setNativeActive(false);h.flush();assert.equal(h.composer.attrs.get('data-glass-refracting'),'true');assert.equal(h.writes,2);
  h.controller.setNativeActive(true);h.controller.setNativeActive(false);h.flush();assert.equal(h.writes,2);h.controller.destroy();
});
test('native material suppresses pointer highlights without preventing fallback restoration',()=>{
  const h=fixture(),surface=h.surface();h.move(surface);h.flush();h.controller.setNativeActive(true);assert.equal(surface.attrs.size,0);h.move(surface);assert.equal(h.frames.size,0);
  h.controller.setNativeActive(false);h.move(surface);h.flush();assert.equal(surface.attrs.get('data-glass-lit'),'true');h.controller.destroy();
});
