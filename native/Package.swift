// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AIBroNative", platforms: [.macOS(.v14)], products: [.executable(name: "AIBroNative", targets: ["AIBro"])], targets: [.executableTarget(name: "AIBro")], swiftLanguageVersions: [.v5])
