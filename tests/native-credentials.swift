import Foundation
@main struct CredentialTests {
 static func main() throws {
 let encrypted=Data(base64Encoded:try String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8))!
 let plain=try NativeCredentials.decryptLegacy(encrypted,password:Data("synthetic-password".utf8));precondition(plain == Data("synthetic credential record".utf8))
 let wrong=try? NativeCredentials.decryptLegacy(encrypted,password:Data("wrong".utf8));precondition(wrong != Data("synthetic credential record".utf8));if let wrong {precondition((try? JSONSerialization.jsonObject(with:wrong)) == nil)}
 do{_ = try NativeCredentials.decryptLegacy(Data("v11unsupported".utf8),password:Data());fatalError("unknown format accepted")}catch{}
 let a=try NativeCredentials.origin("https://example.com:443/v1");precondition(a=="https://example.com")
 let b=try NativeCredentials.origin("http://localhost:9900/v1");precondition(b=="http://localhost:9900")
 do{_ = try NativeCredentials.origin("https://user:password@example.com");fatalError("userinfo accepted")}catch{}
 print("6 credential compatibility checks passed; no real Keychain access")
 }
}
