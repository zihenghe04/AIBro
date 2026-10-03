import AppKit
import SwiftUI

struct NativeQuickExternalNotificationSettingsView: View {
    @ObservedObject var store: NativeQuickExternalNotificationStore
    var entryDisabled: Bool
    @State private var source = "codex"
    @State private var copied = false
    @State private var showingHistory = false
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Toggle(isOn: Binding(get: { store.enabled }, set: { store.setEnabled($0) })) {
                Text(nativeUI("接收外部 Agent 通知", "Receive external agent notifications"))
                    .font(.system(size: 12))
            }.toggleStyle(.switch).controlSize(.small)
                .disabled(!store.loaded || !store.ready || store.changing || store.needsRestart)
            Text(entryDisabled
                 ? nativeUI("选择常驻入口后，任务完成提示会显示在屏幕顶部。", "Choose a persistent entry to show completion notices at the top of the screen.")
                 : nativeUI("在其他工具里完成任务后，在这里查看结果提示。", "See completion notices from tasks in your other tools here."))
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if store.issue {
                HStack {
                    Text(store.needsRestart
                         ? nativeUI("通知存储需要重新载入，请重启 AI Bro。", "Restart AI Bro to reload notification storage.")
                         : nativeUI("暂时无法连接通知服务", "Notification service is unavailable")).foregroundStyle(.orange)
                    Spacer(minLength: 8)
                    if !store.needsRestart { Button(nativeUI("重试", "Retry")) { store.refresh() }.buttonStyle(.plain).foregroundStyle(.tint) }
                }.font(.system(size: 11))
            }
            if store.enabled && store.receiving {
                DisclosureGroup(nativeUI("接入工具", "Connect a tool")) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) {
                            Picker(nativeUI("来源", "Source"), selection: $source) {
                                Text("Codex").tag("codex")
                                Text("Claude").tag("claude")
                                Text(nativeUI("其他 / GPT", "Other / GPT")).tag("gpt")
                            }.labelsHidden().frame(width: 132)
                            Button(copied ? nativeUI("已复制", "Copied") : nativeUI("复制接入命令", "Copy hook command")) {
                                guard let command = store.hookCommand(source: source) else { return }
                                NSPasteboard.general.clearContents()
                                copied = NSPasteboard.general.setString(command, forType: .string)
                            }.controlSize(.small)
                        }
                        Text(nativeUI("需要 Node.js。将命令手动加入工具的完成通知 hook；接收 JSON 参数或标准输入，不自动修改工具设置。", "Requires Node.js. Add this command to your tool’s completion hook. It reads a JSON argument or standard input; tool settings are not changed automatically."))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }.padding(.top, 5)
                }.font(.system(size: 11))
                DisclosureGroup(isExpanded: $showingHistory) {
                    VStack(alignment: .leading, spacing: 0) {
                        if store.history.isEmpty {
                            Text(nativeUI("还没有收到通知", "No notifications yet"))
                                .foregroundStyle(.secondary).padding(.vertical, 10)
                        }
                        ForEach(store.history) { event in
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: event.outcome == .failed ? "exclamationmark.circle" : "checkmark.circle")
                                    .foregroundStyle(event.outcome == .failed ? Color.orange : Color.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(event.title).lineLimit(2)
                                    if !event.detail.isEmpty { Text(event.detail).foregroundStyle(.secondary).lineLimit(2) }
                                    HStack(spacing: 6) {
                                        Text(sourceName(event.source))
                                        Text(event.occurredAt, style: .time)
                                    }.foregroundStyle(.secondary).font(.system(size: 10))
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(.vertical, 8)
                            Divider()
                        }
                        if !store.history.isEmpty {
                            Button(nativeUI("清空通知记录", "Clear notification history")) { store.clearHistory() }
                                .buttonStyle(.plain).foregroundStyle(.secondary).padding(.top, 9)
                                .disabled(store.changing)
                        }
                    }.font(.system(size: 11))
                } label: {
                    Text(nativeUI("最近通知", "Recent notifications") + " · " + String(store.history.count))
                }.font(.system(size: 11))
            }
        }
        .onChange(of: source) { _, _ in copied = false }
        .onChange(of: store.receiving) { _, receiving in if !receiving { copied = false; showingHistory = false } }
        .onAppear { store.refresh() }
    }
    private func sourceName(_ source: NativeQuickNotificationEvent.Source) -> String {
        switch source { case .externalCodex: return "Codex"; case .externalClaude: return "Claude"; default: return "GPT" }
    }
}
