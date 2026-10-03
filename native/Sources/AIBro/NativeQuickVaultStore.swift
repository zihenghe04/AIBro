import Foundation
import Combine

@MainActor final class NativeQuickVaultStore:ObservableObject {
    enum CopyField {case account,password}
    @Published private(set) var rows:[NativeQuickVaultRow]=[]
    @Published private(set) var available=false
    @Published private(set) var loaded=false
    @Published private(set) var draft:NativeQuickVaultDraft?
    @Published private(set) var revealedID:String?
    @Published private(set) var revealedPassword:String?
    @Published private(set) var error:String?
    @Published private(set) var notice:String?
    @Published private(set) var busy=false
    @Published private var writeLeases=Set<Int>()
    private var worker:NativeQuickVaultWorker?
    private var requestedDirectory:URL?
    private var identity:String?
    private var generation=0
    private var visible=false
    private var gate:NativeQuickVaultAccessGate?
    private var loadingTask:Task<Void,Never>?
    private let pasteboard:NativeQuickVaultPasteboard
    private let archiveFactory:(URL,String)->NativeQuickVaultArchive
    init(pasteboard:NativeQuickVaultPasteboard? = nil,archiveFactory:@escaping (URL,String)->NativeQuickVaultArchive = {NativeQuickVaultArchive(directory:$0,identity:$1)}){self.pasteboard=pasteboard ?? NativeQuickVaultPasteboard();self.archiveFactory=archiveFactory}
    var hasEditor:Bool {draft != nil || !writeLeases.isEmpty}
    func flushForQuit()->Bool {draft == nil && writeLeases.isEmpty}
    func configure(directory:URL,identity:String){
        guard worker==nil || (requestedDirectory==directory && self.identity==identity) else{setAvailable(false);error=message(NativeQuickVaultError.unavailable);return}
        guard worker==nil else{return};requestedDirectory=directory;self.identity=identity
        worker=NativeQuickVaultWorker(archive:archiveFactory(directory,identity))
    }
    private func revoke(){generation+=1;gate?.revoke();gate=nil;loadingTask?.cancel();loadingTask=nil;busy=false}
    func setAvailable(_ value:Bool){
        let next=value && worker != nil
        guard available != next else{return};available=next;revoke()
        if next {if visible{reload()}}
        else {rows=[];loaded=false;conceal();pasteboard.clearOwned();notice=nil;error=nil}
    }
    func setVisible(_ value:Bool){
        if visible != value {revoke()};visible=value
        if value && available {reload()}
        else {conceal();rows=[];loaded=false;notice=nil}
    }
    func shutdown(){setAvailable(false);visible=false}
    private func begin(writing:Bool)->(Int,NativeQuickVaultAccessGate)? {
        guard available,visible,!busy else{return nil}
        generation+=1;let gate=NativeQuickVaultAccessGate();self.gate=gate;busy=true;if writing{writeLeases.insert(generation)}
        return (generation,gate)
    }
    private func current(_ token:Int,_ gate:NativeQuickVaultAccessGate)->Bool{generation==token && gate.isValid && available && visible}
    private func end(_ token:Int){writeLeases.remove(token);if generation==token{gate=nil;busy=false;loadingTask=nil}}
    func reload(){
        guard let worker,let (token,gate)=begin(writing:false) else{return};conceal()
        loadingTask=Task{[weak self] in
            do {
                let rows=try await worker.list(gate)
                guard let self,self.current(token,gate) else{return}
                self.rows=rows;self.loaded=true;self.error=nil
            }catch{if let self,self.current(token,gate){self.rows=[];self.loaded=false;self.error=self.message(error)}}
            self?.end(token)
        }
    }
    func beginNew(){guard available,visible,loaded,!busy,draft==nil else{return};conceal();draft = .init(id:UUID().uuidString,expectedRevision:nil);error=nil;notice=nil}
    func beginEdit(_ row:NativeQuickVaultRow){
        guard available,visible,loaded,!busy,draft==nil,rows.contains(row) else{return}
        conceal();draft = .init(id:row.id,expectedRevision:row.revision,service:row.service,account:row.account);error=nil;notice=nil
    }
    func updateDraft(service:String?=nil,account:String?=nil,password:String?=nil){
        guard available,visible,!busy,var value=draft else{return}
        if let service{value.service=service};if let account{value.account=account};if let password{value.password=password}
        value.operationID=UUID().uuidString;draft=value
    }
    func cancelDraft(){guard writeLeases.isEmpty else{return};draft=nil;error=nil;if available && visible{reload()}}
    @discardableResult func save() async ->Bool {
        guard loaded,let worker,let value=draft,value.valid,let (token,gate)=begin(writing:true) else{return false}
        defer{end(token)}
        do {
            let result=try await worker.save(value,gate:gate)
            guard current(token,gate),draft==value else{return false}
            rows=result;draft=nil;error=nil;notice=nativeUI("已加密保存在本机", "Saved encrypted on this Mac");return true
        }catch{if current(token,gate){self.error=message(error)};return false}
    }
    func deleteRequest(ids:Set<String>)->NativeQuickVaultDeleteRequest? {
        guard available,visible,loaded,!busy,draft==nil,!ids.isEmpty else{return nil}
        let selected=rows.filter{ids.contains($0.id)}
        guard selected.count==ids.count else{return nil};return .init(rows:selected)
    }
    @discardableResult func delete(_ request:NativeQuickVaultDeleteRequest) async ->Bool {
        guard loaded,draft==nil,let worker,let (token,gate)=begin(writing:true) else{return false}
        defer{end(token)}
        do {
            let result=try await worker.delete(request,gate:gate)
            guard current(token,gate) else{return false};conceal();rows=result;error=nil;notice=nativeUI("已删除所选账号", "Selected entries deleted");return true
        }catch{if current(token,gate){self.error=message(error)};return false}
    }
    @discardableResult func copy(_ row:NativeQuickVaultRow,field:CopyField) async ->Bool {
        guard loaded,draft==nil,rows.contains(row),let worker,let (token,gate)=begin(writing:false) else{return false}
        defer{end(token)}
        let copyLease=pasteboard.changeCount
        do {
            let secret=try await worker.secret(row,gate:gate)
            guard current(token,gate),rows.contains(row) else{return false}
            guard pasteboard.changeCount==copyLease else{error=nativeUI("剪贴板已有新内容，未覆盖。需要时请再次复制。", "The clipboard changed. Nothing was overwritten; copy again when ready.");return false}
            guard pasteboard.copy(field == .password ? secret:row.account,expectedChangeCount:copyLease) else{throw NativeQuickVaultError.writeFailed}
            error=nil;notice=nativeUI("已复制 · 60 秒后清除本次内容", "Copied · This copy expires in 60 seconds");return true
        }catch{if current(token,gate){self.error=message(error)};return false}
    }
    func reveal(_ row:NativeQuickVaultRow) async {
        guard loaded,draft==nil,rows.contains(row),let worker else{return}
        if revealedID==row.id{conceal();return}
        guard let (token,gate)=begin(writing:false) else{return}
        defer{end(token)}
        do {
            let secret=try await worker.secret(row,gate:gate)
            guard current(token,gate),rows.contains(row) else{return};revealedID=row.id;revealedPassword=secret;error=nil
        }catch{if current(token,gate){conceal();self.error=message(error)}}
    }
    func conceal(){revealedID=nil;revealedPassword=nil}
    private func message(_ error:Error)->String {
        switch error as? NativeQuickVaultError {
        case .changed:return nativeUI("该账号已有变化。当前输入保留，请取消后重新打开最新记录。", "This entry changed. Your input is retained; cancel and reopen the latest entry.")
        case .uncertain:return nativeUI("写入已完成，但持久保存尚未确认。可重试同一操作；不要关闭未保存输入。", "The write completed but durable saving was not confirmed. Retry the same operation; keep your input open.")
        case .invalid:return nativeUI("请填写服务、账号和密码。服务最多 80 字符，账号 320，密码 4096。", "Enter a service, account and password. Limits: service 80 characters, account 320, password 4096.")
        case .limit:return nativeUI("密码库达到容量上限（1,000 项 / 8 MB），没有截断或覆盖记录。", "Vault capacity reached (1,000 entries / 8 MB). Existing records were not truncated or replaced.")
        case .unavailable:return nativeUI("密码库当前不可用，未保存输入仍保留。", "The vault is unavailable. Unsaved input is retained.")
        default:return nativeUI("密码库读取或保存失败。原文件保留，没有重建或覆盖损坏的数据。", "The vault could not be read or saved. Original files are retained; damaged data was not rebuilt or overwritten.")
        }
    }
}
