import XCTest
import Security
import PDFKit
import UIKit
@testable import App

final class MobileNativeTests: XCTestCase {
    func testPrivateNetworkRoutingAndSafeDiagnostics() {
        for raw in ["https://sync.example.ts.net", "https://SYNC.EXAMPLE.TS.NET.", "http://127.0.0.1:18787", "http://[::1]:18787"] {
            XCTAssertTrue(MobileBridge.usesPrivateRoute(URL(string: raw)!))
        }
        for raw in ["https://sync.example.com", "https://fake-ts.net", "https://sync.ts.net.attacker.test"] {
            XCTAssertFalse(MobileBridge.usesPrivateRoute(URL(string: raw)!))
        }
        XCTAssertEqual(MobileBridge.networkConfiguration(privateRoute: true).connectionProxyDictionary?.count, 0)
        XCTAssertNil(MobileBridge.networkConfiguration(privateRoute: false).connectionProxyDictionary)
        let error = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [NSLocalizedDescriptionKey: "private-token-must-not-leak"])
        XCTAssertTrue(MobileBridge.networkError(error).contains("-1200"))
        XCTAssertFalse(MobileBridge.networkError(error).contains("private-token"))
    }
    func testPrivateHTTPSHealthWhenConfigured() async throws {
        guard let raw = ProcessInfo.processInfo.environment["AIBRO_TEST_SYNC_URL"], let url = URL(string: raw) else { throw XCTSkip("Provide AIBRO_TEST_SYNC_URL for private-network acceptance") }
        XCTAssertTrue(MobileBridge.usesPrivateRoute(url))
        let session = URLSession(configuration: MobileBridge.networkConfiguration(privateRoute: true))
        defer { session.invalidateAndCancel() }
        let (data,response) = try await session.data(from: url.appendingPathComponent("v1/health"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual((try JSONSerialization.jsonObject(with:data) as? [String:Int])?["protocol"], 1)
    }
    func testSQLiteReopensAndRejectsBrokenReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = WorkspaceDatabase(directory: directory)
        let content = "{\"schema\":1,\"records\":{},\"cursor\":12,\"fixture\":\"保存后重开\"}"
        try database.save(content)
        XCTAssertEqual(try WorkspaceDatabase(directory: directory).load(), content)
        XCTAssertThrowsError(try database.save("invalid-json"))
        XCTAssertEqual(try database.load(), content)
    }
    func testAppGroupIsAvailableToRunningApp() throws {
        let directory = try XCTUnwrap(FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile"))
        let file = directory.appendingPathComponent("native-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let value = Data("分享扩展与小组件共享容器".utf8)
        try value.write(to: file, options: .atomic)
        XCTAssertEqual(try Data(contentsOf: file), value)
    }
    func testKeychainRoundtripUsesOnlyIsolatedFixture() throws {
        let account = UUID().uuidString
        let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"app.aibro.mobile.native-test", kSecAttrAccount as String:account]
        defer { SecItemDelete(query as CFDictionary) }
        var add = query
        add[kSecValueData as String] = Data("synthetic-session-only".utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
        var get = query; get[kSecReturnData as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(get as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(String(data: try XCTUnwrap(result as? Data), encoding: .utf8), "synthetic-session-only")
    }
    @MainActor func testPDFKitReadsGeneratedDocument() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x:0,y:0,width:400,height:300))
        let data = renderer.pdfData { context in
            context.beginPage()
            ("AI Bro native PDF fixture" as NSString).draw(at: CGPoint(x:20,y:30), withAttributes:[.font:UIFont.systemFont(ofSize:16)])
        }
        let document = try XCTUnwrap(PDFDocument(data:data))
        XCTAssertTrue(document.string?.contains("native PDF fixture") == true)
    }
}
