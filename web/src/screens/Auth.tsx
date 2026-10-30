import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

export function AuthScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [cfg, setCfg] = useState<{ signup: boolean; needsInvite: boolean; firstUser: boolean } | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api("/api/auth/config").then((c) => {
      setCfg(c);
      if (c.firstUser) setMode("signup");
    });
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        await api("/api/auth/signup", {
          method: "POST",
          json: { email, password, name, invite, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        });
      } else {
        await api("/api/auth/login", { method: "POST", json: { email, password } });
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth">
      <div class="logo">Catch</div>
      <p class="muted center">Screenshot it, say it, forget it.</p>
      {cfg?.firstUser && <p class="callout">First account on this server — it becomes the owner.</p>}
      <form onSubmit={submit} class="stack">
        {mode === "signup" && (
          <input placeholder="Your name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" />
        )}
        <input type="email" placeholder="Email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autocomplete="email" />
        <input type="password" placeholder="Password (8+ characters)" required minLength={8} value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autocomplete={mode === "signup" ? "new-password" : "current-password"} />
        {mode === "signup" && cfg?.needsInvite && (
          <input placeholder="Invite code" value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value)} />
        )}
        {error && <div class="error-text">{error}</div>}
        <button class="primary" disabled={busy} type="submit">{mode === "signup" ? "Create account" : "Sign in"}</button>
      </form>
      {cfg?.signup && !cfg.firstUser && (
        <button class="link-btn" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      )}
    </div>
  );
}
