import Foundation

/// Markdown source edits adapted from TO-DO Panel's renderer/app.js at
/// 1deb3cac1e32599f13b1d6b30a7e52af76f67efd (MIT). Offsets use NSTextView's
/// UTF-16 contract, never Swift Character counts.
enum NativeQuickCaptureMarkup {
    enum Inline: Equatable {
        case bold, italic
        var marker: String { self == .bold ? "**" : "*" }
    }

    struct Edit: Equatable {
        let range: NSRange
        let replacement: String
        let selection: NSRange
    }

    static func inline(_ style: Inline, text: String, selection: NSRange, placeholder: String) -> Edit? {
        let value = text as NSString
        guard valid(selection, in: text) else { return nil }
        let marker = style.marker, width = marker.utf16.count
        let selected = value.substring(with: selection), end = NSMaxRange(selection)
        // Inspect the full adjacent run: the inner star of **bold** is not an
        // italic delimiter. ***both*** contains both styles, so toggling one
        // must leave the other intact. Longer/ambiguous runs are left alone.
        func starCount(from start: Int, step: Int, lower: Int, upper: Int) -> Int {
            var position = start, count = 0
            while position >= lower, position < upper, value.character(at: position) == 42 {
                count += 1; position += step
            }
            return count
        }
        func containsStyle(_ count: Int) -> Bool {
            style == .bold ? (count == 2 || count == 3) : (count == 1 || count == 3)
        }
        if selection.length > 0,
           containsStyle(starCount(from: selection.location - 1, step: -1, lower: 0, upper: value.length)),
           containsStyle(starCount(from: end, step: 1, lower: 0, upper: value.length)) {
            return Edit(range: NSRange(location: selection.location - width, length: selection.length + width * 2),
                        replacement: selected, selection: NSRange(location: selection.location - width, length: selection.length))
        }
        // Non-overlapping markers only. A selection containing just "*" or
        // "**" must never produce a negative range or erase unrelated text.
        if selection.length >= width * 2,
           containsStyle(starCount(from: selection.location, step: 1, lower: selection.location, upper: end)),
           containsStyle(starCount(from: end - 1, step: -1, lower: selection.location, upper: end)) {
            let content = (selected as NSString).substring(with: NSRange(location: width, length: selection.length - width * 2))
            return Edit(range: selection, replacement: content,
                        selection: NSRange(location: selection.location, length: content.utf16.count))
        }
        let content = selected.isEmpty ? placeholder : selected
        return Edit(range: selection, replacement: marker + content + marker,
                    selection: NSRange(location: selection.location + width, length: content.utf16.count))
    }

    static func continueList(text: String, selection: NSRange) -> Edit? {
        guard selection.length == 0, valid(selection, in: text) else { return nil }
        let value = text as NSString, cursor = selection.location
        let preceding = value.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: cursor))
        let start = preceding.location == NSNotFound ? 0 : NSMaxRange(preceding)
        let following = value.range(of: "\n", range: NSRange(location: cursor, length: value.length - cursor))
        let end = following.location == NSNotFound ? value.length : following.location
        let line = value.substring(with: NSRange(location: start, length: end - start)) as NSString
        let patterns = [
            #"^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]*(.*)$"#,
            #"^([ \t]*)([0-9]+)[.)][ \t]+(.*)$"#,
            #"^([ \t]*)[-*+][ \t]+(.*)$"#,
            #"^([ \t]*)>[ \t]?(.*)$"#,
        ]
        for (index, pattern) in patterns.enumerated() {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: line as String, range: NSRange(location: 0, length: line.length)) else { continue }
            let bodyRange = match.range(at: match.numberOfRanges - 1)
            // Enter inside a marker is an ordinary newline, not a new list item.
            guard cursor >= start + bodyRange.location else { return nil }
            let indent = line.substring(with: match.range(at: 1))
            if line.substring(with: bodyRange).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return Edit(range: NSRange(location: start, length: end - start), replacement: indent,
                            selection: NSRange(location: start + indent.utf16.count, length: 0))
            }
            var prefix = ["- [ ] ", "", "- ", "> "][index]
            if index == 1 {
                guard let number = UInt64(line.substring(with: match.range(at: 2))), number < UInt64.max else { return nil }
                prefix = "\(number + 1). "
            }
            let insertion = "\n" + indent + prefix
            return Edit(range: selection, replacement: insertion,
                        selection: NSRange(location: cursor + insertion.utf16.count, length: 0))
        }
        return nil
    }

    private static func valid(_ selection: NSRange, in text: String) -> Bool {
        let value = text as NSString
        guard selection.location != NSNotFound, selection.location >= 0, selection.length >= 0, selection.location <= value.length,
              selection.length <= value.length - selection.location else { return false }
        func scalarBoundary(_ offset: Int) -> Bool {
            guard offset > 0, offset < value.length else { return true }
            return !(0xD800...0xDBFF).contains(value.character(at: offset - 1)) ||
                   !(0xDC00...0xDFFF).contains(value.character(at: offset))
        }
        return scalarBoundary(selection.location) && scalarBoundary(NSMaxRange(selection))
    }
}
