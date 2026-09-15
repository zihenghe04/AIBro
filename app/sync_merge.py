"""Pure three-way merge for local snapshots and background cloud updates."""
import copy
from datetime import datetime, timezone
import math

COLLECTIONS = ('projects', 'tasks', 'notes', 'imports', 'papers', 'conversations', 'links', 'attachments', 'trash', 'skills')
DEVICE_FIELDS = frozenset(('localFolder', 'localPath', 'rootPath', 'rootId', 'path', 'absolutePath', 'permissionMode', 'permissions', 'approvalPolicy', 'sandboxMode', 'draft', 'draftAttachmentIds','draftFileReferences'))
MISSING = object()


class MergeConflict(ValueError):
    def __init__(self, path, reason='双方修改了同一字段'):
        self.path = list(path)
        self.paths = [list(path)]
        self.code = 'MERGE_CONFLICT'
        super().__init__('无法自动合并：' + '/'.join(map(str, path)) + '（' + reason + '）。')


def _equal(left, right):
    if left is MISSING or right is MISSING: return left is right
    if type(left) is not type(right):
        return type(left) in (int, float) and type(right) in (int, float) and left == right
    if isinstance(left, dict): return left.keys() == right.keys() and all(_equal(left[key], right[key]) for key in left)
    if isinstance(left, list): return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    return left == right


def _copy(value): return MISSING if value is MISSING else copy.deepcopy(value)


def _timestamp(value):
    if type(value) in (int, float) and math.isfinite(value): return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp() * 1000
        except (ValueError, OverflowError): pass
    return None


def _metadata_value(base, proposed, current, field):
    if field == 'createdAt' and base is not MISSING: return _copy(base)
    candidates = [value for value in (proposed, current, base) if value is not MISSING]
    dated = [(value, _timestamp(value)) for value in candidates]
    dated = [(value, stamp) for value, stamp in dated if stamp is not None]
    if dated: return _copy((max if field == 'updatedAt' else min)(dated, key=lambda item: item[1])[0])
    return _copy(candidates[0]) if candidates else MISSING


def _substantive(value):
    if isinstance(value, dict): return {key: _substantive(item) for key, item in value.items() if key not in DEVICE_FIELDS and key not in ('updatedAt', 'createdAt')}
    if isinstance(value, list): return [_substantive(item) for item in value]
    return value


def _index(items, path, folder_kind=False):
    if not isinstance(items, list): raise MergeConflict(path, '实体集合必须为数组')
    output = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']: raise MergeConflict(path, '记录缺少稳定 ID')
        if folder_kind and (not isinstance(item.get('kind'), str) or not item['kind']): raise MergeConflict(path, '文件夹缺少类型')
        identity = (item['kind'], item['id']) if folder_kind else item['id']
        if identity in output: raise MergeConflict([*path, item['id']], '存在重复 ID')
        output[identity] = item
    return output


def _validate(snapshot):
    if not isinstance(snapshot, dict): raise MergeConflict([], '快照必须为对象')
    for collection in COLLECTIONS:
        records = _index(snapshot.get(collection, []), [collection])
        if collection == 'conversations':
            for item in records.values(): _index(item.get('messages', []), [collection, item['id'], 'messages'])
    folders = snapshot.get('folders', {})
    if isinstance(folders, list): _index(folders, ['folders'], True)
    elif isinstance(folders, dict):
        for group in ('projects', 'conversations'): _index(folders.get(group, []), ['folders', group])
    else: raise MergeConflict(['folders'], '文件夹集合格式无效')


def _merge_value(base, proposed, current, path):
    field = path[-1] if path else None
    if field in ('updatedAt', 'createdAt'): return _metadata_value(base, proposed, current, field)
    if _equal(proposed, current): return _copy(proposed)
    if _equal(proposed, base): return _copy(current)
    if _equal(current, base): return _copy(proposed)
    if proposed is MISSING or current is MISSING: raise MergeConflict(path, '删除与修改发生冲突')
    if isinstance(proposed, dict) and isinstance(current, dict):
        old = base if isinstance(base, dict) else {}
        result = {}
        for key in dict.fromkeys([*old, *proposed, *current]):
            value = _merge_value(old.get(key, MISSING), proposed.get(key, MISSING), current.get(key, MISSING), [*path, key])
            if value is not MISSING: result[key] = value
        return result
    raise MergeConflict(path)


def _merge_record(base, proposed, current, path):
    if proposed is MISSING or current is MISSING:
        if base is not MISSING:
            survivor = current if proposed is MISSING else proposed
            if survivor is MISSING or _equal(_substantive(survivor), _substantive(base)): return MISSING
            raise MergeConflict(path, '删除与修改发生冲突')
        result = _copy(current if proposed is MISSING else proposed)
    else:
        old = base if isinstance(base, dict) else {}
        result = {}
        for key in dict.fromkeys([*old, *proposed, *current]):
            if key in DEVICE_FIELDS:
                value = _copy(proposed.get(key, MISSING))
            elif key == 'messages' and len(path) == 2 and path[0] == 'conversations':
                value = _merge_list(old.get(key, []), proposed.get(key, []), current.get(key, []), [*path, key])
                # Timestamped concurrent additions have a reproducible reading
                # order; records without times retain stable snapshot order.
                if value and all(_timestamp(item.get('at', item.get('createdAt'))) is not None for item in value):
                    value.sort(key=lambda item: (_timestamp(item.get('at', item.get('createdAt'))), item['id']))
            else: value = _merge_value(old.get(key, MISSING), proposed.get(key, MISSING), current.get(key, MISSING), [*path, key])
            if value is not MISSING: result[key] = value
    if result is not MISSING:
        for field in DEVICE_FIELDS:
            if proposed is not MISSING and field in proposed: result[field] = _copy(proposed[field])
            else: result.pop(field, None)
    return result


def _merge_list(base, proposed, current, path, folder_kind=False):
    old, local, cloud = (_index(value, path, folder_kind) for value in (base, proposed, current))
    result = []
    for identity in dict.fromkeys([*local, *cloud, *old]):
        label = ':'.join(identity) if isinstance(identity, tuple) else identity
        value = _merge_record(old.get(identity, MISSING), local.get(identity, MISSING), cloud.get(identity, MISSING), [*path, label])
        if value is not MISSING: result.append(value)
    return result


def merge_local_snapshot(base, proposed, current):
    """Return a fresh merged snapshot, or raise without mutating any input."""
    for snapshot in (base, proposed, current): _validate(snapshot)
    result = _copy(proposed)
    for collection in COLLECTIONS:
        if any(collection in snapshot for snapshot in (base, proposed, current)):
            result[collection] = _merge_list(base.get(collection, []), proposed.get(collection, []), current.get(collection, []), [collection])
    if any('folders' in snapshot for snapshot in (base, proposed, current)):
        values = [snapshot.get('folders', {}) for snapshot in (base, proposed, current)]
        if any(isinstance(value, list) for value in values):
            if not all(isinstance(value, list) for value in values): raise MergeConflict(['folders'], '文件夹表示格式发生变化')
            result['folders'] = _merge_list(*values, ['folders'], folder_kind=True)
        else:
            result['folders'] = _copy(values[1])
            for group in ('projects', 'conversations'):
                if any(group in value for value in values): result['folders'][group] = _merge_list(*(value.get(group, []) for value in values), ['folders', group])
    if '_revision' in current: result['_revision'] = _copy(current['_revision'])
    else: result.pop('_revision', None)
    return result
