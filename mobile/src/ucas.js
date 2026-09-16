// Protocol adaptation from zhan-nine/UCAS-Sign-in and lccipher/UCAS-Course-Sign-in (AGPL-3.0). See THIRD_PARTY_NOTICES.md.
const base = "https://iclass.ucas.edu.cn:8181/app/";
const agent = "student_5.0.1.2_android_12_20_100000000000000_110000";
// Classify responses without displaying/logging the raw body: it may contain
// credentials, personal information, or a partly issued session.
export function parseLoginResponse(j) {
  const code = (value) => /^-?\d{1,8}$/.test(String(value ?? "")) ? String(value) : "未提供";
  if (!j || typeof j !== "object" || Array.isArray(j) || j.STATUS == null)
    throw Error("学校登录响应格式异常（LOGIN_BAD_RESPONSE），请稍后重试；这不代表密码错误。");
  if (String(j.STATUS) !== "0" || j.success === false ||
      (j.ERRCODE != null && !["", "0"].includes(String(j.ERRCODE)))) {
    const message = String(j.ERRMSG || j.message || j.result?.msg || "");
    const hint = /密码|口令|password/i.test(message)
      ? "学校提示账号或密码验证未通过，请先在官方轻新课堂核对对应账号。"
      : /锁定|频繁|次数|too many|locked/i.test(message)
        ? "学校提示登录受限，请稍后重试。"
        : /维护|繁忙|异常|超时|maintenance|timeout/i.test(message)
          ? "学校认证服务暂时异常，请稍后重试。"
          : "学校未接受此次登录，请先在官方轻新课堂确认账号可用；暂不能判定是密码问题。";
    throw Error(`${hint}（LOGIN_REJECTED；状态 ${code(j.STATUS)}，错误码 ${code(j.ERRCODE)}）`);
  }
  const s = j.result;
  const value = (key) => s && ["string", "number"].includes(typeof s[key])
    ? String(s[key]).trim() : "";
  const missing = ["id", "sessionId", "studentNo"].filter((key) => !value(key));
  if (missing.length)
    throw Error(`学校报告登录成功，但缺少 ${missing.join("、")}（LOGIN_INCOMPLETE）。未保存此次会话，请稍后重试；无需因此重置密码。`);
  return { userId: value("id"), sessionId: value("sessionId"), studentNo: value("studentNo") };
}
export function qrURL(identifier, timestamp) {
  const raw = String(identifier).trim(),
    compact = raw.replaceAll("-", "");
  const param = /^\d{7}$/.test(raw)
    ? "courseSchedId"
    : /^[a-f\d]{32}$/i.test(compact)
      ? "timeTableId"
      : null;
  if (!param || !Number.isFinite(timestamp) || timestamp < 1e12)
    throw Error("课程编号或学校时间无效");
  return (
    base +
    "course/stu_scan_sign.action?" +
    new URLSearchParams({
      [param]: param === "timeTableId" ? compact.toUpperCase() : raw,
      timestamp: String(Math.floor(timestamp)),
    })
  );
}
export function parseCourses(rows, day) {
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({
      id: String(x.id || ""),
      uuid: String(x.uuid || ""),
      title: x.courseName || "未命名课程",
      teacher: x.teacherName || "",
      start: x.classBeginTime,
      end: x.classEndTime,
      day,
      signed: String(x.signStatus) === "1",
    }))
    .filter((x) => x.id);
}
export function signOutcome(j) {
  const r = j.result || {},
    msg = String(r.msg || j.ERRMSG || j.message || "");
  if (
    String(j.STATUS) === "0" &&
    ["", "0"].includes(String(j.ERRCODE || "")) &&
    String(r.stuSignStatus) === "1" &&
    j.success !== false
  )
    return { status: "signed", message: "学校已确认签到成功" };
  return {
    status: "unknown",
    message: msg.includes("已签到")
      ? "学校提示已签到，请刷新核对"
      : "学校未明确确认签到成功，请刷新课程状态",
  };
}
// Only explicit authentication rejection can trigger recovery. Transport failures
// and unknown attendance outcomes must never be replayed as a sign-in action.
function authenticationExpired(value) {
  if ([401, 403].includes(value?.status)) return true;
  if (String(value?.STATUS) === "0") return false;
  const message = String(
    value?.ERRMSG || value?.message || value?.result?.msg || "",
  );
  return /未登录|请重新登录|(?:会话|登录|session).{0,12}(?:过期|失效|expired|invalid)|not logged in/i.test(
    message,
  );
}
export class UCAS {
  constructor(http, vault) {
    this.http = http;
    this.vault = vault;
    this.inFlight = new Set();
    this.clock = null;
    this.epoch = 0;
    this.loginPending = false;
    this.vaultQueue = Promise.resolve();
    this.recovery = null;
  }
  assertCurrent(epoch) {
    if (epoch !== this.epoch) throw Error("学校账号已切换，请刷新课程");
  }
  mutateVault(epoch, action) {
    const operation = this.vaultQueue.then(async () => {
      this.assertCurrent(epoch);
      await action();
      this.assertCurrent(epoch);
    });
    this.vaultQueue = operation.catch(() => {});
    return operation;
  }
  async post(path, body, session) {
    return this.http(base + path, {
      method: "POST",
      headers: {
        "User-Agent":
          path === "user/login.action"
            ? "student_5.0.1.2_android_12_20__110000"
            : agent,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(session ? { sessionId: session.sessionId } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
  }
  async authenticate(username, password) {
    username = String(username || "").trim();
    if (!username || !password || password.length > 80)
      throw Error("请输入学校账号和对应密码（最长 80 字符）");
    const j = await this.post("user/login.action", {
      phone: username,
      password,
      verificationType: "1",
      verificationUrl:
        "http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}",
      userLevel: "1",
    });
    return parseLoginResponse(j);
  }
  async login(username, password, { remember = false } = {}) {
    const epoch = ++this.epoch;
    this.loginPending = true;
    this.clock = null;
    try {
      const session = await this.authenticate(username, password);
      if (remember)
        session.credentials = { username: username.trim(), password };
      await this.mutateVault(epoch, () =>
        this.vault.set("ucas", JSON.stringify(session)),
      );
      return { studentNo: session.studentNo };
    } finally {
      if (epoch === this.epoch) this.loginPending = false;
    }
  }
  async logout() {
    const epoch = ++this.epoch;
    this.loginPending = false;
    this.clock = null;
    await this.mutateVault(epoch, () => this.vault.remove("ucas"));
  }
  async session() {
    const epoch = this.epoch;
    if (this.loginPending) throw Error("正在连接学校账号，请稍候");
    await this.vaultQueue;
    const value = await this.vault.get("ucas");
    this.assertCurrent(epoch);
    let s;
    try {
      s = JSON.parse(value || "null");
    } catch {
      /* invalid keychain data */
    }
    if (!s?.userId || !s.sessionId || !s.studentNo)
      throw Error("请先连接学校账号");
    return s;
  }
  async recover(expired, epoch) {
    this.assertCurrent(epoch);
    if (this.recovery?.epoch === epoch) return this.recovery.promise;
    const promise = (async () => {
      const current = await this.session();
      this.assertCurrent(epoch);
      // Another read already refreshed this session while our request was in flight.
      if (current.sessionId !== expired.sessionId) return current;
      if (!current.credentials?.username || !current.credentials.password)
        throw Error("学校会话已过期，请重新连接账号");
      const session = await this.authenticate(
        current.credentials.username,
        current.credentials.password,
      );
      if (
        session.userId !== current.userId ||
        session.studentNo !== current.studentNo
      )
        throw Error("学校返回的账号与原会话不一致，请手动重新连接");
      session.credentials = current.credentials;
      await this.mutateVault(epoch, () =>
        this.vault.set("ucas", JSON.stringify(session)),
      );
      return session;
    })();
    this.recovery = { epoch, promise };
    try {
      return await promise;
    } finally {
      if (this.recovery?.promise === promise) this.recovery = null;
    }
  }
  async courses(day) {
    const epoch = this.epoch;
    let s = await this.session();
    const dateStr = day.replaceAll("-", "");
    if (!/^\d{8}$/.test(dateStr)) throw Error("课程日期无效");
    const query = async () => {
      this.assertCurrent(epoch);
      const j = await this.post(
        "course/get_stu_course_sched.action",
        { id: s.userId, dateStr },
        s,
      );
      this.assertCurrent(epoch);
      if (authenticationExpired(j))
        throw Object.assign(Error("学校会话已过期"), { status: 401 });
      if (String(j.STATUS) === "0" && Array.isArray(j.result))
        return parseCourses(j.result, dateStr);
      // Weekly STATUS is inconsistent upstream; require an explicit array per day.
      const week = await this.post(
        "course/get_stu_course_sched_week.action",
        { id: s.userId, dateStr },
        s,
      );
      this.assertCurrent(epoch);
      if (authenticationExpired(week))
        throw Object.assign(Error("学校会话已过期"), { status: 401 });
      if (
        !Array.isArray(week.result) ||
        !week.result.every((x) => x && Array.isArray(x.schedData))
      )
        throw Error("学校未返回有效课表，请重新登录或稍后重试");
      return week.result
        .filter((x) => String(x.dateStr).replaceAll("-", "") === dateStr)
        .flatMap((x) => parseCourses(x.schedData, dateStr));
    };
    let result;
    try {
      result = await query();
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
      s = await this.recover(s, epoch);
      result = await query(); // Read-only query: at most one reauthentication/retry.
    }
    this.assertCurrent(epoch);
    return result.map((course) => ({ ...course, owner: s.userId }));
  }
  async schoolTime(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.clock &&
      now >= this.clock.local &&
      now - this.clock.local < 30000
    )
      return {
        timestamp: this.clock.school + now - this.clock.local,
        remaining: 30000 - (now - this.clock.local),
      };
    const t0 = Date.now(),
      result = await this.post("common/get_timestamp.do?id=0", {}),
      t1 = Date.now();
    const stamp = Number(result.timestamp);
    if (
      String(result.STATUS) !== "0" ||
      !Number.isFinite(stamp) ||
      stamp < 1e12 ||
      stamp >= 8.64e15 ||
      t1 < t0 ||
      t1 - t0 >= 30000
    ) {
      this.clock = null;
      throw Error("学校校时失败，请稍后刷新");
    }
    this.clock = { school: stamp + (t1 - t0) / 2, local: t1 };
    return { timestamp: this.clock.school, remaining: 30000 };
  }
  async qr(identifier) {
    const reading = await this.schoolTime();
    return {
      url: qrURL(identifier, reading.timestamp),
      expiresAt: Date.now() + Math.min(5000, reading.remaining),
    };
  }
  async sign(course) {
    if (this.inFlight.size) throw Error("正在提交，请勿重复操作");
    this.inFlight.add(course.id);
    const epoch = this.epoch;
    try {
      const s = await this.session();
      if (course.owner && course.owner !== s.userId)
        throw Error("课程属于之前的学校账号，请刷新课程");
      const t = await this.schoolTime(true);
      this.assertCurrent(epoch);
      const q = new URLSearchParams({
        courseSchedId: course.id,
        timestamp: String(Math.floor(t.timestamp)),
        id: s.userId,
      });
      try {
        const response = await this.http(
          base + "course/stu_scan_sign.action?" + q,
          {
            headers: {
              "User-Agent": agent,
              sessionId: s.sessionId,
              "Cache-Control": "no-store",
            },
          },
        );
        this.assertCurrent(epoch);
        return signOutcome(response);
      } catch {
        return {
          status: "unknown",
          message: "连接中断，签到结果待确认。请刷新课程，避免重复提交。",
        };
      }
    } finally {
      this.inFlight.delete(course.id);
    }
  }
}
