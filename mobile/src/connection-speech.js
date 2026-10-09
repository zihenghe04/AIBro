import { speechConfiguration, speechCredential, transcribeSpeech } from './speech.js';

export function syncedSpeechConfiguration(profile) {
  if (profile?.purpose !== 'speech' || profile.authKind !== 'api-key') throw Error('语音配置用途不匹配');
  const provider = profile.provider === 'aliyun' && profile.apiFormat === 'aliyun-multimodal' ? 'aliyun'
    : profile.provider === 'openai-compatible' && profile.apiFormat === 'audio-transcriptions' ? 'openai' : null;
  if (!provider) throw Error('手机暂不支持此语音接口。');
  return speechConfiguration({provider,base:profile.baseUrl,model:profile.model,language:profile.language ?? ''});
}

async function connection({store, connectionSync, vault}) {
  if (!store.state.settings.connectionProfiles?.speech) {
    const captured = structuredClone(store.state.settings.speech), config = speechConfiguration(captured);
    const key = await speechCredential(vault, config);
    const scopedVault = { get: async name => { if (name !== 'speech') throw Error('用途不匹配'); return JSON.stringify({ key, scope: config.scope }); } };
    const { credentialRef: _ref, ...scopedConfig } = config;
    return {config: scopedConfig, vault: scopedVault, assertCurrent: async () => { if(store.state.settings.connectionProfiles?.speech || JSON.stringify(store.state.settings.speech) !== JSON.stringify(captured)) throw Error('语音配置已变化，请重新录制。'); }};
  }
  if (!connectionSync) throw Error('请先连接从 Mac 同步的语音配置。');
  const {profile, assertCurrent} = await connectionSync.resolve('speech');
  const config = syncedSpeechConfiguration(profile);
  // Scoped ephemeral adapter: transcribeSpeech cannot persist or read another
  // credential channel, and no synced API key is copied into the legacy slot.
  const scopedVault = {get: async key => {
    if(key !== 'speech') throw Error('语音配置用途不匹配');
    await assertCurrent();
    return JSON.stringify({key:profile.apiKey,scope:config.scope});
  }};
  return {config, vault:scopedVault, assertCurrent};
}
export async function validateSpeechConnection(options) { const c = await connection(options); await c.assertCurrent(); }
export async function transcribeWithConnections(options) {
  const c = await connection(options); await c.assertCurrent();
  const text = await transcribeSpeech({...options,config:c.config,vault:c.vault});
  await c.assertCurrent(); return text;
}
