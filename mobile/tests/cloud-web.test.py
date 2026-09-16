import sys, tempfile, threading, json, unittest, urllib.request, urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'app'))
from cloud_server import CloudStore, CloudHTTPServer, APIError
from cloud_web import origins, relay
class WebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        store=CloudStore(cls.tmp.name)
        store.add_user('web-fixture','fixture-password-42!',initial=True)
        cls.server=CloudHTTPServer(('127.0.0.1',0),store,web_origins=['https://app.example'])
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.base='http://127.0.0.1:'+str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.tmp.cleanup()
    def request(self,path,method='GET',body=None,headers=None):
        headers={'Origin':'https://app.example',**(headers or {})}
        if body is not None: headers['Content-Type']='application/json'
        req=urllib.request.Request(self.base+path, data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
        try: return urllib.request.urlopen(req)
        except urllib.error.HTTPError as e: return e
    def test_preflight_and_denied_origins(self):
        r=self.request('/v1/sync/push','OPTIONS',headers={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'})
        self.assertEqual(r.status,204); self.assertEqual(r.headers['Access-Control-Allow-Origin'],'https://app.example')
        r=self.request('/v1/health',headers={'Origin':'https://evil.example'})
        self.assertEqual(r.status,403);self.assertIsNone(r.headers.get('Access-Control-Allow-Origin'))
        self.assertEqual(self.request('/v1/health').status,200)
    def test_authenticated_relay_and_cloud_payloads(self):
        self.assertEqual(self.request('/v1/web/relay','POST',{}).status,401)
        login=self.request('/v1/auth/login','POST',{'username':'web-fixture','password':'fixture-password-42!','deviceName':'AI Bro Web'})
        self.assertEqual(login.headers['Access-Control-Allow-Origin'],'https://app.example')
        token=json.load(login)['accessToken'];headers={'Authorization':'Bearer '+token}
        with patch('cloud_web.relay',return_value={'STATUS':0,'timestamp':123}):
            response=self.request('/v1/web/relay','POST',{'url':'https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do?id=0'},headers)
            self.assertEqual(json.load(response)['STATUS'],0)
        self.assertEqual(self.request('/v1/sync/pull',headers=headers).status,200)
    def test_school_http_expiry_is_recoverable_without_reflecting_body(self):
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect=urllib.error.HTTPError('https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action',401,'secret',{},None)
            with self.assertRaises(APIError) as ctx:
                relay({'url':'https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action','method':'POST'},APIError)
            self.assertEqual(ctx.exception.status,401)
            self.assertEqual(ctx.exception.code,'upstream_auth_expired')
            self.assertNotIn('secret',ctx.exception.message)
    def test_no_open_proxy_or_wildcard(self):
        for target in ['https://127.0.0.1/v1/responses','https://evil.example/v1/responses','https://iclass.ucas.edu.cn:8181/app/admin']:
            with self.assertRaises(APIError): relay({'url':target,'method':'POST'},APIError)
        for origin in ['*','https://app.example/path','https://user:pass@app.example','http://app.example']:
            with self.assertRaises(ValueError):origins(origin)
if __name__=='__main__':unittest.main()
