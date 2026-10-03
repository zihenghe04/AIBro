import Foundation
import WebKit

extension Workspace {
    func quickLinksRequest(_ payload: [String: Any]) async throws -> [String: Any] {
        guard ready else { throw NativeQuickLinksError.unavailable }
        let value = try await web.callAsyncJavaScript("""
        if (!window.NativeQuickLinks?.request) return {status:'deferred',reason:'unavailable'};
        return await window.NativeQuickLinks.request(payload);
        """,arguments:["payload":payload],in:nil,contentWorld:.page)
        guard let reply=value as? [String:Any] else { throw NativeQuickLinksError.unconfirmed }
        return reply
    }
}
