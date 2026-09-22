"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction } from "../actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);

  return (
    <div className="auth-shell">
      <div className="auth-card-wrap">
        <div className="auth-brand">
          <strong>AI Calling Agent</strong>
        </div>
        <div className="auth-card">
          <h1>Log in</h1>
          <p className="auth-subtitle">Welcome back — sign in to your dashboard.</p>
          {state?.error && <p className="error">{state.error}</p>}
          <form action={formAction}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <button type="submit" disabled={pending}>
              {pending ? "Logging in..." : "Log in"}
            </button>
          </form>
        </div>
        <p className="auth-footer">
          No account yet? <Link href="/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
