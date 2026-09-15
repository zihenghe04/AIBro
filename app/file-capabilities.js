(function(root){'use strict';
 const rows=[
  ['Markdown / TXT','全文分段读取、源码和排版预览；创建、改写、Diff 与原字节撤销。','Paged full-text reading, source/Markdown preview, creation, edits, diff and byte-exact undo.'],
  ['代码 / Code · JSON / YAML / TOML','按文本读取、生成和改写。源码预览不执行代码；终端命令另行审批。','Read, create and edit as text. Source preview does not execute code; terminal commands are reviewed separately.'],
  ['PDF','以附件保存原件；按页预览、读取文字或页面图像。文字索引不代表已经看过所有页面。','Import originals as attachments; preview pages and read text or page images. Text indexing does not mean every page was reviewed.'],
  ['DOCX / XLSX / PPTX','本机引用读取可定位文字；生成基础文档、表格、幻灯片；审阅后改写文字或非公式单元格。图片、图表、批注与版式不在文字读取范围。','Local references expose addressable text. Generate basic documents, sheets and slides; review edits to text or non-formula cells. Images, charts, comments and layout are outside this text view.'],
  ['图片 / Images','保存原件、预览；交给支持图像输入的模型分析。是否实际读取以本轮记录为准。','Store and preview originals; analyze with a model supporting image input. The run records what was actually read.'],
  ['SQLite','数据库查询与 schema 读取暂缓，尚未启用。','Database queries and schema reading are deferred and not enabled.'],
  ['音视频 / Audio & video','转录、时间段检索与抽帧暂缓，尚未启用。','Transcription, time-range retrieval and frame extraction are deferred and not enabled.']
 ];
 function open(){const en=root.WorkstationI18n?.getLanguage?.()==='en',d=document.createElement('dialog');d.className='wiki-dialog';const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};d.append(node('h2',en?'File capabilities':'文件处理能力'),node('p',en?'Local edits require a connected project folder. Save a reviewed proposal to write the file. Long reads show remaining pages or segments.':'本机改写需要连接项目目录；审阅提案后点击保存才写入文件。长文件会标明尚未读取的页或分段。'));for(const [name,zh,english]of rows){const section=document.createElement('section');section.append(node('h3',name),node('p',en?english:zh));d.append(section);}const close=node('button',en?'Close':'关闭');close.onclick=()=>{d.close();d.remove();};d.append(close);document.body.append(d);d.showModal();}
 root.FileCapabilities={open,rows};
})(globalThis);
