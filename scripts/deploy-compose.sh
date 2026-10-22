#!/usr/bin/env bash
set -euo pipefail

base=/opt/digital-employee-9600/compose/voiceagent
release=${1:?Pass a release/image tag}
[[ "$release" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
source_dir="$base/releases/$release"
mkdir -p "$source_dir" "$base/config" "$base/runtime"
chmod 700 "$base/config"
tar -xzf /home/roottest/voiceagent-compose-source.tar.gz -C "$source_dir"
install -o 999 -g 987 -m 600 /home/roottest/voiceagent-compose.env "$base/config/voiceagent.env"
install -o 999 -g 987 -m 600 /home/roottest/livekit-compose.yaml "$base/config/livekit.yaml"
install -m 600 /home/roottest/voiceagent-compose-settings.env "$base/compose.env"
chown 999:987 "$base/config" "$base/runtime"
ln -sfn "$source_dir" "$base/current"

compose=(docker compose --env-file "$base/compose.env" -f "$base/current/docker-compose.prod.yml")
"${compose[@]}" config --quiet
"${compose[@]}" build voiceagent

image="digital-employee-voiceagent:$release"
preflight="voiceagent-preflight-$release"
cutover=0
success=0
cleanup() {
  docker rm -f "$preflight" >/dev/null 2>&1 || true
  if [[ "$cutover" = 1 && "$success" = 0 ]]; then
    echo 'Compose cutover failed; restoring the previous native services.'
    "${compose[@]}" down || true
    systemctl enable --now digital-employee-livekit.service digital-employee-voiceagent.service
  fi
}
trap cleanup EXIT

docker run -d --name "$preflight" --network host --no-healthcheck --read-only \
  --user 999:987 --tmpfs /tmp:rw,nosuid,size=128m \
  -e HOST=127.0.0.1 -e PORT=3108 \
  -v "$base/config/voiceagent.env:/app/.env:ro" "$image"
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3108/api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3108/api/config | \
  /opt/digital-employee-9600/runtime/node/bin/node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const c=JSON.parse(s);if(c.provider!=='dashscope'||!c.configured||!c.assets.kws||!c.assets.vad)process.exit(1);console.log(JSON.stringify({preflight:'OK',provider:c.provider,wakeRequired:c.wakeRequired,wakeWord:c.wakeWord}));})"
docker rm -f "$preflight"

cutover=1
systemctl disable --now digital-employee-voiceagent.service digital-employee-livekit.service
"${compose[@]}" up -d --no-build --wait --wait-timeout 90
curl --cacert /opt/digital-employee-9600/shared/tls/server.crt -fsS \
  https://192.168.30.109:9600/voice-api/api/config
success=1
echo
"${compose[@]}" ps
echo "Compose deployment ready: $base/current"
