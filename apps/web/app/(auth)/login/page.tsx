"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction } from "../actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);

  return (
    <div className="container">
      <div className="card">
        <h1>Log in</h1>
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
        <p style={{ marginTop: 16 }}>
          No account yet? <Link href="/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
