"""Track Markdown link targets by stable Wiki identity across folder moves."""
import posixpath
import re
from urllib.parse import unquote


def occurrences(content, include_images=False):
    masked=[];fence=None
    for line in content.splitlines(keepends=True):
        marker=re.match(r'^\s*(`{3,}|~{3,})',line)
        if marker:
            token=marker[1]
            if fence is None:fence=token
            elif token[0]==fence[0] and len(token)>=len(fence):fence=None
            masked.append(' '*len(line));continue
        masked.append(' '*len(line) if fence else line)
    value=re.sub(r'(`+).*?\1',lambda m:' '*len(m[0]),''.join(masked),flags=re.S)
    pattern=(r'' if include_images else r'(?<!!)')+r'\[[^\]\n]*\]\(([^)\n]+)\)'
    return [(m[1],m.start(1),m.end(1)) for m in re.finditer(pattern,value)]

def links(content):
    return [href for href,_,_ in occurrences(content)]


def update(snapshot):
    mapping=snapshot.get('_wikiFiles',{});by_path={entry['path']:id for id,entry in mapping.items()};changed=False
    for note in snapshot.get('notes',[]):
        entry=mapping.get(note.get('id'))
        if not entry:continue
        old=entry.get('links',{});new={}
        for href in links(note.get('content','')):
            if re.match(r'^[a-z][a-z0-9+.-]*:|^[/\\]',href,re.I):continue
            value=unquote(href.split('#',1)[0]);path=posixpath.normpath(posixpath.join(posixpath.dirname(entry['path']),value)) if value else entry['path']
            target=old.get(href) or by_path.get(path)
            if target:new[href]=target
        if old!=new or 'links' not in entry:entry['links']=new;changed=True
    return changed
