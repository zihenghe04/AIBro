import Foundation

/// Local presentation/suggestion policy, never a network or access-control rule.
/// Adapted from TO-DO Panel 1deb3cac renderer/domain.js:78–109. Unlike its
/// first-match grouping, callers preserve scope and explicitly choose folders.
/// Unknown suffixes keep the complete host; this is not a complete PSL parser.
enum NativeQuickLinkSitePolicy {
    private static let knownSuffixes: Set<String> = [
        "com", "org", "net", "edu", "gov", "mil", "int", "io", "app", "dev",
        "ai", "info", "biz", "name", "me", "tv", "xyz", "tech", "online", "site",
        "plus", "de", "fr", "ca", "ch", "nl", "se", "no", "fi", "es", "it",
        "cn", "uk", "au", "jp", "kr", "nz"
    ]
    // Common multi-label public suffixes and independent hosting tenants. Keep
    // this explicit and offline; do not infer ownership from a substring.
    private static let nestedSuffixes: Set<String> = [
        "co.uk", "org.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk",
        "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
        "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "ac.kr",
        "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz",
        "github.io", "gitlab.io", "vercel.app", "pages.dev", "netlify.app", "notion.site",
        "appspot.com", "blogspot.com", "cloudfront.net", "azurewebsites.net",
        "herokuapp.com", "web.app", "firebaseapp.com", "wordpress.com", "tumblr.com"
    ]

    static func host(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 8192,
              let parts = URLComponents(string: text.contains("://") ? text : "https://" + text),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil,
              var host = parts.url?.host?.lowercased() else { return nil }
        if host.hasSuffix(".") { host.removeLast() }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, host.utf8.count <= 253,
              labels.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 63 && $0.first != "-" && $0.last != "-" &&
                  $0.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 } }),
              labels.last!.contains(where: { $0.isLetter }),
              !["localhost", "local", "internal", "lan", "home.arpa", "onion"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) else { return nil }
        return host
    }

    static func siteKey(for raw: String) -> String? {
        guard let host = host(raw) else { return nil }
        let labels = host.split(separator: ".").map(String.init)
        if let suffix = nestedSuffixes.filter({ host == $0 || host.hasSuffix("." + $0) }).max(by: { $0.count < $1.count }) {
            let count = suffix.split(separator: ".").count + 1
            return labels.count >= count ? labels.suffix(count).joined(separator: ".") : host
        }
        guard let suffix = labels.last, knownSuffixes.contains(suffix) else { return host }
        // A country-code suffix may contain unlisted delegated registries.
        // Only explicit multi-label rules or a direct two-label host are merged.
        if ["cn", "uk", "au", "jp", "kr", "nz"].contains(suffix), labels.count > 2 { return host }
        return labels.suffix(2).joined(separator: ".")
    }
}

/*
MIT License
Copyright (c) 2026 TO-DO Panel contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
