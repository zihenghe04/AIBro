// One-shot local upgrade helper. Run with Electron against a PRIVATE COPY of
// the stopped legacy profile. Only non-secret settings are read; no app page
// or network content is loaded, and the original profile is never opened.
const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs');
const [profile,output]=process.argv.slice(2);
if(!profile||!output)throw new Error('Expected copied profile and output path');
app.setPath('userData',profile);app.setName('ai-workstation');
const keys=['workstation-api-base','workstation-api-model','workstation-openai-model','workstation-provider','aibro-embedding-settings-v1','ai-bro-language','workstation-ui'];
app.whenReady().then(async()=>{
 protocol.handle('http',()=>new Response('<!doctype html><title>Local settings migration</title>',{headers:{'Content-Type':'text/html'}}));
 protocol.handle('https',()=>new Response('',{status:403}));
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await window.loadURL('http://127.0.0.1:8765/');
 const values=await window.webContents.executeJavaScript(`Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,localStorage.getItem(k)]).filter(x=>x[1]!==null))`);
 fs.writeFileSync(output,JSON.stringify(values),{mode:0o600});
 console.log(`Migrated ${Object.keys(values).length} non-secret settings`);app.quit();
}).catch(()=>{console.error('Settings migration failed; original profile unchanged');app.exit(1)});
