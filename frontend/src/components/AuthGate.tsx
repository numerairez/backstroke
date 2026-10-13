import { useCallback, useEffect, useState } from "react";
import App from "../App";
import { ApiError, SIGNED_OUT, api } from "../api/client";
import type { Account } from "../types";

const message = (e: unknown) => (e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);

/** Shows the sign-in page until there's a signed-in account, then the app. */
export function AuthGate() {
  const [account, setAccount] = useState<Account | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checked, setChecked] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const check = useCallback(() => {
    api
      .me()
      .then((me) => {
        setAccount(me.account);
        setNeedsSetup(me.needs_setup);
        setChecked(true);
      })
      .catch(() => setBootError("Can't reach the backend. Start it with `uvicorn app.main:app --reload` in backend/."));
  }, []);
  useEffect(check, [check]);
  useEffect(() => {
    const onSignedOut = () => setAccount(null);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  if (bootError) return <div className="boot-error">{bootError}</div>;
  if (!checked) return null;
  if (!account) return <SignIn needsSetup={needsSetup} onSignedIn={(a) => (setAccount(a), setNeedsSetup(false))} />;
  return (
    <App
      key={account.id}
      account={account}
      onAccountChanged={check}
      onSignOut={async () => {
        await api.signOut().catch(() => undefined);
        setAccount(null);
      }}
    />
  );
}

function SignIn(props: { needsSetup: boolean; onSignedIn: (account: Account) => void }) {
  const [mode, setMode] = useState<"login" | "register">(props.needsSetup ? "register" : "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const me = registering ? await api.signUp(name, email, password) : await api.signIn(email, password);
      if (me.account) props.onSignedIn(me.account);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="card signin-card" onSubmit={submit}>
        <div className="nav-brand signin-brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="7" width="18" height="6" rx="2" fill="var(--accent)" />
            <rect x="11" y="19" width="18" height="6" rx="2" fill="var(--accent-soft)" />
          </svg>
          <span>Backstroke</span>
        </div>
        <h1>{props.needsSetup ? "Set up Backstroke" : registering ? "Create your account" : "Sign in"}</h1>
        <p className="muted">
          {props.needsSetup
            ? "No one has an account yet. The first account is the admin: it manages people, groups and projects in Settings."
            : registering
              ? "You can register once an admin has listed you in People. Use your name exactly as it's listed."
              : "Plan forward. Look back."}
        </p>
        {!props.needsSetup && (
          <div className="seg-toggle signin-mode" role="group" aria-label="Sign in or register">
            <button type="button" aria-pressed={!registering} onClick={() => (setMode("login"), setError(null))}>
              Sign in
            </button>
            <button type="button" aria-pressed={registering} onClick={() => (setMode("register"), setError(null))}>
              Register
            </button>
          </div>
        )}
        {registering && (
          <label className="field">
            <span>Your name{props.needsSetup ? "" : ", as listed in People"}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus={!registering} required />
        </label>
        <label className="field">
          <span>Password{registering ? " (at least 8 characters)" : ""}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? "new-password" : "current-password"}
            minLength={registering ? 8 : undefined}
            required
          />
        </label>
        {error && <p className="callout error small">{error}</p>}
        <button className="primary signin-submit" disabled={busy}>
          {busy ? "One moment…" : props.needsSetup ? "Create admin account" : registering ? "Create account" : "Sign in"}
        </button>
        {!registering && <p className="muted small">Forgot your password? Ask an admin to reset your account, then register again.</p>}
      </form>
    </div>
  );
}
