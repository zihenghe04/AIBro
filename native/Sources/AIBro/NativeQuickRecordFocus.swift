import Foundation
import Combine
import SwiftUI
import AppKit

struct NativeQuickRecordFocusRequest: Equatable {
    let token: UUID
    let id: String
}

/// Ephemeral presentation state. No record, draft, or retry journal is written.
/// Only the mounted target's marker may acknowledge a request; a setter or a
/// completed data load is not a presentation receipt.
@MainActor final class NativeQuickRecordFocus: ObservableObject {
    @Published private(set) var target: NativeQuickRecordFocusRequest?
    @Published private(set) var highlightedID: String?
    private var accepted: (id: String, valid: () -> Bool)?
    private var continuation: CheckedContinuation<Bool, Never>?
    private var canPresent: (() -> Bool)?
    private var isPresented: (() -> Bool)?
    private var timeout: Task<Void, Never>?
    private var highlightTimeout: Task<Void, Never>?

    func present(id: String, show: () -> Void, canPresent: @escaping () -> Bool, isPresented: @escaping () -> Bool) async -> Bool {
        guard target == nil, !id.isEmpty, canPresent(), !Task.isCancelled else { return false }
        let request = NativeQuickRecordFocusRequest(token: UUID(), id: id)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation; self.canPresent = canPresent; self.isPresented = isPresented
                highlightTimeout?.cancel()
                accepted = nil; target = request; highlightedID = id
                timeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: 2_500_000_000) } catch { return }
                    guard self?.target == request else { return }; self?.finish(false)
                }
                show()
            }
        } onCancel: { Task { @MainActor [weak self] in
            guard self?.target == request else { return }; self?.cancel()
        } }
    }

    @discardableResult func acknowledge(_ request: NativeQuickRecordFocusRequest, isVisible: @escaping () -> Bool = {true}) -> Bool {
        guard target == request else { return true }
        guard canPresent?() == true else { finish(false); return true }
        guard isPresented?() == true,isVisible() else { return false }
        let access=canPresent,presentation=isPresented
        accepted=(request.id,{access?() == true && presentation?() == true && isVisible()})
        finish(true); return true
    }
    func isStillPresented(id:String) -> Bool {accepted?.id==id && accepted?.valid() == true}
    func cancel() { finish(false) }
    private func finish(_ success: Bool) {
        timeout?.cancel(); timeout = nil
        let callback = continuation; continuation = nil; canPresent = nil; isPresented = nil; target = nil
        if success {
            let id = highlightedID
            highlightTimeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 1_600_000_000) } catch { return }
                guard self?.highlightedID == id else { return }; self?.highlightedID = nil
            }
        } else { accepted=nil;highlightTimeout?.cancel(); highlightedID = nil }
        callback?.resume(returning: success)
    }
}

/// ScrollViewReader drives positioning; a separate native marker below checks
/// the target is actually mounted inside the clipped viewport before ACK.
struct NativeQuickFocusScroll<Content: View>: View {
    @ObservedObject var focus: NativeQuickRecordFocus
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollViewReader { proxy in
            content().task(id: focus.target?.token) {
                guard let request = focus.target else { return }
                await Task.yield()
                guard !Task.isCancelled, focus.target == request else { return }
                proxy.scrollTo(request.id, anchor: .center)
            }
        }
    }
}

struct NativeQuickRecordFocusMarker: View {
    @ObservedObject var focus: NativeQuickRecordFocus
    let id: String
    var body: some View {
        NativeQuickMountedRecordMarker(request: focus.target?.id == id ? focus.target : nil,
            acknowledge: { focus.acknowledge($0,isVisible:$1) })
            .overlay(RoundedRectangle(cornerRadius:8).strokeBorder(focus.highlightedID == id ? Color.accentColor.opacity(0.65):Color.clear,lineWidth:1.5))
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

private struct NativeQuickMountedRecordMarker: NSViewRepresentable {
    let request: NativeQuickRecordFocusRequest?
    let acknowledge: (NativeQuickRecordFocusRequest,@escaping () -> Bool) -> Bool
    func makeNSView(context: Context) -> Marker { Marker() }
    func updateNSView(_ view: Marker, context: Context) {
        view.acknowledge = acknowledge
        if view.request != request { view.request = request; view.observeMount() }
    }
    static func dismantleNSView(_ view: Marker, coordinator: ()) { view.observation?.cancel(); view.request = nil }
    final class Marker: NSView {
        var request: NativeQuickRecordFocusRequest?
        var acknowledge: ((NativeQuickRecordFocusRequest,@escaping () -> Bool) -> Bool)?
        var observation: Task<Void, Never>?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        var hasVisibleRecordGeometry:Bool {
            let clipped=visibleRect.intersection(bounds)
            return window != nil && !isHiddenOrHasHiddenAncestor && bounds.width>=8 && bounds.height>=8 &&
                clipped.width>=min(bounds.width,120) && clipped.height>=min(bounds.height,32)
        }
        func observeMount() {
            observation?.cancel()
            guard let request else { return }
            observation = Task { @MainActor [weak self] in
                for _ in 0..<50 {
                    do { try await Task.sleep(nanoseconds: 40_000_000) } catch { return }
                    guard let self, !Task.isCancelled, self.request == request else { return }
                    // The broker's canPresent additionally checks the actual
                    // panel/window/section and transition visibility each time.
                    if self.hasVisibleRecordGeometry {
                        if self.acknowledge?(request,{[weak self] in self?.hasVisibleRecordGeometry == true}) == true { return }
                    }
                }
            }
        }
    }
}
