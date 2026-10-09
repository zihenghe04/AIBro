// Release the microphone UI once the user message is durably accepted. The
// conversation owns the rest of the model run and reports any later failure.
export function waitForVoiceAcceptance(start, onError = () => {}) {
  return new Promise((resolve, reject) => {
    let accepted = false;
    const accept = value => { if (!accepted) { accepted = true; resolve(value); } };
    Promise.resolve().then(() => start(accept)).then(result => {
      if (!accepted) {
        if (result) accept(result);
        else reject(Error('本次提交未完成，文字已保留'));
      }
    }, err => {
      if (!accepted) reject(err);
      else if (err.name !== 'AbortError') { try { onError(err); } catch { /* Reporting cannot own the run. */ } }
    });
  });
}

// One capture owns its callbacks. Cancelled/old ASR results cannot send messages.
export class VoiceSession {
  constructor({ record, transcribe, submit, onChange = () => {}, previewMs = 3000, clock = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout }) {
    Object.assign(this, { record, transcribe, submit, onChange, previewMs, clock, schedule, unschedule });
    this.current = null;
  }
  emit(run, patch) { if (this.current !== run) return false; Object.assign(run, patch); this.onChange({ ...run }); return true; }
  async start(destination = null) {
    if (this.current && !['cancelled', 'failed', 'sent'].includes(this.current.stage)) return false;
    const run = { requestId: crypto.randomUUID(), stage: 'starting', text: '', error: '', destination, startedAt: this.clock(), controller: new AbortController() };
    this.current = run; this.emit(run, {});
    try {
      await this.record.start(run.requestId);
      if (this.current !== run || run.stage !== 'starting') { await this.record.cancel(run.requestId); return false; }
      this.emit(run, { stage: 'recording', startedAt: this.clock() }); return true;
    } catch (e) { if (run.stage !== 'cancelled') this.emit(run, { stage: 'failed', error: e.message }); return false; }
  }
  async stop({ autoSend = true } = {}) {
    const run = this.current;
    if (!run || run.stage !== 'recording') return;
    this.emit(run, { stage: 'transcribing' });
    try {
      const audio = await this.record.stop(run.requestId);
      if (this.current !== run || run.stage !== 'transcribing') return;
      const text = await this.transcribe(audio, run.controller.signal);
      if (this.current !== run || run.stage !== 'transcribing') return;
      this.emit(run, { stage: 'preview', text, sendAt: autoSend ? this.clock() + this.previewMs : null });
      if (autoSend) run.timer = this.schedule(() => this.send(run), this.previewMs);
    } catch (e) { if (this.current === run && run.stage !== 'cancelled') this.emit(run, { stage: 'failed', error: e.message }); }
  }
  hold() { const r = this.current; if (r?.stage === 'preview') { this.unschedule(r.timer); this.emit(r, { sendAt: null }); } }
  async edit(prepare) {
    const run = this.current;
    if (!run || !['preview', 'failed'].includes(run.stage) || !run.text.trim()) return null;
    this.unschedule(run.timer);
    this.emit(run, { stage: 'editing', error: '', sendAt: null });
    try {
      const result = await prepare(run.text, run.requestId, run.destination);
      run.controller.abort();
      await this.record.cancel(run.requestId).catch(() => {});
      this.emit(run, { stage: 'cancelled' });
      return result;
    } catch (e) { this.emit(run, { stage: 'failed', error: e.message }); return null; }
  }
  async send(expected = this.current) {
    const run = this.current;
    if (run !== expected) return;
    if (!run || !['preview', 'failed'].includes(run.stage) || !run.text.trim()) return;
    this.unschedule(run.timer);
    this.emit(run, { stage: 'submitting', error: '', sendAt: null });
    try { const result = await this.submit(run.text, run.requestId, run.destination); this.emit(run, { stage: 'sent', result }); }
    catch (e) { this.emit(run, { stage: 'failed', error: e.message }); }
  }
  async cancel() {
    const run = this.current;
    if (!run || ['sent', 'submitting', 'editing', 'cancelled'].includes(run.stage)) return false;
    this.unschedule(run.timer); run.controller.abort();
    this.emit(run, { stage: 'cancelled', sendAt: null });
    await this.record.cancel(run.requestId).catch(() => {}); return true;
  }
  async interrupted(event) {
    const run = this.current;
    if (!run || event.requestId !== run.requestId) return;
    if (event.type === 'limit') { await this.stop({ autoSend: false }); return; }
    if (['starting', 'recording', 'transcribing', 'preview'].includes(run.stage)) {
      await this.cancel(); this.emit(run, { error: event.error || '录音已中断，未发送' });
    }
  }
}
