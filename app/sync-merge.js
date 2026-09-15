/* Pure local three-way merge. Cloud projection owns credential filtering. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SyncMerge = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLLECTIONS = ['projects','tasks','notes','imports','papers','conversations','links','attachments','trash','skills'];
  const DEVICE_FIELDS = new Set(['localFolder','localPath','rootPath','rootId','path','absolutePath','permissionMode','permissions','approvalPolicy','sandboxMode','draft','draftAttachmentIds','draftFileReferences']);
  const MISSING = Symbol('missing');
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const get = (value, key, fallback = MISSING) => own(value, key) ? value[key] : fallback;
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const copy = value => value === MISSING ? MISSING : JSON.parse(JSON.stringify(value));
  const keys = (...values) => [...new Set(values.flatMap(value => Object.keys(value)))];
  const put = (value, key, item) => Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true });
  class MergeConflict extends Error {
    constructor(path, reason = '双方修改了同一字段') { super(`无法自动合并：${path.join('/')}（${reason}）。`); this.name = 'MergeConflict'; this.code = 'MERGE_CONFLICT'; this.path = [...path]; this.paths = [[...path]]; }
  }
  function equal(a, b) {
    if (a === MISSING || b === MISSING) return a === b;
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
    if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => own(b,key) && equal(a[key],b[key]));
    return false;
  }
  function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) { const number = Date.parse(value); if (Number.isFinite(number)) return number; }
    return null;
  }
  function metadataValue(base, proposed, current, field) {
    if (field === 'createdAt' && base !== MISSING) return copy(base);
    const candidates = [proposed,current,base].filter(value => value !== MISSING);
    const dated = candidates.map(value => ({value,stamp:timestamp(value)})).filter(item => item.stamp !== null);
    if (dated.length) return copy(dated.reduce((best,item) => (field === 'updatedAt' ? item.stamp > best.stamp : item.stamp < best.stamp) ? item : best).value);
    return candidates.length ? copy(candidates[0]) : MISSING;
  }
  function substantive(value) {
    if (Array.isArray(value)) return value.map(substantive);
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !DEVICE_FIELDS.has(key) && !['updatedAt','createdAt'].includes(key)).map(([key,item]) => [key,substantive(item)]));
    return value;
  }
  function index(items, path, folderKind = false) {
    if (!Array.isArray(items)) throw new MergeConflict(path,'实体集合必须为数组');
    const result = new Map();
    for (const item of items) {
      if (!object(item) || typeof item.id !== 'string' || !item.id) throw new MergeConflict(path,'记录缺少稳定 ID');
      if (folderKind && (typeof item.kind !== 'string' || !item.kind)) throw new MergeConflict(path,'文件夹缺少类型');
      const identity = folderKind ? JSON.stringify([item.kind,item.id]) : item.id;
      if (result.has(identity)) throw new MergeConflict([...path,item.id],'存在重复 ID');
      result.set(identity,item);
    }
    return result;
  }
  function validate(snapshot) {
    if (!object(snapshot)) throw new MergeConflict([],'快照必须为对象');
    for (const collection of COLLECTIONS) {
      const records = index(get(snapshot,collection,[]),[collection]);
      if (collection === 'conversations') for (const item of records.values()) index(get(item,'messages',[]),[collection,item.id,'messages']);
    }
    const folders = get(snapshot,'folders',{});
    if (Array.isArray(folders)) index(folders,['folders'],true);
    else if (object(folders)) for (const group of ['projects','conversations']) index(get(folders,group,[]),['folders',group]);
    else throw new MergeConflict(['folders'],'文件夹集合格式无效');
  }
  function mergeValue(base, proposed, current, path) {
    const field = path.at(-1);
    if (['updatedAt','createdAt'].includes(field)) return metadataValue(base,proposed,current,field);
    if (equal(proposed,current)) return copy(proposed);
    if (equal(proposed,base)) return copy(current);
    if (equal(current,base)) return copy(proposed);
    if (proposed === MISSING || current === MISSING) throw new MergeConflict(path,'删除与修改发生冲突');
    if (object(proposed) && object(current)) {
      const old = object(base) ? base : {}, result = {};
      for (const key of keys(old,proposed,current)) { const value = mergeValue(get(old,key),get(proposed,key),get(current,key),[...path,key]); if (value !== MISSING) put(result,key,value); }
      return result;
    }
    throw new MergeConflict(path);
  }
  function mergeRecord(base, proposed, current, path) {
    let result;
    if (proposed === MISSING || current === MISSING) {
      if (base !== MISSING) {
        const survivor = proposed === MISSING ? current : proposed;
        if (survivor === MISSING || equal(substantive(survivor),substantive(base))) return MISSING;
        throw new MergeConflict(path,'删除与修改发生冲突');
      }
      result = copy(proposed === MISSING ? current : proposed);
    } else {
      const old = object(base) ? base : {}; result = {};
      for (const key of keys(old,proposed,current)) {
        let value;
        if (DEVICE_FIELDS.has(key)) value = copy(get(proposed,key));
        else if (key === 'messages' && path.length === 2 && path[0] === 'conversations') {
          value = mergeList(get(old,key,[]),get(proposed,key,[]),get(current,key,[]),[...path,key]);
          if (value.length && value.every(item => timestamp(get(item,'at',get(item,'createdAt',null))) !== null)) value.sort((a,b) => timestamp(get(a,'at',get(a,'createdAt',null))) - timestamp(get(b,'at',get(b,'createdAt',null))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        } else value = mergeValue(get(old,key),get(proposed,key),get(current,key),[...path,key]);
        if (value !== MISSING) put(result,key,value);
      }
    }
    if (result !== MISSING) for (const field of DEVICE_FIELDS) { if (proposed !== MISSING && own(proposed,field)) put(result,field,copy(proposed[field])); else delete result[field]; }
    return result;
  }
  function mergeList(base, proposed, current, path, folderKind = false) {
    const [old,local,cloud] = [base,proposed,current].map(value => index(value,path,folderKind)), result = [];
    for (const identity of new Set([...local.keys(),...cloud.keys(),...old.keys()])) {
      const label = folderKind ? JSON.parse(identity).join(':') : identity;
      const value = mergeRecord(old.has(identity)?old.get(identity):MISSING,local.has(identity)?local.get(identity):MISSING,cloud.has(identity)?cloud.get(identity):MISSING,[...path,label]);
      if (value !== MISSING) result.push(value);
    }
    return result;
  }
  function merge(base, proposed, current) {
    [base,proposed,current].forEach(validate);
    const result = copy(proposed);
    for (const collection of COLLECTIONS) if ([base,proposed,current].some(value => own(value,collection))) put(result,collection,mergeList(get(base,collection,[]),get(proposed,collection,[]),get(current,collection,[]),[collection]));
    if ([base,proposed,current].some(value => own(value,'folders'))) {
      const values = [base,proposed,current].map(value => get(value,'folders',{}));
      if (values.some(Array.isArray)) {
        if (!values.every(Array.isArray)) throw new MergeConflict(['folders'],'文件夹表示格式发生变化');
        put(result,'folders',mergeList(...values,['folders'],true));
      } else {
        put(result,'folders',copy(values[1]));
        for (const group of ['projects','conversations']) if (values.some(value => own(value,group))) put(result.folders,group,mergeList(...values.map(value => get(value,group,[])),['folders',group]));
      }
    }
    if (own(current,'_revision')) result._revision = copy(current._revision); else delete result._revision;
    return result;
  }
  return Object.freeze({merge,MergeConflict});
}));
