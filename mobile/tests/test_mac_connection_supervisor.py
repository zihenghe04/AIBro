"""Small read-only contract/security tests; never starts an App or cloud service."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

path=Path(__file__).resolve().parents[1] / 'scripts/run-mac-native-connection-qa.py'
spec=importlib.util.spec_from_file_location('mac_connection_qa',path)
qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)


class SupervisorContracts(unittest.TestCase):
    def setUp(self):
        self.config={'base':'http://127.0.0.1:19999','accountID':'account_fixture'}
        public={'kty':'EC','crv':'P-256','x':base64.urlsafe_b64encode(bytes(32)).decode().rstrip('='),'y':base64.urlsafe_b64encode(bytes([1])*32).decode().rstrip('=')}
        fp=base64.urlsafe_b64encode(hashlib.sha256(json.dumps(public,sort_keys=True,separators=(',',':')).encode()).digest()).decode().rstrip('=')
        self.pairing={'format':'aibro.connection-pairing.v1','serverOrigin':self.config['base'],'accountId':self.config['accountID'],'publicJwk':public,'fingerprint':fp}
        self.phone={'fixture':qa.PHONE_FIXTURE,'passed':True,'phase':1,'package':'app.aibro.mobile.nativeqa','serverOrigin':self.config['base'],
          'accountId':self.config['accountID'],'deviceFingerprint':'B'*43,'ownerFingerprint':fp,'providerBase':qa.PROVIDER}

    def test_public_pairing_must_match_origin_account_and_public_fingerprint(self):
        self.assertEqual(qa.public_pairing(self.pairing,self.config),self.pairing)
        for changes in [{'serverOrigin':'https://foreign.example'},{'accountId':'foreign'},{'fingerprint':'C'*43},{'privateJwk':{}},
                        {'publicJwk':{**self.pairing['publicJwk'],'d':'D'*43}}]:
            with self.assertRaises(ValueError):qa.public_pairing({**self.pairing,**changes},self.config)

    def test_phase1_requires_same_native_phone_owner_and_service(self):
        result=qa.phone_evidence(self.phone,1,self.config,self.pairing)
        self.assertEqual(set(result),{'deviceFingerprint','ownerFingerprint'})
        for changes in [{'passed':False},{'phase':2},{'package':'app.aibro.mobile'},{'accountId':'other'},
                        {'ownerFingerprint':'C'*43},{'deviceFingerprint':self.pairing['fingerprint']},{'providerBase':'https://foreign.example'}]:
            with self.assertRaises(ValueError):qa.phone_evidence({**self.phone,**changes},1,self.config,self.pairing)

    def test_phase2_requires_approved_phone_and_real_fixture_call_counts(self):
        approved=qa.phone_evidence(self.phone,1,self.config,self.pairing)
        second={**self.phone,'phase':2,'chatHttpsRequests':1,'speechHttpsRequests':1}
        self.assertEqual(qa.phone_evidence(second,2,self.config,self.pairing,approved)['speechHttpsRequests'],1)
        for changes in [{'deviceFingerprint':'C'*43},{'chatHttpsRequests':0},{'speechHttpsRequests':0}]:
            with self.assertRaises(ValueError):qa.phone_evidence({**second,**changes},2,self.config,self.pairing,approved)
        with self.assertRaises(ValueError):qa.phone_evidence(second,2,self.config,self.pairing)

    def test_actual_swift_optional_report_is_verified_without_rerunning_app(self):
        with tempfile.TemporaryDirectory() as directory:
            mac=Path(directory);result={'fixture':qa.FIXTURE,'passed':True,'checks':['native flow']}
            qa.write_json(mac/'result.json',result)
            (mac/'native-report.txt').write_text('PASS')
            for body in [json.dumps(result),'Optional('+json.dumps(result)+')']:
                (mac/'native-report.txt-harness-ux.txt').write_text(body)
                self.assertTrue(qa.verify_reports(mac)['controlResultMatchesNative'])
            (mac/'native-report.txt-harness-ux.txt').write_text('Optional('+json.dumps({**result,'passed':False})+')')
            with self.assertRaises(ValueError):qa.verify_reports(mac)


if __name__=='__main__':unittest.main()
