"""Immutable command approvals and bounded, cancellable local execution.
Directory scope chooses cwd; this is not an OS sandbox for approved programs.
"""
import atexit, fcntl, json, os, re, selectors, shutil, signal, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path
from local_projects import LocalProjectError

class LocalCommands:
    OUTPUT_LIMIT = 65536
    SAFE = (('/bin/pwd',), ('/usr/bin/git','--version'), ('/usr/bin/git','status','--short'), ('/usr/bin/git','diff','--no-ext-diff','--no-textconv','--stat'))
    TERMINAL = {'succeeded','failed','cancelled','timed_out','interrupted'}
    PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

    def __init__(self, projects):
        self.projects=projects;self.directory=projects.directory/'command-runs';self.lock=threading.RLock();self.running={}
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        # Never replay a command following restart; its external effects may remain.
        for path in self.directory.glob('cmd_*.json'):
            entry=json.loads(path.read_text())
            if entry['status'] in ('pending','running'):
                entry.update(status='interrupted',error='应用重启；未重新执行。请核对命令可能已产生的效果。');self._save(entry)
        atexit.register(self.close)

    def _path(self,id):
        if not isinstance(id,str) or not re.fullmatch(r'cmd_[a-f0-9]{32}',id):raise LocalProjectError('无效的命令记录。')
        return self.directory/(id+'.json')

    def _write(self,path,data):
        fd,temp=tempfile.mkstemp(prefix='.command-',dir=self.directory)
        try:
            with os.fdopen(fd,'w') as out:json.dump(data,out,ensure_ascii=False);out.flush();os.fsync(out.fileno())
            os.replace(temp,path)
        finally:
            if os.path.exists(temp):os.unlink(temp)

    def _save(self,e):self._write(self._path(e['id']),e)
    def _load(self,id):
        try:return json.loads(self._path(id).read_text())
        except FileNotFoundError:raise LocalProjectError('此设备没有该命令记录。',404)
    def _rules(self):
        p=self.directory/'allowlist.json'
        return json.loads(p.read_text()) if p.exists() else []
    def _rule(self,e):return {k:e[k] for k in ('candidateId','directoryIdentity','cwd','argv')}
    def _public(self,e):return {**e,'trusted':e['rememberable'] and self._rule(e) in self._rules()}
    @staticmethod
    def _identity(fd):
        s=os.fstat(fd);return [s.st_dev,s.st_ino]
    @staticmethod
    def _display_path(fd):
        if sys.platform=='darwin':return os.fsdecode(fcntl.fcntl(fd,50,b'\0'*1024).split(b'\0')[0])
        return os.readlink('/proc/self/fd/'+str(fd))

    def propose(self,p):
        argv=p.get('argv');cwd=p.get('cwd','');timeout=p.get('timeout',60)
        if not isinstance(argv,list) or not 1<=len(argv)<=64 or any(not isinstance(x,str) or '\0' in x or len(x)>8192 for x in argv):raise LocalProjectError('命令必须为程序与参数组成的数组。')
        if not argv[0] or (not os.path.isabs(argv[0]) and '/' in argv[0]):raise LocalProjectError('程序请使用名称或绝对路径。')
        program=shutil.which(argv[0],path=self.PATH)
        if not program or not os.path.isfile(program):raise LocalProjectError('本机找不到该程序，请先安装或填写绝对路径。',404)
        argv=[program,*argv[1:]]
        if type(timeout) is not int or not 1<=timeout<=120:raise LocalProjectError('命令超时需在 1–120 秒之间。')
        self.projects._parts(cwd)
        rememberable=tuple(argv) in self.SAFE
        # Git checks never invoke a pager, fsmonitor hook, textconv or external diff.
        if program=='/usr/bin/git':argv=[program,'-c','core.fsmonitor=false','--no-pager',*argv[1:]]
        with self.lock, self.projects._connected_folder(p.get('candidateId')) as root:
            folder=self.projects._open_below(root,cwd)
            try:
                e=dict(id='cmd_'+uuid.uuid4().hex,candidateId=p['candidateId'],projectId=p.get('projectId'),runId=p.get('runId'),cwd=cwd,displayCwd=self._display_path(folder),directoryIdentity=self._identity(folder),rootIdentity=self._identity(root),argv=argv,timeout=timeout,rememberable=rememberable,status='pending',createdAt=int(time.time()*1000),output='',truncated=False,exitCode=None)
                self._save(e);return self._public(e)
            finally:os.close(folder)

    def access(self,id,action='get',remember=False,automatic=False):
        with self.lock:
            e=self._load(id)
            if action=='get':return self._public(e)
            if action=='forget':
                self._write(self.directory/'allowlist.json',[r for r in self._rules() if r!=self._rule(e)]);return self._public(e)
            if action in ('deny','cancel'):
                if e['status']=='running':self.running[id]['cancel'].set()
                elif e['status']=='pending':e.update(status='cancelled',finishedAt=int(time.time()*1000));self._save(e)
                return self._public(e)
            if action!='start':raise LocalProjectError('无效的命令操作。')
            if e['status']!='pending':return self._public(e)
            if self.running:raise LocalProjectError('已有本机命令正在执行，请等待完成或停止。',409)
            if automatic and not self._public(e)['trusted']:raise LocalProjectError('该命令未在当前目录的白名单中。',403)
            if remember and not e['rememberable']:raise LocalProjectError('此命令必须逐次审批，不能记入白名单。',403)
            with self.projects._connected_folder(e['candidateId']) as root:
                folder=self.projects._open_below(root,e['cwd'])
                try:
                    if self._identity(folder)!=e['directoryIdentity'] or self._identity(root)!=e['rootIdentity']:raise LocalProjectError('命令目录已变化，请重新提出请求。',409)
                    if remember:
                        rules=self._rules();rule=self._rule(e)
                        if rule not in rules:rules.append(rule);self._write(self.directory/'allowlist.json',rules)
                    # Deliberately omit inherited API tokens, proxy credentials and interpreter hooks.
                    home=tempfile.TemporaryDirectory(prefix='aibro-command-')
                    env={'PATH':self.PATH,'HOME':home.name,'TMPDIR':home.name,'LANG':'en_US.UTF-8','PYTHONIOENCODING':'utf-8','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_OPTIONAL_LOCKS':'0'}
                    e.update(status='running',startedAt=int(time.time()*1000));self._save(e)
                    try:p=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).with_name('command_worker.py')),str(folder),json.dumps(e['argv']),str(os.getpid())],pass_fds=(folder,),env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
                    except Exception:
                        home.cleanup();e.update(status='failed',error='程序无法启动。');self._save(e);raise LocalProjectError('程序无法启动。',503)
                    control={'process':p,'cancel':threading.Event()};self.running[id]=control
                    threading.Thread(target=self._watch,args=(e,control,home),daemon=True).start()
                finally:os.close(folder)
            return self._public(e)

    @staticmethod
    def _kill(p):
        try:os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError:pass

    def _watch(self,e,control,home):
        p=control['process'];started=time.monotonic();raw=bytearray();status=None;last=0
        selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ);os.set_blocking(p.stdout.fileno(),False)
        try:
            while True:
                if control['cancel'].is_set():status='cancelled';self._kill(p)
                elif time.monotonic()-started>e['timeout']:status='timed_out';self._kill(p)
                # Revoked grants stop an ongoing process as well as future starts.
                if not status:
                    try:
                        with self.projects._connected_folder(e['candidateId']) as folder:
                            if self._identity(folder)!=e['rootIdentity']:raise LocalProjectError('目录已变化。')
                    except (LocalProjectError,OSError):status='cancelled';self._kill(p)
                for key,_ in selector.select(.1):
                    try: chunk=os.read(key.fd,16384)
                    except BlockingIOError: continue
                    if chunk:
                        left=self.OUTPUT_LIMIT-len(raw);raw.extend(chunk[:left]);e['truncated'] |= len(chunk)>left
                    else:selector.unregister(key.fileobj)
                if time.monotonic()-last>.25:
                    e['output']=bytes(raw).decode('utf-8','replace')
                    with self.lock:self._save(e)
                    last=time.monotonic()
                if p.poll() is not None:
                    self._kill(p) # Close descendants that still hold inherited stdout.
                    while True:
                        try:chunk=os.read(p.stdout.fileno(),16384)
                        except BlockingIOError:break
                        if not chunk:break
                        left=self.OUTPUT_LIMIT-len(raw);raw.extend(chunk[:left]);e['truncated'] |= len(chunk)>left
                    break
            if control['cancel'].is_set():status='cancelled'
            e.update(status=status or ('succeeded' if p.returncode==0 else 'failed'),exitCode=p.returncode,output=bytes(raw).decode('utf-8','replace'),finishedAt=int(time.time()*1000))
        except Exception:
            # A cancelled process may close its output while the watcher drains it.
            # Preserve the user's cancellation instead of reporting a read failure.
            e.update(status='cancelled' if control['cancel'].is_set() else status or 'failed',finishedAt=int(time.time()*1000))
            if e['status']=='failed':e['error']='命令输出读取失败；进程已停止。'
            self._kill(p)
        finally:
            p.wait();selector.close();p.stdout.close();home.cleanup()
            with self.lock:self._save(e);self.running.pop(e['id'],None)

    def close(self):
        with self.lock:
            for control in self.running.values():control['cancel'].set();self._kill(control['process'])
