"""Create a completely synthetic two-page course handout, without external assets."""
import json, sys
import fitz
from pathlib import Path
content=json.loads(Path(sys.argv[1]).read_text())
output=Path(sys.argv[2]); document=fitz.open()
for index,data in enumerate(content['pages']):
    page=document.new_page(width=720,height=920)
    page.draw_rect(page.rect,fill=(.982,.980,.970),color=None)
    page.insert_font(fontname='china-s')
    def text(rect,value,size=13,color=(.17,.18,.19)):
        for attempt in range(12):
            result=page.insert_textbox(fitz.Rect(*rect),value,fontname='china-s',fontsize=size-attempt*.5,color=color,lineheight=1.35)
            if result>=0: return
        raise ValueError('Synthetic PDF text does not fit')
    text((48,38,672,66),'AI BRO / COURSE NOTES',11,(.42,.44,.45))
    text((48,92,672,144),content['title'],29)
    text((48,153,672,200),content['subtitle'],17,(.42,.44,.45))
    page.draw_line((48,224),(672,224),color=(.78,.79,.78),width=1)
    text((48,254,672,317),data['heading'],23)
    text((48,329,672,405),data['lead'],13)
    for number,label in enumerate(data['steps']):
        x=48+number*160
        page.draw_rect(fitz.Rect(x,432,x+144,532),fill=(.925,.933,.930),color=(.77,.80,.79),width=.7)
        text((x+14,445,x+130,468),f'0{number+1}',11,(.37,.43,.40))
        text((x+14,476,x+132,520),label,16)
    for number,line in enumerate(data['body']):
        text((48,577+number*51,672,625+number*51),line,12)
    page.draw_line((48,836),(672,836),color=(.78,.79,.78),width=.7)
    text((48,855,636,898),content['footer'],10,(.46,.47,.46))
    text((644,855,674,898),str(index+1),11,(.46,.47,.46))
document.set_metadata({'title':content['title'],'author':'AI Bro synthetic demonstration','subject':'Fictional product demonstration; no personal data'})
document.save(output)
