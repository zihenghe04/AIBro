import Foundation
import SwiftUI

/// A display-only projection. Refreshing time never changes task order or data.
/// TO-DO Panel's `todoTimeBattery` distinguishes an expired deadline from a
/// rounded 0% balance; keep that distinction without inventing a creation time.
struct NativeQuickTaskDeadline: Equatable {
    enum Urgency: Equatable { case scheduled, soon, today, overdue }

    let urgency: Urgency
    let date: Date
    let cutoff: Date
    let isAllDay: Bool
    let isCompleted: Bool
    let remainingFraction: Double?

    var remainingPercent: Int? { remainingFraction.map { Int(($0 * 100).rounded()) } }

    static func presentation(for item: NativeQuickTaskItem, now: Date, calendar: Calendar = .current) -> Self? {
        guard valid(now), let raw = item.dueAt,
              let date = deadlineDate(raw, calendar: calendar), valid(date) else { return nil }
        // A date-only deadline includes the whole local calendar day. Adding
        // one calendar day also handles daylight-saving days of 23 or 25 hours.
        let cutoff: Date
        if raw.isDay {
            guard let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date)), valid(end) else { return nil }
            cutoff = end
        } else { cutoff = date }

        let urgency: Urgency
        if item.isCompleted { urgency = .scheduled }
        else if now >= cutoff { urgency = .overdue }
        else if calendar.isDate(date, inSameDayAs: now) { urgency = .today }
        else if cutoff.timeIntervalSince(now) <= 48 * 60 * 60 { urgency = .soon }
        else { urgency = .scheduled }

        var remaining: Double?
        if !item.isCompleted, let milliseconds = item.createdAt, milliseconds.isFinite, milliseconds > 0 {
            let created = Date(timeIntervalSince1970: milliseconds / 1000)
            if valid(created), created <= now, created < cutoff {
                remaining = max(0, min(1, cutoff.timeIntervalSince(now) / cutoff.timeIntervalSince(created)))
            }
        }
        return Self(urgency: urgency, date: date, cutoff: cutoff, isAllDay: raw.isDay,
                    isCompleted: item.isCompleted, remainingFraction: remaining)
    }

    private static func deadlineDate(_ value: NativeQuickTaskDate, calendar: Calendar) -> Date? {
        guard case .text(let text) = value else { return value.date }
        if !value.isDay {
            // Foundation's ISO parser normalizes February 30 to March 2.
            // Validate the literal calendar date before accepting a timestamp.
            guard text.count > 10, text[text.index(text.startIndex, offsetBy: 10)] == "T",
                  strictDay(String(text.prefix(10)), timeZone: TimeZone(secondsFromGMT: 0)!) != nil else { return nil }
            return value.date
        }
        return strictDay(text, timeZone: calendar.timeZone)
    }

    private static func strictDay(_ text: String, timeZone: TimeZone) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let date = formatter.date(from: text), formatter.string(from: date) == text else { return nil }
        return date
    }

    private static func valid(_ date: Date) -> Bool {
        let seconds = date.timeIntervalSince1970
        return seconds.isFinite && seconds >= -62_135_596_800 && seconds < 253_402_300_800
    }
}

/// The owner supplies time, typically from a minute TimelineView around the
/// list. There is no per-row timer, perpetual animation, or transient sorting.
struct NativeQuickTaskDeadlineView: View {
    let item: NativeQuickTaskItem
    let now: Date
    var calendar: Calendar = .current

    var body: some View {
        if let state = NativeQuickTaskDeadline.presentation(for: item, now: now, calendar: calendar) {
            HStack(spacing: 5) {
                if state.urgency == .overdue { Image(systemName: "exclamationmark.circle").font(.system(size: 9, weight: .medium)) }
                Text(label(state)).lineLimit(1)
                if let fraction = state.remainingFraction {
                    battery(fraction: fraction, overdue: state.urgency == .overdue, tint: color(state))
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(color(state))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(state))
            .help(accessibilityLabel(state))
        }
    }

    private func label(_ state: NativeQuickTaskDeadline) -> String {
        switch state.urgency {
        case .overdue: return nativeUI("已逾期", "Overdue")
        case .today: return nativeUI("今天截止", "Due today")
        case .soon: return nativeUI("即将截止", "Due soon")
        case .scheduled: return item.dueLabel.isEmpty ? formatted(state) : item.dueLabel
        }
    }

    private func color(_ state: NativeQuickTaskDeadline) -> Color {
        switch state.urgency {
        case .overdue: return .red
        case .today, .soon: return .orange
        case .scheduled: return .secondary
        }
    }

    private func formatted(_ state: NativeQuickTaskDeadline) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
        formatter.dateStyle = .medium; formatter.timeStyle = state.isAllDay ? .none : .short
        return formatter.string(from: state.date)
    }

    private func accessibilityLabel(_ state: NativeQuickTaskDeadline) -> String {
        var parts = [label(state), formatted(state)]
        if state.isAllDay { parts.append(nativeUI("全天截止", "Due by the end of the day")) }
        if state.isCompleted { parts.append(nativeUI("已完成", "Completed")) }
        if let percent = state.remainingPercent, state.urgency != .overdue {
            parts.append(nativeUI("剩余时间 \(percent)%", "\(percent)% of allotted time remains"))
        }
        return parts.joined(separator: " · ")
    }

    private func battery(fraction: Double, overdue: Bool, tint: Color) -> some View {
        HStack(spacing: 1) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).strokeBorder(tint.opacity(0.45), lineWidth: 0.7)
                RoundedRectangle(cornerRadius: 1)
                    .fill(tint.opacity(overdue ? 0.8 : 0.65))
                    .frame(width: overdue ? 15 : 15 * fraction, height: 5)
                    .padding(.leading, 2)
                if overdue {
                    Text("!").font(.system(size: 6, weight: .heavy)).foregroundStyle(.white)
                        .frame(width: 19, height: 9)
                }
            }.frame(width: 19, height: 9)
            Capsule().fill(tint.opacity(0.45)).frame(width: 1.5, height: 3)
        }.accessibilityHidden(true)
    }
}
