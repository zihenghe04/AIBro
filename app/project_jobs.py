"""Local project schedules and claims. The desktop executes the shared Agent loop.
No credentials or executable commands live in schedule records.
"""
import copy
import json
import re
import secrets
import time
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

class ProjectJobs:
    def __init__(self, store, instance):
        self.store, self.instance = store, instance
        self.path = store.directory / 'project-jobs.json'

    def read(self):
        if self.path.is_symlink(): raise ValueError('自动任务文件不能是符号链接')
        return json.loads(self.path.read_text()) if self.path.exists() else {'jobs': []}

    def write(self, data): self.store.atomic_write(self.path, json.dumps(data, ensure_ascii=False).encode())

    @staticmethod
    def public(job):
        value=copy.deepcopy(job)
        for attempt in [value.get('attempt'), *value.get('history', [])]:
            if attempt: attempt.pop('token', None)
        return value

    def project(self, snapshot, identifier):
        p=next((p for p in snapshot.get('projects',[]) if p['id']==identifier and not p.get('archived') and not p.get('deletedAt')),None)
        if not p: raise ValueError('项目已归档、删除或不可用')
        return p

    def validate_project(self, snapshot, job):
        project=self.project(snapshot,job['projectId'])
        if project['workspace']!=job['workspace']:raise ValueError('项目空间已变化，请重新创建自动任务')
        return project

    def reconcile(self, data):
        changed=False
        for job in data['jobs']:
            attempt=job.get('attempt')
            if not attempt or attempt.get('status')!='running': continue
            if attempt.get('instanceId')!=self.instance or time.time()>attempt['expiresAt']:
                attempt.update(status='interrupted',finishedAt=time.time(),error='上次执行已中断，先核对结果再继续。')
                job['status']='paused';changed=True
        if changed:self.write(data)

    def list(self):
        with self.store.lock():
            data=self.read();self.reconcile(data)
            return [self.public(j) for j in data['jobs']]

    def upsert(self, payload):
        with self.store.lock():
            data=self.read();self.reconcile(data)
            identifier=payload.get('id'); prior=next((j for j in data['jobs'] if j['id']==identifier),None)
            if identifier and not prior: raise ValueError('自动任务不存在')
            if prior and payload.get('version')!=prior['version']: raise ValueError('自动任务已在其他窗口更新，请刷新')
            if prior and prior.get('attempt',{}).get('status')=='running': raise ValueError('请先暂停正在执行的任务')
            project=self.project(self.store.load(),payload.get('projectId'))
            if prior and prior['projectId']!=project['id']: raise ValueError('自动任务不能改到另一个项目，请新建任务')
            name=str(payload.get('name','')).strip();prompt=str(payload.get('prompt','')).strip()
            if not name or len(name)>120 or not prompt or len(prompt)>12000: raise ValueError('填写任务名称与具体目标（最多12000字符）')
            due=payload.get('dueAt')
            try:
                stamp=datetime.fromisoformat(due.replace('Z','+00:00'))
                if stamp.tzinfo is None: raise ValueError()
                due=stamp.timestamp()
                if due<0: raise ValueError()
            except (ValueError,AttributeError,TypeError): raise ValueError('日程需要有效日期、时间与时区')
            interval=payload.get('intervalMinutes',0)
            if type(interval) is not int or interval not in (0,1440,10080): raise ValueError('重复周期应为单次、每天或每周')
            zone_name=payload.get('timeZone')
            if zone_name is not None:
                try: zone=ZoneInfo(zone_name)
                except (ZoneInfoNotFoundError,ValueError,TypeError): raise ValueError('无效时区，请使用 IANA 时区名称')
            budget=payload.get('budgetMinutes',15)
            if type(budget) is not int or not 1<=budget<=120: raise ValueError('运行时间须为1–120分钟')
            mode=payload.get('permissionMode','legacy')
            if mode not in ('legacy','request','smart'): raise ValueError('自动任务权限无效')
            skill=payload.get('skillId') or None
            if skill and not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',skill): raise ValueError('无效 Skill')
            job={**(prior or {}),'id':identifier or 'job_'+secrets.token_hex(10),'projectId':project['id'],'workspace':project['workspace'],'name':name,'prompt':prompt,'dueAt':due,'intervalMinutes':interval,'budgetMinutes':budget,'permissionMode':mode,'skillId':skill,'status':'active','version':(prior or {}).get('version',0)+1,'updatedAt':time.time()}
            if zone_name is not None:
                job['timeZone']=zone_name
                job['wallAnchor']=datetime.fromtimestamp(due,zone).replace(tzinfo=None).isoformat()
            else:
                job.pop('timeZone',None);job.pop('wallAnchor',None)
            if prior:data['jobs'][data['jobs'].index(prior)]=job
            else:data['jobs'].append(job)
            self.write(data);return self.public(job)

    @staticmethod
    def next_due(job, now):
        interval=job['intervalMinutes']*60
        if not job.get('timeZone'):
            return job['dueAt']+max(1,int((now-job['dueAt'])//interval)+1)*interval
        zone=ZoneInfo(job['timeZone'])
        anchor=datetime.fromisoformat(job['wallAnchor'])
        days=job['intervalMinutes']//1440
        today=datetime.fromtimestamp(now,zone).date()
        step=max(0,(today-anchor.date()).days//days)
        while True:
            wall=anchor+timedelta(days=step*days)
            # First occurrence of an ambiguous time; a nonexistent time moves
            # forward by the DST gap. Keep the original wall anchor thereafter.
            stamp=wall.replace(tzinfo=zone,fold=0).timestamp()
            if stamp>now: return stamp
            step+=1

    def change(self, identifier, action):
        with self.store.lock():
            data=self.read();self.reconcile(data);job=next((j for j in data['jobs'] if j['id']==identifier),None)
            if not job:raise ValueError('自动任务不存在')
            if action not in ('pause','resume','now','delete'):raise ValueError('未知操作')
            if action in ('resume','now'):
                self.validate_project(self.store.load(),job)
                if job.get('attempt',{}).get('status')=='running':raise ValueError('上次任务尚未停止')
            job['version']+=1;job['status']='paused' if action=='pause' else 'deleted' if action=='delete' else 'active'
            if action=='now':job['dueAt']=time.time()
            self.write(data);return self.public(job)

    def claim(self, identifier):
        with self.store.lock():
            data=self.read();self.reconcile(data);job=next((j for j in data['jobs'] if j['id']==identifier),None)
            if not job or job['status']!='active' or job['dueAt']>time.time():return {'claimed':False}
            if job.get('attempt',{}).get('status')=='running':return {'claimed':False}
            try:self.validate_project(self.store.load(),job)
            except ValueError:
                job['status']='paused';self.write(data);raise
            attempt={'id':'attempt_'+secrets.token_hex(10),'token':secrets.token_hex(24),'status':'running','instanceId':self.instance,'version':job['version'],'startedAt':time.time(),'expiresAt':time.time()+job['budgetMinutes']*60}
            if job.get('attempt'):
                old=copy.deepcopy(job['attempt']);old.pop('token',None);job.setdefault('history',[]).append(old)
            job['attempt']=attempt;self.write(data)
            return {'claimed':True,'job':self.public(job),'token':attempt['token']}

    def check(self, identifier, token):
        with self.store.lock():
            data=self.read();self.reconcile(data);job=next((j for j in data['jobs'] if j['id']==identifier),None);a=(job or {}).get('attempt',{})
            valid=bool(job and job['status']=='active' and a.get('token')==token and a.get('status')=='running' and a.get('version')==job['version'])
            if valid:
                try:self.validate_project(self.store.load(),job)
                except ValueError:valid=False;job['status']='paused';self.write(data)
            return {'valid':valid}

    def finish(self, identifier, token, run_id=None, error=None):
        with self.store.lock():
            data=self.read();job=next((j for j in data['jobs'] if j['id']==identifier),None);a=(job or {}).get('attempt',{})
            if not a or a.get('token')!=token:raise ValueError('自动任务执行身份已失效')
            was_interrupted=a.get('status')=='interrupted'
            if a.get('status') not in ('running','interrupted'):return self.public(job)
            snapshot=self.store.load();run=next((r for r in snapshot.get('agentRuns',[]) if r['id']==run_id and r.get('automaticJobId')==identifier and r.get('automaticAttemptId')==a['id']),None)
            if run:
                chat=next((c for c in snapshot.get('conversations',[]) if c['id']==run['conversationId']),{})
                if chat.get('projectId')!=job['projectId']:raise ValueError('执行结果不属于此项目')
                if run['status']=='running':raise ValueError('运行尚未结束')
                a.update(runId=run_id,conversationId=run['conversationId'],status=run['status'],error=run.get('error'),finishedAt=time.time())
            else:a.update(status='failed',error=str(error or '尚未形成执行记录')[:2000],finishedAt=time.time())
            if was_interrupted:
                a['resultStatus']=a['status'];a['status']='interrupted'
            if a['status']=='completed' and job['intervalMinutes'] and job['status']=='active':
                job['dueAt']=self.next_due(job,time.time())
            elif a['status']=='completed' and job['status']=='active':job['status']='completed'
            elif job['status']!='deleted':job['status']='paused'
            self.write(data);return self.public(job)
