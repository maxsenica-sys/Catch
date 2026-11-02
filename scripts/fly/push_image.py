"""
Build an OCI image without Docker: node:22-slim (linux/amd64) + one layer
holding /app, then push it to registry.fly.io/<app>:<tag>.

Usage: python3 -I scripts/fly/push_image.py <app> <tag> <staged app dir>
Reads FLY_API_TOKEN from the environment; never prints it.
"""
import base64, gzip, hashlib, io, json, os, ssl, sys, tarfile, urllib.request, urllib.error, re

APP, TAG, SRC = sys.argv[1], sys.argv[2], sys.argv[3]
TOKEN = os.environ["FLY_API_TOKEN"]
CTX = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt") if os.path.exists("/root/.ccr/ca-bundle.crt") else ssl.create_default_context()
OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX))

def req(method, url, headers=None, data=None):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with OPENER.open(r, timeout=300) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()

# ---- pull base ---------------------------------------------------------------
st, _, body = req("GET", "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull")
hub = {"Authorization": "Bearer " + json.loads(body)["token"]}
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"])
st, _, body = req("GET", "https://registry-1.docker.io/v2/library/node/manifests/22-slim", {**hub, "Accept": ACCEPT})
assert st == 200, (st, body[:200])
index = json.loads(body)
entry = next(m for m in index["manifests"] if m["platform"]["os"] == "linux" and m["platform"]["architecture"] == "amd64")
st, _, body = req("GET", f"https://registry-1.docker.io/v2/library/node/manifests/{entry['digest']}", {**hub, "Accept": ACCEPT})
base = json.loads(body)
st, _, cfg_raw = req("GET", f"https://registry-1.docker.io/v2/library/node/blobs/{base['config']['digest']}", hub)
config = json.loads(cfg_raw)
print("base:", entry["digest"][:19], "layers:", len(base["layers"]))

# ---- app layer ---------------------------------------------------------------
raw = io.BytesIO()
with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
    def norm(ti):
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = "root"
        ti.mtime = 0
        return ti
    tar.add(SRC, arcname="app", filter=norm)
    data_dir = tarfile.TarInfo("data"); data_dir.type = tarfile.DIRTYPE; data_dir.mode = 0o755
    tar.addfile(norm(data_dir))
raw_bytes = raw.getvalue()
gz = gzip.compress(raw_bytes, mtime=0)
diff_id = "sha256:" + hashlib.sha256(raw_bytes).hexdigest()
layer_digest = "sha256:" + hashlib.sha256(gz).hexdigest()
print(f"app layer: {len(gz)/1e6:.1f} MB")

c = config["config"]
env = [e for e in c.get("Env", []) if not e.split("=")[0] in ("NODE_ENV", "DATA_DIR", "PORT", "NODE_NO_WARNINGS")]
c["Env"] = env + ["NODE_ENV=production", "DATA_DIR=/data", "PORT=8787", "NODE_NO_WARNINGS=1"]
c["WorkingDir"] = "/app"
c["Cmd"] = ["node", "server/index.ts"]
c["ExposedPorts"] = {"8787/tcp": {}}
config["rootfs"]["diff_ids"].append(diff_id)
config.setdefault("history", []).append({"created_by": "catch: COPY app /app", "comment": "built without docker"})
new_cfg = json.dumps(config, separators=(",", ":")).encode()
cfg_digest = "sha256:" + hashlib.sha256(new_cfg).hexdigest()

# ---- push --------------------------------------------------------------------
REG = "https://registry.fly.io"
basic = "Basic " + base64.b64encode(f"x:{TOKEN}".encode()).decode()
auth = {"Authorization": basic}

def authed(method, url, headers=None, data=None):
    global auth
    st, h, b = req(method, url, {**auth, **(headers or {})}, data)
    if st == 401:
        chal = h.get("www-authenticate", "")
        m = re.match(r'Bearer realm="([^"]+)"(?:,service="([^"]+)")?(?:,scope="([^"]+)")?', chal)
        if m:
            realm, service, scope = m.groups()
            q = []
            if service: q.append("service=" + service)
            q.append("scope=" + (scope or f"repository:{APP}:pull,push"))
            st2, _, tb = req("GET", realm + "?" + "&".join(q), {"Authorization": basic})
            assert st2 == 200, ("token exchange failed", st2)
            tok = json.loads(tb)
            auth = {"Authorization": "Bearer " + (tok.get("token") or tok.get("access_token"))}
            st, h, b = req(method, url, {**auth, **(headers or {})}, data)
    return st, h, b

def push_blob(digest, data):
    st, _, _ = authed("HEAD", f"{REG}/v2/{APP}/blobs/{digest}")
    if st == 200:
        return "exists"
    st, h, b = authed("POST", f"{REG}/v2/{APP}/blobs/uploads/", {"Content-Length": "0"}, b"")
    assert st == 202, ("upload start", st, b[:200])
    loc = h.get("location")
    if loc.startswith("/"):
        loc = REG + loc
    sep = "&" if "?" in loc else "?"
    st, _, b = authed("PUT", f"{loc}{sep}digest={digest}", {"Content-Type": "application/octet-stream", "Content-Length": str(len(data))}, data)
    assert st == 201, ("upload put", st, b[:200])
    return "pushed"

for layer in base["layers"]:
    st, _, blob = req("GET", f"https://registry-1.docker.io/v2/library/node/blobs/{layer['digest']}", hub)
    assert st == 200 and "sha256:" + hashlib.sha256(blob).hexdigest() == layer["digest"], "base layer download failed"
    print("base layer", layer["digest"][:19], push_blob(layer["digest"], blob))
print("app layer", push_blob(layer_digest, gz))
print("config", push_blob(cfg_digest, new_cfg))

layer_type = base["layers"][0]["mediaType"]
manifest = {
    "schemaVersion": 2,
    "mediaType": base["mediaType"],
    "config": {"mediaType": base["config"]["mediaType"], "size": len(new_cfg), "digest": cfg_digest},
    "layers": base["layers"] + [{"mediaType": layer_type, "size": len(gz), "digest": layer_digest}],
}
mbytes = json.dumps(manifest, separators=(",", ":")).encode()
st, _, b = authed("PUT", f"{REG}/v2/{APP}/manifests/{TAG}", {"Content-Type": base["mediaType"]}, mbytes)
assert st in (200, 201), ("manifest", st, b[:300])
print(f"pushed registry.fly.io/{APP}:{TAG}")
