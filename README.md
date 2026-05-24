# poc-cng-editable-tile

Immutable `base.mbtiles` と mutable `edits.sqlite` をリクエスト時にマージし、OSM ID に紐づく tags を動的に上書きする editable vector tile サーバー。

## アーキテクチャ

```
GET /tiles/{z}/{x}/{y}.mvt
  └── base.mbtiles (read-only)  ──┐
                                   ├──▶ request-time merge ──▶ MVT response
  └── edits.sqlite (read-write) ──┘
```

- `base.mbtiles` は読み取り専用。geometry は変更しない
- `edits.sqlite` に OSM ID ごとの tag 差分を保存
- リクエストのたびに merge して返す

## API

| Method | Path | 説明 |
|--------|------|------|
| GET | `/healthz` | ヘルスチェック |
| GET | `/tiles/{z}/{x}/{y}.mvt` | 差分マージ済み MVT |
| POST | `/edit` | 編集を保存 |
| GET | `/edits/{osm_type}/{osm_id}` | 現在の編集状態を取得 |

### POST /edit

```json
{
  "osm_type": "way",
  "osm_id": 123456789,
  "action": "upsert_tags",
  "tags": {
    "disaster:damage": "major",
    "disaster:confidence": "0.8",
    "disaster:source": "drone_cog_001"
  }
}
```

`action` は `upsert_tags` / `delete` / `restore` に対応。

## ローカル実行

### 前提

- Node.js 20+
- `base.mbtiles` ファイル（buildings layer を含む MBTiles）

### セットアップ

```bash
npm install
```

### 起動

```bash
BASE_MBTILES_PATH=/path/to/base.mbtiles \
EDITS_SQLITE_PATH=/tmp/edits.sqlite \
npm start
```

### Docker で起動

```bash
# ビルド
docker build -t poc-cng-editable-tile .

# 起動（/data に base.mbtiles を置いておく）
docker run -p 8080:8080 \
  -v /path/to/data:/data \
  poc-cng-editable-tile
```

## 動作確認手順

```bash
BASE=http://localhost:8080

# 1. ヘルスチェック
curl $BASE/healthz

# 2. タイルが返ること確認（z/x/y は base.mbtiles に存在するものを指定）
curl -o /tmp/tile.mvt "$BASE/tiles/14/14552/6451"
file /tmp/tile.mvt

# 3. 特定 osm_id に tag を付与
curl -X POST $BASE/edit \
  -H "Content-Type: application/json" \
  -d '{
    "osm_type": "way",
    "osm_id": 123456789,
    "action": "upsert_tags",
    "tags": {
      "disaster:damage": "major",
      "disaster:confidence": "0.8"
    }
  }'

# 4. 編集状態を確認
curl $BASE/edits/way/123456789

# 5. 同じタイルを再取得し tag が反映されていることを確認
#    （tippecanoe や MapLibre GL JS で decode して確認）

# 6. feature を非表示にする
curl -X POST $BASE/edit \
  -H "Content-Type: application/json" \
  -d '{"osm_type":"way","osm_id":123456789,"action":"delete"}'

# 7. 編集を元に戻す
curl -X POST $BASE/edit \
  -H "Content-Type: application/json" \
  -d '{"osm_type":"way","osm_id":123456789,"action":"restore"}'
```

### コンテナ再起動後の確認

```bash
# 再起動
docker restart <container>

# edits が保持されていること
curl http://localhost:8080/edits/way/123456789
```

`/data` を volume mount しているため `edits.sqlite` は永続化される。

## テスト

```bash
npm install
npm test
```

## Knative デプロイ

### イメージビルド & プッシュ

```bash
# arm64 (Raspberry Pi) 向け
docker buildx build \
  --platform linux/arm64 \
  -t 192.168.0.90:5000/poc-cng-editable-tile:0.1.0 \
  --push .
```

### データ配置（pi5 上）

```bash
ssh yuiseki@192.168.0.90
sudo mkdir -p /data/poc-cng-editable-tile
sudo cp /path/to/base.mbtiles /data/poc-cng-editable-tile/base.mbtiles
```

### デプロイ

```bash
kubectl apply -f k8s/knative-service.yaml

# 確認
kubectl -n knative-pool get ksvc poc-cng-editable-tile
```

### ホスト名

Knative が割り当てるデフォルト URL 例:
```
https://poc-cng-editable-tile.knative-pool.yuiseki.dev
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `BASE_MBTILES_PATH` | `/data/base.mbtiles` | base MBTiles のパス |
| `EDITS_SQLITE_PATH` | `/data/edits.sqlite` | edits SQLite のパス |
| `BUILDINGS_LAYER_NAME` | `buildings` | 編集対象レイヤー名 |
| `PORT` | `8080` | リッスンポート |
| `HOST` | `0.0.0.0` | リッスンホスト |

## 実装上の制限

- single replica 前提（SQLite write lock 共有不可）
- geometry 編集・新規 feature 作成は非対応
- 複数ユーザー認証・conflict resolution は非対応
