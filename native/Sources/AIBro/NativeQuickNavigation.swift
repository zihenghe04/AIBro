import SwiftUI

/// Keys are handled only by the focused navigation button, never by the panel
/// or a global event monitor. Editors retain their cursor and IME key handling.
struct NativeQuickNavigation: View {
    let sections: [NativeQuickPanelSection]
    let selected: NativeQuickPanelSection
    let visible: Bool
    let reduceMotion: Bool
    let select: (NativeQuickPanelSection, Bool) -> Void
    let focusChanged: (Bool) -> Void
    @FocusState private var focused: NativeQuickPanelSection?
    @Namespace private var selection

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 3) {
                    ForEach(sections) { item in
                        Button { select(item, false) } label: {
                            Group {
                                if item == .home { Image(systemName: item.symbol) }
                                else { Text(item.title) }
                            }
                            .font(.system(size: 12, weight: selected == item ? .semibold : .regular))
                            .padding(.horizontal, 11).frame(height: 31)
                            .foregroundStyle(selected == item ? Color.primary : .secondary)
                            .background {
                                if selected == item {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color.primary.opacity(0.11))
                                        .matchedGeometryEffect(id: "selection", in: selection)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .focusable(true, interactions: [.edit, .activate])
                        .focused($focused, equals: item)
                        .focusEffectDisabled()
                        .overlay {
                            if focused == item {
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(Color.accentColor.opacity(0.9), lineWidth: 1.5)
                                    .padding(1).allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                        .onKeyPress(phases: [.down, .repeat]) { press in
                            // macOS marks hardware arrows as numeric-pad keys;
                            // Fn+Left/Right produces Home/End. Neither changes
                            // navigation intent, unlike editing/system modifiers.
                            guard visible, focused == item,
                                  press.modifiers.intersection([.command, .control, .option, .shift]).isEmpty else { return .ignored }
                            let movement: NativeQuickNavigationMovement
                            switch press.key {
                            case .leftArrow: movement = .previous
                            case .rightArrow: movement = .next
                            case .home: movement = .first
                            case .end: movement = .last
                            default: return .ignored
                            }
                            guard let next = movement.destination(from: item, in: sections) else { return .ignored }
                            select(next, true)
                            focused = next
                            return .handled
                        }
                        .accessibilityLabel(item.title)
                        .accessibilityIdentifier("quick-navigation-" + item.rawValue)
                        .accessibilityAddTraits(selected == item ? [.isSelected] : [])
                        .id(item)
                    }
                }.padding(4)
                    .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: selected)
            }
            .scrollIndicators(.hidden)
            .onChange(of: focused) { _, value in
                focusChanged(value != nil && visible)
                if let value { reveal(value, proxy: proxy) }
            }
            .onChange(of: selected) { _, value in reveal(value, proxy: proxy) }
            .onChange(of: visible) { _, value in
                if value { reveal(selected, proxy: proxy) }
                else { focused = nil; focusChanged(false) }
            }
            .onChange(of: sections) { _, value in
                if let focused, !value.contains(focused) { self.focused = nil }
            }
            .onAppear { reveal(selected, proxy: proxy) }
            .onDisappear { focusChanged(false) }
        }
        .frame(height: 39)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(nativeUI("工作台导航", "Workspace navigation"))
    }

    private func reveal(_ item: NativeQuickPanelSection, proxy: ScrollViewProxy) {
        guard visible, sections.contains(item) else { return }
        // A key repeat must not build a queue of smooth scrolling animations.
        // Only the selection pill moves; the requested tab is immediately visible.
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(item, anchor: .center) }
    }
}

enum NativeQuickNavigationMovement {
    case previous, next, first, last

    func destination<Element: Equatable>(from item: Element, in items: [Element]) -> Element? {
        guard let index = items.firstIndex(of: item), !items.isEmpty else { return nil }
        switch self {
        case .previous: return items[(index + items.count - 1) % items.count]
        case .next: return items[(index + 1) % items.count]
        case .first: return items.first
        case .last: return items.last
        }
    }
}
