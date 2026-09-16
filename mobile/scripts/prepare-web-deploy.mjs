// Package the tested public build as Vercel Build Output v3, without source checkout metadata.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
const root = new URL('../', import.meta.url);
const project = JSON.parse(await readFile(new URL('.vercel/project.json', root), 'utf8'));
if (!project.projectId || !project.orgId) throw Error('Link the intended Vercel project before packaging.');
const worker = await readFile(new URL('web-dist/sw.js', root), 'utf8');
new Script(worker);
const stage = await mkdtemp(join(tmpdir(), 'aibro-web-production-'));
await mkdir(join(stage, '.vercel/output'), {recursive: true});
await writeFile(join(stage, '.vercel/project.json'), JSON.stringify({projectId:project.projectId,orgId:project.orgId}));
await cp(new URL('web-dist/', root), join(stage, '.vercel/output/static'), {recursive:true});
const fn = join(stage,'.vercel/output/functions/api/ucas.func');
await mkdir(fn, {recursive:true});
await cp(new URL('api/ucas.mjs',root),join(fn,'index.mjs'));
await writeFile(join(fn,'.vc-config.json'),JSON.stringify({runtime:'nodejs22.x',handler:'index.mjs',launcherType:'Nodejs',maxDuration:30}));
await writeFile(join(stage, '.vercel/output/config.json'), JSON.stringify({
  version:3,
  routes:[
    {src:'/(.*)',headers:{'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'},continue:true},
    {src:'/sw.js',headers:{'Cache-Control':'no-cache'},continue:true},
    {src:'/index.html',headers:{'Cache-Control':'no-cache'},continue:true},
    {handle:'filesystem'},
    {src:'/.*',dest:'/index.html'}
  ]
},null,2));
console.log(stage);
