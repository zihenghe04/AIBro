import SwiftUI

/// The home canvas gives every widget a real, bounded preview. Complete controls
/// live in a detail surface with one scroll owner, rather than another scroll
/// view squeezed inside the home card.
struct NativeQuickWidgetContext {
    var size = "medium"
    var isDetail = false
    var expand: (() -> Void)?
}

private struct NativeQuickWidgetContextKey: EnvironmentKey {
    static let defaultValue = NativeQuickWidgetContext(isDetail: true)
}

extension EnvironmentValues {
    var nativeQuickWidgetContext: NativeQuickWidgetContext {
        get { self[NativeQuickWidgetContextKey.self] }
        set { self[NativeQuickWidgetContextKey.self] = newValue }
    }
}
