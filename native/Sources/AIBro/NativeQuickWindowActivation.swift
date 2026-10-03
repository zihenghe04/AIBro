import AppKit
import ApplicationServices

/// CG window IDs identify the selected surface; AX only exposes public title
/// and geometry attributes. Never guess an AX index or use a private API.
enum NativeQuickWindowActivation {
    struct Target: Sendable, Equatable {
        let id: String
        let pid: pid_t
        let title: String
        let applicationIdentity: String
        var number: CGWindowID? {
            let parts = id.split(separator: ":")
            guard parts.count == 2, Int32(parts[0]) == pid, let number = UInt32(parts[1]), number > 0 else { return nil }
            return number
        }
    }
    struct Window: Sendable, Equatable {
        let pid: pid_t
        let title: String
        let bounds: CGRect?
    }
    struct Observation: Sendable {
        let current: Window?
        let peers: [Window]
    }
    enum Result: Sendable, Equatable {
        case raised, applicationOnly, controlPermission, ambiguous, unavailable, changed, closed, failed
    }
    struct Prepared: @unchecked Sendable {
        let target: Target
        let current: Window?
        let outcome: Result
        // The AX reference is ephemeral, never stored in workspace data. It is
        // revalidated on MainActor immediately before a foreground action.
        var element: AXUIElement? = nil
    }
    static func valid(_ rect: CGRect?) -> Bool {
        guard let rect else { return false }
        return [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite) && rect.width > 0 && rect.height > 0
    }
    static func sameBounds(_ a: CGRect?, _ b: CGRect?) -> Bool {
        guard valid(a), valid(b), let a, let b else { return false }
        return abs(a.minX-b.minX) <= 1 && abs(a.minY-b.minY) <= 1 && abs(a.width-b.width) <= 1 && abs(a.height-b.height) <= 1
    }
    /// Both APIs use the global top-left coordinate space, in points. A
    /// one-point tolerance permits rounding, not a nearest-window heuristic.
    static func uniqueMatch(_ target: Window, in windows: [Window]) -> Int? {
        guard !target.title.isEmpty, valid(target.bounds) else { return nil }
        let matching = windows.indices.filter { windows[$0].pid == target.pid && windows[$0].title == target.title && sameBounds(windows[$0].bounds,target.bounds) }
        return matching.count == 1 ? matching[0] : nil
    }
    static func canRaise(current: Window?, prepared: Window?, candidate: Window?) -> Bool {
        guard let current, let prepared, let candidate,
              current.pid == prepared.pid, current.title == prepared.title,
              sameBounds(current.bounds,prepared.bounds) else { return false }
        return uniqueMatch(current,in:[candidate]) == 0
    }
    /// CG must also distinguish the selected surface. AX may omit a window
    /// altogether, so uniqueness in its returned subset is insufficient.
    static func uniqueSurface(_ target: Window, in peers: [Window]) -> Bool {
        guard !target.title.isEmpty, valid(target.bounds), peers.allSatisfy({valid($0.bounds)}) else { return false }
        let matches = peers.filter { $0.pid == target.pid && sameBounds($0.bounds,target.bounds)
            && ($0.title == target.title || $0.title.isEmpty) }
        return matches.count == 1 && matches[0].title == target.title
    }
    static func completeMatch(_ target: Window, in candidates: [Window?]) -> Int? {
        guard candidates.allSatisfy({ $0 != nil && valid($0?.bounds) }) else { return nil }
        return uniqueMatch(target,in:candidates.compactMap{$0})
    }
    static func currentObservation(_ target: Target) -> Observation? {
        guard let number = target.number,
              let values = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] else { return nil }
        let owned = values.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == target.pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        func window(_ row: [String:Any]) -> Window {
            .init(pid:target.pid,title:(row[kCGWindowName as String] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines),bounds:NativeQuickWindowScanner.bounds(row[kCGWindowBounds as String]))
        }
        let matches = owned.filter { ($0[kCGWindowNumber as String] as? UInt32) == number }
        return .init(current:matches.count == 1 ? window(matches[0]) : nil,peers:owned.map(window))
    }
    static func appMatches(_ target: Target) -> NSRunningApplication? {
        guard let app = NSRunningApplication(processIdentifier:target.pid), !app.isTerminated,
              !target.applicationIdentity.isEmpty, NativeQuickWindowScanner.identity(app) == target.applicationIdentity else { return nil }
        return app
    }
    private static func axWindow(_ element: AXUIElement) -> Window? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element,&pid) == .success else { return nil }
        var title: CFTypeRef?, position: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element,kAXTitleAttribute as CFString,&title) == .success else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        var rect: CGRect?
        if AXUIElementCopyAttributeValue(element,kAXPositionAttribute as CFString,&position) == .success,
           AXUIElementCopyAttributeValue(element,kAXSizeAttribute as CFString,&size) == .success,
           let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID(),
           AXValueGetValue(unsafeBitCast(position,to:AXValue.self),.cgPoint,&point),
           AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions) {
            rect = CGRect(origin:point,size:dimensions)
        }
        return .init(pid:pid,title:(title as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines),bounds:rect)
    }
    /// Read-only preparation runs away from MainActor. It neither activates an
    /// app nor prompts for a permission. Cancellation prevents publication.
    static func prepare(_ target: Target) async -> Prepared {
        let worker = Task.detached(priority:.userInitiated) {
            let fallback: (Result,Window?) -> Prepared = { .init(target:target,current:$1,outcome:$0) }
            guard !Task.isCancelled, appMatches(target) != nil else { return fallback(.closed,nil) }
            guard !target.title.isEmpty, CGPreflightScreenCaptureAccess() else { return fallback(.applicationOnly,nil) }
            guard let observation = currentObservation(target) else { return fallback(.unavailable,nil) }
            guard let current = observation.current else { return fallback(.closed,nil) }
            guard current.title == target.title else { return fallback(.changed,current) }
            guard uniqueSurface(current,in:observation.peers) else { return fallback(.ambiguous,current) }
            guard AXIsProcessTrusted() else { return fallback(.controlPermission,current) }
            guard valid(current.bounds) else { return fallback(.unavailable,current) }
            let app = AXUIElementCreateApplication(target.pid)
            AXUIElementSetMessagingTimeout(app,0.25)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&value) == .success,
                  let elements = value as? [AXUIElement], elements.count <= 128 else { return fallback(.unavailable,current) }
            var rows: [Window] = [], refs: [AXUIElement] = []
            let deadline = ProcessInfo.processInfo.systemUptime + 3
            for element in elements {
                guard !Task.isCancelled else { return fallback(.changed,current) }
                guard ProcessInfo.processInfo.systemUptime < deadline else { return fallback(.unavailable,current) }
                AXUIElementSetMessagingTimeout(element,0.25)
                // An unreadable candidate can be the actual selected window.
                // Dropping it would turn a different same-name window into a
                // false unique match. No partial AX enumeration is actionable.
                guard let row = axWindow(element), valid(row.bounds) else { return fallback(.unavailable,current) }
                rows.append(row); refs.append(element)
            }
            guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { return fallback(.controlPermission,nil) }
            guard let index = completeMatch(current,in:rows.map{Optional($0)}) else { return fallback(.ambiguous,current) }
            return .init(target:target,current:current,outcome:.raised,element:refs[index])
        }
        return await withTaskCancellationHandler(operation:{await worker.value},onCancel:{worker.cancel()})
    }
    /// All permissions, process identity, CG ID and AX ownership/geometry are
    /// checked again at the last synchronous boundary before changing focus.
    @MainActor static func apply(_ prepared: Prepared) -> Result {
        let target = prepared.target
        guard let app = appMatches(target), prepared.outcome != .closed else { return .closed }
        var outcome = prepared.outcome
        var element: AXUIElement?
        if outcome == .raised {
            if !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() { outcome = .controlPermission }
            else {
                if let observation = currentObservation(target) {
                    if let current = observation.current {
                        if !uniqueSurface(current,in:observation.peers) { outcome = .ambiguous }
                        else if let candidate = prepared.element,
                                canRaise(current:current,prepared:prepared.current,candidate:axWindow(candidate)) { element = candidate }
                        else { outcome = .changed }
                    } else { outcome = .closed }
                } else { outcome = .unavailable }
            }
        } else if prepared.current != nil {
            if let observation = currentObservation(target) {
                if observation.current == nil { return .closed }
            } else { outcome = .unavailable }
        }
        guard outcome != .closed else { return .closed }
        guard app.activate(options:[]) else { return .failed }
        guard let element else { return outcome }
        _ = AXUIElementSetAttributeValue(element,kAXMinimizedAttribute as CFString,kCFBooleanFalse)
        return AXUIElementPerformAction(element,kAXRaiseAction as CFString) == .success ? .raised : .failed
    }
}
