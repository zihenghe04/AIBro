"""Dependency-free OOXML text/cell edits. Never evaluate formulas or run macros."""
import copy
import io
import json
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
P='http://schemas.openxmlformats.org/presentationml/2006/main'
S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'
SUFFIXES={'.docx','.xlsx','.pptx'}


def xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper(): raise ValueError('Office XML 不允许 DTD 或实体。')
    return ET.fromstring(raw)


def package(raw):
    archive=zipfile.ZipFile(io.BytesIO(raw));infos=archive.infolist();names=[i.filename for i in infos]
    if len(infos)>3000 or len(set(names))!=len(names) or sum(i.file_size for i in infos)>100_000_000: raise ValueError('Office 压缩包过大或包含重复条目。')
    if any(n.startswith('/') or '\\' in n or '..' in n.split('/') for n in names): raise ValueError('Office 内部路径无效。')
    if any('vbaProject' in n or n.startswith('_xmlsignatures/') for n in names): raise ValueError('暂不改写带宏或数字签名的 Office 文件。')
    return {i.filename:archive.read(i) for i in infos}


def packed(files):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,raw in files.items(): archive.writestr(name,raw)
    return out.getvalue()


def serialized(tree, original=None):
    # Preserve prefixes referenced by OOXML compatibility attributes (mc:Ignorable).
    # ElementTree otherwise removes unused namespace declarations, invalidating them.
    present=ET.tostring(tree,encoding='utf-8').split(b'>',1)[0]
    if original:
        for event,value in ET.iterparse(io.BytesIO(original),events=('start-ns','start')):
            if event=='start':break
            prefix,uri=value
            if prefix and prefix!='xml' and ('xmlns:'+prefix+'=').encode() not in present:tree.set('xmlns:'+prefix,uri)
    return ET.tostring(tree,encoding='utf-8',xml_declaration=True)

def text(value):
    if not isinstance(value,str) or len(value)>100000 or any(ord(c)<32 and c not in '\n\r\t' for c in value): raise ValueError('Office 文字无效或过长。')
    return value


