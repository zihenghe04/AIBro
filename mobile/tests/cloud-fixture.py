import sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'app'))
from cloud_server import CloudStore,CloudHTTPServer
with tempfile.TemporaryDirectory(prefix='aibro-mobile-cloud-test-') as folder:
    store=CloudStore(folder)
    store.add_user('mobile-test','fixture-password-42!',initial=True)
    server=CloudHTTPServer(('127.0.0.1',0),store)
    print(server.server_port,flush=True)
    server.serve_forever()
