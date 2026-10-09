package app.aibro.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDoneException;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** Workspace, sync cursor and pending operations commit as one durable document. */
final class WorkspaceDatabase extends SQLiteOpenHelper {
    WorkspaceDatabase(Context context) { this(context, "workspace.sqlite"); }
    WorkspaceDatabase(Context context, String name) { super(context, name, null, 1); setWriteAheadLoggingEnabled(true); }
    @Override public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.execSQL("PRAGMA synchronous=FULL");
        // busy_timeout returns a row even when setting it; execSQL only accepts SQLITE_DONE.
        try (SQLiteStatement timeout = db.compileStatement("PRAGMA busy_timeout=5000")) { timeout.simpleQueryForLong(); }
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) { throw new IllegalStateException("工作区版本不受支持；原数据已保留"); }
    String loadValue() {
        // A workspace document can exceed Android's ~2 MB CursorWindow limit.
        // Read the scalar directly instead of copying this single large row into a window.
        try (SQLiteStatement statement = getReadableDatabase().compileStatement("SELECT value FROM workspace WHERE id=1")) {
            return statement.simpleQueryForString();
        } catch (SQLiteDoneException empty) { return null; }
    }
    void saveValue(String value) throws Exception {
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 128 * 1024 * 1024)
            throw new IllegalArgumentException("工作区格式无效，未覆盖原数据");
        Object schema = new JSONObject(value).opt("schema");
        if (!(schema instanceof Number) || ((Number) schema).doubleValue() != 1)
            throw new IllegalArgumentException("工作区格式无效，未覆盖原数据");
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues values = new ContentValues(); values.put("id", 1); values.put("value", value);
            if (db.insertWithOnConflict("workspace", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0)
                throw new IllegalStateException("工作区未保存，请检查可用空间");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
}
