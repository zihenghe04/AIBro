import Foundation
import WebKit

extension Workspace {
    func quickCaptureLibraryRequest(_ payload: [String: Any]) async throws -> [String: Any] {
        guard ready else { throw NativeQuickCaptureError.unavailable }
        let value = try await web.callAsyncJavaScript("""
        if (!window.NativeQuickCapture?.library) return {status:'deferred',reason:'unavailable'};
        return await window.NativeQuickCapture.library(payload);
        """,arguments:["payload":payload],in:nil,contentWorld:.page)
        guard let reply = value as? [String: Any] else { throw NativeQuickCaptureError.unconfirmed }
        return reply
    }
}
