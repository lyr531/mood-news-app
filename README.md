# mood-news-app（容器镜像）

情绪新闻台的容器版本，用于 Sealos / 任何支持容器的平台部署。

零依赖 Node 应用，镜像约 60 MB（基于 `node:20-alpine`）。

---

## 构建

推送到 `main` 分支后，GitHub Actions 自动构建并推送到 GHCR：

```
ghcr.io/<你的用户名>/<仓库名>:latest
```

首次构建约 1-2 分钟。在仓库的 **Actions** 标签页可以看进度。

---

## 在 Sealos 部署

1. 打开 [Sealos 控制台](https://cloud.sealos.run)，进入 **App Launchpad**
2. 新建应用，按下面填：

| 字段 | 值 |
|---|---|
| 应用名 | `mood-news` |
| 镜像 | `ghcr.io/<用户名>/<仓库名>:latest` |
| 副本数 | `1` |
| CPU | `0.2` |
| 内存 | `256 MiB` |
| 容器端口 | `9000` |
| 公网访问 | 开启 |

3. **环境变量**：

| 变量名 | 值 |
|---|---|
| `ZHIPU_API_KEY` | 你的智谱 key |
| `ZHIPU_MODEL` | `glm-4-flash` |
| `BRIEF_COUNT` | `10` |
| `ACCESS_TOKEN` | 访问口令，留空则不启用 |

4. 部署后等待实例状态变为 `running`，点击公网地址访问。

---

## 注意

- **镜像必须公开**，否则 Sealos 拉不到。推送到 GHCR 后，去 GitHub → Packages → 该镜像 → Package settings → Change visibility → Public。
- **ghcr.io 在国内可能拉取慢或失败**。如果 Sealos 报 `ImagePullBackOff`，改用国内镜像仓库（腾讯云 TCR 个人版免费、阿里云 ACR 个人版免费）。
- 容器内只有 `/tmp` 可写，快报缓存存在那里，重启即失效，会重新生成（约 20 秒）。
- 端口固定 `9000`，由 `PORT` 环境变量控制，Sealos 的容器端口要填 `9000`。

---

## 本地运行

```bash
docker build -t mood-news .
docker run -p 9000:9000 -e ZHIPU_API_KEY=你的key mood-news
```

访问 http://localhost:9000