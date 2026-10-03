/* Read-only presentation of run outcomes. Stored answers remain untouched. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunOutcomePresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const terminal = new Set(['failed', 'cancelled', 'interrupted']);
  const retryGuidance = '可以重试，或点击“调整附件后重试”移除有问题的附件；也可以直接在下方继续对话。';
  const generatedEffects = [
    '尚未执行任何动作。',
    '本轮已执行过终端命令，其效果不会自动撤销；请检查命令记录后继续。',
    '本轮已发生浏览器操作，其效果不会自动撤销；请核对页面与操作记录后继续。',
  ];
  const recoveredInterruption = '上次执行随本机服务结束而中断。已保存的输出保留，请核对后继续。';
  const defaultStops = new Set(['已停止本次执行', '已停止本次执行。', '用户已停止本次执行。', 'Stopped']);
  const list = value => Array.isArray(value) ? value : [];
  const string = value => typeof value === 'string' ? value : '';
  const placeholders = new Set(['正在准备工作流…', '正在阅读附件并制定整理计划…', '正在分析需求并制定计划…', '正在生成可执行计划…', '正在结合资料继续处理…']);

  // Read one JSON string, retaining only fully received escape sequences.
  // This is deliberately not a regex search for any nested "message" key.
  function jsonString(source, start, partial = false) {
    if (source[start] !== '"') return null;
    let value = '';
    for (let index = start + 1; index < source.length; index++) {
      const char = source[index];
      if (char === '"') return { value, next: index + 1, complete: true };
      if (char.charCodeAt(0) < 32) return null;
      if (char !== '\\') { value += char; continue; }
      const escaped = source[++index];
      if (escaped === undefined) return partial ? { value, next: source.length, complete: false } : null;
      if (escaped === 'u') {
        const digits = source.slice(index + 1, index + 5);
        if (digits.length < 4 && /^[\da-f]*$/i.test(digits)) return partial ? { value, next: source.length, complete: false } : null;
        if (!/^[\da-f]{4}$/i.test(digits)) return null;
        value += String.fromCharCode(parseInt(digits, 16)); index += 4;
      } else {
        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!Object.prototype.hasOwnProperty.call(escapes, escaped)) return null;
        value += escapes[escaped];
      }
    }
    return partial ? { value, next: source.length, complete: false } : null;
  }

  function topLevelMessage(source) {
    let index = 1;
    const space = () => { while (/\s/.test(source[index] || '') && index < source.length) index++; };
    while (index < source.length) {
      space();
      const key = jsonString(source, index);
      if (!key) return '';
      index = key.next; space();
      if (source[index++] !== ':') return '';
      space();
      if (key.value === 'message') return jsonString(source, index, true)?.value || '';
      const start = index;
      let depth = 0, quoted = false, escaped = false;
      while (index < source.length) {
        const char = source[index];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { if (!depth) break; depth--; }
        else if (char === ',' && !depth) break;
        index++;
      }
      if (quoted || depth) return '';
      try { JSON.parse(source.slice(start, index)); } catch (_) { return ''; }
      space();
      if (source[index++] !== ',') return '';
    }
    return '';
  }

  function preservePartial(message = {}, run = {}, { rawOutput, parsedPlan, inspect } = {}) {
    if (message.role === 'user') return '';
    const checked = value => {
      if (!value.trim() || placeholders.has(value)) return '';
      // Same unsupported bare-completion boundary as Core.validateCompletion:
      // a success label is not useful partial output after a failed run.
      if (/^(?:已|已经)?(?:完成|整理完成|完成整理|处理完成|完成处理|全部完成|done|completed)[。.!！\s]*$/i.test(value.trim())) return '';
      // Keep a substantive answer if only its accompanying note proposal was
      // rejected, but do not retain the rejected save/completion claim alone.
      if (run.errorCode === 'INCOMPLETE_ANALYSIS_RESULT' && /^(?:已(?:经)?(?:完成(?:资料|材料|附件|文档|笔记|课程)?(?:整理|分析|总结|归纳|提炼)|(?:整理|分析|总结|归纳|提炼)(?:完成|完毕))|(?:analysis|summary|synthesis)\s+(?:complete|completed|done))(?:[，,；;\s]*(?:笔记|文档|结果|分析)(?:已保存|已写入))?[。.!！\s]*$/i.test(value.trim())) return '';
      try {
        // Call the real transport guard so fenced and quoted protocol examples
        // keep its existing policy. If unavailable, fail closed on DSML tokens.
        if (typeof inspect === 'function' ? inspect(value, { final: true }) : /<\s*\/?\s*[|｜]+\s*(?:DSML|D?S?M?L?\s*$)/im.test(value)) return '';
      } catch (_) { return ''; }
      return value;
    };
    if (parsedPlan && typeof parsedPlan === 'object' && !Array.isArray(parsedPlan) && typeof parsedPlan.message === 'string') return checked(parsedPlan.message);
    if (typeof rawOutput === 'string') {
      if (!checked(rawOutput)) return '';
      let source = rawOutput.trimStart();
      // The app protocol sometimes arrives in a JSON fence. Never keep its
      // tool/action data as an answer, even when the closing fence is absent.
      const fence = /^(?:```|~~~)(?:json)?[ \t]*\r?\n/i.exec(source);
      if (fence && /^[\[{]/.test(source.slice(fence[0].length).trimStart())) source = source.slice(fence[0].length).trimStart();
      if (source.startsWith('{')) return checked(topLevelMessage(source));
      if (source.startsWith('[')) return '';
      if (/^(?:```|~~~)(?:json)?\s*$/i.test(source)) return '';
      // Core.parsePlan accepts gateways that prepend prose to a JSON plan.
      // Do not let that prefix turn internal action data into public text.
      const objectStart = source.indexOf('{');
      if (objectStart >= 0 && /"(?:actions|knowledgeRequests|workingSummary|workspace|fileEdits|agendaProposals|clarify)"\s*:/.test(source.slice(objectStart))) {
        return checked(topLevelMessage(source.slice(objectStart)));
      }
      return checked(rawOutput);
    }
    // The live display is derived by Core.partialMessage, which historically
    // could select a nested tool argument. Never trust that preview without
    // its source. A caller can explicitly pass the parsed plan instead.
    if (message.planPreview) return '';
    return preservePartial({}, run, { rawOutput: string(message.text), inspect });
  }

  function settledApprovalText(message = {}, run = {}, { language = 'zh' } = {}) {
    const text = string(message.text), receipt = run.approvalReceipt, routing = run.routingReview;
    if (!['agent', 'assistant'].includes(message.role) || message.live || !message.planPreview || !message.id || message.runId !== run.id
      || run.status !== 'completed' || run.error || run.cancelled || run.approvalSaveError
      || !receipt?.id || receipt.messageId !== message.id || receipt.metadataSettled !== true || receipt.savePending
      || !Number.isFinite(receipt.appliedAt) || !Number.isFinite(receipt.settledAt) || receipt.settledAt < receipt.appliedAt
      || run.executionReceipt && (run.executionReceipt.version !== 1 || run.executionReceipt.phase !== 'committed')
      || routing?.required !== true || !string(routing.message)) return text;
    // Only replace the exact system-generated proposal + settled receipt
    // envelope. Similar user/model prose or an unsaved approval is unchanged.
    const prefix = routing.message + '\n\n', suffix = '\n\n已批准并执行，具体结果见下方。';
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return text;
    const summary = text.slice(prefix.length, -suffix.length);
    if (!summary.trim()) return text;
    return (language === 'en' ? 'Course confirmed. The following operations were approved and executed.' : '课程归属已确认，以下操作已批准并执行。') + '\n\n' + summary;
  }

  function present(message = {}, run = {}, { language = 'zh', responseIssue } = {}) {
    const t = (zh, en) => language === 'en' ? en : zh;
    const sourceText = settledApprovalText(message, run, { language });
    const status = run.status || message.runStatus || (message.retryRunId ? 'failed' : '');
    const showNotice = message.role !== 'user' && !message.live && terminal.has(status)
      && !!(message.retryRunId || run.error || responseIssue);
    const result = { answerText: sourceText, showNotice, status, statusLabel: '', noticeTitle: '', noticeDescription: '', hint: '', generatedFailure: false,
      recoveryAction: null, recoveryActionLabel: '', diagnosticDetails: [] };
    if (!showNotice) return result;

    const error = string(run.error);
    result.statusLabel = status === 'cancelled' ? t('已停止', 'Stopped') : status === 'interrupted' ? t('已中断', 'Interrupted') : t('未完成', 'Incomplete');
    result.noticeTitle = status === 'cancelled' ? t('本次执行已停止', 'This run was stopped')
      : status === 'interrupted' ? t('本次执行已中断', 'This run was interrupted') : t('这次执行未完成', 'This run did not finish');
    result.noticeDescription = status === 'cancelled' && defaultStops.has(error) ? '' : error;

    // Only the exact envelope produced by app.js may move into the notice.
    // In particular, a provider answer starting with “调用失败” is not enough:
    // all content and the independently stored run.error must match.
    if (error && message.retryRunId && (status === 'failed' || status === 'cancelled')) {
      const prefix = status === 'cancelled' ? '已停止本次执行：' : '调用失败：';
      const header = prefix + error;
      if (sourceText === header || generatedEffects.some(effect => sourceText === header + '\n\n' + effect + retryGuidance)) {
        result.answerText = '';
        result.generatedFailure = true;
      }
    }

    // This is the sole known recovery append, not a general suffix stripper.
    // Preserve every byte of the partial answer that preceded the append.
    if (status === 'interrupted' && message.retryRunId && error === recoveredInterruption) {
      const suffix = '\n\n' + recoveredInterruption;
      if (sourceText === recoveredInterruption || sourceText.endsWith(suffix)) {
        result.answerText = sourceText === recoveredInterruption ? '' : sourceText.slice(0, -suffix.length);
        result.generatedFailure = true;
      }
    }

    // The caller owns the expandable original protocol reply. Only its
    // explicit, already-substituted diagnostic moves into the recovery card.
    if (message.retryRunId && responseIssue && typeof responseIssue.text === 'string' && sourceText === responseIssue.text) {
      result.answerText = '';
      result.noticeDescription = responseIssue.text;
      result.generatedFailure = true;
    }

    // Only new, explicitly recorded diagnostics can classify a failure. Old
    // free-text errors remain unchanged, and cancellation is never inferred
    // to be an authentication, network or provider failure. Keep this after
    // exact-envelope matching so classification cannot discard a partial answer.
    const storedDiagnostic = root.RunFailureDiagnostics?.forRun?.(run) || run.errorDiagnostic;
    if (status === 'failed' && storedDiagnostic && typeof root.RunFailureDiagnostics?.present === 'function') {
      const diagnostic = root.RunFailureDiagnostics.present(storedDiagnostic, { language });
      if (diagnostic) {
        if (typeof diagnostic.title === 'string' && diagnostic.title) result.noticeTitle = diagnostic.title;
        if (typeof diagnostic.description === 'string' && diagnostic.description) result.noticeDescription = diagnostic.description;
        result.diagnosticDetails = list(diagnostic.details).filter(row => row && typeof row.label === 'string' && typeof row.value === 'string')
          .map(row => ({ label: row.label, value: row.value }));
        if (['settings', 'context'].includes(diagnostic.action) && typeof diagnostic.actionLabel === 'string' && diagnostic.actionLabel) {
          result.recoveryAction = diagnostic.action;
          result.recoveryActionLabel = diagnostic.actionLabel;
        }
      }
    }

    const hints = [];
    if (list(run.commands).some(command => command?.startedAt)) {
      hints.push(t('本轮已执行过终端命令，其效果不会自动撤销；请先检查命令记录。', 'Commands ran during this turn and are not automatically undone. Review the command history first.'));
    }
    if (Number(run.browserSession?.operationCount) > 0) {
      hints.push(t('本轮已有浏览器操作，请先核对页面与操作记录。', 'Browser operations occurred during this turn. Review the page and operation history first.'));
    }
    if (list(run.results).length || list(message.results).length || list(run.localFileEdits).some(edit => ['applied', 'partial', 'applying', 'undoing', 'interrupted'].includes(edit?.status))) {
      hints.push(t('本轮已有结果或文件修改记录，请核对后继续。', 'This turn has result or file-change records. Review them before continuing.'));
    } else if (list(run.localFileEdits).length || list(run.agendaProposals).length) {
      hints.push(t('本轮提案仍保留，可继续审阅。', 'Proposals from this turn remain available for review.'));
    }
    if (!hints.length && (list(run.toolCalls).length || list(run.knowledgeReads).length || list(run.knowledgeSearches).length || list(message.activities).some(activity => activity?.kind === 'tool'))) {
      hints.push(t('本轮工具与资料读取记录仍可查看。', 'Tool and source-reading records from this turn remain available.'));
    }
    // Missing records do not prove that nothing happened, particularly for
    // old runs and provider tools. Do not revive the old no-actions claim.
    hints.push(t('重试会按原始请求发起新一轮执行；也可以在下方继续对话。', 'Retry starts a new run from the original request. You can also continue the conversation below.'));
    result.hint = hints.join('\n');
    return result;
  }

  return { present, preservePartial, settledApprovalText };
});
