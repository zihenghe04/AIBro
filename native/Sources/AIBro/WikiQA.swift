import Foundation
import WebKit
extension Workspace {
    func wikiLinkQA(_ destination:String) async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] != nil else{return}
        let info=try await web.callAsyncJavaScript("const a=state.notes.find(n=>n.wikiOriginalName==='one.md'),b=state.notes.find(n=>n.wikiOriginalName==='two.md');return {a:a.id,b:b.id,path:state._wikiFiles[b.id].path}",arguments:[:],in:nil,contentWorld:.page) as! [String:String]
        let vault=dataDirectory.appendingPathComponent("vault/research"),before=vault.appendingPathComponent(info["path"]!)
        let after=vault.appendingPathComponent("concepts/moved/two.md")
        try FileManager.default.createDirectory(at:after.deletingLastPathComponent(),withIntermediateDirectories:true)
        try FileManager.default.moveItem(at:before,to:after)
        let result=try await web.callAsyncJavaScript("""
        const wait=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,50));}throw Error('Wiki repair timed out');};
        await refreshWikiVault();if(ResearchWiki.resolveLink(state,a,'two.md')!==b)throw Error('Moved identity lost');
        const original=state.notes.find(n=>n.id===a).content;await WikiMaintenance.open();
        document.querySelector('[data-wiki-repair="'+a+'"]').click();await wait(()=>state.notes.find(n=>n.id===a).aiDraft);
        await saveDocumentDurably();if(state.notes.find(n=>n.id===a).content!==original)throw Error('Draft overwrote body');
        document.querySelector('#wikiMaintenanceDialog').close();openPreview('note',a);
        await wait(()=>document.querySelector('[data-note-action=apply-ai]'));
        document.querySelector('[data-note-action=apply-ai]').click();document.querySelector('[data-note-action=save]').click();
        await wait(()=>!state.notes.find(n=>n.id===a).aiDraft);await saveDocumentDurably();await refreshWikiVault();
        const n=state.notes.find(n=>n.id===a);if(!n.content.includes('concepts/moved/two.md')||!n.revisionHistory?.some(h=>h.content===original))throw Error('Repair/history missing');
        return {path:state._wikiFiles[a].path,content:n.content};
        """,arguments:["a":info["a"]!,"b":info["b"]!],in:nil,contentWorld:.page) as! [String:String]
        let bytes=try String(contentsOf:vault.appendingPathComponent(result["path"]!),encoding:.utf8)
        guard bytes.hasSuffix(result["content"]!) else{throw CocoaError(.fileReadCorruptFile)}
        try "PASS: physical target move, stable link navigation, reviewed repair draft, adoption/history and persisted Markdown".write(toFile:destination+"-wiki-links.txt",atomically:true,encoding:.utf8)
    }
}
