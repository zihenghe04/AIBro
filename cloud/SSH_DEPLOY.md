# 无域名部署：Linux 用户服务与 SSH 隧道

这条路径适用于已有 SSH 访问权限的自有 Linux 服务器，不需要 Docker、域名或 TLS 证书。云服务只监听服务器的 `127.0.0.1:8787`，电脑通过 SSH 将它转发到本机 `127.0.0.1:18787`。跨网络传输由 SSH 加密；云服务器仍能读取同步内容，因此应由你信任的人管理。

本文命令中的 `my-sync-host` 是示例 SSH 主机别名，`researcher` 是示例云账号；请换成自己的值。SSH 登录账号与工作站云账号是两套身份。不要上传桌面工作区、模型凭据或整个仓库。

## 1. 检查服务器运行环境

需要 Python 3.10 或以上，包含 `sqlite3` 和可用的 `hashlib.scrypt`；需要 systemd 用户服务和足够的磁盘空间。服务只依赖 Python 标准库，无需 `pip install`。

先从电脑登录服务器：

```sh
ssh my-sync-host
```

以下检查在服务器上运行；使用与服务文件相同的解释器：

```sh
/usr/bin/python3 - <<'PY'
import hashlib, sqlite3, sys
assert sys.version_info >= (3, 10), '需要 Python 3.10 或以上'
assert hasattr(hashlib, 'scrypt'), '此 Python 缺少 scrypt'
hashlib.scrypt(b'runtime-check', salt=b'non-secret-check', n=32768, r=8, p=1, maxmem=64 * 1024 * 1024)
print('Python / SQLite / scrypt 检查通过')
PY
systemctl --user --version
```

若可用解释器不在 `/usr/bin/python3`，后面安装服务文件时修改 `ExecStart` 为它的绝对路径。不要降低密码算法要求。若 `systemctl --user` 提示无法连接用户总线，需要服务器管理员启用该用户的 systemd 登录会话；仅有 systemctl 命令并不代表用户服务已可用。

## 2. 上传一个带版本的最小发布目录

回到电脑，在本仓库根目录运行。每次发布生成新目录，只上传云服务文件与用户服务配置：

```sh
WORKSTATION_SSH_HOST=my-sync-host
WORKSTATION_RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
ssh "$WORKSTATION_SSH_HOST" "mkdir -p ~/.local/share/ai-workstation-cloud/releases/$WORKSTATION_RELEASE ~/.local/share/ai-workstation-cloud/data ~/.config/systemd/user"
scp app/cloud_server.py "$WORKSTATION_SSH_HOST:.local/share/ai-workstation-cloud/releases/$WORKSTATION_RELEASE/cloud_server.py"
scp cloud/ai-workstation-cloud.service "$WORKSTATION_SSH_HOST:.config/systemd/user/ai-workstation-cloud.service"
ssh "$WORKSTATION_SSH_HOST" "/usr/bin/python3 -c \"import ast,pathlib; ast.parse(pathlib.Path.home().joinpath('.local/share/ai-workstation-cloud/releases/$WORKSTATION_RELEASE/cloud_server.py').read_text())\""
ssh "$WORKSTATION_SSH_HOST" "cd ~/.local/share/ai-workstation-cloud && ln -s 'releases/$WORKSTATION_RELEASE' 'current-$WORKSTATION_RELEASE' && mv -Tf 'current-$WORKSTATION_RELEASE' current && chmod 700 data"
```

最后一条使用 Linux 的 `mv -T` 原子替换 `current` 符号链接。已有 `current` 应是符号链接；如果它是实体目录，先检查旧安装布局，不要强行删除。若语法检查失败，不执行切换链接这一步。

服务器布局为：

```text
~/.local/share/ai-workstation-cloud/
├── current -> releases/<release-id>
├── releases/
│   └── <release-id>/cloud_server.py
└── data/
    ├── cloud.sqlite3
    └── ...账号私有附件与 SQLite 辅助文件
~/.config/systemd/user/ai-workstation-cloud.service
```

发布目录与持久数据分开；更新代码时继续使用同一个 `data`，不要重新初始化一份云数据库。桌面的 `server.py` 是本机后端，不属于服务器发布内容。

## 3. 初始化云账号

再次 SSH 登录服务器，在服务器终端运行。密码通过隐藏输入和标准输入管道传给 CLI，不写在命令参数、环境变量或 shell 历史中：

```sh
set -o pipefail
python3 -c 'import getpass; print(getpass.getpass("初始云账号密码（至少12字符）: "))' | /usr/bin/python3 "$HOME/.local/share/ai-workstation-cloud/current/cloud_server.py" --data-dir "$HOME/.local/share/ai-workstation-cloud/data" init --username researcher --password-stdin
```

`init` 只适用于还没有账号的数据库。已有账号时不要重复初始化；需要独立的新账号，将 `init` 改为 `add-user`，并更换 `--username`。账号彼此隔离，不是通过新建账号来增加同一人的设备。首版没有忘记密码、公开注册或账号迁移界面。

## 4. 启动并保持用户服务运行

在服务器上执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now ai-workstation-cloud.service
systemctl --user status ai-workstation-cloud.service --no-pager
curl --fail --silent --show-error http://127.0.0.1:8787/v1/health
```

健康检查应返回 `{"protocol":1}`。服务文件固定监听 loopback，不需要开放公网 8787 端口。

要在 SSH 退出后、以及服务器重启后仍运行此用户的服务，需要管理员开启 linger：

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
```

确认输出 `Linger=yes`。没有 sudo 权限时，让管理员为你的 SSH 用户执行此设置。`enable --now` 与 linger 分别负责启用服务和维持用户服务管理器，不能互相替代。

## 5. 电脑建立 SSH 隧道

