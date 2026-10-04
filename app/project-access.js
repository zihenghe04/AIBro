/* A live, paged project directory. Reading a row records the host's deletion guard. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./context-retrieval') : root.ContextRetrieval,
    typeof module === 'object' && module.exports ? require('./workstation-core') : root.WorkstationCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectAccess = api;
})(globalThis, function (Retrieval, Core) {
  'use strict';
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[\s·_-]+/g, '');
  function catalog(state, request = {}, run) {
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('项目查询需要有效的分页位置。');
    const query = normalize(request.query);
    const visible = Retrieval.accessibleProjects(state).filter(project => !query || normalize([project.id, project.name, project.workspace, project.description].join(' ')).includes(query));
    const projects = visible.slice(offset, offset + 20);
    const snapshots = Core.projectSnapshots(state, { projectIds: projects.map(project => project.id) });
    if (run) {
      run.projectSnapshots ||= {};
      for (const [id, version] of Object.entries(snapshots)) {
        // A second directory read cannot silently reauthorize a changed plan.
        if (!Object.hasOwn(run.projectSnapshots, id)) run.projectSnapshots[id] = version;
      }
    }
    return { type: 'project_list', query: String(request.query || '').trim(), offset, total: visible.length,
      entries: projects.map(project => ({ id: project.id, name: project.name, workspace: project.workspace, description: String(project.description || '').slice(0, 700), hasLocalFolder: !!project.localFolder })),
      nextOffset: offset + projects.length < visible.length ? offset + projects.length : null,
      hint: '这是当前可见项目目录。用返回的真实 id 提出 delete_project；同名或相近项目先核对空间。删除会移入可恢复回收站，审批遵循当前权限模式，不删除本机目录。' };
  }
  return Object.freeze({ catalog });
});
