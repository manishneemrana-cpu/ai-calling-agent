"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { signup, login, createSessionCookie, destroySessionCookie, slugify } from "@/lib/auth";

const signupSchema = z.object({
  orgName: z.string().min(2, "Organization name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().optional(),
});

export async function signupAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const parsed = signupSchema.safeParse({
    orgName: formData.get("orgName"),
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("fullName") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { orgName, email, password, fullName } = parsed.data;

  try {
    const { orgId, userId } = await signup({
      orgName,
      orgSlug: slugify(orgName),
      email,
      password,
      fullName,
    });
    await createSessionCookie({ userId, orgId, role: "owner" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup failed";
    if (message.includes("duplicate key") || message.includes("users_email_unique")) {
      return { error: "An account with that email already exists." };
    }
    return { error: "Signup failed. Please try again." };
  }

  redirect("/dashboard");
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export async function loginAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const session = await login(parsed.data.email, parsed.data.password);
  if (!session) {
    return { error: "Invalid email or password." };
  }
  await createSessionCookie(session);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySessionCookie();
  redirect("/login");
}
