import AppKit
import CryptoKit

/// Explicit writes only. Marker conventions are recognized by AI Bro's existing
/// NativeQuickClipboardPolicy and common password-aware clipboard managers.
@MainActor final class NativeQuickVaultPasteboard {
    static let sensitiveTypes = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "app.aibro.vault.sensitive"]
    static let receiptType = NSPasteboard.PasteboardType("app.aibro.vault.copy-receipt")
    struct Receipt {let id:String;let changeCount:Int;let digest:Data;let expiresAt:Date}
    private let board:NSPasteboard
    private let now:()->Date
    private var timer:Timer?
    private(set) var receipt:Receipt?
    var changeCount:Int {board.changeCount}
    init(board:NSPasteboard = .general,now:@escaping ()->Date = Date.init){self.board=board;self.now=now}
    @discardableResult func copy(_ value:String,expectedChangeCount:Int?=nil)->Bool {
        guard !value.isEmpty,value.utf16.count<=4096 else{return false}
        let item=NSPasteboardItem(),id=UUID().uuidString
        guard item.setString(value,forType:.string),item.setString(id,forType:Self.receiptType) else{return false}
        for type in Self.sensitiveTypes {guard item.setData(Data(),forType:.init(type)) else{return false}}
        // Decryption is asynchronous. A newer copy made meanwhile belongs to
        // the user; checking this lease reads no clipboard content.
        if let expectedChangeCount,board.changeCount != expectedChangeCount{return false}
        // currentHostOnly keeps this explicit copy out of Universal Clipboard.
        board.prepareForNewContents(with:.currentHostOnly)
        guard board.writeObjects([item]) else{return false}
        timer?.invalidate()
        receipt = .init(id:id,changeCount:board.changeCount,digest:Data(SHA256.hash(data:Data(value.utf8))),expiresAt:now().addingTimeInterval(60))
        let timer=Timer(timeInterval:60,repeats:false){[weak self] _ in MainActor.assumeIsolated{self?.expire()}}
        self.timer=timer;RunLoop.main.add(timer,forMode:.common)
        return true
    }
    func expire(){guard let receipt,now()>=receipt.expiresAt else{return};clearOwned()}
    /// Never reads unrelated clipboard text: count and private nonce must match
    /// first. A replacement with even the same text is owned by its new writer.
    func clearOwned(){
        timer?.invalidate();timer=nil
        guard let current=receipt else{return};receipt=nil
        guard board.changeCount==current.changeCount,board.string(forType:Self.receiptType)==current.id,
              let value=board.string(forType:.string),Data(SHA256.hash(data:Data(value.utf8)))==current.digest else{return}
        board.clearContents()
    }
    deinit {timer?.invalidate()}
}
