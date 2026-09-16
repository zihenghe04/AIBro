// Native agenda adapter. The existing workspace remains the sole note writer.
(() => {
  const canonical = value => JSON.stringify(sort(value));
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
  let busy = false;
  const ready = () => {
    if (typeof storageHydrated === 'undefined' || !storageHydrated || serverConflict || sendMessage.busy || purgeTrash.syncPaused) throw Error('工作区暂未就绪，日程稍后同步');
  };
  const agenda = n => n?.kind === '日程' && typeof n.content === 'string';
  const current = id => state.notes.find(n => n.id === id);
  window.NativeAgendaSync = {
    async read() {
      ready(); if (busy) throw Error('正在保存日程');
      if (state._pendingLocalSave || serverSaveQueued || serverSaveInFlight) await window.flushWorkspace();
      ready();
      if (state._pendingLocalSave || serverSaveInFlight) throw Error('工作区仍在保存');
      return JSON.stringify(Object.fromEntries(state.notes.filter(agenda).map(n => [n.id, canonical(n)])));
    },
    async write(changes) {
      ready(); if (busy) throw Error('正在保存日程');
      if (!Array.isArray(changes) || changes.length > 10000) throw Error('日程同步批次无效');
      const replacements = changes.map(change => {
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(change.id)) throw Error('日程标识无效');
        const old = current(change.id), expected = change.expected == null ? null : canonical(JSON.parse(change.expected));
        if ((old ? canonical(old) : null) !== expected) throw Error('日程已被更新，正在重新核对');
        const note = JSON.parse(change.note);
        if (!agenda(note) || note.id !== change.id || JSON.parse(note.content).format !== 'aibro.agenda.v1') throw Error('日程内容无效');
        return {id: change.id, old, note};
      });
      if (new Set(replacements.map(x=>x.id)).size !== replacements.length) throw Error('重复日程标识');
      busy = true;
      try {
        for (const {id,note} of replacements) {
          const index = state.notes.findIndex(n=>n.id===id);
          if (index < 0) state.notes.push(note); else state.notes[index] = note;
        }
        await saveDocumentDurably();
        // A cloud merge or a human edit may have changed the note while saving.
        // Return only exact writes; others remain unacknowledged for reconciliation.
        const accepted = replacements.filter(x=>canonical(current(x.id))===canonical(x.note)).map(x=>x.id);
        renderAll(); return accepted;
      } catch (error) {
        for (const {id,old,note} of replacements) {
          const index = state.notes.findIndex(n=>n.id===id);
          if (index >= 0 && state.notes[index] === note) {
            if (old) state.notes[index] = old; else state.notes.splice(index,1);
          }
        }
        save(); renderAll(); throw error;
      } finally {busy = false;}
    }
  };
})();
