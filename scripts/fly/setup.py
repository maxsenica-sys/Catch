"""
Fly.io setup through its APIs (no flyctl): IPs, secrets, volume, machine.
Idempotent: each step checks what already exists. Never prints a secret.

Usage: python3 -I scripts/fly/setup.py <app> <image> <region>
"""
import json, os, secrets as pysecrets, ssl, sys, time, urllib.error, urllib.request

APP, IMAGE, REGION = sys.argv[1:4]
TOKEN = os.environ["FLY_API_TOKEN"]
CTX = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt") if os.path.exists("/root/.ccr/ca-bundle.crt") else ssl.create_default_context()
OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX))
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def call(method, url, body=None):
    r = urllib.request.Request(url, method=method, headers=H, data=json.dumps(body).encode() if body is not None else None)
    try:
        with OPENER.open(r, timeout=120) as resp:
            t = resp.read()
            return resp.status, json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        t = e.read()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t.decode()[:300]

def gql(query, variables=None):
    st, out = call("POST", "https://api.fly.io/graphql", {"query": query, "variables": variables or {}})
    if st != 200 or out.get("errors"):
        raise SystemExit(f"graphql failed: {st} {out.get('errors') if isinstance(out, dict) else out}")
    return out["data"]

M = f"https://api.machines.dev/v1/apps/{APP}"

# 1. Public addresses -----------------------------------------------------------
app_ips = gql("query($a:String!){ app(name:$a){ sharedIpAddress ipAddresses{ nodes{ address type } } } }", {"a": APP})["app"]
have = {ip["type"] for ip in app_ips["ipAddresses"]["nodes"]}
if app_ips.get("sharedIpAddress"):
    have.add("shared_v4")  # shared v4 is not listed among ipAddresses
for t in ("shared_v4", "v6"):
    if t not in have:
        gql("mutation($i:AllocateIPAddressInput!){ allocateIpAddress(input:$i){ app{ name } } }", {"i": {"appId": APP, "type": t}})
        print("allocated", t)
    else:
        print("ip", t, "exists")

# 2. Secrets (APP_SECRET only on first run) ---------------------------------------
existing = {s["name"] for s in gql("query($a:String!){ app(name:$a){ secrets{ name } } }", {"a": APP})["app"]["secrets"]}
want = {"PUBLIC_URL": f"https://{APP}.fly.dev", "SIGNUP_MODE": "invite"}
if "APP_SECRET" not in existing:
    want["APP_SECRET"] = pysecrets.token_hex(32)
for env_name, secret_name in (("OPENAI_API_KEY", "OPENAI_API_KEY"), ("CATCH_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")):
    if os.environ.get(env_name):
        want[secret_name] = os.environ[env_name]
gql("mutation($i:SetSecretsInput!){ setSecrets(input:$i){ app{ name } } }",
    {"i": {"appId": APP, "secrets": [{"key": k, "value": v} for k, v in want.items()]}})
print("secrets set:", ", ".join(sorted(want)))  # names only

# 3. Volume -----------------------------------------------------------------------
st, vols = call("GET", f"{M}/volumes")
vol = next((v for v in (vols or []) if v.get("name") == "catch_data" and v.get("state") != "destroyed"), None)
if not vol:
    st, vol = call("POST", f"{M}/volumes", {"name": "catch_data", "region": REGION, "size_gb": 1})
    assert st in (200, 201), ("volume", st, vol)
    print("volume created", vol["id"])
else:
    print("volume exists", vol["id"])

# 4. Machine: create, or update the existing one to the new image --------------------
config = {
    "image": IMAGE,
    "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 512},
    "env": {"NODE_ENV": "production", "DATA_DIR": "/data", "PORT": "8787"},
    "mounts": [{"volume": vol["id"], "path": "/data"}],
    "services": [{
        "protocol": "tcp", "internal_port": 8787,
        "autostop": "off", "autostart": True, "min_machines_running": 1,
        "ports": [
            {"port": 80, "handlers": ["http"], "force_https": True},
            {"port": 443, "handlers": ["tls", "http"]},
        ],
    }],
    "checks": {"health": {"type": "http", "port": 8787, "path": "/healthz", "interval": "30s", "timeout": "5s", "grace_period": "20s"}},
    "restart": {"policy": "always"},
}
st, machines = call("GET", f"{M}/machines")
machines = [m for m in (machines or []) if m.get("state") != "destroyed"]
if machines:
    mid = machines[0]["id"]
    st, out = call("POST", f"{M}/machines/{mid}", {"region": REGION, "config": config})
    assert st == 200, ("machine update", st, out)
    print("machine updated", mid)
else:
    st, out = call("POST", f"{M}/machines", {"region": REGION, "name": "catch", "config": config})
    assert st == 200, ("machine create", st, out)
    mid = out["id"]
    print("machine created", mid)

for _ in range(60):
    st, m = call("GET", f"{M}/machines/{mid}")
    state = m.get("state") if isinstance(m, dict) else None
    if state == "started":
        print("machine started")
        break
    time.sleep(3)
else:
    raise SystemExit(f"machine did not start: {state}")
