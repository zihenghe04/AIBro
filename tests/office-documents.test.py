"""Office package preservation, literal spreadsheet strings and real reviewed disk edits."""
import copy,hashlib,io,json,tempfile,unittest,zipfile
from pathlib import Path
import office_documents as O
from local_projects import LocalProjects,LocalProjectError
from local_file_edits import LocalFileEdits

SAMPLES={'.docx':{'paragraphs':[{'text':'Experiment','style':'Title'},'Original evidence']},'.xlsx':{'sheets':[{'name':'Results','rows':[['Name','Value'],['Baseline',2.5]]},{'name':'Sources','rows':[['=not_a_formula']]}]},'.pptx':{'slides':[{'title':'Hypothesis','bullets':['Observation','Control']},{'title':'Results','bullets':['Not measured yet']} ]}}
class OfficeTests(unittest.TestCase):
 def test_create_update_preserves_unmodified_resources(self):
  for suffix,spec in SAMPLES.items():
   raw=O.create(suffix,spec);files=O.package(raw);units=O.units(files,suffix);self.assertGreater(len(units),1);unit=units[0]
   updated=O.update(raw,suffix,{'replace':[dict(id=unit['id'],before=unit['text'],after='Revised evidence')]})
   after=O.package(updated);self.assertEqual(O.units(after,suffix)[0]['text'],'Revised evidence')
   changed=unit['id'].split('@')[0]
   for path,data in files.items():
    if path!=changed:self.assertEqual(after[path],data,path)
   with self.assertRaises(ValueError):O.update(updated,suffix,{'replace':[dict(id=unit['id'],before=unit['text'],after='stale')]})
 def test_spreadsheet_strings_and_formulas(self):
  raw=O.create('.xlsx',SAMPLES['.xlsx']);files=O.package(raw);self.assertIn('=not_a_formula',O.inspect(raw,'.xlsx'));self.assertTrue(all(u['formula'] is None for u in O.units(files,'.xlsx')))
  tree=O.xml(files['xl/worksheets/sheet1.xml']);cell=next(tree.iter('{'+O.S+'}c'));O.ET.SubElement(cell,'{'+O.S+'}f').text='1+2';files['xl/worksheets/sheet1.xml']=O.serialized(tree);raw=O.packed(files);unit=O.units(files,'.xlsx')[0]
  with self.assertRaises(ValueError):O.update(raw,'.xlsx',{'replace':[dict(id=unit['id'],before=unit['text'],after='4')]})
 def test_invalid_packages_and_specs(self):
  for suffix,spec in [('.docx',{'paragraphs':[]}),('.xlsx',{'sheets':[{'name':'../bad','rows':[]}]}),('.pptx',{'slides':[]})]:
   with self.assertRaises(ValueError):O.create(suffix,spec)
  with self.assertRaises(ValueError):O.package(O.packed({'../outside':'data'.encode()}))
  with self.assertRaises(ValueError):O.xml(b'<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>')
 def test_file_review_and_conflict_boundary(self):
  with tempfile.TemporaryDirectory() as tmp:
   base=Path(tmp);folder=base/'project';folder.mkdir();projects=LocalProjects(base/'data');cid=projects.connect(str(folder))['candidate']['id'];edits=LocalFileEdits(projects)
   for suffix,spec in SAMPLES.items():
    path='report'+suffix;proposal=edits.propose(dict(candidateId=cid,projectId='p',runId='r',path=path,operation='create',content=json.dumps(spec)));self.assertFalse((folder/path).exists());edits.access(proposal['id'],'apply');original=(folder/path).read_bytes();view=projects.read_file(cid,path);self.assertIn('Office',view['text']);self.assertEqual(view['version'],hashlib.sha256(original).hexdigest())
    unit=O.units(O.package(original),suffix)[0];patch=json.dumps({'replace':[dict(id=unit['id'],before=unit['text'],after='Changed')]});change=edits.propose(dict(candidateId=cid,projectId='p',runId='r',path=path,operation='update',version=view['version'],content=patch))
    full=edits.access(change['id']);self.assertTrue(full['office']);self.assertIn('Changed',full['after']);edits.access(change['id'],'apply');self.assertNotEqual((folder/path).read_bytes(),original);edits.access(change['id'],'undo');self.assertEqual((folder/path).read_bytes(),original)
    edits.access(proposal['id'],'undo');self.assertFalse((folder/path).exists())
if __name__=='__main__':unittest.main()
