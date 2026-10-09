// Instrumentation-only entry point. Bundled into the test APK, never a product
// asset. Production imports perform every WebCrypto/native-vault/network step.
import { Bridge, adapter, vault, http, native } from '../../src/platform.js';
import { Store } from '../../src/store.js';
import { createConnectionManager } from '../../src/connection-sync.js';
import { transcribeWithConnections } from '../../src/connection-speech.js';

async function transcribe() {
  if (!native || !globalThis.Capacitor?.isNativePlatform() || !globalThis.crypto?.subtle)
    throw Error('Actual native WebView and WebCrypto required');
  const store = await new Store(adapter).load();
  // Read-only hydrated Store: a second manager cannot race a workspace save.
  const manager = createConnectionManager({store,vault,bridge:Bridge,http,native,
    cryptoAPI:globalThis.AIBroConnectionVault.createConnectionVault()});
  const wav = new Uint8Array(44 + 16000); // 0.5 s of synthetic silent PCM at 16 kHz.
  const view = new DataView(wav.buffer), ascii=(at,s)=>[...s].forEach((c,i)=>wav[at+i]=c.charCodeAt(0));
  ascii(0,'RIFF');view.setUint32(4,wav.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  ascii(36,'data');view.setUint32(40,wav.length-44,true);
  let binary='';for(const byte of wav)binary+=String.fromCharCode(byte);
  const text = await transcribeWithConnections({store,connectionSync:manager,vault,http,
    audio:{durationMs:500,data:btoa(binary),mimeType:'audio/wav'}});
  return {text,native:true,webCrypto:!!crypto.subtle,profileId:store.state.settings.connectionProfiles?.speech?.profileId,
    legacySpeechSlotEmpty:(await vault.get('speech'))===null};
}
globalThis.NativeConnectionWorkflowQA = Object.freeze({transcribe});
