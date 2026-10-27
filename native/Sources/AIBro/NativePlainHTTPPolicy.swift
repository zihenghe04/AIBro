import Foundation

/// Plain http / ws is only used by the self-hosted speech protocol, for an address the user typed.
/// App Transport Security refuses it for URLSession (checked: a public IP address answers -1022, even though loopback and LAN addresses pass),
/// and an Info.plist exception cannot name an arbitrary IP, so the app does not relax ATS. Instead the self-hosted client talks over
/// Network.framework (`NativePlainHTTP`, `NativeQuickASRPlainWebSocket`), which ATS does not govern. https / wss keep using URLSession.
enum NativePlainHTTPPolicy {
    /// Plain transport is allowed for the self-hosted protocol only.
    static func allowsPlain(selfHosted: Bool) -> Bool { selfHosted }
}
