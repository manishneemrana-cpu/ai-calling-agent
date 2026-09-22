"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction } from "../actions";

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, undefined);

  return (
    <div className="auth-shell">
      <div className="auth-card-wrap">
        <div className="auth-brand">
          <strong>AI Calling Agent</strong>
        </div>
        <div className="auth-card">
          <h1>Create your organization</h1>
          <p className="auth-subtitle">Set up your account to start building AI calling agents.</p>
          {state?.error && <p className="error">{state.error}</p>}
          <form action={formAction}>
            <div className="field">
              <label htmlFor="orgName">Organization name</label>
              <input id="orgName" name="orgName" type="text" required />
            </div>
            <div className="field">
              <label htmlFor="fullName">Your name</label>
              <input id="fullName" name="fullName" type="text" />
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
              <p className="field-hint">At least 8 characters.</p>
            </div>
            <button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create organization"}
            </button>
          </form>
        </div>
        <p className="auth-footer">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </div>
  );
}
