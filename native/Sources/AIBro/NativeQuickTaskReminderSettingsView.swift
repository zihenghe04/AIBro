import SwiftUI

struct NativeQuickTaskReminderSettingsView: View {
    @ObservedObject var store: NativeQuickTaskReminderStore
    var unavailableReason: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(nativeUI("截止前 1 小时在灵动岛提醒", "Remind in the island 1 hour before task deadlines"), isOn: Binding(
                get: { store.enabled }, set: { value in Task { await store.setEnabled(value) } }))
                .toggleStyle(.switch).controlSize(.small).font(.system(size: 12))
                .disabled(!store.loaded || !store.available || store.savingPreference)
            Text(nativeUI("仅在本机灵动岛提醒。全天任务按当天结束计算，已完成与过期待办不提醒。", "Local island reminders only. All-day tasks are due at day's end; completed and expired tasks are skipped."))
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let error = store.error {
                HStack(alignment: .top) {
                    Text(error).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    Button(nativeUI("重试", "Retry")) { store.retry() }.disabled(store.savingPreference || !store.available)
                }
            } else if !store.available {
                Text(unavailableReason ?? nativeUI("工作区就绪并退出无痕模式后可启用。", "Available when the workspace is ready and private mode is off."))
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if store.queueBlocked {
                Text(nativeUI("提醒队列已满，将在截止前重试。", "The notification queue is full. Delivery will retry before the deadline."))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }
}
