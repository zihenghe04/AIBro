package app.aibro.mobile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.Arrays;
import java.util.HashSet;

/** Shared, testable boundaries for input arriving from the WebView or another app. */
final class NativePolicy {
    static final int FILE_LIMIT = 64 * 1024 * 1024;
    static final int INTAKE_LIMIT = 32 * 1024 * 1024;
    static final int TEXT_LIMIT = 200000;
    static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"));
    static final Set<String> KEYS = new HashSet<>(Arrays.asList("sync", "model", "ucas", "speech"));
    private static final Set<String> LOOPBACK = new HashSet<>(Arrays.asList("localhost", "127.0.0.1", "[::1]", "::1"));
    private static final Set<String> BLOCKED_HEADERS = new HashSet<>(Arrays.asList("host", "cookie", "cookie2", "content-length", "connection", "proxy-authorization"));

    static URI endpoint(String text) {
        try {
            URI uri = new URI(text);
            String host = uri.getHost();
            boolean loopback = LOOPBACK.contains(host == null ? "" : host.toLowerCase(Locale.ROOT));
            if (host == null || uri.getRawUserInfo() != null || uri.getFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535 ||
                !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && loopback)))
                throw new IllegalArgumentException();
            return uri;
        } catch (Exception error) { throw new IllegalArgumentException("请使用不含账号密码的 HTTPS 地址"); }
    }

    static boolean privateRoute(URI uri) {
        String host = uri.getHost().toLowerCase(Locale.ROOT).replaceAll("\\.+$", "");
        return host.endsWith(".ts.net") || LOOPBACK.contains(host);
    }

    static boolean headerAllowed(String name, String value) {
        if (name == null || value == null || !name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+") ||
            BLOCKED_HEADERS.contains(name.toLowerCase(Locale.ROOT))) return false;
        // OkHttp includes invalid header values in its exceptions. Reject them before
        // building the request so a malformed Authorization value cannot enter an error.
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            if ((character < 32 && character != '\t') || character >= 127) return false;
        }
        return true;
    }

    static String filename(String name) {
        String safe = (name == null ? "file" : name).replaceAll("[\\\\/\\x00-\\x1f\\x7f]", "_");
        if (safe.trim().isEmpty() || safe.equals(".") || safe.equals("..")) safe = "file";
        if (safe.getBytes(StandardCharsets.UTF_8).length <= 180) return safe;
        int dot = safe.lastIndexOf('.');
        String suffix = dot > 0 && safe.length() - dot <= 20 ? safe.substring(dot) : "";
        String stem = suffix.isEmpty() ? safe : safe.substring(0, dot);
        int budget = 180 - suffix.getBytes(StandardCharsets.UTF_8).length, end = 0, used = 0;
        while (end < stem.length()) {
            int code = stem.codePointAt(end), width = Character.charCount(code);
            int bytes = new String(Character.toChars(code)).getBytes(StandardCharsets.UTF_8).length;
            if (used + bytes > budget) break;
            used += bytes; end += width;
        }
        return stem.substring(0, end) + suffix;
    }

    static byte[] readBounded(InputStream input, int limit) throws IOException {
        if (input == null) return new byte[0];
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int n;
        while ((n = input.read(buffer)) != -1) {
            if (output.size() > limit - n) throw new IOException("文件或返回内容超过大小限制");
            output.write(buffer, 0, n);
        }
        return output.toByteArray();
    }
}
