import SwiftUI
import WidgetKit

struct ScheduleItem: Codable, Identifiable {
    let id: String
    let title: String
    let start: Double
    let end: Double
    let category: String
    let signed: Bool
    var begins: Date { Date(timeIntervalSince1970: start / 1000) }
    var ends: Date { Date(timeIntervalSince1970: end / 1000) }
}
struct ScheduleSnapshot: Codable {
    let updatedAt: Double
    let items: [ScheduleItem]
    static let empty = ScheduleSnapshot(updatedAt: 0, items: [])
    static func load() -> ScheduleSnapshot {
        guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile"),
              let data = try? Data(contentsOf: directory.appendingPathComponent("widget.json")), data.count < 131072,
              let snapshot = try? JSONDecoder().decode(Self.self, from: data) else { return .empty }
        return snapshot
    }
}
struct ScheduleEntry: TimelineEntry {
    let date: Date
    let snapshot: ScheduleSnapshot
}
struct ScheduleProvider: TimelineProvider {
    func placeholder(in context: Context) -> ScheduleEntry { ScheduleEntry(date: Date(), snapshot: .empty) }
    func getSnapshot(in context: Context, completion: @escaping (ScheduleEntry) -> Void) {
        completion(ScheduleEntry(date: Date(), snapshot: .load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ScheduleEntry>) -> Void) {
        let snapshot = ScheduleSnapshot.load(), now = Date()
        let limit = now.addingTimeInterval(86400)
        let boundaries = snapshot.items.flatMap { [$0.begins, $0.ends] }.filter { $0 > now && $0 < limit }
        let dates = Array(Set([now, limit] + boundaries)).sorted().prefix(80)
        completion(Timeline(entries: dates.map { ScheduleEntry(date: $0, snapshot: snapshot) }, policy: .after(limit)))
    }
}
struct ScheduleWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ScheduleEntry
    private let accent = Color(red: 0.07, green: 0.56, blue: 0.49)
    private var items: [ScheduleItem] {
        entry.snapshot.items.filter { $0.ends > entry.date }.sorted { $0.start < $1.start }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "sparkle").foregroundStyle(accent)
                Text("AI Bro").font(.subheadline.weight(.semibold))
                Spacer()
                Text(entry.date, style: .date).font(.caption2).foregroundStyle(.secondary)
            }
            if items.isEmpty {
                Spacer(minLength: 0)
                Text("把今天安排好").font(.headline)
                Text(entry.snapshot.updatedAt == 0 ? "打开 App，同步课程与日程" : "暂无接下来的安排").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                ForEach(Array(items.prefix(family == .systemSmall ? 1 : family == .systemLarge ? 5 : 2))) { item in
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2).fill(accent.opacity(item.signed ? 0.35 : 1)).frame(width: 3)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title).font(.system(.subheadline, design: .rounded).weight(.semibold)).lineLimit(family == .systemSmall ? 2 : 1)
                            HStack(spacing: 5) {
                                Text(item.begins, style: .time)
                                Text("· " + (item.signed ? "已签到" : item.begins <= entry.date ? "进行中" : item.category))
                            }.font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }.fixedSize(horizontal: false, vertical: true).privacySensitive()
                }
                Spacer(minLength: 0)
            }
            if entry.snapshot.updatedAt > 0 {
                HStack(spacing: 2) { Text("更新于"); Text(Date(timeIntervalSince1970: entry.snapshot.updatedAt / 1000), style: .time) }.font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }.widgetURL(URL(string: "aibro://today"))
        .modifier(WidgetSurface())
    }
}
private struct WidgetSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.containerBackground(for: .widget) { Color(.systemBackground) }
        } else { content.padding().background(Color(.systemBackground)) }
    }
}
@main
struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AIBroToday", provider: ScheduleProvider()) { ScheduleWidgetView(entry: $0) }
            .configurationDisplayName("AI Bro · 今日安排")
            .description("查看课程、下一步安排与最近同步状态。")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
