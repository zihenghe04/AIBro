import Foundation

@main struct Checks {
    static func main() {
        let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        let prod = NativeQuickToolsLocation.directory(environment: [:], home: home, bundleID: "app.ai-workstation.studio")
        precondition(prod.path == "/Users/someone/Library/Application Support/app.ai-workstation.studio/QuickTools", prod.path)
        let isolated = NativeQuickToolsLocation.directory(environment: ["AIBRO_NATIVE_DATA_DIR": "/tmp/aibro-x"], home: home, bundleID: "app.ai-workstation.studio")
        precondition(isolated.path == "/tmp/aibro-x/QuickTools", isolated.path)
        // A relative or empty value is ignored, never resolved against the working directory.
        for bad in ["", "relative/dir"] {
            let url = NativeQuickToolsLocation.directory(environment: ["AIBRO_NATIVE_DATA_DIR": bad], home: home, bundleID: "b")
            precondition(url.path == "/Users/someone/Library/Application Support/b/QuickTools", url.path)
        }
        print("quicktools location checks")
    }
}
