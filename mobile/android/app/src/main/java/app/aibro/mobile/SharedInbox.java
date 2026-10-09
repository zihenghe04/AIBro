package app.aibro.mobile;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Manifest-last inbox. It is acknowledged only after JS commits the note and attachment metadata. */
final class SharedInbox {
    static final ExecutorService QUEUE = Executors.newSingleThreadExecutor();
    private final Context context;
    private final File root;
    SharedInbox(Context context) { this(context, new File(context.getFilesDir(), "Inbox")); }
    SharedInbox(Context context, File root) { this.context = context; this.root = root; }
    static boolean isShare(Intent intent) {
        return intent != null && (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()));
    }
    String capture(Intent intent) throws Exception {
        if (!isShare(intent)) return null;
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) uris.addAll(streams);
        } else {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        }
        ClipData clips = intent.getClipData();
        if (clips != null) for (int i = 0; i < clips.getItemCount(); i++) {
            Uri uri = clips.getItemAt(i).getUri(); if (uri != null) uris.add(uri);
        }
        CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = extra == null ? "" : extra.toString();
        if (text.length() > NativePolicy.TEXT_LIMIT) throw new IllegalArgumentException("分享文字超过 20 万字，请缩小范围后重试");
        if (uris.size() > 12) throw new IllegalArgumentException("每次最多分享 12 个附件");
        if (text.trim().isEmpty() && uris.isEmpty()) throw new IllegalArgumentException("分享内容为空或格式不支持");
        String id = UUID.randomUUID().toString();
        // API 24 AtomicFile writes a new base file directly. Keep incomplete first writes
        // invisible to readers until the complete bundle is committed by a directory rename.
        File folder = new File(root, ".pending-" + id);
        if (!folder.mkdirs()) throw new IllegalStateException("无法建立分享收件箱");
        try {
            JSONArray files = new JSONArray(); int total = 0, index = 0;
            for (Uri uri : uris) {
                // Never let an untrusted share ask us to read our own private provider or arbitrary files.
                if (!"content".equals(uri.getScheme()) || (context.getPackageName() + ".fileprovider").equals(uri.getAuthority()))
                    throw new IllegalArgumentException("分享附件需要有效的文件读取授权");
                String name = "附件-" + (++index);
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex) && cursor.getLong(sizeIndex) > NativePolicy.INTAKE_LIMIT - total)
                            throw new IllegalArgumentException("分享附件合计超过 32 MB");
                    }
                }
                byte[] bytes;
                try (InputStream stream = context.getContentResolver().openInputStream(uri)) {
                    if (stream == null) throw new IllegalArgumentException("分享附件无法读取，请重新分享");
                    bytes = NativePolicy.readBounded(stream, NativePolicy.INTAKE_LIMIT - total);
                }
                total += bytes.length;
                String path = "attachment-" + index;
                atomicWrite(new File(folder, path), bytes);
                String mime = context.getContentResolver().getType(uri);
                files.put(new JSONObject().put("name", NativePolicy.filename(name)).put("path", path).put("mimeType", mime == null ? "application/octet-stream" : mime));
            }
            JSONObject manifest = new JSONObject().put("id", id).put("createdAt", System.currentTimeMillis()).put("text", text).put("files", files);
            atomicWrite(new File(folder, "manifest.json"), manifest.toString().getBytes(StandardCharsets.UTF_8));
            if (!folder.renameTo(new File(root, id))) throw new IllegalStateException("分享收件箱未提交，请重新分享");
            return id;
        } catch (Exception error) { deleteTree(folder); throw error; }
    }
    JSONArray read() throws Exception {
        JSONArray items = new JSONArray();
        File[] folders = root.listFiles(File::isDirectory); if (folders == null) return items;
        Arrays.sort(folders, Comparator.comparingLong(File::lastModified));
        for (File folder : folders) {
            if (!validID(folder.getName())) continue;
            File manifest = new File(folder, "manifest.json"); if (!manifest.exists()) continue;
            JSONObject item;
            try (FileInputStream input = new FileInputStream(manifest)) {
                item = new JSONObject(new String(NativePolicy.readBounded(input, 2 * 1024 * 1024), StandardCharsets.UTF_8));
            }
            JSONArray files = item.getJSONArray("files");
            if (files.length() > 12) throw new IllegalStateException("分享清单格式无效；资料已保留");
            int total = 0;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i); String path = file.getString("path");
                if (!path.matches("attachment-[0-9]+")) throw new IllegalStateException("分享附件路径无效；资料已保留");
                byte[] bytes;
                try (FileInputStream input = new FileInputStream(new File(folder, path))) { bytes = NativePolicy.readBounded(input, NativePolicy.INTAKE_LIMIT - total); }
                total += bytes.length; file.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            }
            item.put("id", folder.getName()); items.put(item); break;
        }
        return items;
    }
    void acknowledge(String id) throws Exception {
        if (!validID(id)) throw new IllegalArgumentException("分享标识无效");
        deleteTree(new File(root, id));
    }
    static boolean validID(String id) {
        return id != null && id.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
    }
    static void atomicWrite(File file, byte[] data) throws Exception {
        AtomicFile atomic = new AtomicFile(file); FileOutputStream stream = null;
        try { stream = atomic.startWrite(); stream.write(data); stream.getFD().sync(); atomic.finishWrite(stream); }
        catch (Exception error) { if (stream != null) atomic.failWrite(stream); throw error; }
    }
    static void deleteTree(File file) throws Exception {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (file.exists() && !file.delete()) throw new IllegalStateException("分享已导入，但清理收件箱失败");
    }
}
