import Foundation

/// Called ONLY on the audio driver's dedicated delivery queue. The local file
/// writer never waits here. At most one MainActor payload is outstanding; a
/// timeout stops this handoff instead of building an unbounded queue of Tasks.
final class NativeQuickASRPCMHandoff: @unchecked Sendable {
    typealias Dispatch = @Sendable (@escaping @MainActor @Sendable () -> Void) -> Void
    private let lock = NSLock()
    private var accepting = true, lost = false
    private var pending: Ticket?
    private let timeout: TimeInterval
    private let dispatch: Dispatch
    private let receive: @MainActor @Sendable (Data) -> Bool
    private let onFailure: @Sendable () -> Void
    private final class Ticket: @unchecked Sendable {
        let data: Data
        let done = DispatchSemaphore(value:0)
        var accepted = false
        init(_ data:Data){self.data=data}
    }
    init(timeout:TimeInterval=0.25,dispatch:@escaping Dispatch={operation in Task{@MainActor in operation()}},
         receive:@escaping @MainActor @Sendable (Data)->Bool,onFailure:@escaping @Sendable ()->Void) {
        self.timeout=timeout;self.dispatch=dispatch;self.receive=receive;self.onFailure=onFailure
    }
    var failed:Bool {lock.lock();defer{lock.unlock()};return lost}
    @discardableResult func send(_ data:Data)->Bool {
        // This synchronous API must never run on the main thread; fail closed
        // rather than deadlock if a future caller violates the worker contract.
        guard !Thread.isMainThread else{fail();return false}
        let ticket=Ticket(data)
        lock.lock()
        guard accepting,pending==nil else{lock.unlock();return false}
        pending=ticket;lock.unlock()
        dispatch{[weak self] in
            guard let self else{ticket.done.signal();return}
            self.lock.lock();let valid=self.accepting && self.pending === ticket;self.lock.unlock()
            let accepted=valid && self.receive(ticket.data)
            self.lock.lock();ticket.accepted=accepted;self.lock.unlock();ticket.done.signal()
        }
        let completed=ticket.done.wait(timeout:.now()+timeout) == .success
        lock.lock();let accepted=completed && ticket.accepted
        if pending === ticket {pending=nil}
        let notify = !accepted && accepting && !lost
        if !accepted {accepting=false;lost=true}
        lock.unlock()
        if notify {onFailure()}
        return accepted
    }
    private func fail(){lock.lock();let notify=accepting && !lost;accepting=false;lost=true;let ticket=pending;pending=nil;lock.unlock();ticket?.done.signal();if notify{onFailure()}}
    /// Called after driver's delivery drain, or immediately on privacy/owner
    /// revocation. Queued main-actor work can no longer append late audio.
    func close(){lock.lock();accepting=false;let ticket=pending;pending=nil;lock.unlock();ticket?.done.signal()}
}
