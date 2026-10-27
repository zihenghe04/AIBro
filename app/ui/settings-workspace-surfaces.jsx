import React from 'react';
import { Heading, Text, Caption } from './halaska-kit.jsx';
import { KitTabs } from './kit-controls.jsx';
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;

export function SettingsNavigation({ selected = 'models', onSelect }) {
  const sections = [
    { value: 'models', label: t('模型', 'Models'), description: t('添加供应商、选默认模型；权限和用量单价在页面底部保存。', 'Add providers and pick defaults. Permissions and usage prices are saved at the bottom.'), hint: '' },
    { value: 'sync', label: t('服务器同步', 'Server sync'), description: t('通过 SSH 连接工作区同步服务，管理设备与同步状态。', 'Connect a workspace sync service over SSH and manage devices and sync.'), hint: t('可选 · 工作区同步，不是远端 Agent 执行', 'Optional · workspace sync, not remote agent execution') },
    { value: 'knowledge', label: t('知识库检索', 'Knowledge search'), description: t('关键词检索可直接使用；需要语义检索时，再配置独立的 Embedding 服务。', 'Keyword search is ready to use. Configure a separate embedding service for semantic search.'), hint: t('可选 · 独立保存与测试', 'Optional · saved and tested separately') },
    { value: 'plugins', label: t('插件', 'Plugins'), description: t('内置插件的启停，以及你手动添加的本机 MCP 服务器。', 'Turn built-in plugins on or off, and manage local MCP servers you add yourself.'), hint: t('下次运行生效 · 只存本机', 'Applies from the next run · this Mac only') },
    { value: 'appearance', label: t('界面偏好', 'Preferences'), description: t('调整语言、动态效果和提示音，让工作台更适合你的习惯。', 'Adjust language, motion and sounds to suit your workflow.'), hint: t('修改后立即生效', 'Changes apply immediately') },
  ];
  const current = sections.find(item => item.value === selected) || sections[0];
  return <div className="settings-navigation-kit">
    <div className="settings-tabs-scroll"><KitTabs label={t('设置分区', 'Settings sections')} value={selected} onChange={onSelect}
      options={sections.map(({ value, label }) => ({ value, label, id: `settings-tab-${value}`, controls: `settings-panel-${value}` }))} /></div>
    <div className="settings-section-intro"><div><Heading level={2} style={{ fontSize: 20, margin: 0 }}>{current.label}</Heading>
      <Text as="p" secondary size="sm" style={{ margin: '6px 0 0', lineHeight: 1.65 }}>{current.description}</Text></div>
      {current.hint ? <Caption>{current.hint}</Caption> : null}</div>
  </div>;
}
