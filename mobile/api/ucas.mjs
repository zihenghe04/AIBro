// A fixed UCAS transport, independent of AI Bro sync. No credential storage or logging.
const BASE = 'https://iclass.ucas.edu.cn:8181';
const PATHS = new Map([
  ['/app/user/login.action', 'POST'],
  ['/app/course/get_stu_course_sched.action', 'POST'],
  ['/app/course/get_stu_course_sched_week.action', 'POST'],
  ['/app/common/get_timestamp.do', 'POST'],
  ['/app/course/stu_scan_sign.action', 'GET'],
]);
const buckets = new Map();
function limited(key, now = Date.now()) {
  for (const [k,v] of buckets) if (now - v.start > 60000) buckets.delete(k);
  if (buckets.size > 5000) return true;
  const b = buckets.get(key) || {start:now, count:0};
  buckets.set(key,b); return ++b.count > 90;
}
export function schoolRequest(value) {
  if (!value || typeof value !== 'object') throw Error('invalid');
  const u = new URL(value.url);
  if (u.origin !== BASE || u.username || u.password || u.hash || PATHS.get(u.pathname) !== value.method) throw Error('invalid');
  const login = u.pathname === '/app/user/login.action';
  const session = value.headers?.sessionId;
  const headers = {'Content-Type':'application/x-www-form-urlencoded', 'User-Agent':login ? 'student_5.0.1.2_android_12_20__110000' : 'student_5.0.1.2_android_12_20_100000000000000_110000'};
  if (!login && !u.pathname.endsWith('get_timestamp.do')) {
    if (typeof session !== 'string' || !session || session.length > 512 || /[\r\n]/.test(session)) throw Error('invalid');
    headers.sessionId = session;
  }
  const input = new URLSearchParams(typeof value.body === 'string' ? value.body : '');
  const params = new URLSearchParams();
  const take = (key, source, pattern, max = 256) => {
    const v = source.get(key);
    if (typeof v !== 'string' || !v || v.length > max || source.getAll(key).length !== 1 || (pattern && !pattern.test(v))) throw Error('invalid');
    params.set(key,v);
  };
  if (login) {
    take('phone',input,null);take('password',input,null,80);
    params.set('verificationType','1');params.set('userLevel','1');
    params.set('verificationUrl','http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}');
  } else if (u.pathname.endsWith('get_timestamp.do')) {
    u.search='?id=0';
  } else if (value.method === 'GET') {
    take('courseSchedId',u.searchParams,/^[A-Za-z0-9_-]+$/);
    take('timestamp',u.searchParams,/^\d{13}$/);take('id',u.searchParams,/^[A-Za-z0-9_-]+$/);
    u.search=params.toString();
  } else {
    take('id',input,/^[A-Za-z0-9_-]+$/);take('dateStr',input,/^\d{8}$/);
  }
  if (value.method === 'POST' && !u.pathname.endsWith('get_timestamp.do')) u.search='';
  return {url:u.href, options:{method:value.method,headers,body:value.method==='POST' ? params.toString():undefined,redirect:'error',signal:AbortSignal.timeout(25000)}};
}
export function createHandler(request = fetch, extraOrigins = []) {
  return async function handler(req,res) {
    const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method !== 'POST') {res.setHeader('Allow','POST');return send(405,{code:'method_not_allowed'});}
    const origins = new Set(['https://aibro-web.vercel.app', ...extraOrigins, ...(process.env.UCAS_WEB_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean)]);
    if (!origins.has(req.headers.origin)) return send(403,{code:'school_origin_denied'});
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(415,{code:'invalid_request'});
    // Per-instance abuse guard; the upstream school still authenticates every account.
    const ip = String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0];
    if (limited(ip)) {res.setHeader('Retry-After','60');return send(429,{code:'school_rate_limited'});}
    let value, outgoing;
    try {
      if (req.body !== undefined) {
        const raw = typeof req.body==='string' ? req.body : JSON.stringify(req.body);
        if (Buffer.byteLength(raw)>8192) return send(413,{code:'invalid_request'});
        value = JSON.parse(raw);
      } else {
        let raw='';for await (const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>8192)return send(413,{code:'invalid_request'});}
        value=JSON.parse(raw);
      }
      outgoing=schoolRequest(value);
    } catch {return send(400,{code:'school_request_invalid'});}
    try {
      const response = await request(outgoing.url,outgoing.options);
      if ([401,403].includes(response.status)) return send(401,{code:'upstream_auth_expired'});
      if (!response.ok) return send(502,{code:'school_unavailable'});
      const reader=response.body.getReader();let size=0;const chunks=[];
      try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('too large');chunks.push(Buffer.from(value));}}
      finally {await reader.cancel().catch(()=>{});}
      const json=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return send(200,json);
    } catch {return send(502,{code:'school_unavailable'});}
  };
}
export default createHandler();
