"""M1 scheduler: manual reminders and unattended automatic tasks, one store.

The store is ``<data>/project-jobs.json`` (schema 2). ``jobs`` keeps the
project automations the main window runs (project_jobs.py, unchanged shape);
``tasks`` holds the scheduler's own tasks; ``executions`` is the run table
shared by both: one row per execution, with the owning service process
(``ownerPid``/``instanceId``) so a restart can tell a live run from a dead one.
Schema 1 files (``{'jobs': [...]}``) migrate in place without dropping a
field; the original bytes are kept once as ``project-jobs.v1-backup.json``.
A schema-1 reader still finds its ``jobs`` untouched.

Task kinds:
- ``reminder``: a person does it. At its time the native shell has already
  handed the system a notification (pre-scheduled, so it arrives while the app
  is closed); the occurrence is ``reminded`` until marked done, and
  ``expired`` two hours after its time.
- ``auto``: an unattended agent run. It becomes a kernel run (source
  ``scheduler``) the headless host executes under the task's declared scope;
  the run counts as completed only when the model called ``mark_task_done``.

Timing: a missed time runs once, however many occurrences were missed (the
latest one; later than the five-minute grace it is labelled a catch-up), and
never earlier than a few seconds after the service started. An execution a
dead process left open is ``interrupted``; one that may have changed
something is never re-sent by itself.
Records hold no credentials.
"""
import copy
import json
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SCHEMA = 2
KINDS = ('reminder', 'auto')
INTERVALS = (0, 1440, 10080)
ACCESS = ('read', 'ask', 'write')          # declared scope, smallest first
ACCESS_MODE = {'read': 'request', 'ask': 'request', 'write': 'smart'}
GRACE_SECONDS = 300
STARTUP_DELAY = 5
REMINDER_EXPIRY = 2 * 3600
REMINDER_HORIZON = 30 * 86400
NOTIFY_MAX = 60
KEEP_PER_TASK, KEEP_TOTAL = 30, 400
# paused: the kernel run hit its model's usage limit (P9b) and waits for a person to resume it; the task is not over.
OPEN = ('starting', 'queued', 'running', 'awaiting-approval', 'paused')
TOOL_NAME = re.compile(r'^[A-Za-z0-9_.:-]{1,128}$')
TASK_ID = re.compile(r'^sch_[a-f0-9]{8,40}$')
BACKUP_NAME = 'project-jobs.v1-backup.json'


def minimal_scope(declared=True):
    return {'declared': declared, 'access': 'read', 'tools': [], 'computerUse': False}


def migrate(data):
    """Schema 1 -> 2 in memory. Returns True when something changed."""
    if not isinstance(data, dict): raise ValueError('自动任务文件格式无效')
    if data.get('schemaVersion', 1) >= SCHEMA and 'tasks' in data and 'executions' in data: return False
    data.setdefault('jobs', [])
    executions = data.setdefault('executions', [])
    data.setdefault('tasks', [])
    known = {e.get('attemptId') for e in executions}
    for job in data['jobs']:
        job.setdefault('kind', 'auto')
        job.setdefault('executor', 'window')
        # Older attempts become execution rows; the attempt and history stay where they were.
        for attempt in [*job.get('history', []), *([job['attempt']] if job.get('attempt') else [])]:
            if attempt.get('id') in known: continue
            known.add(attempt.get('id'))
            executions.append({'id': 'exe_' + secrets.token_hex(8), 'taskId': job['id'], 'kind': 'window', 'attemptId': attempt.get('id'),
                               'status': attempt.get('status'), 'startedAt': attempt.get('startedAt'), 'finishedAt': attempt.get('finishedAt'),
                               'runId': attempt.get('runId'), 'conversationId': attempt.get('conversationId'), 'error': attempt.get('error'),
                               'ownerPid': None, 'instanceId': attempt.get('instanceId'), 'legacy': True, 'log': []})
    data['schemaVersion'] = SCHEMA
    return True


def load_document(store, path):
    """Read (and if needed migrate and persist) the store. Caller holds store.lock()."""
    if path.is_symlink(): raise ValueError('自动任务文件不能是符号链接')
    data = json.loads(path.read_text()) if path.exists() else {'jobs': []}
    if migrate(data):
        backup = path.with_name(BACKUP_NAME)
        if path.exists() and not backup.exists(): shutil.copy2(path, backup)
        store.atomic_write(path, json.dumps(data, ensure_ascii=False).encode())
    return data


