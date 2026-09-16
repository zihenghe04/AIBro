import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'app'))
from sync_store import SyncStore, project
payload=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='aibro-mobile-desktop-test-') as folder:
    store=SyncStore(folder)
    changes=[dict(entityType=key.split(':')[0],entityId=key.split(':')[1],version=1,deleted=False,data=value['data']) for key,value in payload.items()]
    store.apply_changes(changes,len(changes))
    snapshot=store.snapshot()
    print(json.dumps({'notes':snapshot['notes'],'conversations':snapshot['conversations'],'wireIDs':[key[1] for key in project(snapshot) if key[0]=='messages']},ensure_ascii=False))
