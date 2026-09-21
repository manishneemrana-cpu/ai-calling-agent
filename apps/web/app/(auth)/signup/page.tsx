"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction } from "../actions";

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, undefined);

  return (
    <div className="container">
      <div className="card">
        <h1>Create your organization</h1>
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
          </div>
          <button type="submit" disabled={pending}>
            {pending ? "Creating..." : "Create organization"}
          </button>
        </form>
        <p style={{ marginTop: 16 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </div>
  );
}
