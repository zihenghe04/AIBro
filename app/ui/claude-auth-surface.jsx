import React from 'react';
import {Button,Caption,Heading,Label} from './halaska-kit.jsx';
import {KitSelect} from './kit-controls.jsx';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang||'')?en:zh;
export function ClaudeAuthSurface({status,error,model,available,authenticated,pending,busy,logoutConfirmation,onRefresh,onLogin,onCancel,onRequestLogout,onDismissLogout,onConfirmLogout,onModel}){
  return <section className="auth-account-card" aria-label={t('Claude 官方账号','Official Claude account')}>
    <Heading level={3}>{t('连接本机 Claude Code','Connect local Claude Code')}</Heading>
    <p>{t('由未修改的官方 Claude Code 打开浏览器登录。仅在这台 Mac 使用，不会把订阅登录同步给手机。','The unmodified official Claude Code opens browser login. This account is used on this Mac only and is not copied to your phone.')}</p>
    <p id="claudeAuthStatus" className={error?'auth-status auth-error':'auth-status'} role={error?'alert':'status'} aria-live="polite">{status}</p>
    <div className="auth-account-actions">
      {!authenticated&&!pending&&<Button id="claudeSignIn" disabled={busy||!available} onClick={onLogin}>{t('使用 Claude 账号登录','Sign in with Claude')}</Button>}
      {pending&&<Button id="claudeCancelLogin" variant="secondary" onClick={onCancel}>{t('取消登录进程','Cancel login process')}</Button>}
      {authenticated&&!pending&&<Button id="claudeSignOut" variant="secondary" disabled={busy} onClick={onRequestLogout}>{t('退出本机 CLI 账号','Sign out of local CLI')}</Button>}
      <Button id="claudeRefreshStatus" variant="ghost" disabled={busy} onClick={onRefresh}>{t('重新检测','Refresh status')}</Button>
    </div>
    {logoutConfirmation&&<section role="group" aria-label={t('确认退出本机账号','Confirm local sign out')}>
      <p>{t('这会退出本机官方 Claude Code 共用的登录，也会影响你在终端使用该账号。确认退出？','This signs out the account shared with official Claude Code, including terminal usage. Sign out?')}</p>
      <Button id="claudeConfirmSignOut" variant="danger" disabled={busy} onClick={onConfirmLogout}>{t('确认退出','Confirm sign out')}</Button>
      <Button variant="ghost" disabled={busy} onClick={onDismissLogout}>{t('保留登录','Stay signed in')}</Button>
    </section>}
    <Label>{t('模型别名','Model alias')}</Label>
    <KitSelect id="claudeModel" label={t('Claude 模型别名','Claude model alias')} value={model} onChange={onModel} disabled={busy} options={[
      {value:'',label:t('官方默认（不指定模型）','Official default (no override)')},
      ...['sonnet','opus','haiku'].map(value=>({value,label:value}))]} />
    <Caption>{t('这些是官方模型别名，不是账号可用模型目录；具体模型与额度由 Claude Code 决定。','These are official aliases, not an account model catalogue. Claude Code determines the exact model and availability.')}</Caption>
    <p className="setting-help">{t('当前连接发送文字并使用默认推理。图片和 PDF 原件不受支持；PDF 可明确选择“读取文字”。AI Bro 的资料读取与修改仍走宿主审批流程；没有接入 CLI 原生 MCP 工具。','This connection sends text with default reasoning. Images and original PDFs are unsupported; PDFs can explicitly use Read text. AI Bro handles knowledge and reviewed changes through its host workflow, not CLI-native MCP tools.')}</p>
  </section>;
}
