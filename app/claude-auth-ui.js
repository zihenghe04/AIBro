/* Official local Claude Code login. No OAuth token, login URL or code enters this UI. */
(function(root) {
  'use strict';
  const models = Object.freeze(['', 'sonnet', 'opus', 'haiku']);
  const authMethods = new Set(['none','claude.ai','oauth_token','api_key','api_key_helper','third_party']);
  let hooks={}, status=null, lifecycle=0, loading=null, pending=null, loginFlight=null, mutating=false, savingModel=false, previousModel='', cancelling=false, timer=null, island=null, initialized=false;
  let message='尚未检测本机 Claude Code 登录状态。', error=false, logoutConfirmation=false;
  const selected=()=>root.document?.getElementById('provider')?.value==='claude-auth';
  const model=()=>String((savingModel?previousModel:hooks.getState?.()?.settings?.claudeModel)||'');
  const loggedIn=()=>status?.available===true&&status.loggedIn===true&&status.authMethod==='claude.ai';
  const problem=text=>Object.assign(new Error(text),{code:'CLAUDE_AUTH_NOT_READY'});
  const validStatus=value=>{
    if(!value||typeof value.available!=='boolean'||typeof value.loggedIn!=='boolean'||!authMethods.has(value.authMethod)||value.localCLIOnly!==true||value.dynamicTools!==false)throw problem('无法确认本机 Claude Code 状态，请重新检测。');
    return {available:value.available,loggedIn:value.loggedIn,authMethod:value.authMethod,localCLIOnly:true,dynamicTools:false};
  };
  async function request(path,body){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await root.fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
      const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result?.error?.message||'Claude Code 请求未完成，请重试。'),{code:result?.error?.code});
      return result;
    }catch(e){if(e.name==='AbortError')throw problem('Claude Code 请求超时，请重新检测。');throw e;}
    finally{clearTimeout(timeout);}
  }
  function render(){
    const host=root.document?.getElementById('claudeAuthPanel');if(!host)return;
    host.hidden=!selected();
    const props={status:message,error,model:model(),available:status?.available!==false,authenticated:loggedIn(),pending:!!pending,
      busy:mutating||savingModel,logoutConfirmation,onRefresh:()=>refresh().catch(()=>{}),onLogin:signIn,onCancel:cancel,
      onRequestLogout:()=>{logoutConfirmation=true;render();},onDismissLogout:()=>{logoutConfirmation=false;render();},onConfirmLogout:signOut,onModel:setModel};
    if(island)island.update(props);else if(root.HalaskaUI)island=root.HalaskaUI.mount(host,'ClaudeAuthSurface',props);
  }
  const announce=(text,failed=false)=>{message=text;error=failed;render();};
  function invalidate(){lifecycle++;loading=null;clearTimeout(timer);timer=null;return lifecycle;}
  function schedule(){clearTimeout(timer);timer=null;if(pending&&selected())timer=setTimeout(()=>refresh().catch(()=>{}),1800);}
  function statusText(){
    if(status?.available===false)return '未找到官方 Claude Code CLI。安装后重新检测。';
    if(loggedIn())return '已连接本机 Claude 账号 · 登录由官方 Claude Code 管理';
    if(status?.loggedIn||status?.authMethod&&status.authMethod!=='none')return '当前 CLI 认证方式不是 Claude 账号登录，请使用官方 Claude 账号登录。';
    return '尚未登录本机 Claude 账号。';
  }
  async function refresh(){
    if(loading)return loading;
    const own=lifecycle,requestId=pending;
    const work=(async()=>{
      try{
        if(requestId){
          const operation=await request('/__claude/operation?requestId='+encodeURIComponent(requestId));
          if(own!==lifecycle)return status;
          if(operation.requestId!==requestId||!['running','completed','cancelled','failed'].includes(operation.status))throw problem('无法确认本次登录进度，请重新检测。');
          if(operation.status==='running'){announce('等待在官方 Claude Code 打开的浏览器中完成登录…');schedule();return status;}
          pending=null;loginFlight=null;
          if(operation.status==='failed')announce('官方 Claude Code 登录未完成，请重新登录或检测状态。',true);
          if(operation.status==='cancelled')announce('已取消本次登录进程；已完成的官方登录不会被自动退出。');
        }
        const next=validStatus(await request('/__claude/status'));
        if(own!==lifecycle)return status;
        status=next;announce(statusText(),!status.available);return status;
      }catch(e){if(own===lifecycle)announce(e.message,true);throw e;}
      finally{if(own===lifecycle)loading=null;}
    })();loading=work;return work;
  }
  async function signIn(){
    if(mutating||pending)return;
    const own=invalidate(),id=root.crypto.randomUUID();pending=id;mutating=true;logoutConfirmation=false;
    announce('正在请求官方 Claude Code 打开登录…');
    try{
      const flight={id,settled:false,result:null};loginFlight=flight;
      flight.promise=request('/__claude/login',{requestId:id}).then(value=>{flight.result=value;return value;}).finally(()=>{flight.settled=true;});
      const result=await flight.promise;
      if(own!==lifecycle)return;
      if(result.requestId!==id||result.status!=='started'||result.localCLIOnly!==true)throw problem('登录响应无效，请取消后重新检测。');
      announce('等待在官方 Claude Code 打开的浏览器中完成登录…');schedule();
    }catch(e){if(own===lifecycle)announce(e.message+' 可取消本次请求后重新检测。',true);}
    finally{if(own===lifecycle){mutating=false;render();}}
  }
  async function cancel(){
    if(!pending||cancelling)return;
    const id=pending,flight=loginFlight?.id===id?loginFlight:null,own=invalidate();mutating=true;cancelling=true;announce('正在取消本次登录进程…');
    try{
      const validate=result=>{if(result.requestId!==id||typeof result.cancelled!=='boolean')throw problem('无法确认取消结果，请重新检测。');return result;};
      let result=validate(await request('/__claude/cancel',{requestId:id}));
      if(own!==lifecycle)return;
      // Cancellation can reach the server before the login request registers.
      // Keep ownership of that exact ID until its start settles; never claim a
      // stopped process just because the server did not know the ID yet.
      if(!result.cancelled&&flight&&!flight.settled){
        announce('已请求取消；正在等待原登录启动回应，以确认进程已停止…');
        try{await flight.promise;}catch{}
        if(own!==lifecycle)return;
        if(flight.result?.requestId===id&&flight.result.status==='started'&&flight.result.localCLIOnly===true)result=validate(await request('/__claude/cancel',{requestId:id}));
      }
      if(own!==lifecycle)return;
      if(!result.cancelled){
        const operation=await request('/__claude/operation?requestId='+encodeURIComponent(id));
        if(own!==lifecycle)return;
        if(operation.requestId!==id||!['completed','cancelled','failed'].includes(operation.status))throw problem('尚未确认登录进程已停止，请再次取消或重新检测。');
      }
      pending=null;loginFlight=null;status=null;await refresh();
      if(own===lifecycle)announce(loggedIn()?'登录进程已结束；官方 CLI 已登录，取消不等于退出账号。':'已停止等待登录。');
    }catch(e){if(own===lifecycle)announce(e.message,true);}
    finally{if(own===lifecycle){mutating=false;cancelling=false;render();}}
  }
  async function signOut(){
    if(!logoutConfirmation||mutating||pending)return;
    const own=invalidate();mutating=true;logoutConfirmation=false;announce('正在退出本机官方 CLI 账号…');
    try{
      await request('/__claude/logout',{confirmation:true});
      if(own!==lifecycle)return;status=null;await refresh();
      if(own===lifecycle&&status?.loggedIn)throw problem('无法确认账号已退出，请重新检测。');
    }catch(e){if(own===lifecycle)announce(e.message,true);}
    finally{if(own===lifecycle){mutating=false;render();}}
  }
  async function setModel(value){
    if(mutating||savingModel||!models.includes(value))return;
    const state=hooks.getState?.();if(!state)return;state.settings||={};const old=state.settings.claudeModel;
    previousModel=old;savingModel=true;state.settings.claudeModel=value;render();
    let saved=false;
    try{if(await hooks.save?.()===false)throw problem('模型选择未保存，请重试。');saved=true;}
    catch(e){if(state.settings.claudeModel===value){if(old===undefined)delete state.settings.claudeModel;else state.settings.claudeModel=old;}announce(e.message,true);}
    savingModel=false;if(saved)hooks.onChange?.();render();
  }
  async function ensureReady(){
    if(mutating||pending)throw problem('本机 Claude 登录正在变化，请先完成或取消登录。');
    const own=lifecycle;await refresh();
    if(own!==lifecycle||mutating||pending)throw problem('本机 Claude 登录状态已变化，请重试。');
    if(!loggedIn())throw problem(statusText());
  }
  function providerChanged(){clearTimeout(timer);render();if(selected())refresh().catch(()=>{});}
  function init(options){
    hooks=options||{};if(initialized)return;initialized=true;render();
    root.addEventListener?.('pagehide',()=>{invalidate();}, {once:true});
    if(selected())refresh().catch(()=>{});
  }
  root.ClaudeAuth={init,render,model,refresh,ensureReady,providerChanged,signIn,cancel,signOut,setModel,models};
})(typeof globalThis!=='undefined'?globalThis:this);
