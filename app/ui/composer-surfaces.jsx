import React, {useLayoutEffect, useRef} from 'react';
import {Button, TextArea} from './halaska-kit.jsx';
import {KitSelect} from './kit-controls.jsx';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang||'')?en:zh;
export function PdfReadModeControl({id='composerPdfReadMode',value='original',onChange,disabled=false,compact=false}) {
 const description=<p className="pdf-read-mode-description" id={`${id}-description`}>{value==='text'
  ?t('使用可提取文字，按需继续读页；不包含图像或 OCR。实际读取范围见本轮来源记录。','Uses extracted text and reads more pages as needed. No images or OCR. Check this run’s sources for actual coverage.')
  :t('API 连接发送 PDF 原件；账号连接发送页面图像。需要模型支持，不支持时可主动改为读取文字。','API connections send the PDF file; account connections send page images. Requires model support; choose text if unsupported.')}</p>;
 return <div className={`pdf-read-mode-control${compact?' pdf-read-mode-control--compact':''}`}>
  <div className="pdf-read-mode-choice"><label htmlFor={id}>{compact?'PDF':t('PDF 读取方式','PDF reading mode')}</label><KitSelect id={id} label={t('PDF 读取方式','PDF reading mode')} attributes={{'aria-describedby':`${id}-description`}} value={value} disabled={disabled} onChange={next=>{if(!disabled)onChange?.(next);}} options={[
   {value:'original',label:t('发送原件','Send original')},
   {value:'text',label:t('读取文字','Read text')}
  ]}/></div>
  {compact?<details className="pdf-read-mode-help">
   <summary aria-label={t('PDF 读取方式说明','About PDF reading modes')}
    onClick={event=>event.stopPropagation()}
    onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')event.stopPropagation();}}>{t('说明','Details')}</summary>
   {description}
  </details>:description}
 </div>;
}
function Glyph({name}) {
 return <svg className={`kit-composer-glyph kit-composer-glyph--${name}`} aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{name==='attach'?<path d="M12 5v14M5 12h14"/>:name==='folder'?<path d="M3 7V5h7l2 3h9v12H3z"/>:name==='model'?<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></>:name==='shield'?<><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6z"/><path d="m8 12 3 3 5-6"/></>:name==='more'?<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>:name==='mic'?<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6"/></>:name==='stop'?<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>:name==='chevron'?<path d="m7 10 5 5 5-5"/>:<path d="M12 19V5m-6 6 6-6 6 6"/>}</svg>;
}
// Render an actual Kit TextArea before host event listeners are attached.
// It remains uncontrolled: the durable conversation controller owns drafts,
// IME, paste, selection and queueing, so a theme refresh cannot reset typing.
export function ComposerEditor({initialValue='',initialPlaceholder}) {
 const host=useRef(null),first=useRef(true);
 useLayoutEffect(()=>{const input=host.current.querySelector('textarea');input.id='agentInput';input.setAttribute('aria-label',t('发送给 AI 的消息','Message AI'));input.setAttribute('aria-describedby','composerHint');input.setAttribute('enterkeyhint','send');if(first.current){input.value=initialValue;first.current=false;}});
 return <div ref={host} className="kit-composer-editor"><TextArea rows={1} placeholder={t(initialPlaceholder||'发消息，或添加文件与网页…','Message, or add files and webpages…')} style={{gap:0}}/></div>;
}
export function ComposerAction({id,className,label,detail,title,icon,variant='ghost',iconOnly=false,disabled=false,hasPopup}) {
 const host=useRef(null);
 useLayoutEffect(()=>{const button=host.current.querySelector('button');button.className=className||'';if(hasPopup)button.setAttribute('aria-haspopup',hasPopup);});
 return <span ref={host} className="kit-composer-action"><Button id={id} size="sm" variant={variant} disabled={disabled} title={title||label} aria-label={title||label} icon={<Glyph name={icon}/>} iconRight={!iconOnly&&['composerContext','composerModel'].includes(id)?<Glyph name="chevron"/>:undefined} style={{maxWidth:'100%',minWidth:0,gap:6,borderRadius:id==='agentSend'?12:8,height:id==='agentSend'?36:32,padding:iconOnly?'7px':'6px 9px',boxShadow:'none'}}>{!iconOnly&&<span className="kit-composer-copy"><span className="kit-composer-label" data-user-content>{label}</span>{detail&&<small className="kit-composer-detail" data-user-content>{detail}</small>}</span>}</Button></span>;
}

export function ComposerDictationStatus({phase,message,elapsed=0,retryAvailable=false,onStop,onCancel,onRetry,onSettings,onDismiss}) {
 const labels={checking:t('正在读取语音设置…','Checking speech settings…'),authorizing:t('等待麦克风授权…','Awaiting microphone access…'),recording:t('正在录音','Recording'),recorded:t('录音已停止，点击转写','Recording stopped. Transcribe when ready.'),transcribing:t('正在转写…','Transcribing…')};
 const active=['checking','authorizing','recording','recorded','transcribing'].includes(phase),clock=`${Math.floor(elapsed/60)}:${String(Math.floor(elapsed%60)).padStart(2,'0')}`;
 return <div className="composer-dictation-bar">
  <span role="status" aria-live="polite" className="composer-dictation-copy">{phase==='recording'&&<span className="composer-dictation-dot"/>}{message||labels[phase]||''}{phase==='recording'&&<time aria-label={t('录音时长','Recording duration')}>{clock}</time>}</span>
  <div className="composer-dictation-actions">
   {['recording','recorded'].includes(phase)&&<Button size="sm" variant="secondary" onClick={onStop}>{t('转写','Transcribe')}</Button>}
   {phase==='error'&&retryAvailable&&<Button size="sm" variant="secondary" onClick={onRetry}>{t('重试转写','Retry transcription')}</Button>}
   {['error','unconfigured','unavailable'].includes(phase)&&<Button size="sm" variant="ghost" onClick={onSettings}>{t('语音设置','Speech settings')}</Button>}
   <Button size="sm" variant="ghost" onClick={active?onCancel:onDismiss}>{active?t('取消','Cancel'):t('关闭','Dismiss')}</Button>
  </div>
 </div>;
}
