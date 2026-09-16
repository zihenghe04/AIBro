import UIKit
import UniformTypeIdentifiers

// Commit manifest last; the containing app acknowledges only after durable import.
final class ShareViewController: UIViewController {
    private let text = UITextView()
    private let status = UILabel()
    private let save = UIButton(type: .system)
    private var pending: [[String: String]] = []
    private var folder: URL?
    private var failed = false
    private var totalBytes = 0
    private let intakeQueue: OperationQueue = { let q=OperationQueue();q.maxConcurrentOperationCount=1;return q }()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "保存到 AI Bro 随记"; title.font = .preferredFont(forTextStyle: .title2)
        text.font = .preferredFont(forTextStyle: .body); text.backgroundColor = .secondarySystemBackground; text.layer.cornerRadius = 14
        status.text = "正在接收资料…"; status.numberOfLines = 0; status.textColor = .secondaryLabel
        save.setTitle("保存随记", for: .normal); save.addTarget(self, action: #selector(commit), for: .touchUpInside); save.isEnabled = false
        let cancel = UIButton(type: .system); cancel.setTitle("取消", for: .normal); cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, text, status, save, cancel]); stack.axis = .vertical; stack.spacing = 18; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24), stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20), text.heightAnchor.constraint(equalToConstant: 200)])
        receive()
    }
    private func receive() {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile") else { fail(); return }
        let folder = root.appendingPathComponent("Inbox").appendingPathComponent(UUID().uuidString)
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true); self.folder = folder } catch { fail(); return }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let group = DispatchGroup()
        for (index, provider) in providers.prefix(12).enumerated() {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) || provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                let type = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) ? UTType.fileURL.identifier : provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? UTType.image.identifier : UTType.pdf.identifier
                group.enter()
                intakeQueue.addOperation {
                let gate=DispatchSemaphore(value:0)
                provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
                    defer { gate.signal() }
                    var descriptor: [String: String]?
                    var count=0
                    do {
                        if error != nil { throw error! }
                        var bytes: Data; var name = provider.suggestedName ?? "附件"
                        if let url = value as? URL {
                            let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                            guard size <= 32 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                            bytes = try Data(contentsOf: url); name = url.lastPathComponent
                        } else if let image = value as? UIImage, let data = image.jpegData(compressionQuality: 0.88) { bytes = data; name += ".jpg" }
                        else if let data = value as? Data { bytes = data; if type == UTType.image.identifier { name += ".png" } }
                        else { throw CocoaError(.fileReadUnknown) }
                        guard bytes.count <= 32 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                        count=bytes.count
                        let path = "attachment-\(index)"
                        try bytes.write(to: folder.appendingPathComponent(path), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        descriptor = ["name": name, "path": path, "mimeType": UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"]
                    } catch { DispatchQueue.main.async { self.fail() } }
                    let byteCount=count
                    DispatchQueue.main.async { if let descriptor { self.totalBytes += byteCount; if self.totalBytes > 32 * 1024 * 1024 { self.fail() } else { self.pending.append(descriptor) } }; group.leave() }
                }
                gate.wait()
                }
            } else {
                let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? UTType.url.identifier : UTType.plainText.identifier
                guard provider.hasItemConformingToTypeIdentifier(type) else { failed = true; continue }
                group.enter(); provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
                    DispatchQueue.main.async {
                        if error != nil { self.fail() }
                        if let url = value as? URL { self.text.text += (self.text.text.isEmpty ? "" : "\n") + url.absoluteString }
                        else if let string = value as? String { self.text.text += (self.text.text.isEmpty ? "" : "\n") + string }
                        group.leave()
                    }
                }
            }
        }
        if providers.count > 12 { failed = true }
        group.notify(queue: .main) {
            if self.failed { self.fail(); return }
            self.status.text = "\(self.pending.count) 个附件。保存后，下次打开 AI Bro 会自动接收。"
            self.save.isEnabled = true
        }
    }
    private func fail() { failed = true; save.isEnabled = false; status.text = "部分资料无法接收。请一次分享不超过 12 项，附件合计不超过 32 MB，再重试。" }
    @objc private func commit() {
        guard !failed, let folder, !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty else { return }
        save.isEnabled = false
        do {
            let data = try JSONSerialization.data(withJSONObject: ["id": folder.lastPathComponent, "createdAt": Date().timeIntervalSince1970 * 1000, "text": text.text ?? "", "files": pending])
            try data.write(to: folder.appendingPathComponent("manifest.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            extensionContext?.completeRequest(returningItems: nil)
        } catch { save.isEnabled = true; status.text = "保存失败，资料仍在这里，请重试。" }
    }
    @objc private func cancelShare() { if let folder { try? FileManager.default.removeItem(at: folder) }; extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
}
