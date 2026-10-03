import Foundation
import AppKit

func nativeUI(_ zh:String,_ en:String)->String {en}
struct CheckFailure:Error {let message:String}
@main struct Main {
    @MainActor static func main() throws {
        var checks=0
        func check(_ value:Bool,_ message:String) throws {
            guard value else{throw CheckFailure(message:message)};checks+=1;print("PASS \(message)")
        }
        let owner=NSObject(),other=NSObject(),cache=NativeQuickRecordingProjection.Cache()
        var rows=[NativeQuickRecordingItem(id:"a",title:"COURSE",createdAt:Date(timeIntervalSince1970:1),duration:60,transcript:String(repeating:"正文",count:40000)+"尾部标记",state:"ready",category:"课程"),
                  .init(id:"b",title:"Research",createdAt:Date(timeIntervalSince1970:2),duration:60,transcript:"Hypothesis",state:"ready",category:"科研"),
                  .init(id:"c",title:"Deleted",createdAt:Date(timeIntervalSince1970:3),duration:60,transcript:"Archived",state:"ready",deletedAt:Date(),category:"旧分类")]
        func resolve(_ query:String="",_ deleted:Bool=false,_ category:String?=nil,_ available:Bool=true,_ identity:NSObject?=nil)->NativeQuickRecordingProjection.Result {
            cache.resolve(owner:ObjectIdentifier(identity ?? owner),available:available,items:rows,query:query,showingDeleted:deleted,category:category)
        }
        var result=resolve()
        try check(result.items.map(\.id)==["a","b"] && result.activeCount==2,"original order, active count and deleted exclusion are retained")
        try check(Set(result.categories)==["课程","科研"],"category menu comes from the current collection")
        result=resolve("尾部标记")
        try check(result.items.map(\.id)==["a"] && result.items[0].transcript==rows[0].transcript,"search reaches complete transcript tail without shortening returned text")
        let beforeMeters=cache.rebuildCount
        for _ in 0..<200 { _ = resolve("尾部标记") }
        try check(cache.rebuildCount==beforeMeters,"unchanged list inputs across meter/body evaluations perform no full-text rebuild")
        _=resolve("  尾部标记  ")
        try check(cache.rebuildCount==beforeMeters,"equivalent trimmed query reuses the exact projection")
        try check(resolve("course").items.map(\.id)==["a"],"title search preserves localized case-insensitive behavior")
        try check(resolve("hypothesis",false,"科研").items.map(\.id)==["b"],"query and category are jointly applied immediately")
        try check(resolve("",true).items.map(\.id)==["c"] && resolve("",true).categories==["旧分类"],"trash query and categories recompute for the deleted collection")
        rows[1].category=nil
        try check(resolve("",false,"").items.map(\.id)==["b"],"cleared category is immediately selectable as uncategorized")
        let date=rows[0].createdAt;rows[0].transcript="Changed without new ID or timestamp"
        try check(resolve("尾部标记").items.isEmpty && rows[0].createdAt==date,"in-place content changes invalidate without relying on ID or timestamp")
        rows[0].title="New heading"
        try check(resolve("new heading").items.map(\.id)==["a"],"manual title changes immediately update search")
        rows[0].deletedAt=Date()
        try check(resolve().items.map(\.id)==["b"] && resolve().activeCount==1,"soft deletion immediately updates results and count")
        rows[0].deletedAt=nil;rows.reverse()
        try check(resolve().items.map(\.id)==["b","a"],"restore and changed canonical order are reflected immediately")
        let warm=cache.rebuildCount;rows=Array(rows)
        _=resolve();try check(cache.rebuildCount==warm,"equal-value array replacement does not redo full-text search")
        let hidden=resolve("",false,nil,false)
        try check(hidden.items.isEmpty && hidden.categories.isEmpty && hidden.activeCount==0,"unavailable/private projection immediately clears every visible field")
        _=resolve();try check(cache.rebuildCount==warm+1,"availability restoration rebuilds rather than retaining the hidden projection")
        let beforeOwner=cache.rebuildCount;_=resolve("",false,nil,true,other)
        try check(cache.rebuildCount==beforeOwner+1,"replacement store owner cannot reuse the prior owner's projection")
        cache.clear();let beforeMount=cache.rebuildCount;_=resolve()
        try check(cache.rebuildCount==beforeMount+1,"unmount release forces a fresh projection on remount")
        try check(NSApp==nil,"projection checks do not create an App or access audio devices")

        var performance:[[String:Any]]=[]
        for count in [16,64] {
            let text=String(repeating:"课堂讨论材料归纳与复习安排。",count:1024)
            let items=(0..<count).map{NativeQuickRecordingItem(id:String($0),title:"Synthetic recording \($0)",createdAt:Date(timeIntervalSince1970:0),duration:60,transcript:text,state:"ready")}
            let measured=NativeQuickRecordingProjection.Cache()
            var times:[Double]=[];var matches=0
            for _ in 0..<3 {
                let start=DispatchTime.now().uptimeNanoseconds
                for _ in 0..<6 {matches += measured.resolve(owner:ObjectIdentifier(owner),available:true,items:items,query:"量子计算",showingDeleted:false,category:nil).items.count}
                times.append(Double(DispatchTime.now().uptimeNanoseconds-start)/1_000_000)
            }
            try check(measured.rebuildCount==1 && matches==0,"\(count)-row repeated body work performs exactly one real full-text pass")
            performance.append(["rows":count,"transcriptUTF8Bytes":text.utf8.count*count,"callsPerEvaluation":6,"elapsedMilliseconds":times,"rebuilds":measured.rebuildCount])
        }
        let data=try JSONSerialization.data(withJSONObject:["scope":"same bounded synthetic corpus as baseline; optimized actual production cache; not native FPS","results":performance],options:[.prettyPrinted,.sortedKeys])
        if CommandLine.arguments.count>1 {try data.write(to:URL(fileURLWithPath:CommandLine.arguments[1]),options:.atomic)}
        print("PASS \(checks) recording projection checks; no GUI, devices or user data")
    }
}
