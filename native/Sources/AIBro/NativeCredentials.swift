import Foundation
import Security
import CommonCrypto

/// Native secret storage with lazy, read-only compatibility for Electron's macOS v10 record.
/// Nothing reads the login Keychain during status polling or application launch.
final class NativeCredentials: Sendable {
    let folder:URL
    let legacy:URL?
    let service:String
    init(folder:URL,legacy:URL?,service:String){self.folder=folder;self.legacy=legacy;self.service=service}
    private func meta(_ channel:String)->URL {folder.appendingPathComponent(channel+".json")}
    private func legacyFile(_ channel:String)->URL? {legacy?.appendingPathComponent(channel=="api" ? "credentials/api.json":"embedding-credentials/api.json")}
    private func query(_ channel:String)->[String:Any] {[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:channel]}
    private func metadata(_ channel:String)->[String:Any] {(try? Data(contentsOf:meta(channel))).flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]} ?? [:]}
    private func saveMetadata(_ channel:String,_ record:[String:Any])throws {
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try JSONSerialization.data(withJSONObject:record).write(to:meta(channel),options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:meta(channel).path)
    }
    func status(_ channel:String)->[String:Any] {
        let m=metadata(channel), old=m["removed"] as? Bool != true && legacyFile(channel).map{FileManager.default.fileExists(atPath:$0.path)} == true
        return ["available":NSNull(),"hasKey":m["hasKey"] as? Bool == true || old,"base":m["base"] as? String ?? "","model":m["model"] as? String ?? "","verified":false,"requiresUnlock":true]
    }
    static func origin(_ base:String)throws->String {
        guard let u=URLComponents(string:base),["https","http"].contains(u.scheme?.lowercased() ?? ""),let host=u.host,!host.isEmpty,u.user==nil,u.password==nil,u.fragment==nil else{throw AgendaError.message("API 地址无效。")}
        let scheme=u.scheme!.lowercased(),port=u.port
        return scheme+"://"+host.lowercased()+(port == nil || (scheme=="https" && port==443) || (scheme=="http" && port==80) ? "":":\(port!)")
    }
    private func readRecord(_ channel:String)throws->[String:Any]? {
        var q=query(channel);q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var item:CFTypeRef?;let result=SecItemCopyMatching(q as CFDictionary,&item)
        if result==errSecSuccess,let bytes=item as? Data {return try JSONSerialization.jsonObject(with:bytes) as? [String:Any]}
        guard result==errSecItemNotFound else{throw AgendaError.message("请在系统钥匙串提示中允许 AI Bro 访问凭据（\(result)）。")}
        guard metadata(channel)["removed"] as? Bool != true,let file=legacyFile(channel),FileManager.default.fileExists(atPath:file.path) else{return nil}
        let envelope=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as? [String:Any]
        guard let value=envelope?["ciphertext"] as? String,let encrypted=Data(base64Encoded:value) else{throw AgendaError.message("旧版加密凭据格式无效，原文件已保留。")}
        let old:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"ai-workstation Safe Storage",kSecAttrAccount as String:"ai-workstation",kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var password:CFTypeRef?;let unlocked=SecItemCopyMatching(old as CFDictionary,&password)
        guard unlocked==errSecSuccess,let secret=password as? Data else{throw AgendaError.message("旧版凭据需要钥匙串授权（\(unlocked)）；也可在设置中填写新的 Key，旧文件仍保留。")}
        let plaintext=try Self.decryptLegacy(encrypted,password:secret)
        guard let record=try JSONSerialization.jsonObject(with:plaintext) as? [String:Any],let base=record["base"] as? String,let stored=record["origin"] as? String,try Self.origin(base)==stored,!(record["token"] as? String ?? "").isEmpty else{throw AgendaError.message("旧版凭据校验失败，未迁移。")}
        return record
    }
    static func decryptLegacy(_ encrypted:Data,password:Data)throws->Data {
        guard encrypted.prefix(3)==Data("v10".utf8) else{throw AgendaError.message("不支持此旧版凭据加密格式。")}
        var key=[UInt8](repeating:0,count:16);let salt=Array("saltysalt".utf8)
        let derivation=password.withUnsafeBytes{p in CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),p.bindMemory(to:Int8.self).baseAddress,password.count,salt,salt.count,CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),1003,&key,key.count)}
        let cipher=Data(encrypted.dropFirst(3)),iv=[UInt8](repeating:32,count:16);var output=[UInt8](repeating:0,count:cipher.count+16),length=0
        let result=cipher.withUnsafeBytes{p in CCCrypt(CCOperation(kCCDecrypt),CCAlgorithm(kCCAlgorithmAES),CCOptions(kCCOptionPKCS7Padding),key,key.count,iv,p.baseAddress,cipher.count,&output,output.count,&length)}
        guard derivation==kCCSuccess,result==kCCSuccess else{throw AgendaError.message("无法解密旧版凭据；旧文件未改动。")};return Data(output.prefix(length))
    }
    func call(_ channel:String,_ action:String,_ options:[String:Any])throws->[String:Any] {
        guard ["api","embedding"].contains(channel) else{throw AgendaError.message("未知凭据类型")}
        if action=="status" {return status(channel)}
        if action=="remove" {
            let result=SecItemDelete(query(channel) as CFDictionary);guard result==errSecSuccess || result==errSecItemNotFound else{throw AgendaError.message("凭据删除失败（\(result)）")}
            try saveMetadata(channel,["hasKey":false,"removed":true]);return status(channel)
        }
        let base=(options["base"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines),origin=try Self.origin(base)
        if action=="read" {
            guard let record=try readRecord(channel) else{return ["base":base,"token":"","model":""]}
            guard let saved=record["base"] as? String,try Self.origin(saved)==origin else{throw AgendaError.message("已保存的 Key 属于另一个服务地址，未提供给当前地址。")}
            return ["base":saved,"token":record["token"] as? String ?? "","model":record["model"] as? String ?? ""]
        }
        guard action=="save" else{throw AgendaError.message("未知凭据操作")}
        var token=(options["token"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
        if token.isEmpty {guard let old=try readRecord(channel),let oldBase=old["base"] as? String,try Self.origin(oldBase)==origin else{throw AgendaError.message("请填写当前服务的 API Key。")};token=old["token"] as? String ?? ""}
        let model=options["model"] as? String ?? ""
        guard !token.isEmpty,token.utf8.count<=16384,!token.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),model.count<=512 else{throw AgendaError.message("Key 或模型格式无效")}
        let bytes=try JSONSerialization.data(withJSONObject:["base":base,"token":token,"model":model,"origin":origin])
        let q=query(channel);var result=SecItemUpdate(q as CFDictionary,[kSecValueData as String:bytes] as CFDictionary)
        if result==errSecItemNotFound {var add=q;add[kSecValueData as String]=bytes;add[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;result=SecItemAdd(add as CFDictionary,nil)}
        guard result==errSecSuccess else{throw AgendaError.message("钥匙串保存失败（\(result)），未写入明文文件。")}
        try saveMetadata(channel,["hasKey":true,"base":base,"model":model]);return ["available":true,"hasKey":true,"base":base,"model":model,"verified":true,"requiresUnlock":false]
    }
}
