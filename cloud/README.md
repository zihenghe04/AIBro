# 自托管云同步服务（协议 v1）

此服务只提供账号、设备、实体同步与私有附件接口，不运行工作站桌面后端，不读取客户端本机目录，不连接模型账号。首版面向个人多设备使用：单服务实例、SQLite 和服务器私有附件目录。每个账号的实体、游标、幂等记录与附件互相隔离。

没有域名或 Docker 时，可使用 [Linux 用户服务与 SSH 隧道部署](SSH_DEPLOY.md)：云服务只监听服务器 loopback，由电脑通过 SSH 连接；指南也说明首次 URL 绑定与将来切换 HTTPS 的限制。

## 用 Docker Compose 部署

准备指向服务器的域名和 Docker Compose；为 Caddy 开放 TCP 80、443。请在 `cloud` 目录操作，先设置非敏感配置：

```sh
export CLOUD_DOMAIN=sync.example.com
docker compose up -d --build
```

Caddy 负责 HTTPS，Python 服务只在容器网络暴露 8787。不要把桌面的 `server.py` 放到公网，也不要另行公开云服务的明文端口。以上命令会实际部署服务，仓库开发和测试不会替你运行它们。

账号由服务器操作者通过 CLI 创建，不提供公开注册接口。初始化第一个账号（密码从终端隐式输入，经管道传入，不出现在命令行参数或环境变量中）：

```sh
python3 -c 'import getpass; print(getpass.getpass("初始账号密码（至少12字符）: "))' | docker compose exec -T cloud python /app/cloud_server.py init --username admin --password-stdin
```

新增账号使用同样的输入方式，将 `init` 改为 `add-user` 并指定新的 `--username`。初始账号和后续账号都只有自己的数据权限；账号管理依靠服务器本地 CLI，不是公开的管理 API。用户名不区分大小写。密码使用随机盐和 scrypt（N=32768、r=8、p=1）保存；账号密码不支持通过环境变量配置。

`cloud_data` 保存 SQLite、WAL 及附件；`caddy_data` 保存 TLS 状态。备份时停止写入并复制整个 `cloud_data` 卷，或使用 SQLite 一致性备份并配套保存附件目录。不要只复制正在使用的 `.sqlite3` 文件而遗漏 WAL。更新前备份，使用一个实例挂载该数据卷；本版不支持多副本共享 SQLite。

## 本机开发

以下命令从仓库根目录运行；若此前在 `cloud` 目录部署，请先返回上一级。

```sh
python3 -c 'import getpass; print(getpass.getpass("开发账号密码: "))' | python3 cloud_server.py --data-dir /tmp/workstation-cloud-dev init --username developer --password-stdin
python3 cloud_server.py --data-dir /tmp/workstation-cloud-dev serve --host 127.0.0.1 --port 8787
```

服务器需要提供 `hashlib.scrypt` 的 Python（推荐 Python 3.12）；部分 macOS 自带 Python 没有该能力，此时请使用已安装的 Python 3.12 或 Docker 镜像。桌面客户端不需要 scrypt，不受此运行时要求影响。测试运行器从当前 Python、已有 PATH 和常用 Homebrew 路径中选择支持 scrypt 的 Python，不会安装依赖或改用较弱的密码算法。

这是开发用明文 loopback 服务，不应直接用于公网。数据目录通过 `--data-dir` 或 `CLOUD_DATA_DIR` 配置。独立服务文件是 `cloud_server.py`，Docker 镜像只复制这一文件，不依赖工作站或本机同步客户端模块。

## 协议

除健康检查和登录外，所有接口都需要 `Authorization: Bearer <accessToken>`。登录每次创建一个设备会话；令牌由 32 个随机字节产生，默认 30 天有效，数据库仅持久化令牌 SHA-256。失效后重新登录即可，客户端应把令牌保存在设备安全存储，不能放进同步实体。没有通用跨域 CORS 授权；桌面客户端应由本地同步进程访问服务。