def _log(execution, text, at):
    execution.setdefault('log', []).append({'at': at, 'text': str(text)[:300]})
    del execution['log'][:-50]


def record_window_start(data, job, attempt, pid):
    """ProjectJobs.claim: the main window takes an attempt."""
    row = {'id': 'exe_' + secrets.token_hex(8), 'taskId': job['id'], 'kind': 'window', 'attemptId': attempt['id'], 'status': 'running',
           'scheduledFor': job.get('dueAt'), 'startedAt': attempt['startedAt'], 'finishedAt': None, 'ownerPid': pid,
           'instanceId': attempt.get('instanceId'), 'runId': None, 'conversationId': None, 'error': None, 'log': []}
    _log(row, '主窗口领取执行', attempt['startedAt'])
    data.setdefault('executions', []).append(row)
    prune(data)


def record_window_end(data, job):
    """ProjectJobs.reconcile/finish: mirror the attempt's outcome into its row."""
    attempt = job.get('attempt') or {}
    row = next((e for e in data.get('executions', []) if e.get('attemptId') == attempt.get('id')), None)
    if not row: return
    row.update(status=attempt.get('status'), finishedAt=attempt.get('finishedAt'), runId=attempt.get('runId'),
               conversationId=attempt.get('conversationId'), error=attempt.get('error'))
    _log(row, '结束：' + str(attempt.get('status')), attempt.get('finishedAt') or time.time())


def prune(data):
    rows = data.get('executions', [])
    settled = [e for e in rows if e.get('status') not in OPEN]
    drop, per_task = set(), {}
    for row in sorted(settled, key=lambda e: e.get('startedAt') or 0, reverse=True):
        per_task[row.get('taskId')] = per_task.get(row.get('taskId'), 0) + 1
        if per_task[row.get('taskId')] > KEEP_PER_TASK: drop.add(id(row))
    kept = [e for e in rows if id(e) not in drop]
    excess = len(kept) - KEEP_TOTAL
    if excess > 0:
        oldest = sorted((e for e in kept if e.get('status') not in OPEN), key=lambda e: e.get('startedAt') or 0)[:excess]
        drop |= {id(e) for e in oldest}
    data['executions'] = [e for e in rows if id(e) not in drop]


def next_due(task, now):
    """First occurrence strictly after ``now`` (same rule as ProjectJobs.next_due)."""
    from project_jobs import ProjectJobs
    return ProjectJobs.next_due(task, now)


def latest_due(task, now):
    """The latest occurrence at or before ``now`` (the one a catch-up runs)."""
    if not task['intervalMinutes'] or task['dueAt'] > now: return task['dueAt']
    following = next_due(task, now)
    if not task.get('timeZone'): return following - task['intervalMinutes'] * 60
    # Calendar repeats: step back from the next one by whole days until <= now.
    zone = ZoneInfo(task['timeZone'])
    anchor = datetime.fromisoformat(task['wallAnchor'])
    wall = datetime.fromtimestamp(following, zone).replace(tzinfo=None)
    days = task['intervalMinutes'] // 1440
    step = (wall.date() - anchor.date()).days // days - 1
    while step >= 0:
        stamp = (anchor + timedelta(days=step * days)).replace(tzinfo=zone, fold=0).timestamp()
        if stamp <= now: return max(stamp, task['dueAt'])
        step -= 1
    return task['dueAt']


def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0: return False
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    except PermissionError: return True
    return True


