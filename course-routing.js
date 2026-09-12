/* Course routing requires user-owned evidence before reusing an existing course. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CourseRouting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
  const validId = value => typeof value === 'string' && !!value.trim();
  const ids = value => Array.isArray(value) ? value.filter(validId) : [];
  const text = value => typeof value === 'string' ? value : '';
  const compact = value => text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const available = value => value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt;
  const compares = value => /对比|比较|区别|差异|异同|相似|相比|\b(?:compare|comparison|contrast|versus|vs|difference)\b/iu.test(value);

  // Keep offsets so punctuation and whitespace can delimit an exact title even
  // though they are ignored while matching (e.g. AI: Models / AI Models).
  function indexed(value) {
    let normalized = '', offset = 0; const positions = [];
    for (const character of value) {
      const part = compact(character);
      normalized += part;
      for (let index = 0; index < part.length; index++) positions.push({ start: offset, end: offset + character.length });
      offset += character.length;
    }
    return { normalized, positions };
  }
  function wordBoundary(before, after, title) {
    const separator = /[\s\p{P}\p{S}]/u;
    // A short Latin title must not match another word (AI / explain, Algebra /
    // Algebraic). Chinese titles need ordinary routing/description particles.
    const left = !before || separator.test(before.at(-1)) || (/^[a-z\d]/i.test(title) && !/[a-z\d]$/i.test(before)) || /(?:是|为|叫|叫做|并非|与|和|跟|在|属于|归入|归到|并入|放入|放到|放进|分到|算作|当成|添加到|加入|合并到|合并入|整理到|保存到|创建|新建|分析|学习|阅读|整理|处理|查看|总结|复习|理解|记录|关于|针对|这门|该门|本门|我的|我们|我在学|我学的|我选的|课程|项目)$/u.test(compact(before));
    const right = !after || separator.test(after[0]) || (/^[a-z\d]/i.test(title) && !/^[a-z\d]/i.test(after)) || /^(?:的|课(?:程)?|第|这门|本门|该门|这一|这个|相关|附件|讲义|笔记|资料|内容|项目|文件|里|中|下|内|是|而是|不是|并非|不属于|不对|错误|无关)/u.test(compact(after));
    return left && right;
  }
  function nameEvidence(goal, name) {
    const title = compact(name);
    if (!title) return { mentioned: false, denied: false, declared: false };
    const source = indexed(goal); let start = 0, mentioned = false, denied = false, declared = false;
    while (start <= source.normalized.length - title.length) {
      const index = source.normalized.indexOf(title, start); if (index < 0) break;
      start = index + Math.max(1, title.length);
      const from = source.positions[index].start, to = source.positions[index + title.length - 1].end;
      const before = goal.slice(0, from), after = goal.slice(to);
      if (!wordBoundary(before, after, title)) continue;
      // Clause boundaries prevent a correction "不是 A，是 B" from negating B.
      // Ambiguous negatives stay reviewable rather than silently routing files.
      const prefixText = before.split(/[\n。！？!?；;,，]/u).at(-1);
      const suffixText = after.split(/[\n。！？!?；;,，]/u)[0];
      const clause = prefixText + goal.slice(from, to) + suffixText;
      const comparison = compares(goal);
      const reference = /参照|参考|模板|格式|\b(?:template|format|reference)\b/iu.test(clause);
      const prefix = compact(prefixText).split(/而是|应该是|应当是|其实是/u).at(-1).slice(-60);
      const suffix = compact(suffixText).slice(0, 40);
      const occurrenceDenied = /(?:不是|并非|不属于|不归属|不要|不应|不该|不能|不可|不必|无需|别|禁止|拒绝|不放|不归|不并|不合并|无关)(?:.{0,24})$/u.test(prefix)
        || /^(?:(?:这|那|该|本)门?课(?:程)?|这个项目|项目)?(?:不是|并非|不属于|不对|错误|无关|不匹配)/u.test(suffix)
        || /\b(?:not|never|don't|do\s+not|doesn't|isn't|shouldn't)\b.{0,80}$/iu.test(prefixText)
        || /^(?:isnot|isnt|doesnotbelong|iswrong|isunrelated)/u.test(suffix);
      if (occurrenceDenied) denied = true;
      const declaration = /(?:归入|归到|放入|放到|放进|并入|合并到|合并入|添加到|加入|整理到|保存到|分到|属于|而是|应该是|应当是|其实是)$/u.test(compact(prefixText))
        || /(?:课程?|课件|附件|材料|项目)(?:的)?(?:正确|实际|真正)?(?:名称|名字|名|归属)?(?:应(?:该|当)?|实际|正确)?(?:是|为|叫|叫做)$/u.test(compact(prefixText))
        || /\b(?:(?:current|correct|actual)\s+course(?:\s+name)?\s+is|belongs?\s+to|(?:route|move|save|put|merge)\b.{0,32}\b(?:into|to|in))\s*["'“‘《「]*$/iu.test(prefixText);
      if (declaration && !occurrenceDenied) declared = true;
      if ((!comparison && !reference) || (declaration && !occurrenceDenied)) mentioned = true;
    }
    return { mentioned, denied, declared };
  }
  function explicitLabels(goal) {
    // B can be absent from both state and the erroneous dry-run. Extract only
    // short, direct course-name/routing statements, not arbitrary new nouns.
    const pattern = /(?:课程?|项目)(?:的)?(?:正确|实际|真正)?(?:名称|名字|名|归属)?(?:应(?:该|当)?|实际|正确)?(?:是|为|叫做|叫)|(?:归入|归到|放入|放到|放进|并入|合并到|合并入|添加到|加入|整理到|保存到|分到)/gu;
    const found = [];
    for (const match of goal.matchAll(pattern)) {
      const rest = goal.slice(match.index + match[0].length).trimStart();
      const quoted = /^[「《“"'『]([^」》”"'』\n]{1,120})[」》”"'』]/u.exec(rest);
      const label = (quoted?.[1] || rest.split(/[\n。！？!?；;,，]/u)[0]).trim();
      if (!label || label.length > 120) continue;
      const prefix = goal.slice(0, match.index).split(/[\n。！？!?；;,，]/u).at(-1);
      if (/(?:之前|原来|此前|曾经|过去|先前|当时|以前).{0,24}$/u.test(prefix)) continue;
      const evidence = nameEvidence(goal, label);
      if (evidence.declared && !evidence.denied) found.push(label);
    }
    return [...new Set(found)];
  }
  function assess(state, preview, run) {
    state = state || {}; preview = preview || {}; run = run || {};
    const attachmentIds = new Set(ids(run.attachmentIds));
    const clear = () => ({ required: false, candidates: [], message: '' });
    if (!attachmentIds.size) return clear();
    const touched = new Set(ids(preview.projectIds));
    // Use actual dry-run results, including create_project which may have
    // reused a same-name project. Never trust the action's requested identity.
    for (const result of list(preview.results)) {
      if (validId(result.projectId)) touched.add(result.projectId);
      if (result.type === 'project' && validId(result.id)) touched.add(result.id);
    }
    const linked = new Set(list(state.imports).filter(item => available(item) && attachmentIds.has(item.id) && validId(item.projectId)).map(item => item.projectId));
    // A current, explicit correction to B outranks a stale conversation/source
    // binding to A. A newly created B may only exist in the dry-run, but a
    // model-proposed rename must not change an existing project's identity.
    const knownCourses = new Map();
    for (const project of [...list(state.projects), ...list(preview.state?.projects)]) {
      if (validId(project.id) && project.workspace === '课程' && !knownCourses.has(project.id)) knownCourses.set(project.id, project);
    }
    const evidenceById = new Map([...knownCourses].map(([id, project]) => [id, nameEvidence(text(run.goal), text(project.name))]));
    const declaredTargets = new Set([...evidenceById].filter(([, evidence]) => evidence.declared && !evidence.denied).map(([id]) => id));
    const unknownLabels = explicitLabels(text(run.goal)).filter(label => ![...knownCourses.values()].some(project => nameEvidence(`课程是${label}`, text(project.name)).declared));
    const candidates = [], seen = new Set();
    for (const project of list(state.projects)) {
      if (!validId(project.id) || project.workspace !== '课程' || !touched.has(project.id) || seen.has(project.id)) continue;
      seen.add(project.id);
      const evidence = evidenceById.get(project.id);
      const contradictsCurrentTarget = unknownLabels.length > 0 || (declaredTargets.size > 0 && !declaredTargets.has(project.id));
      const supported = available(project) && (run.projectId === project.id || linked.has(project.id) || evidence.mentioned);
      if (evidence.denied || contradictsCurrentTarget || !supported) candidates.push({ id: project.id, name: text(project.name).trim() || '未命名课程' });
    }
    if (!candidates.length) return clear();
    const names = candidates.map(project => `「${project.name}」`).join('、');
    return { required: true, candidates, message: `本轮资料拟归入已有课程 ${names}，但归属尚未确认。请确认目标课程后再保存，避免把不同课程的资料混在一起。` };
  }
  return { assess };
});
