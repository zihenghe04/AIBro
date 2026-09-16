#!/usr/bin/env python3
"""Frame real native-UI captures. Edited step demos, never inference benchmarks.
Requires Pillow, ffmpeg and a CJK font (--font or fc-match PingFang SC).
Input captures and storyboard are deliberately fictional; no live account is used.
"""
import argparse,json,math,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter,ImageOps
ROOT=Path(__file__).resolve().parents[1]
STORY={
 'files':('修改有迹可循。','Make every change reviewable.', [('files-chat','从对话产出打开文件','Open the file produced in a conversation'),('files-diff','逐行核对本轮修改','Inspect the changes line by line'),('files-preview','切换排版预览与源码','Switch between preview and source'),('files-source','继续编辑，留下自己的理解','Keep editing with your own understanding')]),
 'projects':('下一步，安排在这里。','Give the next step a home.', [('projects-overview','任务、进度与时间轴在同一处','See tasks, progress and a timeline together'),('projects-kanban','按状态组织，接着上次继续','Organize by status and pick up where you left off')]),
 'wiki':('让研究，逐渐连成体系。','Build a research memory.', [('wiki-library','按概念、方法、实验与问题浏览','Browse concepts, methods, experiments and questions'),('wiki-method','打开方法笔记，继续阅读与修订','Read and refine the method note beside the library')]),
 'captures':('先捕捉，再连接。','Catch a thought. Connect it later.', [('captures-list','不必整理完，先记下灵感','Capture an observation before organizing it'),('captures-selected','选择一组，准备整理与寻找关联','Select a group for organization and connections'),('captures-agenda','把想法接到可确认的日程草稿','Turn an observation into a calendar draft')]),
 'agenda':('让计划，落到每一天。','Make room for the next step.', [('agenda-month','任务与日程，一起出现在月历','See tasks and events in the same calendar'),('agenda-day','点击日期，直接查看当天安排','Click a date to see the day in detail'),('agenda-reminders','按自己的节奏选择提醒','Choose when you want to be reminded')]),
 'retrieval':('回答背后，有迹可查。','Follow the answer back to evidence.', [('retrieval-found','查看命中片段与实际索引范围','Inspect matching passages and actual index coverage'),('retrieval-context','展开前后证据，回到原文核对','Expand neighboring evidence and check the source')]),
 'tools':('把好方法，变成可复用流程。','Keep a good workflow within reach.', [('tools-skills','在对话里选择工作流技能','Choose a workflow skill from the conversation'),('tools-instructions','说明可查看，自定义可以继续完善','Inspect the instructions and make your own workflow')]),
 'conversations':('一个想法，也有自己的位置。','A place for every conversation.', [('conversations-list','找回之前正在推进的工作','Find the work you want to continue'),('conversations-manage','重命名、归档或放入文件夹','Rename, archive or organize into a folder'),('conversations-folder','在文件夹里继续这段对话','Continue the conversation from its folder')])}