class Scheduler:
    def __init__(self, store, instance, runs=None, clock=time.time, pid=None):
        self.store, self.instance, self.runs, self.clock = store, instance, runs, clock
        self.pid = pid if pid is not None else os.getpid()
        self.path = store.directory / 'project-jobs.json'
        self.started = clock()
        self.recovered = False

    # -- storage ---------------------------------------------------------
    def read(self): return load_document(self.store, self.path)

    def write(self, data):
        prune(data)
        self.store.atomic_write(self.path, json.dumps(data, ensure_ascii=False).encode())

    @staticmethod
    def _task(data, identifier):
        task = next((t for t in data['tasks'] if t['id'] == identifier), None) if isinstance(identifier, str) else None
        if not task: raise ValueError('计划任务不存在')
        return task

    def _open(self, data, task_id):
        return next((e for e in data['executions'] if e.get('taskId') == task_id and e.get('status') in OPEN), None)

    # -- views -----------------------------------------------------------
    def public_task(self, data, task, now):
        value = copy.deepcopy(task)
        open_row = self._open(data, task['id'])
        value['openExecution'] = open_row['id'] if open_row else None
        value['waiting'] = None
        if task['kind'] == 'auto' and task['status'] == 'active' and not open_row and not self._deps_ready(data, task): value['waiting'] = 'dependencies'
        if task['kind'] == 'auto' and task.get('scope', {}).get('declared') is False: value['needsScopeConfirmation'] = True
        return value

    def list(self):
        with self.store.lock():
            data = self.read(); now = self.clock()
            rows = sorted(data['executions'], key=lambda e: e.get('startedAt') or 0, reverse=True)
            jobs = [{'id': j['id'], 'name': j.get('name'), 'projectId': j.get('projectId'), 'status': j.get('status'), 'dueAt': j.get('dueAt'),
                     'intervalMinutes': j.get('intervalMinutes'), 'permissionMode': j.get('permissionMode'), 'executor': 'window',
                     'scopeDeclared': bool(j.get('scope'))} for j in data['jobs'] if j.get('status') != 'deleted']
            return {'tasks': [self.public_task(data, t, now) for t in data['tasks'] if t['status'] != 'deleted'],
                    'archived': [self.public_task(data, t, now) for t in data['tasks'] if t['status'] == 'deleted'],
                    'jobs': jobs, 'executions': rows[:100],
                    'attention': [e for e in rows if e.get('status') == 'awaiting-approval'],
                    'reminders': [e for e in rows if e.get('kind') == 'reminder' and e.get('status') == 'reminded']}

    def executions(self, task_id=None, limit=50):
        with self.store.lock():
            rows = [e for e in self.read()['executions'] if task_id is None or e.get('taskId') == task_id]
            rows.sort(key=lambda e: e.get('startedAt') or 0, reverse=True)
            return rows[:max(1, min(200, int(limit)))]

    # -- validation ------------------------------------------------------
    @staticmethod
    def parse_scope(raw):
        if raw is None: return None
        if not isinstance(raw, dict): raise ValueError('声明范围格式无效')
        access = raw.get('access', 'read')
        if access not in ACCESS: raise ValueError('声明范围无效：只读、写入需审批或允许写入')
        tools = raw.get('tools', [])
        if not isinstance(tools, list) or len(tools) > 50 or any(not isinstance(t, str) or not TOOL_NAME.match(t) for t in tools): raise ValueError('声明的外部工具无效')
        computer = raw.get('computerUse', False)
        if not isinstance(computer, bool): raise ValueError('电脑操作开关无效')
        return {'declared': True, 'access': access, 'tools': list(dict.fromkeys(tools)), 'computerUse': computer}

    @staticmethod
    def parse_model(raw):
        """A task's own model: {connectionId, model?}. The connection is what P9b applies (run.request.model); a model alone has nothing to attach to."""
        if raw is None: return None
        if not isinstance(raw, dict): raise ValueError('任务模型格式无效')
        model = raw.get('model'); connection = raw.get('connectionId')
        if model is not None and (not isinstance(model, str) or len(model) > 200): raise ValueError('任务模型名称无效')
        if not (model or '').strip() and not connection: raise ValueError('任务模型名称无效')
        if connection is not None and (not isinstance(connection, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,64}', connection)): raise ValueError('任务模型连接无效')
        return {**({'model': model.strip()} if (model or '').strip() else {}), **({'connectionId': connection} if connection else {})}

    def _check_deps(self, data, identifier, deps):
        if not isinstance(deps, list) or len(deps) > 10 or any(not isinstance(d, str) for d in deps): raise ValueError('依赖格式无效（最多 10 项）')
        deps = list(dict.fromkeys(deps))
        tasks = {t['id']: t for t in data['tasks'] if t['status'] != 'deleted'}
        for dep in deps:
            if dep == identifier: raise ValueError('任务不能依赖自己')
            if dep not in tasks: raise ValueError('依赖的任务不存在或已归档')
        # No cycles: walk from each dependency back to this task.
        graph = {k: list(v.get('dependsOn', [])) for k, v in tasks.items()}
        if identifier: graph[identifier] = deps
        seen, stack = set(), list(deps)
        while stack:
            node = stack.pop()
            if node == identifier: raise ValueError('任务依赖形成了循环')
            if node in seen: continue
            seen.add(node); stack.extend(graph.get(node, []))
        return deps

    def _deps_ready(self, data, task):
        for dep in task.get('dependsOn', []):
            other = next((t for t in data['tasks'] if t['id'] == dep), None)
            if not other: return False
            settled = [e for e in data['executions'] if e.get('taskId') == dep and e.get('status') not in OPEN]
            last = max(settled, key=lambda e: e.get('finishedAt') or e.get('startedAt') or 0, default=None)
            if not last or last.get('status') not in ('completed', 'done'): return False
        return True

    def upsert(self, payload):
        if not isinstance(payload, dict): raise ValueError('请求必须是 JSON 对象')
        with self.store.lock():
            data = self.read(); now = self.clock()
            identifier = payload.get('id')
            prior = next((t for t in data['tasks'] if t['id'] == identifier), None) if identifier else None
            if identifier and not prior: raise ValueError('计划任务不存在')
            if prior and payload.get('version') != prior['version']: raise ValueError('计划任务已在其他窗口更新，请刷新')
            if prior and self._open(data, prior['id']): raise ValueError('任务正在执行，请等它结束或先取消')
            kind = payload.get('kind', prior['kind'] if prior else None)
            if kind not in KINDS: raise ValueError('任务类型应为人工提醒或自动任务')
            if prior and kind != prior['kind']: raise ValueError('任务类型不能修改，请新建任务')
            name = str(payload.get('name', '')).strip(); prompt = str(payload.get('prompt', '')).strip()
            if not name or len(name) > 120: raise ValueError('填写任务名称（最多 120 字）')
            if kind == 'auto' and (not prompt or len(prompt) > 8000): raise ValueError('自动任务需要具体目标（最多 8000 字）')
            if len(prompt) > 8000: raise ValueError('备注最多 8000 字')
            try:
                stamp = datetime.fromisoformat(str(payload.get('dueAt')).replace('Z', '+00:00'))
                if stamp.tzinfo is None: raise ValueError()
                due = stamp.timestamp()
            except (ValueError, TypeError): raise ValueError('时间需要有效日期、时间与时区')
            interval = payload.get('intervalMinutes', 0)
            if type(interval) is not int or interval not in INTERVALS: raise ValueError('重复周期应为单次、每天或每周')
            zone_name = payload.get('timeZone')
            if zone_name is not None:
                try: zone = ZoneInfo(zone_name)
                except (ZoneInfoNotFoundError, ValueError, TypeError): raise ValueError('无效时区，请使用 IANA 时区名称')
            task = {**(prior or {}), 'id': identifier or 'sch_' + secrets.token_hex(10), 'kind': kind, 'name': name, 'prompt': prompt,
                    'dueAt': due, 'intervalMinutes': interval, 'status': 'active', 'version': (prior or {}).get('version', 0) + 1,
                    'createdAt': (prior or {}).get('createdAt', now), 'updatedAt': now}
            task['dependsOn'] = self._check_deps(data, task['id'], payload.get('dependsOn', (prior or {}).get('dependsOn', [])))
            if zone_name is not None:
                task['timeZone'] = zone_name
                task['wallAnchor'] = datetime.fromtimestamp(due, zone).replace(tzinfo=None).isoformat()
            else:
                task.pop('timeZone', None); task.pop('wallAnchor', None)
            project = payload.get('projectId')
            if project is not None and (not isinstance(project, str) or len(project) > 512): raise ValueError('项目无效')
            task['projectId'] = project
            if project:
                found = next((p for p in self.store.load().get('projects', []) if p.get('id') == project and not p.get('archived') and not p.get('deletedAt')), None)
                if not found: raise ValueError('项目已归档、删除或不可用')
                task['workspace'] = found.get('workspace')
            else: task['workspace'] = payload.get('workspace') if payload.get('workspace') in ('日常', '课程', '科研') else None
            if kind == 'auto':
                scope = self.parse_scope(payload.get('scope'))
                if scope is None:
                    # No declared scope: saved only after the person confirms, and then the smallest one.
                    if payload.get('confirmUndeclared') is not True: raise ScopeConfirmation()
                    scope = minimal_scope(declared=False)
                task['scope'] = scope
                task['modelOverride'] = self.parse_model(payload.get('modelOverride'))
                budget = payload.get('budgetMinutes', 15)
                if type(budget) is not int or not 1 <= budget <= 120: raise ValueError('运行时间须为 1–120 分钟')
                steps = payload.get('maxSteps', 30)
                if type(steps) is not int or not 1 <= steps <= 60: raise ValueError('步数上限须为 1–60')
                task.update(budgetMinutes=budget, maxSteps=steps)
            else:
                for key in ('scope', 'modelOverride', 'budgetMinutes', 'maxSteps'): task.pop(key, None)
            if prior: data['tasks'][data['tasks'].index(prior)] = task
            else: data['tasks'].append(task)
            self.write(data)
            return self.public_task(data, task, now)

    def change(self, identifier, action):
        with self.store.lock():
            data = self.read(); now = self.clock(); task = self._task(data, identifier)
            if action not in ('pause', 'resume', 'now', 'delete', 'done'): raise ValueError('未知操作')
            open_row = self._open(data, task['id'])
            if action in ('resume', 'now') and open_row: raise ValueError('上次执行尚未结束')
            if action == 'done':
                if task['kind'] != 'reminder': raise ValueError('只有人工提醒可以标记完成')
                row = next((e for e in reversed(data['executions']) if e.get('taskId') == task['id'] and e.get('status') == 'reminded'), None)
                if row: row.update(status='done', finishedAt=now); _log(row, '已标记完成', now)
                else:
                    row = self._row(task, 'done', task['dueAt'], now); row['finishedAt'] = now; data['executions'].append(row)
                self._advance(task, now, finished=True)
            elif action == 'pause': task['status'] = 'paused'
            elif action == 'delete': task['status'] = 'deleted'
            else:
                if task['kind'] == 'auto' and task.get('scope', {}).get('declared') is False: raise ValueError('请先编辑任务并确认声明范围')
                task['status'] = 'active'
                if action == 'now': task['dueAt'] = now
            task['version'] += 1; task['updatedAt'] = now
            self.write(data)
            return self.public_task(data, task, now)

    # -- execution -------------------------------------------------------
    def _row(self, task, status, scheduled, now, catch_up=False):
        row = {'id': 'exe_' + secrets.token_hex(8), 'taskId': task['id'], 'kind': task['kind'], 'status': status, 'scheduledFor': scheduled,
               'startedAt': now, 'finishedAt': None, 'catchUp': catch_up, 'ownerPid': self.pid, 'instanceId': self.instance,
               'runId': None, 'conversationId': None, 'error': None, 'sideEffects': False, 'log': []}
        _log(row, ('补跑错过的时间点 ' if catch_up else '') + datetime.fromtimestamp(scheduled).isoformat(timespec='minutes'), now)
        return row

    def _advance(self, task, now, finished=False):
        """After an occurrence: repeats move to the next time; one-shots end."""
        if task['intervalMinutes']: task['dueAt'] = next_due(task, max(now, task['dueAt']))
        elif finished: task['status'] = 'done' if task['kind'] == 'reminder' else 'completed'

    def recover(self):
        """Startup: rows a dead process left open are interrupted (never silently re-sent)."""
        with self.store.lock():
            data = self.read(); now = self.clock(); changed = False
            for row in data['executions']:
                if row.get('status') not in OPEN or row.get('kind') == 'window': continue
                if row.get('instanceId') == self.instance: continue
                # Another live service still owns it (not this process under a new instance id).
                if row.get('ownerPid') != self.pid and _pid_alive(row.get('ownerPid')): continue
                if row.get('runId') or not self.runs: continue  # the kernel run decides (requeue or interrupted)
                found = self.runs.find_by_key(row['id']) if hasattr(self.runs, 'find_by_key') else None
                if found:
                    row['runId'] = found['id']; _log(row, '服务重启后重新关联后台运行', now)
                else:
                    # Never reached the kernel: nothing ran, so this one occurrence may run again once.
                    row.update(status='interrupted', finishedAt=now, error='服务在提交前中断，未执行')
                    _log(row, '服务重启：提交前中断，未执行', now)
                    task = next((t for t in data['tasks'] if t['id'] == row['taskId']), None)
                    if task and task['status'] == 'active' and not row.get('retryOf'):
                        task['dueAt'] = min(task['dueAt'], row.get('scheduledFor') or task['dueAt']); task['retryNext'] = row['id']
                changed = True
            self.recovered = True
            if changed: self.write(data)

    def tick(self, now=None):
        """One scheduler pass. Returns what it did (for tests and logs)."""
        if not self.recovered: self.recover()
        now = self.clock() if now is None else now
        done = []
        with self.store.lock():
            data = self.read(); changed = False
            changed |= self._sync(data, now, done)
            for task in data['tasks']:
                if task['status'] not in ('active',) or task['dueAt'] > now: continue
                if task['kind'] == 'reminder': changed |= self._remind(data, task, now, done)
            changed |= self._expire(data, now, done)
            starting = []
            if now >= self.started + STARTUP_DELAY and self.runs is not None:
                for task in data['tasks']:
                    if task['kind'] != 'auto' or task['status'] != 'active' or task['dueAt'] > now: continue
                    if self._open(data, task['id']) or not self._deps_ready(data, task): continue
                    if task.get('scope', {}).get('declared') is False: continue
                    scheduled = latest_due(task, now)
                    row = self._row(task, 'starting', scheduled, now, catch_up=now - scheduled > GRACE_SECONDS)
                    if task.pop('retryNext', None): row['retryOf'] = True
                    data['executions'].append(row)
                    if task['intervalMinutes']: task['dueAt'] = next_due(task, now)
                    starting.append((task, row)); changed = True
            if changed: self.write(data)
        # Kernel runs live in their own registry; the row records the run id after.
        for task, row in starting:
            try:
                run, _ = self.runs.create(self.run_request(task, row), source_kind='scheduler')
                result = {'runId': run['id'], 'status': 'queued'}
            except Exception as error:  # never leave a row starting
                result = {'status': 'failed', 'error': '无法提交后台运行：' + str(getattr(error, 'message', error))[:200]}
            with self.store.lock():
                data = self.read(); current = next((e for e in data['executions'] if e['id'] == row['id']), None)
                if current and current['status'] == 'starting':
                    current.update(result); _log(current, '已提交后台运行' if result.get('runId') else result['error'], now)
                    if result['status'] == 'failed':
                        current['finishedAt'] = now
                        live = next((t for t in data['tasks'] if t['id'] == task['id']), None)
                        if live and live['status'] == 'active': live['status'] = 'paused'
                    self.write(data)
            done.append(('started', task['id'], row['id']))
        return done

    def run_request(self, task, row):
        scope = task.get('scope') or minimal_scope(False)
        override = task.get('modelOverride') or {}
        own = {'model': {'connection': override['connectionId'], **({'model': override['model']} if override.get('model') else {})}} if override.get('connectionId') else {}
        return {**own, 'prompt': task['prompt'], 'title': task['name'], 'projectId': task.get('projectId'), 'workspace': task.get('workspace'),
                'permissionMode': ACCESS_MODE[scope['access']], 'maxSteps': task.get('maxSteps', 30), 'idempotencyKey': row['id'],
                'source': {'kind': 'scheduler', 'id': task['id'][:64]},
                'schedule': {'taskId': task['id'], 'executionId': row['id'], 'scope': scope, 'modelOverride': task.get('modelOverride'),
                             'budgetMinutes': task.get('budgetMinutes', 15), 'catchUp': row['catchUp']}}

    def _remind(self, data, task, now, done):
        scheduled = latest_due(task, now)
        if any(e.get('taskId') == task['id'] and e.get('scheduledFor') == scheduled for e in data['executions']): return False
        late = now - scheduled > REMINDER_EXPIRY
        row = self._row(task, 'expired' if late else 'reminded', scheduled, now)
        if late: row['finishedAt'] = now; _log(row, '超过 2 小时未处理，标为过期', now)
        data['executions'].append(row)
        if late and task['intervalMinutes']: task['dueAt'] = next_due(task, max(now, task['dueAt']))
        elif late: task['status'] = 'expired'
        done.append(('expired' if late else 'reminded', task['id'], row['id']))
        return True

    def _expire(self, data, now, done):
        changed = False
        for row in data['executions']:
            if row.get('kind') != 'reminder' or row.get('status') != 'reminded' or now - (row.get('scheduledFor') or now) <= REMINDER_EXPIRY: continue
            row.update(status='expired', finishedAt=now); _log(row, '超过 2 小时未处理，标为过期', now); changed = True
            task = next((t for t in data['tasks'] if t['id'] == row['taskId']), None)
            if task and task['status'] == 'active':
                if task['intervalMinutes']: task['dueAt'] = next_due(task, max(now, task['dueAt']))
                else: task['status'] = 'expired'
            done.append(('expired', row['taskId'], row['id']))
        return changed

    def _sync(self, data, now, done):
        """Mirror kernel run outcomes into execution rows and their tasks."""
        if self.runs is None: return False
        changed = False
        for row in data['executions']:
            if row.get('kind') != 'auto' or row.get('status') not in OPEN or not row.get('runId'): continue
            try: run = self.runs.get(row['runId'])
            except Exception: run = None
            task = next((t for t in data['tasks'] if t['id'] == row['taskId']), None)
            if not run:
                row.update(status='interrupted', finishedAt=now, error='后台运行记录已不存在'); changed = True
                if task and task['status'] == 'active': task['status'] = 'paused'
                continue
            status = run['status']
            effects = any(e.get('status') in ('claimed', 'applied', 'failed') for e in run.get('effects', []))
            if effects and not row.get('sideEffects'): row['sideEffects'] = True; changed = True
            if status in ('queued', 'running', 'awaiting-approval', 'paused'):
                if row['status'] != status:
                    _log(row, {'queued': '排队中', 'running': '运行中', 'awaiting-approval': '越界或需要审批，已暂停，等你批准', 'paused': '模型额度用尽，已暂停，额度恢复后在「后台运行」里继续'}[status], now)
                    row['status'] = status; changed = True
                continue
            result = run.get('result') or {}
            if status == 'completed': final = 'completed' if result.get('markedDone') else 'unverified'
            else: final = status
            row.update(status=final, finishedAt=now, error=run.get('error') or ('没有调用「标记完成」，未通过完成验收' if final == 'unverified' else None),
                       summary=(result.get('markedDone') or {}).get('summary') if isinstance(result.get('markedDone'), dict) else None)
            _log(row, '结束：' + final, now); changed = True
            if task and task['status'] == 'active':
                # A repeat already moved to its next time when this run started.
                if final == 'completed': task['status'] = 'active' if task['intervalMinutes'] else 'completed'
                else: task['status'] = 'paused'
            done.append((final, row['taskId'], row['id']))
        return changed

    # -- native reminders --------------------------------------------------
    def notifications(self, now=None):
        """Reminders the native shell should hand to the system (next 30 days, up to 60)."""
        now = self.clock() if now is None else now
        with self.store.lock():
            data = self.read(); planned = []
            for task in data['tasks']:
                if task['kind'] != 'reminder' or task['status'] != 'active': continue
                at, guard = task['dueAt'], 0
                while at <= now + REMINDER_HORIZON and guard < NOTIFY_MAX:
                    handled = any(e.get('taskId') == task['id'] and e.get('scheduledFor') == at and e.get('status') in ('done', 'expired') for e in data['executions'])
                    if at >= now - REMINDER_EXPIRY and not handled:
                        planned.append({'id': f"{task['id']}-{int(at)}", 'taskId': task['id'], 'fireAt': at, 'title': task['name'], 'body': task.get('prompt') or ''})
                    if not task['intervalMinutes']: break
                    at = next_due(task, at); guard += 1
            planned.sort(key=lambda p: (p['fireAt'], p['id']))
            return planned[:NOTIFY_MAX]


class ScopeConfirmation(ValueError):
    code = 'SCOPE_UNDECLARED'

    def __init__(self):
        super().__init__('这个自动任务没有声明权限范围。确认后会按最小范围（只读）保存。')
