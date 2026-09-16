import SwiftUI

struct TaskCompletionButton: View {
    @ObservedObject var model: Workspace
    let task: ContentRecord
    private var completed: Bool { task.status == "done" }
    var body: some View {
        Button { model.command(completed ? "reopen-task" : "complete-task", task.id) } label: {
            Image(systemName: completed ? "checkmark.circle.fill" : "circle")
                .font(.system(size:17,weight:.regular))
                .foregroundStyle(StudioPalette.space(task.workspace))
                .frame(width:32,height:32).contentShape(Rectangle())
        }.buttonStyle(LiftStyle()).disabled(!model.ready)
            .accessibilityLabel(nativeUI(completed ? "标记为未完成：" : "标记为已完成：", completed ? "Mark incomplete: " : "Mark complete: ") + task.title)
            .accessibilityValue(completed ? nativeUI("已完成", "Completed") : nativeUI("未完成", "Incomplete"))
            .help(completed ? nativeUI("标记为未完成", "Mark incomplete") : nativeUI("标记为已完成", "Mark complete"))
    }
}
