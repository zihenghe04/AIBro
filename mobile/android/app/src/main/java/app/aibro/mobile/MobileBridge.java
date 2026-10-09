package app.aibro.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;
import java.io.File;
import java.io.InputStreamReader;
import java.net.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(name = "MobileBridge", permissions = {
    @Permission(alias = "microphone", strings = { android.Manifest.permission.RECORD_AUDIO })
})
public final class MobileBridge extends Plugin {
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final ExecutorService streamWorkers = Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<String, Call> streams = new ConcurrentHashMap<>();
    private WorkspaceDatabase database;
    private SecretVault vault;
    private OkHttpClient network;
    private OkHttpClient privateNetwork;
    private VoiceRecorder voice;
    private PluginCall pendingVoiceStart;
    private boolean voicePermissionPending;
    private final android.os.Handler voiceHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    @Override public void load() {
        database = new WorkspaceDatabase(getContext()); vault = new SecretVault(getContext());
        // No redirects, cookies, response cache or implicit retries of potentially committed writes.
        network = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(30, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS).callTimeout(180, TimeUnit.SECONDS).build();
        privateNetwork = network.newBuilder().proxy(Proxy.NO_PROXY).build();
        voice = new VoiceRecorder(getActivity(), event -> notifyListeners("voiceRecordingEvent", event));
    }
    interface Operation { void run() throws Exception; }
    private void storage(PluginCall call, String failure, Operation operation) {
        SharedInbox.QUEUE.execute(() -> perform(call, failure, operation));
    }
    private void perform(PluginCall call, String failure, Operation operation) {
        try { operation.run(); }
        catch (Exception error) {
            // Never expose URL paths, Authorization headers, keys or server payloads in native logs.
            call.reject(error instanceof IllegalArgumentException ? error.getMessage() : failure);
        }
    }
    @PluginMethod public void load(PluginCall call) {
        storage(call, "读取手机工作区失败；原数据已保留", () -> {
            String value = database.loadValue(); call.resolve(new JSObject().put("value", value == null ? JSONObject.NULL : value));
        });
    }
    @PluginMethod public void save(PluginCall call) {
        storage(call, "工作区未保存，请检查可用空间", () -> { database.saveValue(call.getString("value")); call.resolve(); });
    }
    @PluginMethod public void secretGet(PluginCall call) {
        storage(call, "凭据无法解密，请解锁设备或重新设置", () -> {
            String value = vault.get(call.getString("key")); call.resolve(new JSObject().put("value", value == null ? JSONObject.NULL : value));
        });
    }
    @PluginMethod public void secretSet(PluginCall call) {
        storage(call, "凭据未保存，请解锁设备后重试", () -> { vault.set(call.getString("key"), call.getString("value")); call.resolve(); });
    }
    @PluginMethod public void secretRemove(PluginCall call) {
        storage(call, "凭据未移除", () -> { vault.remove(call.getString("key")); call.resolve(); });
    }
    @PluginMethod public void connectionSessionFence(PluginCall call) {
        storage(call, "连接会话暂不可读取，请解锁设备后重试", () ->
            call.resolve(new JSObject().put("fence", vault.connectionSessionFence(call.getString("expectedSyncSha256")))));
    }
    @PluginMethod public void connectionVaultRead(PluginCall call) {
        storage(call, "连接配置无法读取，原数据已保留", () -> {
            JSONObject result = vault.connectionVaultRead(call.getObject("binding"), call.getObject("sessionFence"));
            call.resolve(new JSObject().put("revision", result.get("revision")).put("value", result.get("value")));
        });
    }
    @PluginMethod public void connectionVaultCompareAndSwap(PluginCall call) {
        storage(call, "连接配置写入未确认，请检查存储空间并重开应用", () ->
            call.resolve(new JSObject().put("swapped", vault.connectionVaultCompareAndSwap(call.getObject("binding"),
                call.getData().opt("expectedRevision"), call.getData().opt("value"), call.getObject("sessionFence")))));
    }
    @PluginMethod public void request(PluginCall call) {
        workers.execute(() -> {
            try {
                URI endpoint = NativePolicy.endpoint(call.getString("url"));
                String method = call.getString("method", "GET");
                if (!NativePolicy.METHODS.contains(method)) throw new IllegalArgumentException("请求方式无效");
                Request.Builder request = new Request.Builder().url(endpoint.toString());
                JSObject headers = call.getObject("headers", new JSObject());
                for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                    String key = keys.next(); Object value = headers.opt(key);
                    if (value instanceof String && NativePolicy.headerAllowed(key, (String) value)) request.header(key, (String) value);
                }
                RequestBody body = null;
                if (!method.equals("GET") && !method.equals("HEAD")) {
                    String encoded = call.getString("body", "");
                    byte[] bytes = call.getBoolean("binaryBody", false) ? decode(encoded, NativePolicy.FILE_LIMIT) : encoded.getBytes(StandardCharsets.UTF_8);
                    if (bytes.length > NativePolicy.FILE_LIMIT) throw new IllegalArgumentException("请求内容超过 64 MB");
                    body = RequestBody.create(bytes, null);
                }
                request.method(method, body);
                OkHttpClient client = NativePolicy.privateRoute(endpoint) ? privateNetwork : network;
                try (Response response = client.newCall(request.build()).execute()) {
                    ResponseBody responseBody = response.body();
                    if (responseBody != null && responseBody.contentLength() > NativePolicy.FILE_LIMIT) throw new IllegalArgumentException("返回内容超过 64 MB");
                    byte[] bytes = responseBody == null ? new byte[0] : NativePolicy.readBounded(responseBody.byteStream(), NativePolicy.FILE_LIMIT);
                    call.resolve(new JSObject().put("status", response.code()).put("data", call.getBoolean("raw", false) ?
                        Base64.encodeToString(bytes, Base64.NO_WRAP) : new String(bytes, StandardCharsets.UTF_8)));
                }
            } catch (Exception error) {
                String message = "连接中断；提交结果请刷新核对。";
                if (error instanceof IllegalArgumentException) message = error.getMessage();
                else if (error instanceof javax.net.ssl.SSLException) message = "HTTPS 安全连接失败，请检查证书或代理配置。";
                else if (error instanceof java.net.UnknownHostException) message = "无法解析服务器地址，请检查地址与 Tailscale 连接。";
                else if (error instanceof java.net.ConnectException) message = "无法连接服务器，请检查网络与 Tailscale 是否在线。";
                else if (error instanceof java.io.InterruptedIOException) message = "连接超时；提交结果请刷新核对。";
                call.reject(message);
            }
        });
    }
    @PluginMethod public void preview(PluginCall call) {
        workers.execute(() -> perform(call, "无法准备文件预览，请检查可用空间", () -> {
            byte[] bytes = decode(call.getString("data"), NativePolicy.FILE_LIMIT);
            String name = NativePolicy.filename(call.getString("name", "file"));
            File root = new File(getContext().getCacheDir(), "previews");
            if (!root.exists() && !root.mkdirs()) throw new IllegalStateException();
            // Expire previous temporary grants after a day without touching exported originals.
            File[] previous = root.listFiles();
            if (previous != null) for (File old : previous) if (old.lastModified() < System.currentTimeMillis() - 86400000L) {
                try { SharedInbox.deleteTree(old); } catch (Exception ignored) {}
            }
            File folder = new File(root, UUID.randomUUID().toString()); if (!folder.mkdir()) throw new IllegalStateException();
            File file = new File(folder, name); SharedInbox.atomicWrite(file, bytes);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            int dot = name.lastIndexOf('.'); String extension = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type == null ? "application/octet-stream" : type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(android.content.ClipData.newRawUri(name, uri));
            getActivity().runOnUiThread(() -> {
                try { getActivity().startActivity(intent); call.resolve(); }
                catch (ActivityNotFoundException error) { call.reject("设备没有支持此文件的预览应用，请使用导出原件"); }
                catch (Exception error) { call.reject("无法打开文件预览"); }
            });
        }));
    }
    @PluginMethod public void requestStream(PluginCall call) {
        try {
            String id = call.getString("requestId");
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("流式请求标识无效");
            URI endpoint = NativePolicy.endpoint(call.getString("url"));
            String method = call.getString("method", "POST");
            if (!NativePolicy.METHODS.contains(method)) throw new IllegalArgumentException("请求方式无效");
            Request.Builder builder = new Request.Builder().url(endpoint.toString());
            JSObject headers = call.getObject("headers", new JSObject());
            for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                String key = keys.next(); Object value = headers.opt(key);
                if (value instanceof String && NativePolicy.headerAllowed(key, (String) value)) builder.header(key, (String) value);
            }
            byte[] bytes = call.getString("body", "").getBytes(StandardCharsets.UTF_8);
            if (bytes.length > NativePolicy.FILE_LIMIT) throw new IllegalArgumentException("请求内容超过 64 MB");
            builder.method(method, method.equals("GET") || method.equals("HEAD") ? null : RequestBody.create(bytes, null));
            OkHttpClient client = NativePolicy.privateRoute(endpoint) ? privateNetwork : network;
            Call task = client.newCall(builder.build());
            synchronized (streams) {
                if (streams.containsKey(id)) throw new IllegalArgumentException("流式请求标识重复");
                if (streams.size() >= 2) throw new IllegalArgumentException("已有两个流式请求，请稍后重试");
                streams.put(id, task);
            }
            call.resolve();
            streamWorkers.execute(() -> {
                try (Response response = task.execute()) {
                    if (!response.isSuccessful()) {
                        finishStream(id, task, "error", "服务返回 HTTP " + response.code(), response.code()); return;
                    }
                    ResponseBody body = response.body();
                    String type = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                    if (body == null || !type.contains("text/event-stream")) {
                        finishStream(id, task, "error", "服务未返回 SSE 流式内容，请检查模型接口", response.code()); return;
                    }
                    long count = 0;
                    try (InputStreamReader reader = new InputStreamReader(body.byteStream(), StandardCharsets.UTF_8)) {
                        char[] buffer = new char[8192]; int n;
                        while ((n = reader.read(buffer)) != -1) {
                            if (streams.get(id) != task) return;
                            count += n;
                            if (count > NativePolicy.FILE_LIMIT) throw new IllegalArgumentException("流式返回内容超过大小限制");
                            notifyListeners("requestStreamEvent", new JSObject().put("requestId", id).put("type", "data")
                                .put("status", response.code()).put("data", new String(buffer, 0, n)));
                        }
                    }
                    finishStream(id, task, "done", null, response.code());
                } catch (Exception error) {
                    String message = task.isCanceled() ? "请求已取消" : error instanceof javax.net.ssl.SSLException ? "HTTPS 安全连接失败，请检查证书或代理配置。" :
                        error instanceof java.io.InterruptedIOException ? "流式连接超时；已接收的内容已保留" : "流式连接中断；已接收的内容已保留";
                    finishStream(id, task, "error", message, 0);
                }
            });
        } catch (Exception error) { call.reject(error instanceof IllegalArgumentException ? error.getMessage() : "无法启动流式请求"); }
    }
    private void finishStream(String id, Call task, String type, String error, int status) {
        if (!streams.remove(id, task)) return;
        JSObject event = new JSObject().put("requestId", id).put("type", type).put("status", status);
        if (error != null) event.put("error", error);
        notifyListeners("requestStreamEvent", event);
    }
    @PluginMethod public void cancelRequest(PluginCall call) {
        String id = call.getString("requestId");
        Call task = id == null ? null : streams.remove(id);
        if (task != null) {
            task.cancel();
            notifyListeners("requestStreamEvent", new JSObject().put("requestId", id).put("type", "error").put("error", "请求已取消"));
        }
        call.resolve(new JSObject().put("cancelled", task != null));
    }
    @PluginMethod public void extractText(PluginCall call) {
        workers.execute(() -> perform(call, "本机暂未提取到文字；PDF 可能需要密码，原件仍可预览", () ->
            call.resolve(TextExtractor.extract(getContext(), call.getString("name", ""), decode(call.getString("data"), NativePolicy.INTAKE_LIMIT)))));
    }
    @PluginMethod public void shared(PluginCall call) {
        storage(call, "分享资料暂未读取，原件仍保留", () -> call.resolve(new JSObject().put("items", new SharedInbox(getContext()).read())));
    }
    @PluginMethod public void sharedAck(PluginCall call) {
        storage(call, "分享已导入，但清理收件箱失败", () -> { new SharedInbox(getContext()).acknowledge(call.getString("id")); call.resolve(); });
    }
    @PluginMethod public void widgetSave(PluginCall call) {
        storage(call, "今日小组件未更新，请重试", () -> { TodayWidget.save(getContext(), call.getString("value")); call.resolve(); });
    }
    void sharedReceived() { notifyListeners("sharedReceived", new JSObject(), true); }
    private boolean voiceForeground() {
        return getActivity() instanceof MainActivity && ((MainActivity) getActivity()).isVoiceForeground();
    }
    private void voiceMain(PluginCall call, Operation operation) {
        getActivity().runOnUiThread(() -> perform(call, "语音操作未完成，请检查麦克风权限与可用空间后重试", operation));
    }
    @PluginMethod public void voiceStart(PluginCall call) {
        voiceMain(call, () -> {
            VoiceSessionState.validId(call.getString("requestId"));
            if (!voiceForeground()) throw new IllegalArgumentException("请解锁设备，并在 AI Bro 前台开始录音");
            if (pendingVoiceStart != null || voice.hasSession()) throw new IllegalArgumentException("已有录音待完成，请先停止或取消");
            pendingVoiceStart = call;
            if (getPermissionState("microphone") == PermissionState.GRANTED) completeVoiceStart(call);
            else {
                voicePermissionPending = true;
                try { requestPermissionForAlias("microphone", call, "microphonePermissionResult"); }
                catch (RuntimeException error) {
                    pendingVoiceStart = null; voicePermissionPending = false;
                    throw new IllegalArgumentException("系统麦克风授权没有打开，请在设置中检查权限");
                }
                voiceHandler.postDelayed(() -> {
                    if (pendingVoiceStart == call) rejectPendingVoice("麦克风授权未完成，请在前台重试");
                }, 30000);
            }
        });
    }
    @PermissionCallback private void microphonePermissionResult(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (call == null || pendingVoiceStart != call) return; // Capacitor releases cancelled/expired calls before a late permission result.
            voicePermissionPending = false;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                rejectPendingVoice("未获得麦克风权限，请在系统应用权限中允许后重试"); return;
            }
            // Android can deliver this callback just before Activity.onResume.
            if (voiceForeground()) completeVoiceStart(call);
            else voiceHandler.postDelayed(() -> {
                if (pendingVoiceStart == call) {
                    if (voiceForeground()) completeVoiceStart(call);
                    else rejectPendingVoice("录音没有开始：请解锁设备并返回 AI Bro 前台");
                }
            }, 600);
        });
    }
    private void completeVoiceStart(PluginCall call) {
        if (call == null || pendingVoiceStart != call || voicePermissionPending) return;
        pendingVoiceStart = null;
        try {
            if (!voiceForeground()) throw new IllegalArgumentException("请解锁设备，并在 AI Bro 前台开始录音");
            voice.start(call.getString("requestId"));
            call.resolve(new JSObject().put("requestId", call.getString("requestId")).put("recording", true));
        } catch (Exception error) { call.reject(error instanceof IllegalArgumentException ? error.getMessage() : "录音未能开始，请检查麦克风权限、其他应用的音频占用与可用空间"); }
    }
    private void rejectPendingVoice(String error) {
        PluginCall pending = pendingVoiceStart; pendingVoiceStart = null; voicePermissionPending = false;
        if (pending != null) pending.reject(error);
    }
    @PluginMethod public void voiceStop(PluginCall call) {
        voiceMain(call, () -> {
            if (!voiceForeground()) throw new IllegalArgumentException("录音已中断，请返回 AI Bro 前台重新录音");
            call.resolve(voice.stop(call.getString("requestId")));
        });
    }
    @PluginMethod public void voiceCancel(PluginCall call) {
        voiceMain(call, () -> {
            String id = VoiceSessionState.validId(call.getString("requestId"));
            boolean cancelled = pendingVoiceStart != null && id.equals(pendingVoiceStart.getString("requestId"));
            if (cancelled) rejectPendingVoice("录音已取消");
            cancelled = voice.cancel(id, "用户取消") || cancelled;
            call.resolve(new JSObject().put("requestId", id).put("cancelled", cancelled));
        });
    }
    private JSObject voiceStatusValue() {
        PermissionState permission = getPermissionState("microphone");
        boolean optedIn = new VoiceShortcutStore(getContext()).enabled(), service = VoiceShortcutService.isConnected();
        return new JSObject().put("recording", voice.recording()).put("microphonePermission", permission == PermissionState.GRANTED ? "granted" : permission == PermissionState.DENIED ? "denied" : "prompt")
            .put("shortcutSupported", true).put("shortcutEnabled", optedIn && service).put("shortcutOptIn", optedIn)
            .put("shortcutServiceEnabled", service).put("shortcutForegroundEnabled", optedIn).put("foregroundOnly", true);
    }
    @PluginMethod public void voiceStatus(PluginCall call) { voiceMain(call, () -> call.resolve(voiceStatusValue())); }
    @PluginMethod public void voiceShortcutSet(PluginCall call) {
        voiceMain(call, () -> {
            Boolean enabled = call.getBoolean("enabled"); if (enabled == null) throw new IllegalArgumentException("请选择是否启用快捷键");
            new VoiceShortcutStore(getContext()).setEnabled(enabled); call.resolve(voiceStatusValue());
        });
    }
    @PluginMethod public void openVoiceShortcutSettings(PluginCall call) {
        voiceMain(call, () -> {
            if (!voiceForeground()) throw new IllegalArgumentException("请在 AI Bro 前台打开系统设置");
            // Opening this page never grants accessibility permission or changes secure settings.
            Intent settings = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            getActivity().startActivity(settings); call.resolve();
        });
    }
    @PluginMethod public void voiceShortcutPending(PluginCall call) {
        voiceMain(call, () -> call.resolve(new VoiceShortcutStore(getContext()).pending()));
    }
    @PluginMethod public void voiceShortcutAck(PluginCall call) {
        voiceMain(call, () -> { new VoiceShortcutStore(getContext()).acknowledge(call.getString("requestId")); call.resolve(); });
    }
    void voiceShortcutReceived() {
        JSObject pending = new VoiceShortcutStore(getContext()).pending();
        if (!pending.isNull("requestId")) notifyListeners("voiceShortcut", pending, true);
    }
    @Override protected void handleOnResume() {
        if (pendingVoiceStart != null && !voicePermissionPending && getPermissionState("microphone") == PermissionState.GRANTED)
            completeVoiceStart(pendingVoiceStart);
        voiceShortcutReceived(); super.handleOnResume();
    }
    @Override protected void handleOnPause() {
        if (voice != null) voice.interrupt("App 已离开前台，录音已取消");
        super.handleOnPause();
    }
    @Override protected void handleOnStop() {
        rejectPendingVoice("App 已离开前台，录音没有开始");
        if (voice != null) voice.interrupt("App 已离开前台，录音已取消");
        super.handleOnStop();
    }
    static byte[] decode(String encoded, int limit) {
        if (encoded == null || encoded.length() > ((long) limit + 2) / 3 * 4 + 4) throw new IllegalArgumentException("文件无效或超过大小限制");
        byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("文件编码无效"); }
        if (bytes.length > limit) throw new IllegalArgumentException("文件超过大小限制");
        return bytes;
    }
    @Override protected void handleOnDestroy() {
        voiceHandler.removeCallbacksAndMessages(null); rejectPendingVoice("录音已取消");
        if (voice != null) voice.interrupt("App 已关闭，录音已取消");
        workers.shutdown();
        for (Call task : streams.values()) task.cancel();
        streams.clear(); streamWorkers.shutdown();
        if (network != null) network.dispatcher().cancelAll();
        if (privateNetwork != null) privateNetwork.dispatcher().cancelAll();
        SharedInbox.QUEUE.execute(() -> { if (database != null) database.close(); });
        super.handleOnDestroy();
    }
}
