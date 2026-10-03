import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

/// Only local presentation preferences. Never stores a captured camera frame.
struct NativeQuickMirrorPreferences: Codable, Equatable, Sendable {
    var cameraID: String? = nil
    var coverJPEG: Data? = nil
}

struct NativeQuickMirrorImage: @unchecked Sendable { let image: CGImage }

final class NativeQuickMirrorWriteLease: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func revoke() { lock.lock(); valid = false; lock.unlock() }
    func commit(_ body: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard valid else { throw CancellationError() }
        try body()
    }
}

/// Bounded image decode and all disk work live off the UI thread. The commit
/// lease is synchronously revoked on privacy/owner changes before a rename.
actor NativeQuickMirrorArchive {
    enum Failure: Error { case unsafePath, invalidImage, invalidPreferences, writeFailed }
    let directory: URL
    init(directory: URL) { self.directory = directory }
    private func openDirectory() throws -> Int32 {
        var path = directory.standardizedFileURL
        while path.path != "/" {
            if (try? path.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { throw Failure.unsafePath }
            path.deleteLastPathComponent()
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unsafePath }
        return fd
    }
    func load() throws -> NativeQuickMirrorPreferences {
        let dir = try openDirectory(); defer { close(dir) }
        let fd = openat(dir, "preferences.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return .init() }
        guard fd >= 0 else { throw Failure.unsafePath }; defer { close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
            info.st_size >= 0, info.st_size <= 2_000_000 else { throw Failure.invalidPreferences }
        var data = Data(count: Int(info.st_size))
        let count = data.withUnsafeMutableBytes { raw in Darwin.read(fd, raw.baseAddress, raw.count) }
        guard count == data.count else { throw Failure.invalidPreferences }
        let value = try JSONDecoder().decode(NativeQuickMirrorPreferences.self, from: data)
        try validate(value); return value
    }
    func preview(_ value: NativeQuickMirrorPreferences) -> NativeQuickMirrorImage? {
        guard let data = value.coverJPEG,
              let source = CGImageSourceCreateWithData(data as CFData,nil),
              let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else { return nil }
        return .init(image:image)
    }
    private func validate(_ value: NativeQuickMirrorPreferences) throws {
        guard (value.cameraID?.utf8.count ?? 0) <= 512,
              (value.coverJPEG?.count ?? 0) <= 1_200_000 else { throw Failure.invalidPreferences }
        if let data = value.coverJPEG {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  CGImageSourceGetCount(source) == 1,
                  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = props[kCGImagePropertyPixelWidth] as? Int,
                  let height = props[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 1600, height <= 1600 else { throw Failure.invalidPreferences }
        }
    }
    func save(_ value: NativeQuickMirrorPreferences, lease: NativeQuickMirrorWriteLease) throws {
        try validate(value)
        let bytes = try JSONEncoder().encode(value)
        let dir = try openDirectory(); defer { close(dir) }
        let temp = ".mirror-" + UUID().uuidString
        let fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.writeFailed }
        defer { close(fd); unlinkat(dir, temp, 0) }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count-offset)
                guard n > 0 else { throw Failure.writeFailed }; offset += n
            }
        }
        guard fsync(fd) == 0 else { throw Failure.writeFailed }
        try lease.commit {
            guard renameat(dir, temp, dir, "preferences.json") == 0 else { throw Failure.writeFailed }
        }
        guard fsync(dir) == 0 else { throw Failure.writeFailed }
    }
    /// Decode the user's explicitly selected image, strip metadata, cap dimensions
    /// and bytes. No source bookmark/path or embedded location metadata is saved.
    nonisolated static func cover(from url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unsafePath }; defer { close(fd) }
        var info = stat(); guard fstat(fd,&info) == 0, info.st_mode & S_IFMT == S_IFREG,
            info.st_size > 0, info.st_size <= 25_000_000 else { throw Failure.invalidImage }
        var bytes = Data(count:Int(info.st_size))
        let readCount = bytes.withUnsafeMutableBytes { Darwin.read(fd,$0.baseAddress,$0.count) }
        guard readCount == bytes.count, let source = CGImageSourceCreateWithData(bytes as CFData,nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 60_000_000 / height else { throw Failure.invalidImage }
        let options: [CFString:Any] = [kCGImageSourceCreateThumbnailFromImageAlways:true,
            kCGImageSourceThumbnailMaxPixelSize:1600,kCGImageSourceCreateThumbnailWithTransform:true,
            kCGImageSourceShouldCacheImmediately:true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source,0,options as CFDictionary) else { throw Failure.invalidImage }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output,UTType.jpeg.identifier as CFString,1,nil) else { throw Failure.invalidImage }
        CGImageDestinationAddImage(destination,image,[kCGImageDestinationLossyCompressionQuality:0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= 1_200_000 else { throw Failure.invalidImage }
        return output as Data
    }
}