- `GET /v1/health` → `{protocol:1}`，不泄露账号或存储信息。
- `POST /v1/auth/login`，JSON `{username,password,deviceName}` → `{accessToken,account:{id,username},device:{id,name}}`。
- `GET /v1/devices` → `{devices:[{id,name,createdAt,lastSeenAt,revokedAt,current}]}`；设备时间为 Unix 秒。
- `POST /v1/auth/logout` 撤销当前令牌。
- `DELETE /v1/devices/:id` 撤销自己账号的指定设备及其令牌。
- `POST /v1/sync/push`，JSON `{operations:[{opId,entityType,entityId,baseVersion,deleted,data}]}` → `{accepted:[{opId,entityType,entityId,version}],conflicts:[{opId,entityType,entityId,remote:{version,deleted,data}}]}`。
- `GET /v1/sync/pull?cursor=0&limit=100` → `{changes:[{seq,entityType,entityId,version,deleted,data}],cursor,hasMore}`。
- `HEAD/PUT/GET /v1/blobs/{sha256}` 检查、上传、下载当前账号的附件；摘要为小写 64 位十六进制 SHA-256。PUT 需要准确的 Content-Length，校验实际内容后原子保存，返回 `{hash,size,existed}`。HEAD 不存在返回 404，成功包含 Content-Length 和 ETag；相同账号重复上传不增加持久副本。

实体类型：`projects/tasks/notes/imports/attachments/papers/conversations/messages/links/trash/folders/skills`。实体键是 `(account,entityType,entityId)`；`data` 是 JSON 对象，服务不以 `data.id` 重写实体键。删除使用 `deleted:true,data:null`。`imports` 的 `blobHash` 不要求附件已经上传，客户端必须显示尚未上传或缺少原件的状态，不能声称原件已在云端。

每项操作在同一 SQLite 事务中提交实体、变更事件与幂等结果。`baseVersion` 必须等于服务器当前版本；新实体从 0 开始。冲突不覆盖服务端数据。重试同一个 `opId` 和相同内容会返回原结果，包含原冲突结果；同 ID 改内容返回 409 `op_id_reuse`。解决冲突需要新操作 ID 和更新后的版本。批次内每项独立提交，网络中断后可原样重试整个批次。

游标是账号内单调递增的序号，与设备时钟无关。首次从 0 分页读取，直至 `hasMore:false`；客户端应原子地应用结果并推进游标。首版永久保留变更历史、操作幂等记录和删除 tombstone，不会因设备长期离线而把旧修改当新建记录。删除不等于清除历史内容；首版尚未实现历史保留策略、账户销毁或自动附件垃圾回收。

## 限额和边界

- JSON 请求不超过 16 MiB，每批最多 100 项；单实体不超过 4 MiB。
- Pull 每页默认 100、最多 500 项，响应另有约 4 MiB 内容预算。
- 单附件不超过 64 MiB，流式写入，使用摘要路径及私有账号目录；符号链接和路径穿越被拒绝。
- 登录按地址、用户名及全局进行一分钟窗口限流；最多 4 个并行密码校验、16 个并行连接。服务不信任客户端伪造的转发地址头；Caddy 后方的地址限额由所有用户共享，适合当前个人部署规模。
- 不提供任意路径读写、终端、附件删除、公开注册、CRDT、OIDC 或端到端加密接口。云服务器持有同步内容明文，需信任服务器和备份管理者。
- 不记录请求体、Authorization 或令牌；API 错误不返回内部路径、数据库异常或凭据。

## 测试

从仓库根目录运行云服务和客户端测试：

```sh
npm run test:cloud
# 或直接运行：python3 cloud/run-tests.py
```

测试只创建临时账号、SQLite 和附件，并在 loopback 的随机端口运行临时服务，覆盖账号隔离、幂等、版本冲突、tombstone、分页、设备撤销、上传校验和非法输入；不读取真实账号或部署公网服务。
