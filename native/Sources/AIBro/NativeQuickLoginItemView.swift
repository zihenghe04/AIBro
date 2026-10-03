import AppKit
import SwiftUI

struct NativeQuickLoginItemView: View {
    @ObservedObject var store: NativeQuickLoginItemStore
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { store.status.isRegistered }, set: { value in
                Task { @MainActor in await store.setEnabled(value) }
            })) {
                Text(nativeUI("登录 Mac 时启动 AI Bro", "Open AI Bro at login"))
                    .font(.system(size: 12))
            }.toggleStyle(.switch).controlSize(.small)
                .disabled(store.changing || store.status == .unknown)
            if store.status == .requiresApproval {
                HStack(alignment: .firstTextBaseline) {
                    Text(nativeUI("等待系统允许", "Awaiting system approval")).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button(nativeUI("打开登录项设置", "Open Login Items")) { store.openSettings() }
                        .buttonStyle(.plain).foregroundStyle(.tint)
                }.font(.system(size: 11))
            } else if store.status == .notFound || store.status == .unknown {
                HStack(alignment: .firstTextBaseline) {
                    Text(store.status == .notFound
                         ? nativeUI("系统未找到登录项，可尝试开启。", "macOS could not find this login item. You can try enabling it.")
                         : nativeUI("此安装的登录项状态不可用", "Login item status unavailable for this installation"))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button(nativeUI("重新检查", "Check again")) { store.refresh() }
                        .buttonStyle(.plain).foregroundStyle(.tint)
                }.font(.system(size: 11))
            }
            if let issue = store.issue {
                Text(issue).font(.system(size: 11)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in store.refresh() }
    }
}
