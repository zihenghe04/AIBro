const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('dictation, shared recording sheet, native desktop, quick panel and shortcut interfaces typecheck',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const root=path.resolve(__dirname,'..');
 const names=['NativeQuickRecordingPlayback','NativeQuickRecordingProjection','NativeQuickRecordingTitle','NativeQuickRecordingBatch','NativeQuickRecordingStore','NativeQuickRealtimeASRHandoff','NativeQuickRealtimeASRProtocol','NativeQuickRealtimeASRSession','NativeQuickRealtimeASRSettings','NativeQuickRealtimeASRAudio','NativeQuickRealtimeASRView','NativeQuickRecordingViews','NativeQuickWidgetContext','NativeSpeechService','NativeSpeechCredentials','NativeSpeechSettingsView','NativeCredentials','AgendaCore','AgendaSync','AgendaEditing','AgendaStore','OverviewTasks','AgendaAgentAccess','AgendaAgentReview','NativeSpeechDictation','NativeSpeechDictationRecorder','NativeDesktop','NativeQuickPanelAgent','NativeVoiceCommandCoordinator','NativeVoiceCommandPanel','NativeVoiceWorkspace','NativeQuickShortcut','NativeSpeechShortcut','NativeSpeechShortcutView'];
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-speech-integration-'));
 try {
 const source=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
 const palette=source.match(/enum StudioPalette \{[^]*?\n\}/)?.[0];assert.ok(palette,'real native palette exists');
 const paletteFile=path.join(temp,'Palette.swift');fs.writeFileSync(paletteFile,'import AppKit\nimport SwiftUI\n'+palette);
 const review=fs.readFileSync(path.join(root,'native/Sources/AIBro/AgendaCreationReview.swift'),'utf8').split('/// A sheet owned')[0];
 assert.match(review,/struct AgendaCreationReview:Identifiable/);
 const reviewFile=path.join(temp,'ReviewModel.swift');fs.writeFileSync(reviewFile,review);
 const result=spawnSync('xcrun',['swiftc','-typecheck','-target','arm64-apple-macosx14.0','-swift-version','5',...names.map(x=>path.join(root,'native/Sources/AIBro',x+'.swift')),path.join(__dirname,'native-speech-dictation-host-stubs.swift'),paletteFile,reviewFile],{encoding:'utf8',timeout:110000});
 if(result.stderr)process.stdout.write(result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