def units(files,suffix):
    result=[]
    if suffix in ('.docx','.pptx'):
        paths=['word/document.xml'] if suffix=='.docx' else sorted((n for n in files if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
        for path in paths:
            tree=xml(files[path]);tag='{'+(W if suffix=='.docx' else A)+'}t'
            for index,node in enumerate(tree.iter(tag)):result.append({'id':path+'@'+str(index),'text':node.text or ''})
    else:
        shared=[]
        if 'xl/sharedStrings.xml' in files:
            shared=[''.join(n.text or '' for n in si.iter('{'+S+'}t')) for si in xml(files['xl/sharedStrings.xml'])]
        for path in sorted(n for n in files if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',n)):
            for cell in xml(files[path]).iter('{'+S+'}c'):
                formula=cell.find('{'+S+'}f');value=cell.find('{'+S+'}v');value='' if value is None else value.text or ''
                if cell.get('t')=='s':value=shared[int(value)] if value.isdigit() and int(value)<len(shared) else ''
                if cell.get('t')=='inlineStr':value=''.join(n.text or '' for n in cell.iter('{'+S+'}t'))
                result.append({'id':path+'@'+cell.get('r',''),'text':value,'formula':None if formula is None else formula.text,'type':cell.get('t','n')})
    return result


def inspect(raw,suffix):
    if raw is None:return ''
    entries=units(package(raw),suffix)
    return 'Office 可编辑文字视图。未解析图片、图表、批注、页眉页脚及版式；公式仅展示，不计算。修改请使用下列稳定定位 ID 与原文。\n'+json.dumps(entries,ensure_ascii=False,indent=2)


def update(raw,suffix,spec):
    changes=spec.get('replace')
    if not isinstance(changes,list) or not 1<=len(changes)<=1000:raise ValueError('Office 修改需要 1–1000 个 replace 定位项。')
    files=package(raw);by_id={u['id']:u for u in units(files,suffix)};trees={};seen=set()
    for change in changes:
        identifier=change.get('id');before=change.get('before');after=text(change.get('after'))
        if identifier in seen or identifier not in by_id or by_id[identifier]['text']!=before:raise ValueError('Office 定位或原文已变化，请完整读取后重新提出。')
        seen.add(identifier);path,position=identifier.rsplit('@',1);tree=trees.setdefault(path,xml(files[path]))
        if suffix in ('.docx','.pptx'):
            node=list(tree.iter('{'+(W if suffix=='.docx' else A)+'}t'))[int(position)];node.text=after;node.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
        else:
            cell=next(c for c in tree.iter('{'+S+'}c') if c.get('r')==position)
            if cell.find('{'+S+'}f') is not None:raise ValueError('公式单元格不能通过文本改写；请使用专门的表格编辑。')
            for child in list(cell):
                if child.tag in ('{'+S+'}v','{'+S+'}is'):cell.remove(child)
            kind=change.get('type','text')
            if kind=='number':
                if not re.fullmatch(r'-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?',after):raise ValueError('数值格式无效。')
                cell.set('t','n');ET.SubElement(cell,'{'+S+'}v').text=after
            elif kind=='text':
                cell.set('t','inlineStr');ET.SubElement(ET.SubElement(cell,'{'+S+'}is'),'{'+S+'}t',{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=after
            else:raise ValueError('单元格仅支持 text / number。')
    for path,tree in trees.items():files[path]=serialized(tree,files.get(path))
    return packed(files)


def create(suffix,spec):
    files=package((Path(__file__).with_name('office-blank'+suffix)).read_bytes())
    if suffix=='.docx':
        paragraphs=spec.get('paragraphs');
        if not isinstance(paragraphs,list) or not 1<=len(paragraphs)<=5000:raise ValueError('Word 需要 paragraphs 段落数组，最多 5000 段。')
        tree=xml(files['word/document.xml']);body=tree.find('{'+W+'}body')
        for p in list(body):
            if p.tag!='{'+W+'}sectPr':body.remove(p)
        for index,item in enumerate(paragraphs):
            item={'text':item} if isinstance(item,str) else item;p=ET.Element('{'+W+'}p');style=item.get('style','Normal')
            if style not in ('Normal','Title','Heading1','Heading2','Heading3'):raise ValueError('不支持的 Word 段落样式。')
            ET.SubElement(ET.SubElement(p,'{'+W+'}pPr'),'{'+W+'}pStyle',{'{'+W+'}val':style});ET.SubElement(ET.SubElement(p,'{'+W+'}r'),'{'+W+'}t',{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=text(item.get('text'));body.insert(index,p)
        files['word/document.xml']=serialized(tree,files['word/document.xml'])
    elif suffix=='.xlsx':
        sheets=spec.get('sheets')
        if not isinstance(sheets,list) or not 1<=len(sheets)<=32:raise ValueError('Excel 需要 1–32 个 sheets。')
        workbook=xml(files['xl/workbook.xml']);listing=workbook.find('{'+S+'}sheets');listing.clear();rels=xml(files['xl/_rels/workbook.xml.rels']);types=xml(files['[Content_Types].xml']);template=xml(files['xl/worksheets/sheet1.xml']);names=set()
        for rel in list(rels):
            if rel.get('Type','').endswith('/worksheet'):rels.remove(rel)
        for override in list(types):
            if '/worksheets/' in override.get('PartName',''):types.remove(override)
        for index,sheet in enumerate(sheets,1):
            name=text(sheet.get('name'));rows=sheet.get('rows')
            if not name or len(name)>31 or re.search(r'[\\/*?:\[\]]',name) or name.casefold() in names:raise ValueError('工作表名称无效或重复。')
            names.add(name.casefold())
            if not isinstance(rows,list) or len(rows)>10000 or any(not isinstance(r,list) or len(r)>256 for r in rows):raise ValueError('每张表最多 10000 行、256 列。')
            tree=copy.deepcopy(template);data=tree.find('{'+S+'}sheetData');data.clear();dimension=tree.find('{'+S+'}dimension')
            if dimension is not None:tree.remove(dimension)
            for r,row in enumerate(rows,1):
                target=ET.SubElement(data,'{'+S+'}row',r=str(r))
                for col,value in enumerate(row,1):
                    letters='';n=col
                    while n:n,rem=divmod(n-1,26);letters=chr(65+rem)+letters
                    c=ET.SubElement(target,'{'+S+'}c',r=letters+str(r))
                    if type(value) in (int,float):
                        import math
                        if not math.isfinite(value):raise ValueError('表格数值必须有限。')
                        c.set('t','n');ET.SubElement(c,'{'+S+'}v').text=str(value)
                    else:c.set('t','inlineStr');ET.SubElement(ET.SubElement(c,'{'+S+'}is'),'{'+S+'}t').text=text('' if value is None else str(value))
            path='xl/worksheets/sheet'+str(index)+'.xml';files[path]=serialized(tree,files.get(path));rid='aibroSheet'+str(index)
            ET.SubElement(listing,'{'+S+'}sheet',{'name':name,'sheetId':str(index),'{'+R+'}id':rid});ET.SubElement(rels,'{'+REL+'}Relationship',{'Id':rid,'Type':R+'/worksheet','Target':'worksheets/sheet'+str(index)+'.xml'});ET.SubElement(types,'{'+CT+'}Override',{'PartName':'/'+path,'ContentType':'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'})
        files['xl/workbook.xml']=serialized(workbook);files['xl/_rels/workbook.xml.rels']=serialized(rels);files['[Content_Types].xml']=serialized(types)
    else:
        slides=spec.get('slides')
        if not isinstance(slides,list) or not 1<=len(slides)<=100:raise ValueError('PowerPoint 需要 1–100 页 slides。')
        presentation=xml(files['ppt/presentation.xml']);listing=presentation.find('{'+P+'}sldIdLst');listing.clear();rels=xml(files['ppt/_rels/presentation.xml.rels']);types=xml(files['[Content_Types].xml']);template=xml(files['ppt/slides/slide1.xml']);slide_rels=files['ppt/slides/_rels/slide1.xml.rels']
        for rel in list(rels):
            if rel.get('Type','').endswith('/slide'):rels.remove(rel)
        for override in list(types):
            if '/slides/' in override.get('PartName',''):types.remove(override)
        for index,slide in enumerate(slides,1):
            tree=copy.deepcopy(template);bodies=list(tree.iter('{'+P+'}txBody'));title=text(slide.get('title'));bullets=slide.get('bullets',[])
            if not isinstance(bullets,list) or len(bullets)>50:raise ValueError('每页最多 50 个文字段落。')
            for body,values in zip(bodies,[[title],bullets]):
                for child in list(body):
                    if child.tag=='{'+A+'}p':body.remove(child)
                for value in values or ['']:
                    paragraph=ET.SubElement(body,'{'+A+'}p');ET.SubElement(ET.SubElement(paragraph,'{'+A+'}r'),'{'+A+'}t').text=text(value)
            path='ppt/slides/slide'+str(index)+'.xml';files[path]=serialized(tree,files.get(path));files['ppt/slides/_rels/slide'+str(index)+'.xml.rels']=slide_rels;rid='aibroSlide'+str(index)
            ET.SubElement(listing,'{'+P+'}sldId',{'id':str(255+index),'{'+R+'}id':rid});ET.SubElement(rels,'{'+REL+'}Relationship',{'Id':rid,'Type':R+'/slide','Target':'slides/slide'+str(index)+'.xml'});ET.SubElement(types,'{'+CT+'}Override',{'PartName':'/'+path,'ContentType':'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'})
        files['ppt/presentation.xml']=serialized(presentation);files['ppt/_rels/presentation.xml.rels']=serialized(rels);files['[Content_Types].xml']=serialized(types)
    return packed(files)


def transform(raw,suffix,content):
    spec=json.loads(content)
    if not isinstance(spec,dict):raise ValueError('Office 内容需要结构化 JSON。')
    return create(suffix,spec) if raw is None else update(raw,suffix,spec)
