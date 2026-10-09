# 签名共享与 registry 使用

本地操作者负责登记身份、团队权限与公钥信任。Registry 传输和保存精确版本，接收方仍决定是否导入、验证与采用。协议与撤权语义见 [ADR 0010](./adr/0010-signed-sharing-and-registry.md)。所有命令支持 `--home`、`--organism`、`--actor`；以下假定已初始化发布方 alice 的实例 `./publisher`，接收方 bob 的实例 `./receiver`，并存在团队 contributors 与待发布记录。

## 签名与信任

```bash
# 发布方创建私钥，私钥仅保存在实例 keys 目录；公钥文件必须尚不存在
proteus sharing-key-create contributors --public-out ./alice-public.pem \
  --home ./publisher --organism alice-organism --actor alice

# 核对公钥指纹和 team/publisher 身份后，接收方主动登记公钥
proteus sharing-key-trust contributors --publisher alice --public-key ./alice-public.pem \
  --home ./receiver --organism bob-organism --actor bob

# 也可先签名再用原有 share-import 进行离线交换
proteus publication-sign <publication-id> --key <key-id> --out ./signed-share.json \
  --home ./publisher --organism alice-organism --actor alice
proteus share-import ./signed-share.json \
  --home ./receiver --organism bob-organism --actor bob
```

`key-id` 是公钥的固定指纹，命令仅输出公钥和身份元数据。接收方按个体登记信任，其他个体不会自动继承；分享包不携带可自行获得信任的公钥。私钥丢失后不能重新生成同一身份，须创建新密钥并重新登记信任。

## Registry

服务所在个体需独立登记上传方公钥；发布方同时作为 registry 服务时，创建的本地签名密钥已经登记。Registry 凭据对应服务端已有的 Principal 与团队授权，`token-create` 不会额外授予团队权限。

```bash
# 此例 alice 已是 contributors 的管理者；凭据写入新文件，输出不包含明文
proteus registry token-create --team contributors --principal alice \
  --permission read publish --out ./alice-registry.token \
  --home ./publisher --organism alice-organism --actor alice

# 保持该命令运行；Ctrl-C / SIGTERM 关闭服务
proteus registry serve --port 9030 \
  --home ./publisher --organism alice-organism --actor alice

proteus registry publish <publication-id> --key <key-id> \
  --registry http://127.0.0.1:9030 --token-file ./alice-registry.token \
  --home ./publisher --organism alice-organism --actor alice

# public 包允许匿名下载；接收方未信任签名身份时，命令拒绝导入
proteus registry import <bundle-digest> --registry http://127.0.0.1:9030 \
  --home ./receiver --organism bob-organism --actor bob
```

Team 包还需要 registry read 凭据（`registry import --token-file <file>`），以及接收方本地团队 read 授权。两者分别由 registry 管理者与接收方本地操作者配置。服务端可通过 `init` 登记远端操作者对应的本地 Principal，再经 `team-grant` 授权；凭据绑定该主体和团队，撤销团队权限也会使相应请求失败。

远端部署需为 loopback 服务配置 HTTPS 反向代理；客户端 URL 为无路径前缀的 registry 根地址，例如 `https://registry.example`。凭据只在 HTTPS 或 loopback 传输，重定向会被拒绝。应用和代理均须限制请求体，服务端默认最多 16 MB，并返回 `Cache-Control: no-store`。上传响应丢失时，通过相同摘要显式重试会读回既有记录；客户端不会自动重复写入。服务重启后发布包与撤销状态继续保留。

下载、导入与签名不改变 active。接收方仍使用 `validation-register` → `inherit` → `evaluate-policy` → `promote` 的 M4 本地流程；外部签名和外部 eligible 汇总均不能代替本地证据。

## 撤销与轮换

```bash
proteus access-revoke team:contributors bob --permission read \
  --home ./publisher --organism alice-organism --actor alice
proteus registry token-revoke <credential-id> \
  --home ./publisher --organism alice-organism --actor alice
proteus sharing-key-revoke <key-id> \
  --home ./receiver --organism bob-organism --actor bob
```

`access-grant` / `access-revoke` 支持 team 和 organism；团队权限为 read/publish/manage，个体权限为 read/operate/promote/manage。拥有更强的 publish/manage 权限时，撤销单独 read 授权不会撤去这些权限隐含的读取能力；个体 owner 的管理权属于归属关系。

撤销接收方的来源信任会阻止新导入、继承、评估与首次晋升，保留已有来源证明和已采用行为；需恢复旧行为时显式 rollback。已撤销公钥不能重新启用，轮换流程是创建新密钥、核对新公钥、分别更新 registry 和接收方信任，再发布新记录。撤销不会追回已经下载的 public 内容，也不会删除已发生的运行结果。
