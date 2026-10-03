"""Synthetic website metadata, safe image decode, and actual loopback route."""
import base64, contextlib, copy, email.message, http.client, io, json, os, socket, tempfile, threading, unittest, uuid
from unittest import mock
from PIL import Image
import bookmark_metadata as metadata
import public_url_fetch as transport
import sync_store


def png(size=(128, 128)):
    out=io.BytesIO();Image.new('RGBA',size,(12,130,120,255)).save(out,format='PNG');return out.getvalue()


def fetched(raw, url='https://example.org/page', mime='text/html'):
    return {'raw':raw,'finalUrl':url,'mimeType':mime,'charset':'utf-8'}


def state():
    return {'imports':[{'id':'existing','quickLinkIdentity':'owner-existing','updatedAt':1,'url':'https://example.org/page','content':'Retain original','fileStored':True,'projectId':'p'}],'projects':[{'id':'p'}]}


def request():
    return {'native':True,'url':'https://example.org/page','bookmark':{'id':'existing','identity':'owner-existing','updatedAt':1,'requestId':'quick_link_'+str(uuid.uuid4())}}


class Store:
    def __init__(self): self.state=state()
    def load(self): return copy.deepcopy(self.state)
    def lock(self): return contextlib.nullcontext()


class MetadataChecks(unittest.TestCase):
    def test_html_title_description_and_real_icon_become_small_png_without_original_writes(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append((url,kwargs));return fetched(b'<head><title>Research &amp; evidence</title><meta name="description" content="Read the paper"><link rel="shortcut icon" href="/assets/a.png"></head>') if len(calls)==1 else fetched(png(),mime='image/png')
        store=Store();before=copy.deepcopy(store.state);result=metadata.receive(store,request(),fetcher=fetch)
        self.assertEqual(store.state,before);self.assertEqual(result['title'],'Research & evidence');self.assertEqual(result['description'],'Read the paper');self.assertEqual(calls[1][0],'https://example.org/assets/a.png');self.assertEqual(calls[1][1]['max_bytes'],160*1024)
        raw=base64.b64decode(result['iconDataUrl'].split(',',1)[1]);self.assertEqual(Image.open(io.BytesIO(raw)).size,(64,64));self.assertLess(len(raw),32768)
    def test_fallback_icon_is_same_site_root_and_one_candidate_only(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            if len(calls)==1:return fetched(b'<title>Public page</title>','https://example.org/deep/page')
            raise transport.PublicFetchError('missing')
        result=metadata.inspect('https://example.org/deep/page',fetcher=fetch)
        self.assertEqual(calls,['https://example.org/deep/page','https://example.org/favicon.ico']);self.assertEqual(result['title'],'Public page');self.assertEqual(result['iconStatus'],'unavailable')
    def test_svg_corrupt_or_large_dimensions_never_reach_native_image(self):
        for raw in [b'<svg><script>danger</script></svg>',b'not an image',png((1025,1025))]:
            calls=[]
            def fetch(url,**kwargs):calls.append(url);return fetched(b'<title>Retained</title>') if len(calls)==1 else fetched(raw,mime='image/svg+xml')
            result=metadata.inspect('https://example.org',fetcher=fetch);self.assertEqual(result['title'],'Retained');self.assertEqual(result['iconDataUrl'],'')
    def test_url_credentials_and_private_address_use_existing_transport_refusal(self):
        with self.assertRaises(transport.PublicFetchError):metadata.inspect('http://user:pass@example.org/')
        with mock.patch.object(socket,'getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',80))]),self.assertRaises(transport.PublicFetchError) as error:metadata.inspect('http://private.example.org/')
        self.assertEqual(error.exception.code,'NON_PUBLIC_URL')
    def test_icon_private_dns_is_rejected_before_second_connection(self):
        public=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.216.34',80))];private=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',80))]
        headers=email.message.Message();headers['Content-Type']='text/html'
        response=mock.Mock(status=200,headers=headers);stream=io.BytesIO(b'<title>Keep</title><link rel="icon" href="http://bad.example.org/icon">');response.read1=stream.read
        with mock.patch.object(socket,'getaddrinfo',side_effect=[public,private]),mock.patch.object(transport,'_open',return_value=(mock.Mock(),response)) as opened:
            result=metadata.inspect('http://public.example.org/')
        self.assertEqual(opened.call_count,1);self.assertEqual(result['title'],'Keep');self.assertEqual(result['iconStatus'],'unavailable')
    def test_https_icon_downgrade_is_not_requested(self):
        calls=[]
        def fetch(url,**kwargs):calls.append(url);return fetched(b'<title>Keep</title><link rel="icon" href="http://example.org/icon">')
        result=metadata.inspect('https://example.org',fetcher=fetch);self.assertEqual(len(calls),1);self.assertEqual(result['iconStatus'],'unavailable')
    def test_mixed_case_http_icon_downgrade_is_not_requested(self):
        for scheme in ['HTTP', 'HtTp']:
            with self.subTest(scheme=scheme):
                calls=[]
                def fetch(url,**kwargs):
                    calls.append(url)
                    return fetched(f'<title>Keep</title><link rel="icon" href="{scheme}://public.example.org/icon.png">'.encode())
                result=metadata.inspect('https://example.org',fetcher=fetch)
                self.assertEqual(calls,['https://example.org']);self.assertEqual(result['iconStatus'],'unavailable');self.assertEqual(result['title'],'Keep')
    def test_private_changed_and_removed_record_refuse_before_network(self):
        for mutate in [lambda s:s['projects'][0].update(private=True),lambda s:s['imports'][0].update(url='https://example.org/other'),lambda s:s['imports'].clear()]:
            store=Store();mutate(store.state)
            with self.assertRaises(transport.PublicFetchError):metadata.receive(store,request(),fetcher=lambda *a,**k:self.fail('unexpected network'))
    def test_changes_during_network_reject_late_metadata(self):
        for mutate in [lambda s:s['imports'][0].update(content='Later change'),lambda s:s['projects'][0].update(private=True),lambda s:s['imports'][0].update(projectId='removed')]:
            store=Store();count=0
            def fetch(url,**kwargs):
                nonlocal count
                count+=1
                if count==1:mutate(store.state);return fetched(b'<title>Late</title>')
                return fetched(png(),mime='image/png')
            with self.assertRaises(transport.PublicFetchError):metadata.receive(store,request(),fetcher=fetch)
    def test_metadata_ui_cache_is_not_part_of_cloud_projection(self):
        value=state();value['ui']={'nativeQuickLinkMetadata':{'existing':{'iconDataUrl':'LOCAL_ONLY_ICON','description':'LOCAL_ONLY_DESCRIPTION'}}}
        encoded=json.dumps(list(sync_store.project(value).values()))
        self.assertNotIn('LOCAL_ONLY',encoded);self.assertIn('Retain original',encoded)


class RouteChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='aibro-metadata-http-');cls.env=mock.patch.dict(os.environ,{'AI_WORKSTATION_DATA_DIR':cls.temp.name,'AI_WORKSTATION_PORT':'0'});cls.env.start()
        import server
        cls.server=server;cls.httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);cls.origin=f'http://127.0.0.1:{cls.httpd.server_port}';cls.portPatch=mock.patch.object(server,'PORT',cls.httpd.server_port);cls.portPatch.start();cls.thread=threading.Thread(target=cls.httpd.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.httpd.shutdown();cls.httpd.server_close();cls.thread.join();cls.portPatch.stop();cls.env.stop();cls.temp.cleanup()
    def post(self,payload,origin=True):
        connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port);headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=self.origin
        connection.request('POST','/__bookmark-metadata',json.dumps(payload),headers);response=connection.getresponse();data=json.loads(response.read());connection.close();return response.status,data
    def test_loopback_route_requires_exact_mutation_origin_and_returns_bound_receipt(self):
        store=Store()
        with mock.patch.object(self.server,'STORE',store),mock.patch.object(metadata,'inspect',return_value={'title':'Verified','description':'Description','finalUrl':'https://example.org/page','iconDataUrl':'','iconStatus':'unavailable'}) as inspected:
            p=request();status,result=self.post(p,origin=False);self.assertEqual(status,403);self.assertEqual(inspected.call_count,0)
            status,result=self.post(p);self.assertEqual(status,200);self.assertEqual(result['id'],'existing');self.assertEqual(result['bookmarkRequestId'],p['bookmark']['requestId']);self.assertEqual(inspected.call_count,1)
    def test_read_failure_never_exposes_raw_internal_error_or_mutates_source(self):
        store=Store();before=copy.deepcopy(store.state)
        with mock.patch.object(self.server,'STORE',store),mock.patch.object(metadata,'inspect',side_effect=OSError('PRIVATE_PATH')):
            status,result=self.post(request());self.assertEqual(status,503);self.assertNotIn('PRIVATE_PATH',json.dumps(result));self.assertEqual(store.state,before)

if __name__=='__main__':unittest.main()
