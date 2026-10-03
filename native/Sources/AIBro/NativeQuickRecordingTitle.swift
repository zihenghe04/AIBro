import Foundation

/// Model output is a proposal, never a recording mutation. The complete record
/// fingerprint binds review and eventual explicit save to the same transcript.
struct NativeQuickRecordingSuggestion: Equatable {
    let id: String
    let fingerprint: String
    let title: String
    let category: String
    let model: String
}

struct NativeQuickRecordingSuggestionDraft: Codable, Equatable {
    let id: String
    let fingerprint: String
    let model: String
    var title: String?
    var category: String?

    var valid: Bool {
        NativeQuickRecordingArchive.validID(id) && fingerprint.count == 64 && fingerprint.allSatisfy(\.isHexDigit)
        && NativeQuickRecordingSuggestionValidation.text(model, limit: 200) && (title != nil || category != nil)
        && (title.map { NativeQuickRecordingSuggestionValidation.text($0, limit: 80) } ?? true)
        && (category.map { NativeQuickRecordingSuggestionValidation.text($0, limit: 40) } ?? true)
    }
}

enum NativeQuickRecordingSuggestionValidation {
    static func text(_ value: String, limit: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && value.unicodeScalars.count <= limit
        && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
    static func reason(_ reason: String) -> String {
        switch reason {
        case "timeout": return nativeUI("生成建议超时，原录音和文字已保留。", "Suggestions timed out. Original audio and text are retained.")
        case "cancelled": return nativeUI("已停止生成。", "Generation stopped.")
        case "not_configured": return nativeUI("请先在 AI Bro 设置中配置默认模型。", "Configure the default model in AI Bro settings first.")
        case "context_length": return nativeUI("这段完整转写超过模型上下文，请选择支持更长内容的模型。", "The complete transcript exceeds the model context. Choose a model with a larger context.")
        case "invalid_response": return nativeUI("模型未返回有效的名称和分类，未修改录音。", "The model did not return a valid title and category. Nothing was changed.")
        case "changed": return nativeUI("录音或编辑状态已变化，请重新生成建议。", "The recording or editor changed. Generate a new suggestion.")
        default: return nativeUI("暂时无法生成建议，原录音与编辑内容已保留。", "Suggestions are unavailable. Original audio and edits are retained.")
        }
    }
}
