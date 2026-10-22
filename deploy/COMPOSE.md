# VoiceAgent 的 Docker Compose 生产部署

> 当前状态（2026-10-21）：已按用户要求切回 systemd，Compose 语音容器已停止并移除。本文件以下内容为此前 Compose 部署记录，不代表当前运行方式。
>
> 当前语音代码目录：`/opt/digital-employee-9600/releases/release-20261021-2200/voiceagent`，2026-10-21 晚间与 digital-employee 一起更新，包含本地未提交改动。`.env` 链接至原 `/opt/digital-employee-9600/shared/voiceagent.env`。服务为 `digital-employee-voiceagent.service` 和 `digital-employee-livekit.service`，已启用开机启动。工作目录覆盖文件为 `/etc/systemd/system/digital-employee-voiceagent.service.d/20-native-release.conf`。生产构建通过，按用户要求未运行单元及联调测试。旧 native 和 Compose 文件保留用于历史记录。

当前运维命令：

```sh
systemctl status digital-employee-voiceagent digital-employee-livekit
systemctl restart digital-employee-voiceagent
journalctl -u digital-employee-voiceagent -n 100 --no-pager
```

生产入口沿用 `https://192.168.30.109:9600`。前端 nginx 和证书沿用原部署，`/voice-api/` 继续反向代理到 `127.0.0.1:3001`，`/livekit/` 代理到 `127.0.0.1:7880`。

`docker-compose.yml` 保留原来的本机开发配置；服务器使用完整的 `docker-compose.prod.yml`，同时管理 VoiceAgent 和 LiveKit。

## 镜像与配置

- Node.js 使用 `node:22.23.3-bookworm-slim`。LiveKit 原生 RTC 依赖 glibc，不使用 Alpine 作为 VoiceAgent 基础镜像。
- Dockerfile 在 Linux 内编译当前源码、SDK 和 Web 页面，并安装 Linux 原生 RTC 依赖；最终镜像只保留生产依赖。
- 本地 `web/public` 的模型和 WASM 资源必须随源码传输，不能只打包 Git 跟踪文件。
- `.env` 不进入构建上下文或镜像，以只读文件挂载到 `/app/.env`。线上模型配置保留原内容。
- 服务器特有的 HOST、PORT、LiveKit 公网和内网地址由 Compose 覆盖。
- Linux 使用宿主网络，让 WebRTC 7881/TCP、7882/UDP 直接可达；浏览器信令走现有 WSS 入口。
- 两个容器都使用非 root UID/GID、只读根文件系统和 `unless-stopped`；VoiceAgent 提供 HTTP 健康检查。

本机准备配置：

```sh
node scripts/prepare-compose.mjs 192.168.30.109
```

输出在忽略目录 `.runtime/deploy-compose/`，其中 `voiceagent.env` 和 `livekit.yaml` 含密钥，不要提交。`compose.env` 包含镜像标签、挂载路径及 UID/GID；服务器目前使用 UID 999、GID 987。

## 服务器目录和命令

部署根目录：`/opt/digital-employee-9600/compose/voiceagent`。

```sh
cd /opt/digital-employee-9600/compose/voiceagent
docker compose --env-file compose.env -f current/docker-compose.prod.yml ps
docker compose --env-file compose.env -f current/docker-compose.prod.yml logs --tail 100 voiceagent
docker compose --env-file compose.env -f current/docker-compose.prod.yml restart voiceagent
docker compose --env-file compose.env -f current/docker-compose.prod.yml up -d
```

`current` 指向本次源码快照，`config` 保存权限为 600 的环境文件和 LiveKit 配置，`runtime` 是容器可写目录。镜像带有 Git revision 标签，并使用独立版本号，便于后续回退。

`scripts/deploy-compose.sh` 会先构建镜像、在 3108 做预检查，再停止原 systemd 语音服务并启动 Compose。失败时自动恢复旧 systemd 服务。成功后旧语音服务保持禁用，避免重启时抢占相同端口；原目录和配置继续保留。

如需回退到之前的原生部署：

```sh
cd /opt/digital-employee-9600/compose/voiceagent
docker compose --env-file compose.env -f current/docker-compose.prod.yml down
systemctl enable --now digital-employee-livekit digital-employee-voiceagent
```

只更新语音服务时，不需要重启前端 nginx。

## 本次部署验证（2026-10-21）

- Git revision：`59569895fd3b5f558823e2608f85b413b390fe90`。
- 镜像：`digital-employee-voiceagent:5956989-20261021T014559Z`。
- 容器内服务构建文件与本地 SHA-256 一致；当前 `.env` 按字节保留，未进入镜像。
- 生产构建、9 个测试文件的 95 项测试通过；Linux 原生 RTC 模块加载通过。
- Compose 配置校验通过，VoiceAgent 健康，LiveKit 运行；两个旧 systemd 服务已禁用。
- 9600 公开配置确认 `wakeRequired: true`，使用默认“每轮提问需要唤醒”，唤醒词“你好小圆”。
- 浏览器实际登录、唤醒、线上 Paraformer 识别、前端业务问答流、线上 CosyVoice 合成及 LiveKit WebRTC 回答播放通过。
- 回答音频峰值 `0.2292855679988861`，观察到不同嘴型，暂停立即闭嘴；浏览器安全上下文有效。
- 首轮联调出现 SSH 和浏览器媒体连接同时中断；重连后完整复测通过，容器无重启、无 OOM。

浏览器验证使用合成麦克风输入，真实房间的远场和回声效果仍需现场验收。测试记录在前端工作区的 `node_modules/.cache/deploy-9600/browser-result.json`，截图在 `docs/previews/deployed-9600.jpg`，均不保存密码或模型密钥。
