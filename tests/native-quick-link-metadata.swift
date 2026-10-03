import Foundation
import AppKit
func nativeUI(_ zh:String,_ en:String)->String{en}
@main struct MetadataNativeChecks {
 @MainActor static func main() async throws {
  var n=0
  func check(_ condition:Bool,_ name:String)throws{guard condition else{throw NSError(domain:name,code:1)};n+=1;print("PASS \(name)")}
  let directory=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
  let icon="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgaar4DwADqgIGRYRp+QAAAABJRU5ErkJggg=="
  let row:[String:Any]=["id":"existing","title":"Manual title","url":"https://example.org","site":"example.org","folder":"Reading","workspace":"科研","projectTitle":"","version":"v1","createdAt":1,"hasContent":true,"order":0,"iconDataUrl":icon,"metadataStatus":"ready","siteDescription":"A source description"]
  let listed:[String:Any]=["status":"ready","rows":[row],"groups":[],"projects":[],"trash":[]]
  func saved(_ p:[String:Any],status:String="ready")->[String:Any]{["status":"saved","requestId":p["requestId"]!,"action":"metadata","ids":["existing"],"metadataStatus":status,"metadataError":"Website unavailable","iconStatus":"ready"]}
  let store=NativeQuickLinksStore();var requests=0,fail=false,wrong=false,revoke=false,last:[String:Any]=[:]
  store.configure(directory:directory,request:{p in
   if p["action"] as? String=="list"{return listed}
   requests+=1;last=p
   let persisted=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("native-quick-links-draft.json"))) as! [String:Any]
   try check(persisted["pending"] != nil,"metadata request is durable before bridge dispatch")
   if revoke{store.setAvailable(false)}
   if fail{throw NativeQuickLinksError.unconfirmed}
   return saved(p,status:wrong ? "unknown":"ready")
  },openSource:{_ in true},openURL:{_ in true});store.setAvailable(true);await store.refresh()
  try check(store.rows[0].iconDataUrl==icon && store.rows[0].hasContent,"native projection decodes metadata while retaining saved-body status")
  await store.fetchMetadata(store.rows[0]);try check(requests==1 && store.pending==nil && store.notice?.contains("icon saved") == true,"matching saved metadata ACK settles exact native request")
  store.beginEditing(store.rows[0]);store.title="Unsent title";await store.fetchMetadata(store.rows[0]);try check(requests==1 && store.title=="Unsent title","unsent title draft blocks metadata fetch")
  store.discardDraft()
  wrong=true;await store.fetchMetadata(store.rows[0]);try check(store.pending != nil,"unknown metadata receipt leaves original pending envelope")
  wrong=false;await store.retry();try check(store.pending==nil,"exact retained metadata envelope accepts a later valid ACK")
  fail=true;await store.fetchMetadata(store.rows[0]);let operation=last["requestId"] as! String
  let restored=NativeQuickLinksStore();restored.configure(directory:directory,request:{p in
   if p["action"] as? String=="list"{return listed}
   try check(p["requestId"] as? String==operation,"metadata retry after restart preserves the original operation ID")
   return saved(p)
  },openSource:{_ in true},openURL:{_ in true});restored.setAvailable(true);await restored.retry();try check(restored.pending==nil,"restart metadata retry settles without creating a second native operation")
  fail=false;store.discardDraft();revoke=true;await store.fetchMetadata(store.rows[0]);try check(store.pending != nil && store.rows.isEmpty && store.notice==nil && store.error==nil,"private revoke during await preserves pending request and does not publish late receipt or error")
  try check(NativeQuickLinkIcon.decode(icon)?.width==1,"native offline icon decodes a real small PNG")
  try check(NativeQuickLinkIcon.decode("https://example.org/icon.png")==nil && NativeQuickLinkIcon.decode("data:image/svg+xml;base64,PHN2Zz4=")==nil,"native icon has no remote URL or SVG decode path")
  print("\(n) native metadata checks")
 }
}