W,H,FPS=1280,900,24

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--captures',type=Path,default=ROOT/'demo/native/captures');ap.add_argument('--output',type=Path,default=ROOT/'launch/dist/assets');ap.add_argument('--font');ap.add_argument('--only',choices=list(STORY));args=ap.parse_args()
 font=args.font or subprocess.check_output(['fc-match','PingFang SC','-f','%{file}'],text=True)
 fonts={s:ImageFont.truetype(font,s) for s in [16,18,21,26,36,40,64]}
 out=args.output; (out/'features').mkdir(parents=True,exist_ok=True)
 background=Image.new('RGB',(W,H))
 pixels=background.load()
 for y in range(H):
  for x in range(W):
   g=math.exp(-(((x-W*.8)/(W*.55))**2+((y-H*.5)/(H*.6))**2))
   pixels[x,y]=(int(14+16*g),int(20+24*g),int(23+23*g))
 cache={}
 for key,(_,_,steps) in STORY.items():
  for name,*_ in steps:
   f=args.captures/(name+'.png')
   if not f.exists(): f=sorted((args.captures/name).glob('*.png'))[-1]
   im=Image.open(f).convert('RGB')
   # Crop the recorded system title strip consistently; preserve all app content.
   if im.width/im.height>1.3:im=im.crop((0,28,im.width,im.height))
   if name in ['files-diff','files-preview','files-source']:
    im=im.crop((int(im.width*.42),0,im.width,im.height))
   elif name in ['wiki-method','retrieval-context','tools-instructions']:
    im=im.crop((int(im.width*.24),0,im.width,im.height))
   cache[name]=im
 def frame(key,idx,t,lang,feature=True):
  zh,en,steps=STORY[key];name,cz,ce=steps[idx];im=background.copy();d=ImageDraw.Draw(im)
  title=zh if lang=='zh' else en
  d.text((48,29),'AI BRO  /  '+key.upper(),font=fonts[18],fill='#c3e999')
  d.text((48,62),title,font=fonts[36 if lang=='en' else 40],fill='#f4f7ef')
  shot=cache[name];box=(1160,635)
  sc=min(box[0]/shot.width,box[1]/shot.height)*(1+.012*(.5-.5*math.cos(math.pi*t)))
  shot=shot.resize((int(shot.width*sc),int(shot.height*sc)),Image.Resampling.LANCZOS)
  x=(W-shot.width)//2;y=143+(635-shot.height)//2
  mask=Image.new('L',shot.size);ImageDraw.Draw(mask).rounded_rectangle((0,0,shot.width-1,shot.height-1),radius=18,fill=255)
  shadow=Image.new('RGBA',(W,H));ImageDraw.Draw(shadow).rounded_rectangle((x-3,y+10,x+shot.width+3,y+shot.height+12),radius=22,fill=(0,0,0,155));im=Image.alpha_composite(im.convert('RGBA'),shadow.filter(ImageFilter.GaussianBlur(17))).convert('RGB');im.paste(shot,(x,y),mask)
  d=ImageDraw.Draw(im);caption=cz if lang=='zh' else ce
  d.text((48,805),caption,font=fonts[26],fill='#edf3e9')
  note='真实界面步骤演示 · 示例数据 · 经过剪辑' if lang=='zh' else 'Actual UI steps · Fictional data · Edited presentation'
  d.text((48,852),note,font=fonts[16],fill='#8d9c97')
  for i in range(len(steps)):
   d.rounded_rectangle((W-48-len(steps)*25+i*25,856,W-32-len(steps)*25+i*25,860),radius=2,fill='#c3e999' if i==idx else '#42504c')
  return im
 def encode(path,frames):
  p=subprocess.Popen(['ffmpeg','-y','-v','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(path)],stdin=subprocess.PIPE)
  try:
   for im in frames:p.stdin.write(im.tobytes())
  finally:p.stdin.close()
  if p.wait():raise RuntimeError(path)
 def segment(key,duration,lang):
  steps=STORY[key][2];n=round(duration*FPS);per=n/len(steps)
  for i in range(n):
   idx=min(len(steps)-1,int(i/per));u=(i-idx*per)/per;im=frame(key,idx,u,lang)
   # Short crossfades join captured steps, without pretending to record UI latency.
   if idx and i-idx*per<6:im=Image.blend(frame(key,idx-1,1,lang),im,(i-idx*per+1)/6)
   yield im
 keys=[args.only] if args.only else list(STORY)
 for key in keys:
  video=out/'features'/f'{key}.mp4';encode(video,segment(key,12,'zh'));frame(key,0,0,'zh').save(video.with_suffix('.jpg'),quality=90)
  subprocess.run(['ffmpeg','-y','-v','error','-i',str(video),'-filter_complex','fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4','-loop','0',str(video.with_suffix('.gif'))],check=True)
  print('Rendered',key,flush=True)
 if args.only:return
 def card(lang,end=False):
  im=background.copy();d=ImageDraw.Draw(im);d.text((70,135),'AI BRO',font=fonts[64],fill='#c3e999')
  lines=(['把一次对话，','变成可以继续的工作。'] if lang=='zh' else ['Turn a conversation','into work you can continue.']) if not end else (['从一份资料开始。','留下你的下一步。'] if lang=='zh' else ['Start with one file.','Leave with a next step.'])
  for i,l in enumerate(lines):d.text((70,330+i*78),l,font=fonts[40],fill='#f4f7ef')
  d.text((70,650),'zihenghe04.github.io/AIBro' if end else ('文件 / 项目 / 科研记忆 / 日程' if lang=='zh' else 'Files / Projects / Research memory / Calendar'),font=fonts[26],fill='#abbab0')
  d.text((70,824),'示例数据与预设历史 · 真实界面步骤经剪辑' if lang=='zh' else 'Fictional data and seeded history · Edited actual Chinese UI steps',font=fonts[18],fill='#8d9c97');return im
 for lang in ['zh','en']:
  def film():
   for _ in range(FPS*4):yield card(lang)
   for key in STORY:yield from segment(key,7,lang)
   for _ in range(FPS*4):yield card(lang,True)
  encode(out/f'film-{lang}.mp4',film());card(lang).save(out/f'film-{lang}.poster.jpg',quality=92)
  cues=['WEBVTT\n'];offset=4
  for key,(zh,en,steps) in STORY.items():
   fmt=lambda s:f'00:{s//60:02d}:{s%60:02d}.000'
   cues.append(f'{fmt(offset)} --> {fmt(offset+7)}\n{zh if lang=="zh" else en}\n');offset+=7
  (out/f'film-{lang}.vtt').write_text('\n'.join(cues))
 cache['projects-overview'].save(out/'workspace.jpg',quality=94)
 (out/'features'/'provenance.json').write_text(json.dumps({'version':'0.7.0','type':'edited-native-ui-step-demonstration','data':'fictional isolated workspace; conversation history seeded, no live model inference','capture':'native application screenshots through accessibility tooling','editing':'background, framing, camera drift, step crossfade, captions; not realtime recording','features':{k:[s[0] for s in v[2]] for k,v in STORY.items()}},ensure_ascii=False,indent=2)+'\n')
 print('Films and provenance complete',flush=True)
if __name__=='__main__':main()
