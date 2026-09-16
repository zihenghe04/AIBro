/* Explicit, local-time reminders only. Broader language stays with the Agent. */
(function(root) {
  function number(s) {
    if (/^\d+$/.test(s)) return Number(s);
    const digits = '零一二三四五六七八九'; s = s.replace(/两/g, '二');
    if (s === '十') return 10;
    if (s.includes('十')) { const [a,b] = s.split('十'); return (a ? digits.indexOf(a) : 1)*10+(b ? digits.indexOf(b) : 0); }
    return digits.indexOf(s);
  }
  function parse(text, now = new Date()) {
    const m = /^(?:请|帮我|请帮我)?\s*(今天|明天|后天)(凌晨|早上|上午|中午|下午|晚上|晚间)?\s*([\d零一二三四五六七八九十两]{1,3})(?:点|:|：)(半|[\d零一二三四五六七八九十两]{1,3}分?)?\s*提醒我\s*(.+?)[。！!]?\s*$/.exec(String(text).trim());
    if (!m) return null;
    let hour=number(m[3]), minute=m[4]==='半'?30:m[4]?number(m[4].replace(/分$/, '')):0;
    if (['下午','晚上','晚间'].includes(m[2]) && hour < 12) hour+=12;
    if (m[2]==='中午' && hour < 11) hour+=12;
    if (m[2]==='凌晨' && hour===12) hour=0;
    if (hour<0||hour>23||minute<0||minute>59) return {error:'提醒时间无效，请提供准确的日期和时间。'};
    const date=new Date(now);date.setDate(date.getDate()+['今天','明天','后天'].indexOf(m[1]));date.setHours(hour,minute,0,0);
    if (date.getHours()!==hour || date.getMinutes()!==minute) return {error:'该本地时间不存在，请换一个时间。'};
    if (date<=now) return {error:'这个时间已经过去了，请重新指定提醒日期和时间。'};
    const title=m[5].trim();
    return {title,dueAt:date.toISOString(),reminderMinutes:0,checklist:/^买/.test(title)?title.replace(/^买/, '').split(/[、，,]/).map(x=>({text:x.trim(),done:false})).filter(x=>x.text):[]};
  }
  const api={parse};root.AIBroReminderIntent=api;
  if(typeof module==='object'&&module.exports) module.exports=api;
})(globalThis);
