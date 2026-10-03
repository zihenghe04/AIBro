import Foundation
import CoreFoundation
import CryptoKit

/// TO-DO Panel's append-only file contract, adapted to AI Bro's three priority
/// levels. The original four-category identity stays attached to each task.
enum NativeTaskInboxParser {
    static let maximumBytes = 1_048_576
    static let maximumItems = 200
    static let categories = ["P0", "P1", "P2", "P3"]

    struct Entry: Codable, Equatable {
        let index: Int
        let sourceID: String
        let id: String
        let title: String
        let category: String
        let categoryName: String
        let priority: String
        let workspace: String
        let projectId: String?
        let dueAt: String
        var payload: [String: Any] {
            ["action": "create-task", "id": id, "title": title,
             "workspace": workspace, "projectId": projectId as Any? ?? NSNull(), "dueAt": dueAt,
             "priority": priority, "sourceTaskInbox": ["version": 1, "id": sourceID, "category": category]]
        }
    }
    struct Issue: Codable, Equatable {
        let index: Int
        var id: String? = nil
        let reason: String
    }
    struct Parsed: Codable {
        let hash: String
        let entries: [Entry]
        let skipped: [Issue]
        let warnings: [Issue]
        let error: String?
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func taskID(_ sourceID: String) -> String {
        var bytes = Array(SHA256.hash(data: Data(("AI Bro task inbox v1\u{0}" + sourceID).utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return "quick_task_" + [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(hex[hex.index(hex.startIndex, offsetBy: $0.lowerBound)..<hex.index(hex.startIndex, offsetBy: $0.upperBound)]) }.joined(separator: "-")
    }
    private static func normalized(_ text: String) -> String { text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
    private static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
    private static func integer(_ value: Any) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, abs(number.doubleValue) <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }
    static func parse(_ data: Data, now: Date = Date(), timeZone: TimeZone = .current) -> Parsed {
        let digest = hash(data)
        func rejected(_ reason: String) -> Parsed { Parsed(hash: digest, entries: [], skipped: [], warnings: [], error: reason) }
        guard data.count <= maximumBytes else { return rejected("文件超过 1 MiB 上限") }
        guard var text = String(data: data, encoding: .utf8) else { return rejected("文件必须是 UTF-8 JSON") }
        if text.hasPrefix("\u{feff}") { text.removeFirst() }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return rejected("文件为空") }
        guard let json = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) else { return rejected("JSON 解析失败；原文件已保留") }
        let envelope = json as? [String: Any]
        guard let rows = json as? [Any] ?? envelope?["todos"] as? [Any] else { return rejected("文件顶层必须是数组，或包含 todos 数组的对象") }
        let names = envelope?["categoryNames"] as? [String: Any] ?? [:]
        var entries: [Entry] = [], skipped: [Issue] = [], warnings: [Issue] = [], seen = Set<String>()
        for (index, value) in rows.prefix(maximumItems).enumerated() {
            guard let row = value as? [String: Any] else { skipped.append(Issue(index: index, reason: "条目必须是对象")); continue }
            var reasons: [String] = []
            let title = (row["text"] as? String).map(normalized) ?? ""
            if title.isEmpty { reasons.append("缺少 text 字符串") }
            else if title.utf16.count > 80 { reasons.append("text 超过 80 个字符") }
            let label = (row["category"] as? String).map(normalized) ?? ""
            let named = categories.filter { (names[$0] as? String).map { normalized($0).lowercased() } == label.lowercased() }
            let category = categories.first { $0.lowercased() == label.lowercased() } ?? (named.count == 1 ? named[0] : nil)
            if label.isEmpty { reasons.append("缺少 category") }
            else if category == nil { reasons.append(named.count > 1 ? "category 显示名不唯一，请使用 P0–P3" : "未知 category，请使用 P0–P3 或 categoryNames 中的显示名") }
            let rawID = row["id"]
            let sourceID: String
            if rawID == nil || rawID is NSNull || rawID as? String == "" { sourceID = "import-\(digest.prefix(12))-\(index)" }
            else if let string = rawID as? String { sourceID = string }
            else if let number = rawID.flatMap(integer) { sourceID = String(number) }
            else { sourceID = "" }
            if !matches(sourceID, "^[A-Za-z0-9._:-]{1,128}$") { reasons.append("id 只能包含字母、数字和 . _ : -，长度 1–128") }
            let workspace: String
            if row["workspace"] == nil { workspace = "日常" } else { workspace = row["workspace"] as? String ?? "" }
            if !["日常", "课程", "科研"].contains(workspace) { reasons.append("workspace 必须是日常、课程或科研") }
            var projectID: String?
            if let raw = row["projectId"], !(raw is NSNull) {
                if let value = raw as? String, !value.isEmpty, value.utf16.count <= 200 { projectID = value }
                else { reasons.append("projectId 必须是已有项目的非空 ID") }
            }
            let deadline = parseDeadline(row["deadline"], now: now, timeZone: timeZone)
            if let error = deadline.error { reasons.append(error) }
            guard reasons.isEmpty, let category, let dueAt = deadline.iso else { skipped.append(Issue(index: index, id: sourceID.isEmpty ? nil : String(sourceID.prefix(128)), reason: reasons.joined(separator: "；"))); continue }
            guard seen.insert(sourceID).inserted else { skipped.append(Issue(index: index, id: sourceID, reason: "id 已在此文件中出现，未重复添加")); continue }
            let categoryName = (names[category] as? String).map(normalized).flatMap { $0.isEmpty ? nil : String($0.prefix(80)) } ?? category
            entries.append(Entry(index: index, sourceID: sourceID, id: taskID(sourceID), title: title, category: category, categoryName: categoryName,
                                 priority: ["P0": "high", "P1": "high", "P2": "medium", "P3": "low"][category]!, workspace: workspace, projectId: projectID, dueAt: dueAt))
            if let date = deadline.date, date <= now { warnings.append(Issue(index: index, id: sourceID, reason: deadline.defaulted ? "未写 deadline，默认的当天 23:30 已过" : "deadline 早于导入时间")) }
        }
        if rows.count > maximumItems { skipped.append(Issue(index: maximumItems, reason: "单个文件最多导入 200 条，第 201–\(rows.count) 条未导入")) }
        return Parsed(hash: digest, entries: entries, skipped: skipped, warnings: warnings, error: nil)
    }
    struct Deadline { let iso: String?; let date: Date?; let defaulted: Bool; let error: String? }
    static func parseDeadline(_ value: Any?, now: Date, timeZone: TimeZone) -> Deadline {
        func failure(_ message: String) -> Deadline { Deadline(iso: nil, date: nil, defaulted: false, error: message) }
        let missing = value == nil || value is NSNull || value as? String == ""
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        var date: Date?
        if missing {
            var components = calendar.dateComponents([.year, .month, .day], from: now); components.hour = 23; components.minute = 30
            date = calendar.date(from: components)
        } else if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID(), let ms = integer(number) else { return failure("deadline 毫秒时间戳必须是整数") }
            if ms > 0 && ms < 100_000_000_000 { return failure("deadline 看起来是秒级时间戳，请改用毫秒") }
            date = Date(timeIntervalSince1970: Double(ms) / 1000)
        } else if let text = value as? String {
            let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let pattern = "^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\\.([0-9]{1,9}))?)?(Z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$"
            let regex = try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
            guard let match = regex.firstMatch(in: input, range: NSRange(input.startIndex..., in: input)) else { return failure("deadline 必须是 ISO 8601 字符串或毫秒时间戳") }
            func part(_ index: Int) -> String? { Range(match.range(at: index), in: input).map { String(input[$0]) } }
            let year = Int(part(1)!)!, month = Int(part(2)!)!, day = Int(part(3)!)!, hour = Int(part(4) ?? "23")!, minute = Int(part(5) ?? "30")!, second = Int(part(6) ?? "0")!
            guard year >= 2000, year <= 9999, (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 60 else { return failure("deadline 日期或时间不存在") }
            if let zone = part(8) {
                var offset = 0
                if zone.uppercased() != "Z" {
                    let digits = zone.dropFirst().replacingOccurrences(of: ":", with: ""), hours = Int(digits.prefix(2))!, minutes = digits.count > 2 ? Int(digits.suffix(2))! : 0
                    guard hours <= 14, minutes < 60, hours < 14 || minutes == 0 else { return failure("deadline 时区偏移无效") }
                    offset = (hours * 3600 + minutes * 60) * (zone.hasPrefix("-") ? -1 : 1)
                }
                calendar.timeZone = TimeZone(secondsFromGMT: offset)!
            }
            let milliseconds = Int(String((part(7) ?? "0").padding(toLength: 3, withPad: "0", startingAt: 0).prefix(3)))!
            let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
            guard let built = calendar.date(from: components) else { return failure("deadline 日期不存在") }
            let actual = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: built)
            guard actual.year == year, actual.month == month, actual.day == day, actual.hour == hour, actual.minute == minute, actual.second == second else { return failure("deadline 日期不存在或处于本地夏令时跳时区间") }
            date = built.addingTimeInterval(Double(milliseconds) / 1000)
        }
        guard let date, date.timeIntervalSince1970 >= 946_684_800, date.timeIntervalSince1970 <= 253_402_300_799.999 else { return failure("deadline 超出可用范围（2000–9999 年）") }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return Deadline(iso: formatter.string(from: date), date: date, defaulted: missing, error: nil)
    }
}
