package app.aibro.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.AtomicFile;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class TodayWidget extends AppWidgetProvider {
    static synchronized void save(Context context, String value) throws Exception {
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length >= 131072) throw new IllegalArgumentException("小组件内容过大");
        JSONObject object = new JSONObject(value); JSONArray items = object.getJSONArray("items");
        if (!(object.opt("updatedAt") instanceof Number) || items.length() > 64) throw new IllegalArgumentException("小组件内容格式无效");
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            if (!(item.opt("title") instanceof String) || !(item.opt("start") instanceof Number) || !(item.opt("end") instanceof Number))
                throw new IllegalArgumentException("小组件日程格式无效");
        }
        SharedInbox.atomicWrite(new File(context.getFilesDir(), "widget.json"), value.getBytes(StandardCharsets.UTF_8));
        refresh(context, AppWidgetManager.getInstance(context));
    }
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) { refresh(context, manager); }
    private static synchronized void refresh(Context context, AppWidgetManager manager) {
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        if (ids.length == 0) return;
        String text = "打开 AI Bro 查看今天的安排";
        String updated = "尚未同步日程";
        try (FileInputStream input = new AtomicFile(new File(context.getFilesDir(), "widget.json")).openRead()) {
            JSONObject object = new JSONObject(new String(NativePolicy.readBounded(input, 131072), StandardCharsets.UTF_8));
            JSONArray items = object.getJSONArray("items"); StringBuilder body = new StringBuilder(); int shown = 0;
            SimpleDateFormat time = new SimpleDateFormat("MM/dd HH:mm", Locale.getDefault());
            long now = System.currentTimeMillis();
            for (int i = 0; i < items.length() && shown < 5; i++) {
                JSONObject item = items.getJSONObject(i); if (item.getDouble("end") <= now) continue;
                if (shown++ > 0) body.append("\n\n");
                String title = item.getString("title");
                body.append(time.format(new Date(item.getLong("start")))).append("  ").append(title.substring(0, Math.min(title.length(), 70)));
            }
            text = shown == 0 ? "暂无接下来的安排" : body.toString();
            updated = "更新于 " + time.format(new Date(object.getLong("updatedAt")));
        } catch (Exception ignored) { /* An unreadable snapshot never overwrites the workspace. */ }
        Intent launch = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse("aibro://today"));
        PendingIntent pending = PendingIntent.getActivity(context, 41001, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            RemoteViews view = new RemoteViews(context.getPackageName(), R.layout.today_widget);
            view.setTextViewText(R.id.widget_events, text); view.setTextViewText(R.id.widget_updated, updated);
            view.setOnClickPendingIntent(R.id.widget_root, pending); manager.updateAppWidget(id, view);
        }
    }
}
