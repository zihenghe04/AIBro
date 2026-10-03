import Foundation
import CryptoKit

// Selection behavior adapted from TO-DO Panel (MIT), renderer/workspace.js
// 2013–2049 and Domain.updateRangeSelection. Persistence below is AI Bro's
// reversible manifest transaction; upstream's audio unlink is not reused.
struct NativeQuickRecordingSelection: Equatable {
    private(set) var ids:Set<String>=[]
    private(set) var anchor:String?
    mutating func clear(){ids=[];anchor=nil}
    mutating func reconcile(_ order:[String]){ids.formIntersection(Set(order));if let anchor,!order.contains(anchor){self.anchor=nil}}
    mutating func anchor(_ id:String){anchor=id}
    mutating func all(_ order:[String]){ids=Set(order);anchor=order.first}
    mutating func select(_ id:String,order:[String],extending:Bool=false,toggling:Bool=false){
        reconcile(order);guard let end=order.firstIndex(of:id) else{return}
        if extending,let anchor,let start=order.firstIndex(of:anchor){ids.formUnion(order[min(start,end)...max(start,end)])}
        else{if toggling{if !ids.insert(id).inserted{ids.remove(id)}}else{ids=[id]};anchor=id}
    }
}
enum NativeQuickRecordingBatchAction:Codable,Equatable {case categorize(String?),trash,restore}
struct NativeQuickRecordingBatchTarget:Codable,Equatable {let id:String;let fingerprint:String}
struct NativeQuickRecordingBatchRequest:Equatable {
    let id:String
    let targets:[NativeQuickRecordingBatchTarget]
    let action:NativeQuickRecordingBatchAction
    init(targets:[NativeQuickRecordingBatchTarget],action:NativeQuickRecordingBatchAction){id=UUID().uuidString.lowercased();self.targets=targets;self.action=action}
}
struct NativeQuickRecordingBatchUndo:Codable,Equatable {
    struct Target:Codable,Equatable {
        let id:String
        let fingerprint:String
        let category:String?
        let deletedAt:Date?
    }
    let id:String
    let action:NativeQuickRecordingBatchAction
    let createdAt:Date
    let targets:[Target]
}
enum NativeQuickRecordingBatchError:LocalizedError {
    case changed,unavailable,invalidCategory
    var errorDescription:String? {
        switch self {
        case .changed:return nativeUI("所选录音已变化，未执行批处理。请重新选择。","Selected recordings changed. Nothing was changed; select them again.")
        case .unavailable:return nativeUI("请先结束录音、转写或编辑，再处理这些录音。","Finish recording, transcription or editing before changing these recordings.")
        case .invalidCategory:return nativeUI("分类最多 40 个字符，不能包含换行。","Use a category of at most 40 characters without line breaks.")
        }
    }
}
extension NativeQuickRecordingItem {
    var categoryName:String {category ?? ""}
    var batchFingerprint:String {
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        return (try? encoder.encode(self)).map{SHA256.hash(data:$0).map{String(format:"%02x",$0)}.joined()} ?? ""
    }
    var batchTarget:NativeQuickRecordingBatchTarget {.init(id:id,fingerprint:batchFingerprint)}
}

struct NativeQuickRecordingCategoryDraft:Equatable {
    let targets:[NativeQuickRecordingBatchTarget]
    var text:String
}
struct NativeQuickRecordingTitleDraft:Equatable {
    let id:String
    var text:String
}
