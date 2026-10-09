package app.aibro.mobile;

/** SharedPreferences may change its memory map even when commit fails. Called under the vault lock. */
final class VaultEntryCommit {
    interface Entry {
        String read();
        boolean commit(String value);
        void quarantine();
    }
    static void replace(Entry entry, String value) {
        String previous = entry.read();
        try { if (entry.commit(value)) return; } catch (RuntimeException ignored) { /* Restore the last known value. */ }
        boolean restored = false;
        try { restored = entry.commit(previous); } catch (RuntimeException ignored) { /* Refuse further reads/writes in this process. */ }
        if (!restored) entry.quarantine();
        throw new IllegalStateException("凭据写入未确认，请重试或关闭后重开应用");
    }
    private VaultEntryCommit() {}
}