在使用工作站的电脑终端运行；先按正常 SSH 流程核验服务器主机密钥并配置密钥登录，不要关闭主机密钥检查：

```sh
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18787:127.0.0.1:8787 \
  my-sync-host
```

此命令前台保持运行且通常没有输出；关闭终端或按 Ctrl+C 会断开隧道。另开终端验证：

```sh
curl --fail --silent --show-error http://127.0.0.1:18787/v1/health
```

返回 `{"protocol":1}` 后，在工作站的“设置 → 账号与云同步”填写：

| 字段 | 值 |
| --- | --- |
| 云服务器 | `http://127.0.0.1:18787` |
| 用户名、密码 | 第 3 步初始化的云账号 |
| 设备名称 | 能区分这台电脑的名称 |

核对合并说明，勾选确认，再连接。首次连接会将当前本地知识与云端合并；存在冲突时，在界面核对本机与云端版本。另一台电脑需要建立自己的相同端口隧道，使用同一个云账号和不同的设备名称。不要把地址填成服务器公网 IP、追加 `/v1`，也不要混用 `localhost` 与 `127.0.0.1`。

本指南中的命令没有自动重连功能。macOS 可以另配用户级 LaunchAgent 启动同一条 SSH 命令，并使用 `BatchMode=yes` 和故障重启；应先确保交互式密钥登录与主机密钥核验已完成，避免后台等待密码。休眠或断网期间，工作站保持本地使用，云同步显示离线并保留待上传内容；SSH 隧道恢复后才可继续同步。不要把云账号密码放进 SSH 启动项。

## 6. 地址绑定与将来切换 HTTPS

**第一次连接前选定稳定的客户端地址。** 当前本地工作区绑定的是规范化后的服务器 URL 与云账号 ID。`http://127.0.0.1:18787`、`http://localhost:18787` 和未来的 `https://sync.example.com` 是不同的目标；断开连接不会清除此绑定。

首版没有服务器 URL 迁移、账号重绑定或同步游标重置功能。将来增加 HTTPS 后，不要直接在既有工作区改地址、手改 SQLite 绑定或重新初始化云账号。可继续保留 SSH 隧道供已绑定设备使用，新的独立本地工作区再通过 HTTPS 连接同一云数据库；把原有工作区迁到新 URL 需要另行实现并验证迁移流程。服务端加 HTTPS 不等于客户端已有迁移能力。

SSH 主机名或服务器位置变化时，可以调整隧道的 SSH 目标并保留本机 `18787` 地址，但目标必须仍是同一份云数据库及账号，不能把旧工作区指向一份全新的数据库。带域名的部署见 [Docker Compose 与 HTTPS 指南](README.md)。

## 7. 升级、日志与备份

服务器上的常用检查：

```sh
systemctl --user is-active ai-workstation-cloud.service
journalctl --user -u ai-workstation-cloud.service -n 80 --no-pager
ss -ltn '( sport = :8787 )'
readlink "$HOME/.local/share/ai-workstation-cloud/current"
```

`ss` 应只看到 `127.0.0.1:8787`。日志用于查看启动和请求状态；不要额外开启记录密码、令牌或请求正文的调试代理。

升级前暂停各设备同步，在服务器停止服务并备份整个数据目录：

```sh
WORKSTATION_BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$HOME/.local/share/ai-workstation-cloud/backups"
chmod 700 "$HOME/.local/share/ai-workstation-cloud/backups"
systemctl --user stop ai-workstation-cloud.service
tar -C "$HOME/.local/share/ai-workstation-cloud" -czf "$HOME/.local/share/ai-workstation-cloud/backups/data-$WORKSTATION_BACKUP_STAMP.tar.gz" data
chmod 600 "$HOME/.local/share/ai-workstation-cloud/backups/data-$WORKSTATION_BACKUP_STAMP.tar.gz"
```

确认备份成功后，按第 2 步上传新的 release 并切换 `current`；如果 Python 路径不同，重新上传 unit 后继续保留该修改。然后启动并核验：

```sh
systemctl --user daemon-reload
systemctl --user restart ai-workstation-cloud.service
curl --fail --silent --show-error http://127.0.0.1:8787/v1/health
```

不要仅复制运行中的 `cloud.sqlite3` 而遗漏 WAL 和附件；不要把备份放在公开 Web 目录。备份含同步内容与会话数据库，应与原数据同样保护。服务只使用单实例 SQLite，不支持多个进程或多副本共用此目录。

若仅代码升级失败且数据库格式仍兼容，可以把 `current` 原子切回已记录的旧 release 并重启。若版本涉及数据库迁移，旧代码不一定能读取新数据库；不能把代码回滚当成数据恢复。恢复历史云备份还涉及客户端已有游标与离线更改，首版没有自动恢复协调流程，应先暂停所有设备、保留现有数据副本，并在隔离实例与独立客户端工作区验证恢复方案后再处理生产连接。

## 8. 排障顺序

1. 服务器健康检查失败：查看 systemd 日志，核对 Python 路径、scrypt、数据目录权限与磁盘空间。
2. 服务器正常而电脑健康检查失败：检查 SSH 会话、网络和端口占用；`ExitOnForwardFailure` 会在本机 18787 被占用时直接报错。
3. 健康检查正常但登录失败：使用云账号而非 SSH 账号；设备被撤销或会话过期时重新登录。不要重新初始化数据库。
4. 提示目标不匹配：核对是否改了 URL、端口或云账号。恢复原目标；当前版本不支持直接迁移绑定。
5. 存在待上传或冲突：在工作站查看明确状态并处理冲突。待上传数量不为零时不能把它视为已经备份成功。

同步范围、附件限制和当前产品边界见 [客户端云同步说明](../docs/CLOUD_SYNC.md)，协议与服务限额见 [云服务说明](README.md)。
