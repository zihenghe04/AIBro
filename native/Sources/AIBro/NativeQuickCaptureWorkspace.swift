import Foundation
import WebKit

extension Workspace {
    /// Save without changing routes, editor ownership or main-window visibility.
    /// The bridge is the same in-memory workspace owner used by the full editor.
    func saveQuickCapture(_ payload: NativeQuickCapturePayload) async throws -> String {
        guard ready else { throw NativeQuickCaptureError.unavailable }
        let value: [String: Any] = ["id": payload.id, "text": payload.text, "tags": payload.tags]
        let raw: Any?
        do {
            raw = try await web.callAsyncJavaScript("""
            if (!window.NativeQuickCapture?.save) return {status:'error',reason:'unavailable'};
            return await window.NativeQuickCapture.save(payload);
            """, arguments: ["payload": value], in: nil, contentWorld: .page)
        } catch { throw NativeQuickCaptureError.unconfirmed }
        guard let receipt = raw as? [String: Any] else { throw NativeQuickCaptureError.unconfirmed }
        guard receipt["status"] as? String == "saved" else {
            throw NativeQuickCaptureError.rejected(receipt["reason"] as? String ?? "unavailable")
        }
        guard let id = receipt["id"] as? String, id == payload.id else { throw NativeQuickCaptureError.unconfirmed }
        return id
    }
}
