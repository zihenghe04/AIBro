(() => {
'use strict';
const EN={
  "scenarioHeading": "What are you working on?",
  "scenarioIntro": "Choose a scenario. See what you get.<br>Jump straight to the relevant part of the film.",
  "scenarioTabCourse": "Study a course",
  "scenarioTabResearch": "Find past research",
  "scenarioTabCapture": "Update a quick note",
  "scenarioInputCourse": "Import a lecture. Ask AI for its key ideas and assignments.",
  "scenarioTitleCourse": "Course notes you can keep editing.",
  "scenarioResultCourse": "Core ideas, a learning framework and this week’s work, saved with the course.",
  "scenarioCaptionCourse": "Course notes · Interaction design",
  "scenarioWatchCourse": "From lecture to notes",
  "scenarioFromCourse": "Film from 00:00",
  "scenarioInputResearch": "“What did that study about waiting compare?”",
  "scenarioTitleResearch": "Find that study. Check the source.",
  "scenarioResultResearch": "Find the original source, key figures and citations. Open the page to check.",
  "scenarioCaptionResearch": "Source recall · Low-carbon transport",
  "scenarioWatchResearch": "Find it and check it",
  "scenarioFromResearch": "Film from 00:36",
  "scenarioInputCapture": "Open a saved observation and add field notes.",
  "scenarioTitleCapture": "An observation, saved with its course.",
  "scenarioResultCapture": "Save the added detail, then revisit the earlier course connection.",
  "scenarioCaptionCapture": "Original quick note · Linked to a course",
  "scenarioWatchCapture": "Update a note and revisit its results",
  "scenarioFromCapture": "Film from 00:54",
  "scenarioMaterial": "Actual App · Fictional examples",
  "scenarioPanHint": "Swipe across to explore, or open the full image.",
  "scenarioLoading": "Loading the result image…",
  "scenarioRetry": "Reload image",

  "skip": "Skip to content",
  "nav1": "Workspace",
  "nav2": "How it works",
  "nav3": "Your choices",
  "get": "Get AI Bro",
  "release": "0.9.0 · Mac preview",
  "download": "Download for Mac",
  "tabRead": "Read sources",
  "tabReview": "Edit notes",
  "tabPlan": "Plan tasks",
  "expand": "View larger",
  "value1": "Open the source cited in an answer",
  "value2": "Review AI changes before saving",
  "value3": "Ask about saved sources in a new chat",
  "readTitle": "Read course materials<br>with your questions in mind.",
  "readDesc": "Import your sources and ask AI to explain concepts, compare methods or summarize key points. Open a citation to check the original, with the PDF beside your conversation.",
  "reviewTitle": "Edit your notes.<br>Review each change.",
  "reviewDesc": "Edit text, tables and equations directly, or switch to Markdown source. When AI suggests a change, compare the differences and approve what you want to save.",
  "planTitle": "Describe a task<br>or an event.",
  "planDesc": "Describe your plans, check the time and project, then save. You can also create tasks manually, set deadlines or import an ICS timetable.",
  "possTitle": "A few ways to use AI Bro.",
  "learnTitle": "Organize a course",
  "learnDesc": "Add lecture materials to a course project. Summarize each chapter and its assignments, then ask follow-up questions when revising.",
  "researchTitle": "Prepare a research report",
  "researchDesc": "Read papers and extract methods and findings. When writing your report, ask about earlier reading in your own words and check the cited source.",
  "dailyTitle": "Save a passing thought",
  "dailyDesc": "Capture a quick note. Later, expand it, link it to an existing project or turn it into a task.",
  "controlTitle": "Your workspace is stored on your Mac.<br><span>You choose the model.</span>",
  "localTitle": "Local first",
  "localText": "Materials, conversations, and notes live on your Mac. When you use a remote model, relevant content goes to the service you choose.",
  "modelTitle": "Your choice of model",
  "modelText": "Connect a compatible API or the official local Codex CLI. Model subscriptions and usage credits are provided separately.",
  "syncTitle": "Sync when you want",
  "syncText": "Push and pull supported workspace content through a self-hosted service. SSH provides the connection, not remote file management.",
  "faqTitle": "Common questions",
  "faq1": "Which devices are supported?",
  "faq1A": "The 0.9.0 preview is for Apple Silicon Macs on macOS 14 or later. Python and PDF runtimes are included. This is an ad-hoc signed preview, not Apple-notarized. Read the release instructions before installing.",
  "faq3": "Can I build it or host sync myself?",
  "faq3A": "Yes. AI Bro is open source under AGPL-3.0, with build and self-hosted sync guides. Sync supports personal push and pull, and is not end-to-end encrypted. Model credentials and local directory permissions are not synced.",
  "guide": "Read the guide ↗",
  "downloadTitle": "Bring a source.<br>Ask what you want to understand.",
  "downloadDesc": "Download AI Bro, connect a model and add a source to your first project.",
  "downloadMeta": "Apple Silicon · macOS 14+ · Open-source preview",
  "footerLine": "An AI study and research assistant for Mac",
  "changelog": "Changelog",
  "feedback": "Feedback",
  "filmPlay": "Play the product film",
  "filmFormat": "84 sec · 1080p · Development preview",
  "filmChapterIntro": "Import and summarize",
  "filmChapterWorkspace": "Review notes",
  "filmChapterRead": "Schedule an event",
  "filmChapterWrite": "Find past sources",
  "filmChapterPlan": "Update a quick note",
  "filmChapterClose": "Check tasks",
  "heroStatement": "An AI study and research assistant for Mac",
  "heroDescription": "Read course materials and papers. Write editable notes. Plan tasks and events.",
  "watchFilm": "Watch the 84-second workflow",
  "heroMetaNative": "Local first · Your model · Apple Silicon Mac",
  "explore": "See what you can do",
  "workspaceTitle": "One project for each course.<br><span>Sources and notes, together.</span>",
  "workspaceDesc": "Organize files, conversations and notes by course or research topic.<br>Keep tasks and events in the same project, ready for revision or writing.",
  "overviewCaption": "Actual App interface · Fictional example materials",
  "filmNativeTitle": "Turn a lecture<br><span>into notes and a study plan.</span>",
  "filmNativeDesc": "Watch AI read a source, save notes and schedule an event.<br>Then find earlier research from a new conversation.",
  "filmNativeDisclosure": "Actual App action captures · Fictional materials · Edited across sessions; waiting condensed",
  "downloadFilm": "Download film · About 16 MB",
  "storiesTitle": "Read sources. Write notes.<br><span>Plan what you need to do.</span>",
  "storiesDesc": "Ask a question and keep the answer as a document you can edit.<br>Add the work you need to do as a task or event.",
  "pauseMotion": "Pause page motion",
  "readHook": "Ask for an explanation, an example or a comparison.",
  "readDetails": "Original PDF pages / Citations / Project sources",
  "readerCaption": "Actual reader interface · Fictional materials",
  "reviewHook": "Start with an AI draft. Add your own understanding.",
  "reviewDetails": "Visual editing / Markdown source / Document review",
  "editorCaption": "Actual document interface · Fictional materials",
  "planHook": "“Schedule a 20-minute campus observation for 3 pm tomorrow.”",
  "planDetails": "Project tasks / Calendar / ICS timetables",
  "agendaCaption": "Actual calendar interface · Fictional events",
  "clipNote": "Choreographed from actual App screenshots",
  "openSource": "View the source and build guide",
  "faqNative": "Are these actual App screens?",
  "faqNativeA": "Yes. The film uses actual AI Bro screens with fictional course materials, papers and projects. Actions and waits are edited for length, not shown at real model speed. Some features are in development preview; the current public download is 0.9.0. App screens are in Chinese in both films.",
  "buildSource": "Build from source ↗",
  "footerNative": "Actual isolated App interface · Fictional materials throughout · AGPL-3.0"
};
const originals=new Map([...document.querySelectorAll('[data-t]')].map(el=>[el.dataset.t,el.innerHTML]));
let lang=new URLSearchParams(location.search).get('lang')==='en'?'en':'zh';
const reduced=matchMedia('(prefers-reduced-motion:reduce)');
let motionEnabled=!reduced.matches,opener=null,filmState='idle';
const players=new Map(),dialog=document.getElementById('media-dialog'),film=document.getElementById('workflow-film'),filmButton=document.getElementById('film-start');
const filmChapters=[...document.querySelectorAll('[data-film-time]')];
let filmLanguage=null,filmGeneration=0,pendingFilmSeek=null;
const t=(zh,en)=>lang==='en'?en:zh;
const text=key=>lang==='en'?(EN[key]||originals.get(key)):originals.get(key);
function updatePlayers(){players.forEach(state=>state.update());}
function updateMotion(){
  document.documentElement.classList.toggle('motion-off',!motionEnabled);
  const btn=document.getElementById('motion-toggle');
  btn.setAttribute('aria-pressed',String(motionEnabled));
  btn.innerHTML=`<span aria-hidden="true">${motionEnabled?'Ⅱ':'▶'}</span><span>${motionEnabled?t('暂停页面动效','Pause page motion'):t('启用页面动效','Enable page motion')}</span>`;
  updatePlayers();
}
function localize(){
  document.documentElement.lang=lang==='en'?'en':'zh-CN';
  document.title=t('AI Bro — Mac 上的 AI 学习与研究助手','AI Bro — An AI study and research assistant for Mac');
  document.querySelector('meta[name="description"]').content=t('用 AI 阅读课件与论文，整理带来源的笔记，安排任务和日程。适用于 Mac，本地保存资料，自选模型。','An AI study and research assistant for Mac. Read course materials and papers, write notes with sources, and plan tasks and events.');
  document.querySelectorAll('[data-t]').forEach(el=>{const v=text(el.dataset.t);if(v!=null)el.innerHTML=v;});
  const btn=document.getElementById('language');btn.textContent=lang==='en'?'中':'EN';btn.setAttribute('aria-label',lang==='en'?'切换为简体中文':'Switch to English');
  document.querySelector('.site-header nav').setAttribute('aria-label',t('主导航','Main navigation'));
  document.querySelector('.demo-navigation').setAttribute('aria-label',t('浏览工作流程','Browse workflows'));
  document.getElementById('close-media').setAttribute('aria-label',t('关闭','Close'));
  dialog.setAttribute('aria-label',t('放大 App 界面','Enlarged App interface'));
  film.setAttribute('aria-label',t('AI Bro 产品宣传短片','AI Bro product film'));
  document.querySelector('.film-chapters').setAttribute('aria-label',t('产品短片章节','Product film chapters'));
  filmChapters.forEach(button=>button.setAttribute('aria-label',`${t('播放','Play')} ${button.querySelector('.film-chapter-time').textContent} · ${text(button.querySelector('[data-t]').dataset.t)}`));
  setFilmLanguage();
  document.querySelectorAll('[data-image]').forEach(el=>el.setAttribute('aria-label',`${t('放大：','Enlarge: ')}${text(el.dataset.caption)}`));
  localizeScenarios();
  players.forEach(state=>state.updateButton());updateFilmStatus();updateMotion();
  if(dialog.open&&opener){document.getElementById('expanded-image').alt=text(opener.dataset.caption);document.getElementById('dialog-caption').textContent=text(opener.dataset.caption);updateDialogImageStatus();}
}
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){const state=players.get(entry.target);if(state){state.visible=entry.isIntersecting&&entry.intersectionRatio>=.08;state.update();}}
},{threshold:[0,.08]});
const preload=new IntersectionObserver(entries=>{
  for(const entry of entries){if(entry.isIntersecting&&motionEnabled){players.get(entry.target)?.load();preload.unobserve(entry.target);}}
},{rootMargin:'240px 0px'});
for(const video of document.querySelectorAll('.chapter-video')){
  const frame=video.closest('.clip-frame'),button=frame.querySelector('.clip-play');
  const state={video,visible:false,manualPause:false,manualPlay:false,pending:false,failed:false,
    load(){if(!video.hasAttribute('src')){video.preload='metadata';video.src=video.dataset.src;}},
    allowed(){return this.visible&&!document.hidden&&!dialog.open&&film.paused&&!this.manualPause&&!this.failed&&(motionEnabled||this.manualPlay);},
    updateButton(){
      const caption=text(frame.querySelector('[data-caption]').dataset.caption);
      video.setAttribute('aria-label',`${caption} · ${t('实际界面截图编排','Choreographed from actual App screenshots')}`);
      button.setAttribute('aria-label',this.failed?t('重新加载演示','Retry loading demonstration'):video.paused?t('播放演示','Play demonstration'):t('暂停演示','Pause demonstration'));
      button.innerHTML=`<span aria-hidden="true">${this.failed?'↺':video.paused?'▶':'Ⅱ'}</span>`;
      frame.classList.toggle('is-playing',!video.paused);
      const note=frame.closest('figure').querySelector('.clip-note');
      note.textContent=this.failed?t('短片暂时无法加载。点击重试，或放大查看实际截图。','The clip could not load. Retry, or enlarge the actual screenshot.'):text('clipNote');
      note.setAttribute('role',this.failed?'status':'note');
    },
    update(){if(this.allowed()){this.load();if(video.paused&&!this.pending){this.pending=true;video.play().then(()=>{if(!this.allowed())video.pause();}).catch(()=>{}).finally(()=>{this.pending=false;this.updateButton();});}}else{video.pause();this.updateButton();}}
  };
  video.muted=true;video.defaultMuted=true;video.loop=true;
  video.addEventListener('play',()=>state.updateButton());video.addEventListener('pause',()=>state.updateButton());
  video.addEventListener('loadedmetadata',()=>{state.failed=false;state.updateButton();if(video.videoWidth&&video.videoHeight)video.style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;});
  video.addEventListener('error',()=>{
    state.failed=true;state.manualPlay=false;state.updateButton();
  });
  button.addEventListener('click',()=>{
    if(state.failed){state.failed=false;state.manualPause=false;state.manualPlay=true;state.visible=true;video.load();state.update();return;}
    if(video.paused){state.manualPause=false;state.manualPlay=true;state.visible=true;}else{state.manualPause=true;state.manualPlay=false;}
    state.update();
  });
  players.set(video,state);observer.observe(video);preload.observe(video);
}
document.getElementById('motion-toggle').addEventListener('click',()=>{motionEnabled=!motionEnabled;if(!motionEnabled){players.forEach(state=>{state.manualPlay=false;});film.pause();}updateMotion();});
reduced.addEventListener('change',()=>{motionEnabled=!reduced.matches;if(!motionEnabled)players.forEach(state=>{state.manualPlay=false;});updateMotion();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)film.pause();updatePlayers();});
function setFilmLanguage(){
  if(filmLanguage===lang)return;
  filmGeneration++;filmLanguage=lang;film.pause();pendingFilmSeek=null;filmState='idle';
  film.preload='none';film.src=`assets/film/motion-84-${lang}.mp4?v=motion12-20261003`;film.poster=`assets/film/motion-84-poster-${lang}.jpg?v=motion12-20261003`;
  film.load();filmButton.hidden=false;
  const download=document.getElementById('film-download');download.href=film.getAttribute('src');download.download=`AI-Bro-Workflow-84s-${lang.toUpperCase()}.mp4`;
  updateFilmChapters();
}
function updateFilmChapters(){
  const position=Number.isFinite(film.currentTime)?film.currentTime:0;
  filmChapters.forEach((button,index)=>{
    const start=Number(button.dataset.filmTime),end=Number(filmChapters[index+1]?.dataset.filmTime)||84;
    const active=position>=start&&(position<end||index===filmChapters.length-1);
    if(active)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
    button.style.setProperty('--chapter-progress',`${Math.max(0,Math.min(1,(position-start)/(end-start)))*100}%`);
  });
}
function updateFilmStatus(){
  const status=document.getElementById('film-status');
  status.hidden=filmState!=='error'&&filmState!=='gesture';
  status.textContent=filmState==='error'?t('短片暂时无法加载。请点击重新加载；也可查看下方实际 App 界面。','The film could not load. Retry, or explore the actual App screens below.'):filmState==='gesture'?t('请使用播放器的播放按钮。','Use the player controls to start the film.'):'';
  filmButton.querySelector('[data-t]').textContent=filmState==='error'?t('重新加载短片','Retry loading film'):filmState==='ended'?t('再看一次','Watch again'):text('filmPlay');
  if(filmState==='error'||filmState==='ended')filmButton.hidden=false;
}
function playFilm(time){
  const generation=filmGeneration;
  if(typeof time==='number')pendingFilmSeek=time;
  if(filmState==='error')film.load();
  if(pendingFilmSeek!==null&&film.readyState>=1){film.currentTime=pendingFilmSeek;pendingFilmSeek=null;}
  filmState='idle';filmButton.hidden=true;updateFilmStatus();
  film.play().catch(error=>{
    if(generation!==filmGeneration||error.name==='AbortError')return;
    if(filmState!=='error')filmState='gesture';updateFilmStatus();
  });
}
filmButton.addEventListener('click',()=>playFilm(film.ended?0:undefined));
filmChapters.forEach(button=>button.addEventListener('click',()=>{
  film.scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'center'});
  playFilm(Number(button.dataset.filmTime));
}));
film.addEventListener('play',()=>{filmState='playing';filmButton.hidden=true;updateFilmStatus();updatePlayers();});
film.addEventListener('pause',updatePlayers);
film.addEventListener('timeupdate',updateFilmChapters);
film.addEventListener('ended',()=>{filmState='ended';updateFilmStatus();updateFilmChapters();});
film.addEventListener('seeked',()=>{if(filmState==='ended'&&!film.ended){filmState=film.paused?'idle':'playing';filmButton.hidden=true;updateFilmStatus();}});
film.addEventListener('loadedmetadata',()=>{
  if(pendingFilmSeek!==null){film.currentTime=Math.min(pendingFilmSeek,Number.isFinite(film.duration)?film.duration:84);pendingFilmSeek=null;}
  if(filmState==='error'){filmState='idle';updateFilmStatus();}
  updateFilmChapters();
});
film.addEventListener('error',()=>{filmState='error';updateFilmStatus();});
new IntersectionObserver(entries=>{if(!entries[0].isIntersecting)film.pause();},{threshold:.02}).observe(film);
// Result panels keep the original captures, with a crop only in the page layout.
const scenarioTabs=[...document.querySelectorAll('[data-scenario]')];
const scenarioPanels=[...document.querySelectorAll('[data-scenario-panel]')];
const scenarioImages=new Map();
const sceneNames=['course','research','capture'];
const sceneAlt={
  course:['课程笔记已保存，包含核心思路、四步框架和本周行动。','Saved course notes with key ideas, a four-step framework and this week’s work.'],
  research:['研究资料的自然语言追问，回答列出原资料名称、比较方法、关键数字和引用。','A question about past research. The answer identifies the source, comparison, figures and citations.'],
  capture:['校园候车观察随记已保存，信息栏显示归属交互设计方法课程，原始记录保留。','A saved observation note, linked to the interaction design course. The original text is retained.']
};
function selectScenario(key,{focus=false,remember=false}={}){
  const selected=sceneNames.includes(key)?key:'course';
  scenarioTabs.forEach(tab=>{const active=tab.dataset.scenario===selected;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();});
  scenarioPanels.forEach(panel=>{panel.hidden=panel.dataset.scenarioPanel!==selected;});
  if(remember){const url=new URL(location.href);url.searchParams.set('scene',selected);history.replaceState(null,'',url);}
}
function updateScenarioImage(state){
  const failed=state.status==='error',loading=state.status==='loading';
  state.pan.hidden=failed;state.statusEl.hidden=!failed&&!loading;state.statusEl.classList.toggle('is-loading',loading);
  state.pan.querySelector('button').disabled=failed||loading;
  state.statusEl.querySelector('p').textContent=failed?t('图片暂时无法加载。可以重试，或观看上方对应片段。','The image could not load. Retry, or watch the linked film segment.'):text('scenarioLoading');
  state.retry.hidden=!failed;
}
function localizeScenarios(){
  document.querySelector('.scenario-tabs').setAttribute('aria-label',t('选择使用场景','Choose a scenario'));
  scenarioImages.forEach((state,key)=>{state.image.alt=sceneAlt[key][lang==='en'?1:0];state.pan.setAttribute('aria-label',t('成果图片，可横向滚动或放大','Result image: scroll horizontally or open the full image'));updateScenarioImage(state);});
}
for(const panel of scenarioPanels){
  const key=panel.dataset.scenarioPanel;
  panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`scenario-tab-${key}`);
  const image=panel.querySelector('.scenario-source');
  const state={image,pan:panel.querySelector('.scenario-media-pan'),statusEl:panel.querySelector('.scenario-image-state'),retry:panel.querySelector('.scenario-retry'),status:image.complete?(image.naturalWidth?'loaded':'error'):'loading'};
  scenarioImages.set(key,state);
  image.addEventListener('load',()=>{state.status='loaded';updateScenarioImage(state);if(state.restoreFocus&&!panel.hidden&&document.activeElement===document.body)state.pan.querySelector('button').focus({preventScroll:true});state.restoreFocus=false;});
  image.addEventListener('error',()=>{state.status='error';updateScenarioImage(state);if(state.restoreFocus&&!panel.hidden&&document.activeElement===document.body)state.retry.focus({preventScroll:true});state.restoreFocus=false;});
  state.retry.addEventListener('click',()=>{state.restoreFocus=document.activeElement===state.retry;image.loading='eager';state.status='loading';updateScenarioImage(state);const src=new URL(panel.querySelector('[data-image]').dataset.image,location.href);src.searchParams.set('retry',Date.now());image.src=src.href;});
  updateScenarioImage(state);
}
document.querySelector('.scenario-tabs').hidden=false;
document.getElementById('workspace').classList.add('scenario-ready');
selectScenario(new URLSearchParams(location.search).get('scene'));
scenarioTabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectScenario(tab.dataset.scenario,{remember:true}));
  tab.addEventListener('keydown',event=>{
    let next;if(event.key==='ArrowRight')next=(index+1)%scenarioTabs.length;else if(event.key==='ArrowLeft')next=(index-1+scenarioTabs.length)%scenarioTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=scenarioTabs.length-1;else return;
    event.preventDefault();selectScenario(scenarioTabs[next].dataset.scenario,{focus:true,remember:true});
  });
});
document.querySelectorAll('[data-scene-film]').forEach(link=>link.addEventListener('click',event=>{
  event.preventDefault();film.scrollIntoView({behavior:reduced.matches||!motionEnabled?'instant':'smooth',block:'center'});
  film.tabIndex=-1;film.focus({preventScroll:true});playFilm(Number(link.dataset.sceneFilm));
}));
const expandedImage=document.getElementById('expanded-image'),dialogImageStatus=document.getElementById('dialog-image-status');
let dialogImageFailed=false;
function updateDialogImageStatus(){
  dialogImageStatus.hidden=!dialogImageFailed;expandedImage.hidden=dialogImageFailed;
  dialogImageStatus.querySelector('p').textContent=t('图片暂时无法加载，请重试。','The image could not load. Please retry.');
}
expandedImage.addEventListener('load',()=>{dialogImageFailed=false;updateDialogImageStatus();});
expandedImage.addEventListener('error',()=>{dialogImageFailed=true;updateDialogImageStatus();});
document.getElementById('dialog-image-retry').addEventListener('click',()=>{if(!opener)return;const src=new URL(opener.dataset.image,location.href);src.searchParams.set('retry',Date.now());dialogImageFailed=false;updateDialogImageStatus();expandedImage.src=src.href;});
for(const trigger of document.querySelectorAll('[data-image]')){
  trigger.addEventListener('click',()=>{
    opener=trigger;dialogImageFailed=false;updateDialogImageStatus();expandedImage.src=trigger.dataset.image;expandedImage.alt=text(trigger.dataset.caption);
    document.getElementById('dialog-caption').textContent=text(trigger.dataset.caption);film.pause();dialog.showModal();updatePlayers();
  });
}
function closeDialog(){dialog.close();opener?.focus();updatePlayers();}
document.getElementById('close-media').addEventListener('click',closeDialog);
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
document.getElementById('language').addEventListener('click',()=>{lang=lang==='zh'?'en':'zh';const url=new URL(location.href);if(lang==='en')url.searchParams.set('lang','en');else url.searchParams.delete('lang');history.pushState(null,'',url);localize();});
window.addEventListener('popstate',()=>{const params=new URLSearchParams(location.search);lang=params.get('lang')==='en'?'en':'zh';selectScenario(params.get('scene'));localize();});
const reveals=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){entry.target.classList.add('is-revealed');reveals.unobserve(entry.target);}}},{threshold:.06});
if(!reduced.matches){document.querySelectorAll('.section-heading,.native-overview,.story-copy,.story-media,.use-cases article,.control>div,.faq>h2,.faq-list').forEach(el=>{if(el.getBoundingClientRect().top>window.innerHeight){el.classList.add('reveal-in');reveals.observe(el);}});}
const chapterObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){document.querySelectorAll('.demo-navigation a').forEach(a=>a.classList.toggle('is-current',a.hash===`#${entry.target.id}`));}}},{rootMargin:'-15% 0px -45% 0px',threshold:0});
document.querySelectorAll('.story').forEach(el=>chapterObserver.observe(el));
localize();
})();
