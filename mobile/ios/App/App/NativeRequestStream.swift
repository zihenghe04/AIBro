import Foundation

/// URLSession can split a Unicode scalar between delegate callbacks.
struct StreamUTF8Decoder {
    private var pending = Data()
    mutating func append(_ data: Data, final: Bool = false) throws -> String {
        pending.append(data)
        for tail in 0...(final ? 0 : min(3, pending.count)) {
            let length = pending.count - tail
            if let text = String(data: pending.prefix(length), encoding: .utf8) {
                pending = Data(pending.suffix(tail))
                return text
            }
        }
        throw NSError(domain: "AI Bro stream", code: 1, userInfo: [NSLocalizedDescriptionKey: "服务器返回了无效的 UTF-8 内容"])
    }
}

/// A real incremental response, with one serial delegate queue per request.
/// Only response bytes, status and safe diagnostics leave this object.
final class NativeRequestStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let requestID: String
    private let configuration: URLSessionConfiguration
    private let request: URLRequest
    private let event: ([String: Any]) -> Void
    private let completion: () -> Void
    private let safeNetworkError: (Error) -> String
    private let workQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    // Mutable state is accessed only on workQueue.
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var finished = false
    private var status = 0
    private var byteCount = 0
    private var decoder = StreamUTF8Decoder()

    init(requestID: String, configuration: URLSessionConfiguration, request: URLRequest,
         safeNetworkError: @escaping (Error) -> String,
         event: @escaping ([String: Any]) -> Void, completion: @escaping () -> Void) {
        self.requestID = requestID
        self.configuration = configuration
        self.request = request
        self.safeNetworkError = safeNetworkError
        self.event = event
        self.completion = completion
    }

    func start() {
        workQueue.addOperation {
            guard !self.finished else { return }
            let session = URLSession(configuration: self.configuration, delegate: self, delegateQueue: self.workQueue)
            self.session = session
            let task = session.dataTask(with: self.request)
            self.task = task
            task.resume()
        }
    }

    func cancel() {
        workQueue.addOperation { self.finish(error: "请求已取消") }
    }

    private func emit(_ type: String, data: String? = nil, error: String? = nil) {
        var value: [String: Any] = ["requestId": requestID, "type": type, "status": status]
        if let data { value["data"] = data }
        if let error { value["error"] = error }
        event(value)
    }

    private func finish(error: String? = nil) {
        guard !finished else { return }
        finished = true
        emit(error == nil ? "done" : "error", error: error)
        task?.cancel()
        session?.invalidateAndCancel()
        task = nil
        session = nil
        completion()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Do not send Authorization headers to a redirected host.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !finished, let response = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            finish(error: "服务器未返回有效的 HTTP 响应")
            return
        }
        status = response.statusCode
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?
            .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if (200..<300).contains(status), contentType != "text/event-stream" {
            completionHandler(.cancel)
            finish(error: "服务未返回 SSE 流式内容，请检查模型接口")
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        byteCount += data.count
        guard byteCount <= 64 * 1024 * 1024 else { finish(error: "返回内容过大"); return }
        do {
            let text = try decoder.append(data)
            if !text.isEmpty { emit("data", data: text) }
        } catch { finish(error: "服务器返回了无效的 UTF-8 内容") }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        if let error { finish(error: safeNetworkError(error)); return }
        do {
            let text = try decoder.append(Data(), final: true)
            if !text.isEmpty { emit("data", data: text) }
            finish()
        } catch { finish(error: "服务器返回的 UTF-8 内容不完整") }
    }
}
