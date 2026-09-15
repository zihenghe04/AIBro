import Foundation
import Combine

@main struct NativeLocalizationTests {
    static func main() {
        let language = NativeL10n.shared
        var changes = 0
        let subscription = language.$language.dropFirst().sink { _ in changes += 1 }
        language.setLanguage("en")
        precondition(nativeUI("保存", "Save") == "Save")
        precondition(NativeL10n.space("科研") == "Research")
        precondition(NativeL10n.space("我的原文 Project") == "我的原文 Project")
        precondition(NativeL10n.agendaMode("周") == "Week")
        precondition(NativeL10n.weekday("一") == "Mon")
        precondition(NativeL10n.notificationStatus("已交给系统 60 条 · 未来 30 天 · 8 条待后续补排") == "Scheduled with macOS: 60 · Next 30 days · 8 pending")
        precondition(NativeL10n.notificationStatus("已交给系统 2 条 · 未来 30 天") == "Scheduled with macOS: 2 · Next 30 days")
        precondition(NativeL10n.notificationStatus("自定义状态") == "自定义状态")
        let date = Date(timeIntervalSince1970: 1789430400)
        let english = date.nativeFormatted(.dateTime.month(.wide).day())
        precondition(english.contains("September"))
        language.setLanguage("en")
        precondition(changes == 1, "Repeated bridge messages must not trigger redraws")
        language.setLanguage("zh-CN")
        precondition(nativeUI("保存", "Save") == "保存")
        precondition(NativeL10n.space("科研") == "科研")
        precondition(NativeL10n.weekday("一") == "一")
        precondition(date.nativeFormatted(.dateTime.month(.wide).day()).contains("月"))
        precondition(changes == 2)
        precondition(NativeL10n.normalize("invalid") == "zh-CN")
        precondition(NativeL10n.normalize("en-US") == "zh-CN", "Match web language normalization")
        withExtendedLifetime(subscription) {}
        print("Native localization: 17 checks passed")
    }
}
