import Cocoa
import WebKit
// usage: h <html> <readRoot> <stub.js> <steps.json> <outDir>
final class D: NSObject, WKNavigationDelegate {
    let web: WKWebView; let steps: [[String: Any]]; let out: String; var i = 0; var failed = 0
    init(web: WKWebView, steps: [[String: Any]], out: String) { self.web = web; self.steps = steps; self.out = out }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.next() } }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("FAIL", e); exit(2) }
    func next() {
        guard i < steps.count else { print(failed == 0 ? "ALL STEPS OK" : "FAILED STEPS: \(failed)"); exit(failed == 0 ? 0 : 4) }
        let s = steps[i]; i += 1
        if let w = s["w"] as? Double, let h = s["h"] as? Double { web.window?.setContentSize(NSSize(width: w, height: h)); web.frame = NSRect(x: 0, y: 0, width: w, height: h) }
        let js = (s["js"] as? String) ?? "return null"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): print("[\(self.i)] \(s["name"] ?? "")", v ?? "ok")
            case .failure(let e): self.failed += 1; print("[\(self.i)] ERR", (e as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? e)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + (s["wait"] as? Double ?? 0.4)) {
                if let shot = s["shot"] as? String {
                    self.web.takeSnapshot(with: nil) { img, _ in
                        if let img = img, let t = img.tiffRepresentation, let b = NSBitmapImageRep(data: t)?.representation(using: .png, properties: [:]) {
                            try? b.write(to: URL(fileURLWithPath: "\(self.out)/\(shot).png"))
                        }
                        self.next()
                    }
                } else { self.next() }
            }
        }
    }
}
let a = CommandLine.arguments
let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()
let stub = try! String(contentsOfFile: a[3])
cfg.userContentController.addUserScript(WKUserScript(source: stub, injectionTime: .atDocumentStart, forMainFrameOnly: true))
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
if ProcessInfo.processInfo.environment["HARNESS_DARK"] == "1" { web.appearance = NSAppearance(named: .darkAqua) }
let win = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = web; win.setFrameOrigin(NSPoint(x: -3000, y: 0)); win.orderBack(nil)
let steps = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[4]))) as! [[String: Any]]
let d = D(web: web, steps: steps, out: a[5]); web.navigationDelegate = d
web.loadFileURL(URL(fileURLWithPath: a[1]), allowingReadAccessTo: URL(fileURLWithPath: a[2]))
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { print("TIMEOUT"); exit(3) }
app.run()
